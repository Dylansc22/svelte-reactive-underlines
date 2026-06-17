import * as path from 'node:path';
import * as ts from 'typescript';
import * as vscode from 'vscode';
import { createSvelteVirtualScript } from './svelte';
import {
  CallerPropagation,
  DecorationRanges,
  DocumentAnalysis,
  FunctionInfo,
  ImportBinding,
  IdentifierRange,
  OffsetRange,
  WorkspaceAnalysis
} from './types';

const supportedExtensions = new Set(['.svelte', '.svelte.ts', '.svelte.js', '.ts', '.js']);
const runeNames = new Set(['$state', '$derived', '$props', '$bindable']);
const identifierPattern = /\b[$A-Z_a-z][$\w]*\b/g;

export function isSupportedUri(uri: vscode.Uri) {
  return isSupportedPath(uri.fsPath);
}

export function isSupportedPath(filePath: string) {
  return filePath.endsWith('.svelte.ts') || filePath.endsWith('.svelte.js') || supportedExtensions.has(path.extname(filePath));
}

export function analyzeText(uri: vscode.Uri, text: string): DocumentAnalysis {
  const isSvelte = uri.fsPath.endsWith('.svelte');
  const virtual = isSvelte ? createSvelteVirtualScript(text) : undefined;
  const sourceText = virtual?.text ?? text;
  const sourceFile = ts.createSourceFile(
    uri.fsPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(uri.fsPath)
  );

  const reactiveVariables = new Set<string>();
  const identifiers: IdentifierRange[] = [];
  const functions = new Map<string, FunctionInfo>();
  const imports = collectImports(sourceFile);

  collectReactiveVariables(sourceFile, reactiveVariables);
  collectIdentifiers(sourceFile, identifiers);
  collectFunctions(sourceFile, reactiveVariables, functions);

  if (isSvelte && virtual) {
    collectMarkupIdentifiers(text, virtual.markupExpressionRanges, identifiers);
  }

  return {
    uri,
    path: uri.fsPath,
    text,
    isSvelte,
    reactiveVariables,
    functions,
    imports,
    identifiers,
    markupExpressionRanges: virtual?.markupExpressionRanges ?? []
  };
}

export function buildWorkspaceAnalysis(
  documents: DocumentAnalysis[],
  callerPropagation: CallerPropagation
): WorkspaceAnalysis {
  const reactiveVariablesByFile = new Map<string, Set<string>>();
  const reactiveFunctionsByFile = new Map<string, Set<string>>();
  const documentsByPath = new Map(documents.map((document) => [document.path, document]));
  const reactiveVariableReferencesByFile = new Map<string, Set<string>>();
  const reactiveFunctionReferencesByFile = new Map<string, Set<string>>();

  for (const document of documents) {
    reactiveVariablesByFile.set(document.path, document.reactiveVariables);
    reactiveFunctionsByFile.set(document.path, new Set());
    reactiveVariableReferencesByFile.set(document.path, new Set(document.reactiveVariables));

    for (const fn of document.functions.values()) {
      if (fn.directReactiveReads.size > 0) {
        reactiveFunctionsByFile.get(document.path)?.add(fn.name);
      }
    }
  }

  for (const document of documents) {
    addImportedReactiveNames(document, documentsByPath, reactiveVariablesByFile, reactiveVariableReferencesByFile);
  }

  if (callerPropagation !== 'off') {
    propagateReactiveFunctions(documents, documentsByPath, reactiveFunctionsByFile, callerPropagation);
  }

  for (const document of documents) {
    reactiveFunctionReferencesByFile.set(
      document.path,
      new Set(reactiveFunctionsByFile.get(document.path) ?? [])
    );
    addImportedReactiveNames(document, documentsByPath, reactiveFunctionsByFile, reactiveFunctionReferencesByFile);
  }

  return {
    reactiveVariablesByFile,
    reactiveFunctionsByFile,
    reactiveVariableReferencesByFile,
    reactiveFunctionReferencesByFile,
    documents: new Map(documents.map((document) => [document.uri.toString(), document]))
  };
}

export function getDecorationRanges(
  document: vscode.TextDocument,
  analysis: WorkspaceAnalysis
): DecorationRanges {
  const analyzedDocument = analysis.documents.get(document.uri.toString());
  if (!analyzedDocument) {
    return { variables: [], functions: [] };
  }

  const reactiveVariables = analysis.reactiveVariableReferencesByFile.get(analyzedDocument.path) ?? new Set();
  const reactiveFunctions = analysis.reactiveFunctionReferencesByFile.get(analyzedDocument.path) ?? new Set();
  const variables: vscode.Range[] = [];
  const functions: vscode.Range[] = [];

  for (const identifier of analyzedDocument.identifiers) {
    if (reactiveVariables.has(identifier.name)) {
      variables.push(toVsCodeRange(document, identifier));
      continue;
    }

    if (reactiveFunctions.has(identifier.name)) {
      functions.push(toVsCodeRange(document, identifier));
    }
  }

  return { variables, functions };
}

