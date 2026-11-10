// Plane statistics, display limits (percentile / zscale) and region statistics.

import { RegionSpec, inRegion } from '../common/protocol';

export interface PlaneStats {
	min: number;
	max: number;
	mean: number;
	std: number;
	nFinite: number;
	nTotal: number;
	/** Sorted subsample of the finite values, used for percentiles. */
	sample: Float32Array;
}

const MAX_SAMPLE = 400000;

export function computeStats(data: Float32Array): PlaneStats {
	const n = data.length;
	const stride = Math.max(1, Math.floor(n / MAX_SAMPLE));
	const buf = new Float32Array(Math.ceil(n / stride));
	let ns = 0;
	let min = Infinity;
	let max = -Infinity;
	let sum = 0;
	let sumsq = 0;
	let cnt = 0;
	for (let i = 0; i < n; i++) {
		const v = data[i];
		if (v !== v || v === Infinity || v === -Infinity) {
			continue;
		}
		if (v < min) { min = v; }
		if (v > max) { max = v; }
		sum += v;
		sumsq += v * v;
		cnt++;
		if (i % stride === 0) {
			buf[ns++] = v;
		}
	}
	const sample = buf.slice(0, ns).sort();
	const mean = cnt ? sum / cnt : NaN;
	const std = cnt ? Math.sqrt(Math.max(0, sumsq / cnt - mean * mean)) : NaN;
	return { min: cnt ? min : NaN, max: cnt ? max : NaN, mean, std, nFinite: cnt, nTotal: n, sample };
}

function quantile(sorted: Float32Array, q: number): number {
	if (sorted.length === 0) {
		return NaN;
	}
	const f = q * (sorted.length - 1);
	const i = Math.floor(f);
	const j = Math.min(sorted.length - 1, i + 1);
	return sorted[i] + (sorted[j] - sorted[i]) * (f - i);
}

/** Central interval containing `pct` percent of the pixels. */
export function percentileLimits(stats: PlaneStats, pct: number): [number, number] {
	const tail = (1 - pct / 100) / 2;
	return [quantile(stats.sample, tail), quantile(stats.sample, 1 - tail)];
}

/** IRAF zscale (contrast 0.25, 2.5-sigma rejection, up to 5 iterations). */
export function zscale(stats: PlaneStats, contrast = 0.25): [number, number] {
	const all = stats.sample;
	if (all.length < 5) {
		return [stats.min, stats.max];
	}
	const n = Math.min(all.length, 1000);
	const s = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		s[i] = all[Math.floor((i * (all.length - 1)) / (n - 1))];
	}
	const zmin = s[0];
	const zmax = s[n - 1];
	const center = (n - 1) / 2;
	const median = n % 2 ? s[center] : (s[center - 0.5] + s[center + 0.5]) / 2;

	const good = new Uint8Array(n).fill(1);
	let ngood = n;
	let slope = 0;
	let intercept = 0;
	const minpix = Math.max(5, Math.floor(n * 0.5));
	for (let iter = 0; iter < 5; iter++) {
		let sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
		for (let i = 0; i < n; i++) {
			if (good[i]) {
				const x = i - center;
				sx += x; sy += s[i]; sxx += x * x; sxy += x * s[i]; m++;
			}
		}
		const den = m * sxx - sx * sx;
		if (m < 2 || den === 0) {
			break;
		}
		slope = (m * sxy - sx * sy) / den;
		intercept = (sy - slope * sx) / m;
		let ss = 0;
		for (let i = 0; i < n; i++) {
			if (good[i]) {
				const r = s[i] - (intercept + slope * (i - center));
				ss += r * r;
			}
		}
		const thresh = 2.5 * Math.sqrt(ss / m);
		let rejected = 0;
		for (let i = 0; i < n; i++) {
			if (good[i] && Math.abs(s[i] - (intercept + slope * (i - center))) > thresh) {
				good[i] = 0;
				rejected++;
			}
		}
		ngood = m - rejected;
		if (rejected === 0 || ngood < minpix) {
			break;
		}
	}
	if (ngood < minpix) {
		return [zmin, zmax];
	}
	const sl = contrast > 0 ? slope / contrast : slope;
	const z1 = Math.max(zmin, median - center * sl);
	const z2 = Math.min(zmax, median + (n - 1 - center) * sl);
	return z2 > z1 ? [z1, z2] : [zmin, zmax];
}

export interface RegionStats {
	npix: number;
	nFinite: number;
	sum: number;
	mean: number;
	median: number;
	std: number;
	rms: number;
	min: number;
	max: number;
	maxPos?: [number, number];
	minPos?: [number, number];
}

export function regionStats(data: Float32Array, nx: number, ny: number, region: RegionSpec): RegionStats {
	const x0 = Math.max(0, region.x0);
	const x1 = Math.min(nx - 1, region.x1);
	const y0 = Math.max(0, region.y0);
	const y1 = Math.min(ny - 1, region.y1);
	const vals: number[] = [];
	let npix = 0;
	let sum = 0;
	let sumsq = 0;
	let min = Infinity;
	let max = -Infinity;
	let minPos: [number, number] | undefined;
	let maxPos: [number, number] | undefined;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			if (!inRegion(region, x, y)) {
				continue;
			}
			npix++;
			const v = data[y * nx + x];
			if (!Number.isFinite(v)) {
				continue;
			}
			vals.push(v);
			sum += v;
			sumsq += v * v;
			if (v < min) { min = v; minPos = [x, y]; }
			if (v > max) { max = v; maxPos = [x, y]; }
		}
	}
	const n = vals.length;
	if (n === 0) {
		return { npix, nFinite: 0, sum: NaN, mean: NaN, median: NaN, std: NaN, rms: NaN, min: NaN, max: NaN };
	}
	const sorted = Float32Array.from(vals).sort();
	const mean = sum / n;
	return {
		npix, nFinite: n, sum, mean,
		median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
		std: n > 1 ? Math.sqrt(Math.max(0, (sumsq - n * mean * mean) / (n - 1))) : 0,
		rms: Math.sqrt(sumsq / n),
		min, max, minPos, maxPos,
	};
}
