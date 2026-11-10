// Types shared between the extension host and the webview.

export type CardValue = string | number | boolean | null;

export interface HeaderCard {
	key: string;
	value: CardValue;
	comment: string;
	raw: string;
}

export type HduKind = 'image' | 'bintable' | 'table' | 'compressed' | 'empty' | 'unknown';

export interface HduSummary {
	index: number;
	name: string;
	kind: HduKind;
	bitpix: number;
	/** NAXISn values, FITS order (NAXIS1 first). */
	shape: number[];
	/** True when the HDU holds pixel data this viewer can display. */
	displayable: boolean;
}

/** Synthesized beam, all angles in degrees. */
export interface Beam {
	bmaj: number;
	bmin: number;
	bpa: number;
	chan?: number;
	pol?: number;
}

export interface RegionSpec {
	shape: 'point' | 'rect' | 'ellipse';
	/** Inclusive 0-based pixel bounding box. */
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

// ---- webview -> host ----

export type ToHost =
	| { type: 'ready' }
	| { type: 'selectHdu'; hdu: number }
	| { type: 'getPlane'; reqId: number; hdu: number; indices: number[] }
	| { type: 'getProfile'; reqId: number; hdu: number; axis: number; indices: number[]; region: RegionSpec };

// ---- host -> webview ----

export type ToWebview =
	| { type: 'init'; fileName: string; fileSize: number; hdus: HduSummary[] }
	| { type: 'hdu'; hdu: number; cards: HeaderCard[]; beams: Beam[] }
	| { type: 'plane'; reqId: number; hdu: number; indices: number[]; nx: number; ny: number; data: Float32Array }
	| { type: 'profile'; reqId: number; hdu: number; axis: number; values: Float32Array; npix: number; region: RegionSpec }
	| { type: 'error'; message: string; reqId?: number };

/** Membership test shared by region statistics (webview) and profile extraction (host). */
export function inRegion(r: RegionSpec, x: number, y: number): boolean {
	if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) {
		return false;
	}
	if (r.shape !== 'ellipse') {
		return true;
	}
	const cx = (r.x0 + r.x1) / 2;
	const cy = (r.y0 + r.y1) / 2;
	const rx = (r.x1 - r.x0 + 1) / 2;
	const ry = (r.y1 - r.y0 + 1) / 2;
	const dx = (x - cx) / rx;
	const dy = (y - cy) / ry;
	return dx * dx + dy * dy <= 1;
}