function getScriptKind(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (filePath.endsWith('.js') || filePath.endsWith('.svelte.js')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function collectReactiveVariables(sourceFile: ts.SourceFile, reactiveVariables: Set<string>) {
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && isRuneExpression(node.initializer)) {
      collectBindingNames(node.name, reactiveVariables);
    }

    if (ts.isPropertyDeclaration(node) && node.initializer && isRuneExpression(node.initializer)) {
      const name = getPropertyName(node.name);
      if (name) {
        reactiveVariables.add(name);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function collectImports(sourceFile: ts.SourceFile): ImportBinding[] {
  const imports: ImportBinding[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }

    const source = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (!clause) {
      continue;
    }

    if (clause.name) {
      imports.push({ localName: clause.name.text, importedName: 'default', source });
    }

    const namedBindings = clause.namedBindings;
    if (namedBindings && ts.isNamedImports(namedBindings)) {
      for (const element of namedBindings.elements) {
        imports.push({
          localName: element.name.text,
          importedName: element.propertyName?.text ?? element.name.text,
          source
        });
      }
    }
  }

  return imports;
}

function collectIdentifiers(sourceFile: ts.SourceFile, identifiers: IdentifierRange[]) {
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      identifiers.push({ name: node.text, start: node.getStart(sourceFile), end: node.getEnd() });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function collectFunctions(
  sourceFile: ts.SourceFile,
  reactiveVariables: Set<string>,
  functions: Map<string, FunctionInfo>
) {
  const visit = (node: ts.Node) => {
    const namedFunction = getNamedFunction(node, sourceFile);

    if (namedFunction) {
      const { name, declaration, body } = namedFunction;
      const shadowedNames = collectShadowedNames(node);
      const directReactiveReads = new Set<string>();
      const functionCalls = new Set<string>();

      collectFunctionBodyFacts(sourceFile, body, reactiveVariables, shadowedNames, directReactiveReads, functionCalls);

      functions.set(name, {
        name,
        declaration,
        body: { start: body.getStart(sourceFile), end: body.getEnd() },
        directReactiveReads,
        functionCalls
      });
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

function collectFunctionBodyFacts(
  sourceFile: ts.SourceFile,
  body: ts.Node,
  reactiveVariables: Set<string>,
  shadowedNames: Set<string>,
  directReactiveReads: Set<string>,
  functionCalls: Set<string>
) {
  const visit = (node: ts.Node) => {
    if (node !== body && isFunctionLike(node)) {
      return;
    }

    if (ts.isCallExpression(node)) {
      const calledName = getExpressionName(node.expression);
      if (calledName) {
        functionCalls.add(calledName);
      }
    }

    if (ts.isIdentifier(node) && !isDeclarationIdentifier(node)) {
      const name = node.text;
      if (reactiveVariables.has(name) && !shadowedNames.has(name)) {
        directReactiveReads.add(name);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
}

function collectShadowedNames(functionNode: ts.Node) {
  const shadowedNames = new Set<string>();

  if (isFunctionLike(functionNode)) {
    for (const parameter of functionNode.parameters) {
      collectBindingNames(parameter.name, shadowedNames);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node)) {
      collectBindingNames(node.name, shadowedNames);
    }

    if (isFunctionLike(node) && node !== functionNode) {
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(functionNode);
  return shadowedNames;
}

function getNamedFunction(
  node: ts.Node,
  sourceFile: ts.SourceFile
): { name: string; declaration: OffsetRange; body: ts.ConciseBody } | undefined {
  if (ts.isFunctionDeclaration(node) && node.name && node.body) {
    return {
      name: node.name.text,
      declaration: { start: node.name.getStart(sourceFile), end: node.name.getEnd() },
      body: node.body
    };
  }

  if ((ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node)) && node.body) {
    const name = getPropertyName(node.name);
    if (!name) return undefined;

    return {
      name,
      declaration: { start: node.name.getStart(sourceFile), end: node.name.getEnd() },
      body: node.body
    };
  }

  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && isNamedFunctionExpression(node)) {
    const nameNode = getFunctionExpressionNameNode(node);
    if (!nameNode) return undefined;

    return {
      name: nameNode.getText(sourceFile),
      declaration: { start: nameNode.getStart(sourceFile), end: nameNode.getEnd() },
      body: node.body
    };
  }

  return undefined;
}

function isNamedFunctionExpression(node: ts.ArrowFunction | ts.FunctionExpression) {
  return Boolean(getFunctionExpressionNameNode(node));
}

function getFunctionExpressionNameNode(node: ts.ArrowFunction | ts.FunctionExpression): ts.Node | undefined {
  const parent = node.parent;

  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name;
  }

  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) {
    return parent.name;
  }

  if (ts.isBinaryExpression(parent) && ts.isIdentifier(parent.left)) {
    return parent.left;
  }

  return undefined;
}

function isRuneExpression(expression: ts.Expression): boolean {
  const unwrapped = unwrapExpression(expression);

  if (ts.isCallExpression(unwrapped)) {
    const name = getExpressionName(unwrapped.expression);
    return Boolean(name && runeNames.has(name));
  }

  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;

  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }

  return current;
}

function getExpressionName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }

  if (ts.isPropertyAccessExpression(expression)) {
    const left = getExpressionName(expression.expression);
    if (left && runeNames.has(left)) {
      return left;
    }
    return expression.name.text;
  }

  return undefined;
}

function collectBindingNames(name: ts.BindingName, names: Set<string>) {
  if (ts.isIdentifier(name)) {
    names.add(name.text);
    return;
  }

  for (const element of name.elements) {
    if (ts.isBindingElement(element)) {
      collectBindingNames(element.name, names);
    }
  }
}

function getPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }

  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }

  return undefined;
}

function isDeclarationIdentifier(node: ts.Identifier) {
  const parent = node.parent;
  return (
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isImportSpecifier(parent) && parent.name === node) ||
    (ts.isImportClause(parent) && parent.name === node) ||
    (ts.isClassDeclaration(parent) && parent.name === node) ||
    (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
    (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node)
  );
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node)
  );
}

