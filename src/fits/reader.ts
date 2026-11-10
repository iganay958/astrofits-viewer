// Minimal, lazy FITS reader. Headers are parsed up front; pixel data is read
// one plane (or one small sub-block) at a time so multi-GB cubes stay usable.

import * as fs from 'fs';
import * as zlib from 'zlib';
import { Beam, CardValue, HduKind, HduSummary, HeaderCard, RegionSpec, inRegion } from '../common/protocol';

const BLOCK = 2880;
const CARD = 80;

export interface ByteSource {
	readonly size: number;
	read(offset: number, length: number): Promise<Buffer>;
	close(): Promise<void>;
}

export class MemorySource implements ByteSource {
	constructor(private readonly buf: Buffer) { }
	get size(): number {
		return this.buf.length;
	}
	async read(offset: number, length: number): Promise<Buffer> {
		// Return an aligned private copy: callers byte-swap in place.
		const end = Math.min(this.buf.length, offset + length);
		const out = Buffer.from(new ArrayBuffer(Math.max(0, end - offset)));
		this.buf.copy(out, 0, offset, end);
		return out;
	}
	async close(): Promise<void> { }
}

export class FileSource implements ByteSource {
	private constructor(private readonly handle: fs.promises.FileHandle, readonly size: number) { }

	static async open(path: string): Promise<ByteSource> {
		const handle = await fs.promises.open(path, 'r');
		try {
			const stat = await handle.stat();
			const magic = Buffer.alloc(2);
			await handle.read(magic, 0, 2, 0);
			if (magic[0] === 0x1f && magic[1] === 0x8b) {
				// gzip cannot be read randomly: inflate the whole file into memory.
				const raw = await handle.readFile();
				await handle.close();
				const inflated = await new Promise<Buffer>((resolve, reject) =>
					zlib.gunzip(raw, (err, out) => (err ? reject(err) : resolve(out))));
				return new MemorySource(inflated);
			}
			return new FileSource(handle, stat.size);
		} catch (e) {
			await handle.close().catch(() => undefined);
			throw e;
		}
	}

	async read(offset: number, length: number): Promise<Buffer> {
		const len = Math.max(0, Math.min(length, this.size - offset));
		// A fresh ArrayBuffer guarantees alignment for typed-array views.
		const buf = Buffer.from(new ArrayBuffer(len));
		let done = 0;
		while (done < len) {
			const { bytesRead } = await this.handle.read(buf, done, len - done, offset + done);
			if (bytesRead === 0) {
				break;
			}
			done += bytesRead;
		}
		return done === len ? buf : buf.subarray(0, done);
	}

	async close(): Promise<void> {
		await this.handle.close();
	}
}

export function sourceFromBuffer(buf: Buffer): ByteSource {
	if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
		return new MemorySource(zlib.gunzipSync(buf));
	}
	return new MemorySource(buf);
}

export function parseCard(raw: string): HeaderCard {
	const key8 = raw.slice(0, 8).trimEnd();
	if (key8 === 'HIERARCH') {
		const eq = raw.indexOf('=');
		if (eq > 0) {
			const { value, comment } = parseValue(raw.slice(eq + 1));
			return { key: raw.slice(0, eq).trim(), value, comment, raw };
		}
	}
	if (raw.slice(8, 10) === '= ') {
		const { value, comment } = parseValue(raw.slice(10));
		return { key: key8, value, comment, raw };
	}
	// COMMENT, HISTORY, CONTINUE, blank keyword and other commentary cards.
	return { key: key8, value: null, comment: raw.slice(8).trim(), raw };
}

function parseValue(text: string): { value: CardValue; comment: string } {
	const t = text.trimStart();
	if (t.startsWith("'")) {
		// Quoted string; '' is an escaped quote.
		let out = '';
		let i = 1;
		for (; i < t.length; i++) {
			if (t[i] === "'") {
				if (t[i + 1] === "'") {
					out += "'";
					i++;
				} else {
					break;
				}
			} else {
				out += t[i];
			}
		}
		const rest = t.slice(i + 1);
		const slash = rest.indexOf('/');
		return { value: out.trimEnd(), comment: slash >= 0 ? rest.slice(slash + 1).trim() : '' };
	}
	const slash = t.indexOf('/');
	const v = (slash >= 0 ? t.slice(0, slash) : t).trim();
	const comment = slash >= 0 ? t.slice(slash + 1).trim() : '';
	if (v === '') {
		return { value: null, comment };
	}
	if (v === 'T' || v === 'F') {
		return { value: v === 'T', comment };
	}
	// Fortran-style exponents (1.0D+03) are legal in FITS.
	const n = Number(v.replace(/[dD]/, 'E'));
	return { value: Number.isNaN(n) ? v : n, comment };
}

