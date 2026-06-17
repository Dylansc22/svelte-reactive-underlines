import * as vscode from 'vscode';
import { ExtensionSettings } from './types';

const section = 'svelteReactiveUnderlines';

export function getSettings(): ExtensionSettings {
  const config = vscode.workspace.getConfiguration(section);

  return {
    enabled: config.get('enabled', true),
    callerPropagation: config.get('callerPropagation', 'off'),
    maxFiles: config.get('maxFiles', 3000),
    variableUnderlineColor: config.get('variableUnderlineColor', 'rgba(255, 193, 7, 0.95)'),
    functionUnderlineColor: config.get('functionUnderlineColor', 'rgba(64, 196, 255, 0.95)')
  };
}
