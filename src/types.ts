import * as vscode from 'vscode';

export type CallerPropagation = 'off' | 'oneHop' | 'transitive';

export interface ExtensionSettings {
  enabled: boolean;
  callerPropagation: CallerPropagation;
  maxFiles: number;
  variableUnderlineColor: string;
  functionUnderlineColor: string;
}

export interface OffsetRange {
  start: number;
  end: number;
}

export interface IdentifierRange extends OffsetRange {
  name: string;
}

export interface FunctionInfo {
  name: string;
  declaration: OffsetRange;
  body: OffsetRange;
  directReactiveReads: Set<string>;
  functionCalls: Set<string>;
}

export interface DocumentAnalysis {
  uri: vscode.Uri;
  path: string;
  text: string;
  isSvelte: boolean;
  reactiveVariables: Set<string>;
  functions: Map<string, FunctionInfo>;
  identifiers: IdentifierRange[];
  markupExpressionRanges: OffsetRange[];
}

export interface WorkspaceAnalysis {
  reactiveVariablesByFile: Map<string, Set<string>>;
  reactiveFunctionsByFile: Map<string, Set<string>>;
  documents: Map<string, DocumentAnalysis>;
}

export interface DecorationRanges {
  variables: vscode.Range[];
  functions: vscode.Range[];
}
