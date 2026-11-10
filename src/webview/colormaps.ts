// Colormaps as evenly spaced colour stops, expanded to 256-entry RGB tables.

const STOPS: Record<string, string[]> = {
	gray: ['000000', 'ffffff'],
	viridis: ['440154', '482878', '3e4a89', '31688e', '26828e', '1f9e89', '35b779', '6dcd59', 'b4de2c', 'fde725'],
	inferno: ['000004', '1b0c41', '4a0c6b', '781c6d', 'a52c60', 'cf4446', 'ed6925', 'fb9b06', 'f7d13d', 'fcffa4'],
	magma: ['000004', '180f3d', '440f76', '721f81', '9e2f7f', 'cd4071', 'f1605d', 'fd9668', 'feca8d', 'fcfdbf'],
	plasma: ['0d0887', '46039f', '7201a8', '9c179e', 'bd3786', 'd8576b', 'ed7953', 'fb9f3a', 'fdca26', 'f0f921'],
	heat: ['000000', '800000', 'ff8000', 'ffff80', 'ffffff'],
	coolwarm: ['3b4cc0', '6788ee', '9abbff', 'c9d7f0', 'dddddd', 'f7c4aa', 'f49a7b', 'd65244', 'b40426'],
	turbo: ['30123b', '4662d7', '36aaf9', '1ae4b6', '72fe5e', 'c7ef34', 'faba39', 'f66b19', 'cb2a04', '7a0403'],
};

function fromStops(stops: string[]): Uint8Array {
	const rgb = stops.map(s => [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)]);
	const out = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i++) {
		const f = (i / 255) * (rgb.length - 1);
		const k = Math.min(rgb.length - 2, Math.floor(f));
		const t = f - k;
		for (let c = 0; c < 3; c++) {
			out[i * 3 + c] = Math.round(rgb[k][c] * (1 - t) + rgb[k + 1][c] * t);
		}
	}
	return out;
}

function cubehelix(): Uint8Array {
	// Green (2011) default: start 0.5, rotations -1.5, hue 1, gamma 1.
	const out = new Uint8Array(256 * 3);
	for (let i = 0; i < 256; i++) {
		const t = i / 255;
		const ang = 2 * Math.PI * (0.5 / 3 + 1 - 1.5 * t);
		const amp = t * (1 - t) / 2;
		const cs = Math.cos(ang);
		const sn = Math.sin(ang);
		const rgb = [
			t + amp * (-0.14861 * cs + 1.78277 * sn),
			t + amp * (-0.29227 * cs - 0.90649 * sn),
			t + amp * (1.97294 * cs),
		];
		for (let c = 0; c < 3; c++) {
			out[i * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, rgb[c])));
		}
	}
	return out;
}

const TABLES = new Map<string, Uint8Array>();

export const COLORMAPS = ['gray', 'viridis', 'inferno', 'magma', 'plasma', 'heat', 'cubehelix', 'coolwarm', 'turbo'];

export function colormapTable(name: string): Uint8Array {
	let t = TABLES.get(name);
	if (!t) {
		t = name === 'cubehelix' ? cubehelix() : fromStops(STOPS[name] ?? STOPS.gray);
		TABLES.set(name, t);
	}
	return t;
}

export type Stretch = 'linear' | 'log' | 'sqrt' | 'squared' | 'asinh';
export const STRETCHES: Stretch[] = ['linear', 'log', 'sqrt', 'squared', 'asinh'];

/** Stretch functions map [0, 1] -> [0, 1] (same definitions as DS9 / astropy.visualization). */
export function applyStretch(s: Stretch, t: number): number {
	switch (s) {
		case 'log': return Math.log(1000 * t + 1) / Math.log(1001);
		case 'sqrt': return Math.sqrt(t);
		case 'squared': return t * t;
		case 'asinh': return Math.asinh(10 * t) / Math.asinh(10);
		default: return t;
	}
}

export const LUT_SIZE = 4096;

/** Combined stretch + colormap lookup table of packed little-endian RGBA pixels. */
export function buildLut(cmap: string, stretch: Stretch, invert: boolean): Uint32Array {
	const table = colormapTable(cmap);
	const lut = new Uint32Array(LUT_SIZE);
	for (let i = 0; i < LUT_SIZE; i++) {
		let s = applyStretch(stretch, i / (LUT_SIZE - 1));
		if (invert) {
			s = 1 - s;
		}
		const k = Math.max(0, Math.min(255, Math.round(s * 255))) * 3;
		lut[i] = (255 << 24) | (table[k + 2] << 16) | (table[k + 1] << 8) | table[k];
	}
	return lut;
}
