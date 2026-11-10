import * as vscode from 'vscode';
import { FitsEditorProvider } from './fitsEditorProvider';

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(FitsEditorProvider.register(context));

	context.subscriptions.push(vscode.commands.registerCommand('astro-fits-reviewer.openFile', async (uri?: vscode.Uri) => {
		let target = uri;
		if (!target) {
			const picked = await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: { 'FITS files': ['fits', 'fit', 'fts', 'gz', 'fz'], 'All files': ['*'] },
			});
			target = picked?.[0];
		}
		if (target) {
			await vscode.commands.executeCommand('vscode.openWith', target, FitsEditorProvider.viewType);
		}
	}));
}

export function deactivate() { }