function propagateReactiveFunctions(
  documents: DocumentAnalysis[],
  documentsByPath: Map<string, DocumentAnalysis>,
  reactiveFunctionsByFile: Map<string, Set<string>>,
  callerPropagation: CallerPropagation
) {
  const maxIterations = callerPropagation === 'oneHop' ? 1 : 20;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let changed = false;

    for (const document of documents) {
      const reactiveFunctions = reactiveFunctionsByFile.get(document.path);
      if (!reactiveFunctions) continue;
      const callableReactiveFunctions = new Set(reactiveFunctions);
      addImportedReactiveNames(document, documentsByPath, reactiveFunctionsByFile, new Map([[document.path, callableReactiveFunctions]]));

      for (const fn of document.functions.values()) {
        if (reactiveFunctions.has(fn.name)) continue;

        if (intersects(fn.functionCalls, callableReactiveFunctions)) {
          reactiveFunctions.add(fn.name);
          changed = true;
        }
      }
    }

    if (!changed) {
      return;
    }
  }
}

function addImportedReactiveNames(
  document: DocumentAnalysis,
  documentsByPath: Map<string, DocumentAnalysis>,
  sourceNamesByFile: Map<string, Set<string>>,
  targetNamesByFile: Map<string, Set<string>>
) {
  const targetNames = targetNamesByFile.get(document.path);
  if (!targetNames) {
    return;
  }

  for (const binding of document.imports) {
    const importedDocument = resolveImport(document.path, binding.source, documentsByPath);
    if (!importedDocument) {
      continue;
    }

    const sourceNames = sourceNamesByFile.get(importedDocument.path);
    if (sourceNames?.has(binding.importedName)) {
      targetNames.add(binding.localName);
    }
  }
}

function resolveImport(
  importingPath: string,
  source: string,
  documentsByPath: Map<string, DocumentAnalysis>
): DocumentAnalysis | undefined {
  if (!source.startsWith('.')) {
    return undefined;
  }

  const basePath = path.resolve(path.dirname(importingPath), source);
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.js`,
    `${basePath}.svelte.ts`,
    `${basePath}.svelte.js`,
    `${basePath}.svelte`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.js'),
    path.join(basePath, 'index.svelte.ts'),
    path.join(basePath, 'index.svelte.js')
  ];

  return candidates.map((candidate) => documentsByPath.get(candidate)).find(Boolean);
}

function collectMarkupIdentifiers(
  source: string,
  ranges: OffsetRange[],
  identifiers: IdentifierRange[]
) {
  for (const range of ranges) {
    const expression = source.slice(range.start, range.end);
    for (const match of expression.matchAll(identifierPattern)) {
      if (isKeyword(match[0])) {
        continue;
      }

      const start = range.start + (match.index ?? 0);
      identifiers.push({ name: match[0], start, end: start + match[0].length });
    }
  }
}

function isKeyword(word: string) {
  return [
    'as',
    'await',
    'break',
    'case',
    'catch',
    'const',
    'continue',
    'else',
    'false',
    'for',
    'function',
    'if',
    'in',
    'let',
    'new',
    'null',
    'of',
    'return',
    'switch',
    'this',
    'true',
    'typeof',
    'undefined',
    'var',
    'void',
    'while'
  ].includes(word);
}

function toVsCodeRange(document: vscode.TextDocument, range: OffsetRange) {
  return new vscode.Range(document.positionAt(range.start), document.positionAt(range.end));
}

function intersects(left: Set<string>, right: Set<string>) {
  for (const item of left) {
    if (right.has(item)) {
      return true;
    }
  }
  return false;
}