export interface Hdu {
	summary: HduSummary;
	cards: HeaderCard[];
	header: Map<string, CardValue>;
	headerOffset: number;
	dataOffset: number;
	dataSize: number;
}

function hnum(h: Map<string, CardValue>, key: string, dflt: number): number {
	const v = h.get(key);
	return typeof v === 'number' ? v : dflt;
}

export class FitsFile {
	readonly hdus: Hdu[] = [];

	private constructor(private readonly src: ByteSource) { }

	get size(): number {
		return this.src.size;
	}

	static async open(src: ByteSource): Promise<FitsFile> {
		const f = new FitsFile(src);
		let offset = 0;
		while (offset + BLOCK <= src.size) {
			const hdu = await f.readHdu(offset, f.hdus.length);
			if (!hdu) {
				break;
			}
			f.hdus.push(hdu);
			offset = hdu.dataOffset + Math.ceil(hdu.dataSize / BLOCK) * BLOCK;
		}
		if (f.hdus.length === 0) {
			throw new Error('Not a FITS file: no valid header found (expected SIMPLE = T).');
		}
		return f;
	}

	async close(): Promise<void> {
		await this.src.close();
	}

	private async readHdu(offset: number, index: number): Promise<Hdu | null> {
		const cards: HeaderCard[] = [];
		let pos = offset;
		let ended = false;
		while (!ended) {
			const block = await this.src.read(pos, BLOCK);
			if (block.length < BLOCK) {
				// Trailing junk / truncated file.
				if (index === 0) {
					throw new Error('Truncated FITS header.');
				}
				return null;
			}
			const text = block.toString('latin1');
			if (pos === offset) {
				const first = text.slice(0, 8);
				if (index === 0 ? first !== 'SIMPLE  ' : first !== 'XTENSION') {
					if (index === 0) {
						throw new Error('Not a FITS file: header does not start with SIMPLE.');
					}
					return null;
				}
			}
			for (let i = 0; i < BLOCK; i += CARD) {
				const raw = text.slice(i, i + CARD);
				if (raw.slice(0, 8) === 'END     ') {
					ended = true;
					break;
				}
				if (raw.trim() === '') {
					continue;
				}
				cards.push(parseCard(raw));
			}
			pos += BLOCK;
		}

		// Fold CONTINUE long-string cards into the card they extend.
		const header = new Map<string, CardValue>();
		let lastKey: string | undefined;
		for (const c of cards) {
			if (c.key === 'CONTINUE' && lastKey !== undefined) {
				const prev = header.get(lastKey);
				const m = /^\s*'((?:[^']|'')*)'/.exec(c.raw.slice(8));
				if (typeof prev === 'string' && m) {
					header.set(lastKey, prev.replace(/&$/, '') + m[1].replace(/''/g, "'").trimEnd());
				}
				continue;
			}
			if (c.key && c.key !== 'COMMENT' && c.key !== 'HISTORY' && c.value !== null && !header.has(c.key)) {
				header.set(c.key, c.value);
				lastKey = c.key;
			}
		}

		const bitpix = hnum(header, 'BITPIX', 8);
		const naxis = hnum(header, 'NAXIS', 0);
		const shape: number[] = [];
		for (let i = 1; i <= naxis; i++) {
			shape.push(hnum(header, `NAXIS${i}`, 0));
		}
		const groups = header.get('GROUPS') === true && shape[0] === 0;
		const pcount = hnum(header, 'PCOUNT', 0);
		const gcount = hnum(header, 'GCOUNT', 1);
		let npix = 0;
		if (naxis > 0) {
			npix = (groups ? shape.slice(1) : shape).reduce((a, b) => a * b, 1);
		}
		const dataSize = (Math.abs(bitpix) / 8) * gcount * (pcount + npix);

		const xtension = typeof header.get('XTENSION') === 'string' ? (header.get('XTENSION') as string).trim() : '';
		let kind: HduKind;
		if (index === 0 || xtension === 'IMAGE') {
			kind = npix > 0 && !groups ? 'image' : groups ? 'unknown' : 'empty';
		} else if (xtension === 'BINTABLE') {
			kind = header.get('ZIMAGE') === true ? 'compressed' : 'bintable';
		} else if (xtension === 'TABLE') {
			kind = 'table';
		} else {
			kind = 'unknown';
		}
		const extname = header.get('EXTNAME');
		const name = typeof extname === 'string' && extname ? extname : index === 0 ? 'PRIMARY' : xtension || `HDU ${index}`;

		return {
			summary: { index, name, kind, bitpix, shape, displayable: kind === 'image' },
			cards, header, headerOffset: offset, dataOffset: pos, dataSize,
		};
	}

	private imageHdu(index: number): Hdu {
		const hdu = this.hdus[index];
		if (!hdu || hdu.summary.kind !== 'image') {
			throw new Error(`HDU ${index} has no image data.`);
		}
		return hdu;
	}

	/** Element offset of the start of the 2D plane selected by `indices` (0-based, axes 3..N). */
	private planeStart(hdu: Hdu, indices: number[]): { nx: number; ny: number; start: number } {
		const shape = hdu.summary.shape;
		const nx = shape[0];
		const ny = shape.length > 1 ? shape[1] : 1;
		let start = 0;
		let stride = nx * ny;
		for (let a = 2; a < shape.length; a++) {
			const k = indices[a - 2] ?? 0;
			if (k < 0 || k >= shape[a]) {
				throw new Error(`Index ${k} out of range for axis ${a + 1}.`);
			}
			start += k * stride;
			stride *= shape[a];
		}
		return { nx, ny, start };
	}

	private async readElements(hdu: Hdu, start: number, count: number): Promise<Float32Array> {
		const bytes = Math.abs(hdu.summary.bitpix) / 8;
		const buf = await this.src.read(hdu.dataOffset + start * bytes, count * bytes);
		if (buf.length < count * bytes) {
			throw new Error('FITS data is truncated.');
		}
		return decode(buf, count, hdu);
	}

	async readPlane(hduIndex: number, indices: number[]): Promise<{ nx: number; ny: number; data: Float32Array }> {
		const hdu = this.imageHdu(hduIndex);
		const { nx, ny, start } = this.planeStart(hdu, indices);
		if (nx * ny > 2 ** 28) {
			throw new Error(`Plane of ${nx} x ${ny} pixels is too large to display.`);
		}
		return { nx, ny, data: await this.readElements(hdu, start, nx * ny) };
	}

	/**
	 * Mean of the finite pixels inside `region` for every position along `axis`
	 * (0-based FITS axis index, >= 2), holding the other axes at `indices`.
	 */
	async readProfile(
		hduIndex: number, axis: number, indices: number[], region: RegionSpec, cancelled: () => boolean,
	): Promise<{ values: Float32Array; npix: number } | null> {
		const hdu = this.imageHdu(hduIndex);
		const shape = hdu.summary.shape;
		if (axis < 2 || axis >= shape.length) {
			throw new Error('Invalid profile axis.');
		}
		const nx = shape[0];
		const ny = shape[1];
		const r: RegionSpec = {
			shape: region.shape,
			x0: Math.max(0, Math.floor(region.x0)), y0: Math.max(0, Math.floor(region.y0)),
			x1: Math.min(nx - 1, Math.floor(region.x1)), y1: Math.min(ny - 1, Math.floor(region.y1)),
		};
		const n = shape[axis];
		const values = new Float32Array(n).fill(NaN);
		if (r.x1 < r.x0 || r.y1 < r.y0) {
			return { values, npix: 0 };
		}
		// Membership uses the unclipped region so a clipped ellipse keeps its shape.
		const offsets: number[] = [];
		for (let y = r.y0; y <= r.y1; y++) {
			for (let x = r.x0; x <= r.x1; x++) {
				if (inRegion(region, x, y)) {
					offsets.push((y - r.y0) * nx + (x - r.x0));
				}
			}
		}
		const first = r.y0 * nx + r.x0;
		const span = (r.y1 - r.y0) * nx + (r.x1 - r.x0) + 1;
		const idx = indices.slice();
		for (let k = 0; k < n; k++) {
			if (cancelled()) {
				return null;
			}
			idx[axis - 2] = k;
			const { start } = this.planeStart(hdu, idx);
			const block = await this.readElements(hdu, start + first, span);
			let sum = 0;
			let cnt = 0;
			for (const o of offsets) {
				const v = block[o];
				if (v === v) {
					sum += v;
					cnt++;
				}
			}
			values[k] = cnt ? sum / cnt : NaN;
		}
		return { values, npix: offsets.length };
	}

	/** Per-channel beams from a CASA-style BEAMS binary table, in degrees. */
	async readBeams(): Promise<Beam[]> {
		const hdu = this.hdus.find(h => h.summary.kind === 'bintable' && h.summary.name.toUpperCase() === 'BEAMS');
		if (!hdu) {
			return [];
		}
		const h = hdu.header;
		const rowLen = hnum(h, 'NAXIS1', 0);
		const rows = hnum(h, 'NAXIS2', 0);
		const nf = hnum(h, 'TFIELDS', 0);
		if (!rowLen || !rows || rows > 1e6) {
			return [];
		}
		const sizes: Record<string, number> = { L: 1, B: 1, I: 2, J: 4, K: 8, A: 1, E: 4, D: 8, C: 8, M: 16, P: 8, Q: 16 };
		const cols = new Map<string, { off: number; code: string; scale: number }>();
		let off = 0;
		for (let i = 1; i <= nf; i++) {
			const m = /^(\d*)([A-Z])/.exec(String(h.get(`TFORM${i}`) ?? '').trim());
			if (!m) {
				return [];
			}
			const rep = m[1] === '' ? 1 : Number(m[1]);
			const width = m[2] === 'X' ? Math.ceil(rep / 8) : rep * (sizes[m[2]] ?? 0);
			const name = String(h.get(`TTYPE${i}`) ?? '').trim().toUpperCase();
			const unit = String(h.get(`TUNIT${i}`) ?? '').trim().toLowerCase();
			const scale = unit === 'arcsec' ? 1 / 3600 : unit === 'arcmin' ? 1 / 60 : unit === 'rad' ? 180 / Math.PI : 1;
			cols.set(name, { off, code: m[2], scale });
			off += width;
		}
		const buf = await this.src.read(hdu.dataOffset, rowLen * rows);
		if (buf.length < rowLen * rows) {
			return [];
		}
		const get = (name: string, row: number): number | undefined => {
			const c = cols.get(name);
			if (!c) {
				return undefined;
			}
			const p = row * rowLen + c.off;
			switch (c.code) {
				case 'E': return buf.readFloatBE(p) * c.scale;
				case 'D': return buf.readDoubleBE(p) * c.scale;
				case 'J': return buf.readInt32BE(p);
				case 'I': return buf.readInt16BE(p);
				case 'B': return buf.readUInt8(p);
				case 'K': return Number(buf.readBigInt64BE(p));
				default: return undefined;
			}
		};
		const beams: Beam[] = [];
		for (let r = 0; r < rows; r++) {
			const bmaj = get('BMAJ', r);
			const bmin = get('BMIN', r);
			if (bmaj === undefined || bmin === undefined) {
				return [];
			}
			beams.push({ bmaj, bmin, bpa: get('BPA', r) ?? 0, chan: get('CHAN', r), pol: get('POL', r) });
		}
		return beams;
	}
}

