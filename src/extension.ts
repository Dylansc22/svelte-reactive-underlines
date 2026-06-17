import * as vscode from 'vscode';
import { analyzeText, buildWorkspaceAnalysis, getDecorationRanges, isSupportedUri } from './analyzer';
import { getSettings } from './config';
import { DocumentAnalysis, ExtensionSettings, WorkspaceAnalysis } from './types';

let variableDecoration: vscode.TextEditorDecorationType | undefined;
let functionDecoration: vscode.TextEditorDecorationType | undefined;
let latestAnalysis: WorkspaceAnalysis | undefined;
let rescanTimer: NodeJS.Timeout | undefined;
let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;
let lastIndexedFileCount = 0;
let lastScanDurationMs = 0;
let lastVisibleVariableCount = 0;
let lastVisibleFunctionCount = 0;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Svelte Reactive Underlines');
  context.subscriptions.push(output);
  output.appendLine('Svelte Reactive Underlines activated');

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);
  statusBar.command = 'svelteReactiveUnderlines.showStatus';
  context.subscriptions.push(statusBar);
  updateStatusBar('starting');

  rebuildDecorations();

  context.subscriptions.push(
    vscode.commands.registerCommand('svelteReactiveUnderlines.rescanWorkspace', () => {
      void scanWorkspace();
    }),
    vscode.commands.registerCommand('svelteReactiveUnderlines.showStatus', () => {
      showStatus();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('svelteReactiveUnderlines')) {
        rebuildDecorations();
        scheduleWorkspaceScan();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (isSupportedUri(event.document.uri)) {
        scheduleWorkspaceScan();
      }
    }),
    vscode.workspace.onDidOpenTextDocument((document) => {
      if (isSupportedUri(document.uri)) {
        scheduleWorkspaceScan();
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (isSupportedUri(document.uri)) {
        scheduleWorkspaceScan();
      }
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => {
      updateVisibleEditors();
    })
  );

  scheduleWorkspaceScan(0);
}

export function deactivate() {
  variableDecoration?.dispose();
  functionDecoration?.dispose();
  statusBar?.dispose();
  output?.dispose();
}

function rebuildDecorations() {
  const settings = getSettings();
  variableDecoration?.dispose();
  functionDecoration?.dispose();

  variableDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none',
    borderColor: settings.variableUnderlineColor,
    borderStyle: 'none none solid none',
    borderWidth: '0 0 1px 0',
    overviewRulerColor: settings.variableUnderlineColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });

  functionDecoration = vscode.window.createTextEditorDecorationType({
    textDecoration: 'none',
    borderColor: settings.functionUnderlineColor,
    borderStyle: 'none none dotted none',
    borderWidth: '0 0 1px 0',
    overviewRulerColor: settings.functionUnderlineColor,
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
}

function scheduleWorkspaceScan(delay = 250) {
  if (rescanTimer) {
    clearTimeout(rescanTimer);
  }

  rescanTimer = setTimeout(() => {
    void scanWorkspace();
  }, delay);
}

async function scanWorkspace() {
  const settings = getSettings();
  if (!settings.enabled) {
    clearVisibleEditors();
    updateStatusBar('disabled');
    return;
  }

  const startedAt = Date.now();
  const documents = await collectDocuments(settings);
  latestAnalysis = buildWorkspaceAnalysis(documents, settings.callerPropagation);
  lastIndexedFileCount = documents.length;
  lastScanDurationMs = Date.now() - startedAt;
  updateVisibleEditors();
  output.appendLine(`Indexed ${documents.length} files in ${lastScanDurationMs}ms`);
  updateStatusBar('ready');
}

async function collectDocuments(settings: ExtensionSettings): Promise<DocumentAnalysis[]> {
  const visibleOpenDocuments = new Map(
    vscode.workspace.textDocuments
      .filter((document) => isSupportedUri(document.uri))
      .map((document) => [document.uri.toString(), document])
  );

  const files = await vscode.workspace.findFiles(
    '**/*.{svelte,svelte.ts,svelte.js,ts,js}',
    '**/{node_modules,.svelte-kit,dist,build,.git}/**',
    settings.maxFiles
  );

  const analyses: DocumentAnalysis[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    const key = file.toString();
    seen.add(key);

    const openDocument = visibleOpenDocuments.get(key);
    const text = openDocument
      ? openDocument.getText()
      : Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf8');

    analyses.push(analyzeText(file, text));
  }

  for (const [key, document] of visibleOpenDocuments) {
    if (!seen.has(key)) {
      analyses.push(analyzeText(document.uri, document.getText()));
    }
  }

  return analyses;
}

function updateVisibleEditors() {
  if (!latestAnalysis || !variableDecoration || !functionDecoration) {
    return;
  }

  let variableCount = 0;
  let functionCount = 0;

  for (const editor of vscode.window.visibleTextEditors) {
    if (!isSupportedUri(editor.document.uri)) {
      continue;
    }

    const ranges = getDecorationRanges(editor.document, latestAnalysis);
    variableCount += ranges.variables.length;
    functionCount += ranges.functions.length;
    editor.setDecorations(variableDecoration, ranges.variables);
    editor.setDecorations(functionDecoration, ranges.functions);
  }

  lastVisibleVariableCount = variableCount;
  lastVisibleFunctionCount = functionCount;
  updateStatusBar('ready');
}

function clearVisibleEditors() {
  if (!variableDecoration || !functionDecoration) {
    return;
  }

  for (const editor of vscode.window.visibleTextEditors) {
    editor.setDecorations(variableDecoration, []);
    editor.setDecorations(functionDecoration, []);
  }

  lastVisibleVariableCount = 0;
  lastVisibleFunctionCount = 0;
}

function updateStatusBar(state: 'starting' | 'ready' | 'disabled') {
  if (!statusBar) {
    return;
  }

  if (state === 'disabled') {
    statusBar.text = 'Svelte reactive: disabled';
    statusBar.tooltip = 'Svelte Reactive Underlines is disabled';
    statusBar.show();
    return;
  }

  if (state === 'starting') {
    statusBar.text = 'Svelte reactive: scanning';
    statusBar.tooltip = 'Svelte Reactive Underlines is scanning the workspace';
    statusBar.show();
    return;
  }

  statusBar.text = `Svelte reactive: ${lastVisibleVariableCount}v ${lastVisibleFunctionCount}f`;
  statusBar.tooltip = [
    'Svelte Reactive Underlines',
    `Indexed files: ${lastIndexedFileCount}`,
    `Last scan: ${lastScanDurationMs}ms`,
    `Visible reactive variables: ${lastVisibleVariableCount}`,
    `Visible reactive functions: ${lastVisibleFunctionCount}`
  ].join('\n');
  statusBar.show();
}

function showStatus() {
  const settings = getSettings();
  const reactiveVariables =
    latestAnalysis ? [...latestAnalysis.reactiveVariablesByFile.values()].reduce((total, set) => total + set.size, 0) : 0;
  const reactiveFunctions =
    latestAnalysis ? [...latestAnalysis.reactiveFunctionsByFile.values()].reduce((total, set) => total + set.size, 0) : 0;

  const message = [
    `Enabled: ${settings.enabled}`,
    `Caller propagation: ${settings.callerPropagation}`,
    `Indexed files: ${lastIndexedFileCount}`,
    `Workspace reactive variables: ${reactiveVariables}`,
    `Workspace reactive functions: ${reactiveFunctions}`,
    `Visible reactive variables: ${lastVisibleVariableCount}`,
    `Visible reactive functions: ${lastVisibleFunctionCount}`,
    `Last scan: ${lastScanDurationMs}ms`
  ].join('\n');

  output.appendLine(message);
  void vscode.window.showInformationMessage(message, 'Open Output').then((choice) => {
    if (choice === 'Open Output') {
      output.show();
    }
  });
}
