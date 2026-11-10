import * as vscode from 'vscode';
import * as path from 'path';
import { FileSource, FitsFile, sourceFromBuffer } from './fits/reader';
import { Beam, ToHost, ToWebview } from './common/protocol';

class FitsDocument implements vscode.CustomDocument {
	private beams?: Promise<Beam[]>;

	constructor(readonly uri: vscode.Uri, readonly fits: FitsFile) { }

	getBeams(): Promise<Beam[]> {
		this.beams ??= this.fits.readBeams().catch(() => []);
		return this.beams;
	}

	dispose(): void {
		void this.fits.close();
	}
}

export class FitsEditorProvider implements vscode.CustomReadonlyEditorProvider<FitsDocument> {
	static readonly viewType = 'astroFitsReviewer.viewer';

	static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider(
			FitsEditorProvider.viewType,
			new FitsEditorProvider(context),
			{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
		);
	}

	constructor(private readonly context: vscode.ExtensionContext) { }

	async openCustomDocument(uri: vscode.Uri): Promise<FitsDocument> {
		const source = uri.scheme === 'file'
			? await FileSource.open(uri.fsPath)
			: sourceFromBuffer(Buffer.from(await vscode.workspace.fs.readFile(uri)));
		try {
			return new FitsDocument(uri, await FitsFile.open(source));
		} catch (e) {
			await source.close().catch(() => undefined);
			throw e;
		}
	}

	resolveCustomEditor(document: FitsDocument, panel: vscode.WebviewPanel): void {
		const webview = panel.webview;
		webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
				vscode.Uri.joinPath(this.context.extensionUri, 'media'),
			],
		};
		webview.html = this.html(webview);

		const post = (msg: ToWebview) => void webview.postMessage(msg);
		const fits = document.fits;
		// Only the most recent profile request is worth finishing.
		let latestProfile = 0;

		panel.webview.onDidReceiveMessage(async (msg: ToHost) => {
			const reqId = 'reqId' in msg ? msg.reqId : undefined;
			try {
				switch (msg.type) {
					case 'ready':
						post({
							type: 'init',
							fileName: path.basename(document.uri.path),
							fileSize: fits.size,
							hdus: fits.hdus.map(h => h.summary),
						});
						break;
					case 'selectHdu': {
						const hdu = fits.hdus[msg.hdu];
						if (!hdu) {
							throw new Error(`No HDU ${msg.hdu}.`);
						}
						const beams = hdu.summary.kind === 'image' ? await document.getBeams() : [];
						post({ type: 'hdu', hdu: msg.hdu, cards: hdu.cards, beams });
						break;
					}
					case 'getPlane': {
						const { nx, ny, data } = await fits.readPlane(msg.hdu, msg.indices);
						post({ type: 'plane', reqId: msg.reqId, hdu: msg.hdu, indices: msg.indices, nx, ny, data });
						break;
					}
					case 'getProfile': {
						latestProfile = msg.reqId;
						const res = await fits.readProfile(
							msg.hdu, msg.axis, msg.indices, msg.region, () => latestProfile !== msg.reqId);
						if (res) {
							post({
								type: 'profile', reqId: msg.reqId, hdu: msg.hdu, axis: msg.axis,
								values: res.values, npix: res.npix, region: msg.region,
							});
						}
						break;
					}
				}
			} catch (e) {
				post({ type: 'error', message: e instanceof Error ? e.message : String(e), reqId });
			}
		});
	}

	private html(webview: vscode.Webview): string {
		const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
		const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('media', 'viewer.css')}" rel="stylesheet">
<title>FITS Viewer</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${uri('dist', 'webview.js')}"></script>
</body>
</html>`;
	}
}