/** Big-endian FITS bytes -> physical values (BSCALE/BZERO applied, BLANK -> NaN). */
function decode(buf: Buffer, count: number, hdu: Hdu): Float32Array {
	const bitpix = hdu.summary.bitpix;
	const bscale = hnum(hdu.header, 'BSCALE', 1);
	const bzero = hnum(hdu.header, 'BZERO', 0);
	const blankV = hdu.header.get('BLANK');
	const blank = typeof blankV === 'number' && bitpix > 0 ? blankV : undefined;
	const scaled = bscale !== 1 || bzero !== 0;

	// Sources hand out private, aligned buffers, so swapping in place is safe.
	const b = buf;
	const ab = b.buffer as ArrayBuffer;
	const bo = b.byteOffset;

	if (bitpix === -32) {
		b.swap32();
		const out = new Float32Array(ab, bo, count);
		if (scaled) {
			for (let i = 0; i < count; i++) {
				out[i] = out[i] * bscale + bzero;
			}
		}
		return out;
	}
	const out = new Float32Array(count);
	let src: ArrayLike<number> | BigInt64Array;
	switch (bitpix) {
		case 8: src = new Uint8Array(ab, bo, count); break;
		case 16: b.swap16(); src = new Int16Array(ab, bo, count); break;
		case 32: b.swap32(); src = new Int32Array(ab, bo, count); break;
		case 64: b.swap64(); src = new BigInt64Array(ab, bo, count); break;
		case -64: b.swap64(); src = new Float64Array(ab, bo, count); break;
		default: throw new Error(`Unsupported BITPIX ${bitpix}.`);
	}
	if (src instanceof BigInt64Array) {
		for (let i = 0; i < count; i++) {
			const v = Number(src[i]);
			out[i] = v === blank ? NaN : v * bscale + bzero;
		}
	} else {
		for (let i = 0; i < count; i++) {
			const v = src[i];
			out[i] = v === blank ? NaN : v * bscale + bzero;
		}
	}
	return out;
}
