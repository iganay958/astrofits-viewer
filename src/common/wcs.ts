// FITS WCS: celestial projections (Calabretta & Greisen 2002, "Paper II"),
// spectral axis conversions (Greisen et al. 2006, "Paper III", linear cases),
// and Stokes / generic linear axes.

import { CardValue } from './protocol';

export type Header = Map<string, CardValue>;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
export const C_MS = 299792458;

export type AxisKind = 'lon' | 'lat' | 'spectral' | 'stokes' | 'linear';

export interface AxisInfo {
	/** 0-based axis index (FITS axis number minus one). */
	index: number;
	n: number;
	ctype: string;
	cunit: string;
	crval: number;
	crpix: number;
	/** Diagonal scale: world units per pixel. */
	cdelt: number;
	kind: AxisKind;
}

export interface SpectralValue {
	/** Value on the native axis, in the axis' own unit. */
	native: number;
	nativeUnit: string;
	nativeType: string;
	freqHz?: number;
	/** Velocities in m/s; present only when a rest frequency is known. */
	vRadio?: number;
	vOptical?: number;
	vRelativistic?: number;
}

export type VelocityConvention = 'radio' | 'optical' | 'relativistic';

function num(h: Header, key: string, dflt: number): number {
	const v = h.get(key);
	return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function str(h: Header, key: string, dflt = ''): string {
	const v = h.get(key);
	return typeof v === 'string' ? v.trim() : dflt;
}

const STOKES: Record<number, string> = {
	1: 'I', 2: 'Q', 3: 'U', 4: 'V',
	[-1]: 'RR', [-2]: 'LL', [-3]: 'RL', [-4]: 'LR',
	[-5]: 'XX', [-6]: 'YY', [-7]: 'XY', [-8]: 'YX',
};

export function stokesLabel(v: number): string {
	return STOKES[Math.round(v)] ?? String(v);
}

const SPECTRAL_TYPES = ['FREQ', 'VRAD', 'VOPT', 'VELO', 'FELO', 'WAVE', 'AWAV', 'ZOPT', 'ENER', 'WAVN', 'BETA'];

function axisKind(ctype: string): AxisKind {
	const c = ctype.toUpperCase();
	const head = c.split('-')[0];
	if (head === 'RA' || /^.LON$/.test(head) || /^..LN$/.test(head)) {
		return 'lon';
	}
	if (head === 'DEC' || /^.LAT$/.test(head) || /^..LT$/.test(head)) {
		return 'lat';
	}
	if (head === 'STOKES') {
		return 'stokes';
	}
	if (SPECTRAL_TYPES.includes(head.slice(0, 4))) {
		return 'spectral';
	}
	return 'linear';
}

const FREQ_UNITS: Record<string, number> = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9, thz: 1e12 };
const VEL_UNITS: Record<string, number> = { 'm/s': 1, 'm s-1': 1, 'km/s': 1e3, 'km s-1': 1e3, 'cm/s': 1e-2 };
const LEN_UNITS: Record<string, number> = {
	m: 1, cm: 1e-2, mm: 1e-3, um: 1e-6, micron: 1e-6, nm: 1e-9, angstrom: 1e-10, a: 1e-10,
};
const ANGLE_UNITS: Record<string, number> = { deg: 1, arcmin: 1 / 60, arcsec: 1 / 3600, mas: 1 / 3.6e6, rad: R2D };

function unitFactor(table: Record<string, number>, unit: string): number {
	return table[unit.trim().toLowerCase()] ?? 1;
}

interface Celestial {
	lonAxis: number;
	latAxis: number;
	proj: string;
	/** Intermediate world coordinates (deg) = m * (p - crpix), rows (lon, lat), columns (axis1, axis2). */
	m: [number, number, number, number];
	crpix: [number, number];
	alphaP: number;
	deltaP: number;
	phiP: number;
	pv1: number;
	pv2: number;
	system: string;
}

export class Wcs {
	readonly axes: AxisInfo[] = [];
	readonly celestial?: Celestial;
	readonly spectralAxis?: AxisInfo;
	readonly restFreq?: number;
	readonly specsys: string;
	/** AIPS VELREF: >256 radio, otherwise optical. */
	private readonly velref: number;
	readonly unsupportedProjection?: string;

	constructor(private readonly h: Header) {
		const naxis = Math.max(num(h, 'NAXIS', 0), num(h, 'WCSAXES', 0));
		const hasCd = [...h.keys()].some(k => /^CD\d+_\d+$/.test(k));
		const hasPc = [...h.keys()].some(k => /^PC\d+_\d+$/.test(k));
		for (let i = 0; i < naxis; i++) {
			const a = i + 1;
			const ctype = str(h, `CTYPE${a}`);
			let cdelt = num(h, `CDELT${a}`, 1);
			if (hasCd) {
				cdelt = num(h, `CD${a}_${a}`, 0) || cdelt;
			} else if (hasPc) {
				cdelt *= num(h, `PC${a}_${a}`, 1);
			}
			this.axes.push({
				index: i,
				n: num(h, `NAXIS${a}`, 1),
				ctype,
				cunit: str(h, `CUNIT${a}`),
				crval: num(h, `CRVAL${a}`, 0),
				crpix: num(h, `CRPIX${a}`, 0),
				cdelt,
				kind: axisKind(ctype),
			});
		}
		this.spectralAxis = this.axes.find(a => a.kind === 'spectral');
		const rf = num(h, 'RESTFRQ', NaN);
		const rf2 = Number.isFinite(rf) ? rf : num(h, 'RESTFREQ', NaN);
		this.restFreq = Number.isFinite(rf2) && rf2 > 0 ? rf2 : undefined;
		this.specsys = str(h, 'SPECSYS');
		this.velref = num(h, 'VELREF', 0);

		const lon = this.axes.find(a => a.kind === 'lon');
		const lat = this.axes.find(a => a.kind === 'lat');
		if (lon && lat && lon.index < 2 && lat.index < 2) {
			const c = this.buildCelestial(lon, lat, hasCd, hasPc);
			if (typeof c === 'string') {
				this.unsupportedProjection = c;
			} else {
				this.celestial = c;
			}
		}
	}

	private buildCelestial(lon: AxisInfo, lat: AxisInfo, hasCd: boolean, hasPc: boolean): Celestial | string {
		const h = this.h;
		const proj = (lon.ctype.split('-').pop() ?? '').toUpperCase() || 'CAR';
		const code = lon.ctype.length > 5 && lon.ctype.includes('-') ? proj : 'CAR';
		const supported = ['TAN', 'SIN', 'NCP', 'ARC', 'STG', 'ZEA', 'CAR', 'CEA', 'MER', 'SFL', 'GLS', 'AIT'];
		if (!supported.includes(code)) {
			return code;
		}
		const la = lon.index + 1;
		const ba = lat.index + 1;
		const cdLon = num(h, `CDELT${la}`, 1);
		const cdLat = num(h, `CDELT${ba}`, 1);
		const el = (i: number, j: number): number => {
			if (hasCd) {
				return num(h, `CD${i}_${j}`, 0);
			}
			const cdi = i === la ? cdLon : cdLat;
			if (hasPc) {
				return cdi * num(h, `PC${i}_${j}`, i === j ? 1 : 0);
			}
			const rho = num(h, `CROTA${ba}`, num(h, `CROTA${la}`, 0)) * D2R;
			if (rho === 0) {
				return i === j ? cdi : 0;
			}
			const cs = Math.cos(rho);
			const sn = Math.sin(rho);
			if (i === la) {
				return j === la ? cdLon * cs : -cdLat * sn;
			}
			return j === la ? cdLon * sn : cdLat * cs;
		};
		const m: [number, number, number, number] = [el(la, 1), el(la, 2), el(ba, 1), el(ba, 2)];

		const zenithal = ['TAN', 'SIN', 'NCP', 'ARC', 'STG', 'ZEA'].includes(code);
		const theta0 = zenithal ? 90 : 0;
		const alpha0 = lon.crval;
		const delta0 = lat.crval;
		const phiP = num(h, 'LONPOLE', num(h, `PV${la}_3`, delta0 >= theta0 ? 0 : 180));
		const latPole = num(h, 'LATPOLE', num(h, `PV${la}_4`, 90));

		let alphaP: number;
		let deltaP: number;
		if (zenithal) {
			alphaP = alpha0;
			deltaP = delta0;
		} else {
			// Paper II eqs. 8-10 with (phi0, theta0) = (0, 0).
			const sp = Math.sin(phiP * D2R);
			const cp = Math.cos(phiP * D2R);
			const base = Math.atan2(0, cp) * R2D;
			const ratio = Math.sin(delta0 * D2R) / Math.sqrt(Math.max(1e-300, 1 - sp * sp));
			const ac = Math.acos(Math.max(-1, Math.min(1, ratio))) * R2D;
			const tol = 1e-9;
			const cands = [base + ac, base - ac]
				.map(d => (d > 180 ? d - 360 : d < -180 ? d + 360 : d))
				.filter(d => Math.abs(d) <= 90 + tol)
				.map(d => Math.max(-90, Math.min(90, d)));
			if (cands.length === 0) {
				return code;
			}
			cands.sort((a, b) => Math.abs(a - latPole) - Math.abs(b - latPole));
			deltaP = cands[0];
			if (Math.abs(deltaP - 90) < tol) {
				alphaP = alpha0 + phiP - 180;
			} else if (Math.abs(deltaP + 90) < tol) {
				alphaP = alpha0 - phiP;
			} else {
				const cd0 = Math.cos(delta0 * D2R);
				const sdp = Math.sin(deltaP * D2R);
				const cdp = Math.cos(deltaP * D2R);
				alphaP = alpha0 - Math.atan2(sp / cd0, (0 - sdp * Math.sin(delta0 * D2R)) / (cdp * cd0)) * R2D;
			}
		}

		let pv1 = num(h, `PV${ba}_1`, code === 'CEA' ? 1 : 0);
		let pv2 = num(h, `PV${ba}_2`, 0);
		if (code === 'NCP') {
			// AIPS NCP is SIN with xi = 0, eta = cot(delta0).
			pv1 = 0;
			pv2 = 1 / Math.tan(delta0 * D2R);
		}

		const head = lon.ctype.split('-')[0].toUpperCase();
		let system: string;
		if (head === 'RA') {
			const equinox = num(h, 'EQUINOX', num(h, 'EPOCH', NaN));
			system = str(h, 'RADESYS', str(h, 'RADECSYS')) ||
				(Number.isFinite(equinox) ? (equinox < 1984 ? 'FK4' : 'FK5') : 'ICRS');
			if (Number.isFinite(equinox) && system !== 'ICRS') {
				system += ` ${system === 'FK4' ? 'B' : 'J'}${equinox}`;
			}
		} else if (head === 'GLON') {
			system = 'Galactic';
		} else if (head === 'ELON') {
			system = 'Ecliptic';
		} else if (head === 'SLON') {
			system = 'Supergalactic';
		} else {
			system = head;
		}

		return {
			lonAxis: lon.index, latAxis: lat.index, proj: code, m,
			crpix: [num(h, 'CRPIX1', 0), num(h, 'CRPIX2', 0)],
			alphaP, deltaP, phiP, pv1, pv2, system,
		};
	}

	/** True when longitude is right ascension (sexagesimal hours are appropriate). */
	get isEquatorial(): boolean {
		return this.axes.some(a => a.kind === 'lon' && a.ctype.toUpperCase().startsWith('RA'));
	}

	/** Pixel area in square degrees, when a celestial WCS exists. */
	get pixelAreaDeg2(): number | undefined {
		const c = this.celestial;
		return c ? Math.abs(c.m[0] * c.m[3] - c.m[1] * c.m[2]) : undefined;
	}

	/**
	 * FITS pixel coordinates on axes 1 and 2 (1-based, pixel centres are integers)
	 * to celestial (lon, lat) in degrees. Returns null outside the projection.
	 */
	pixToSky(p1: number, p2: number): { lon: number; lat: number } | null {
		const c = this.celestial;
		if (!c) {
			return null;
		}
		const d1 = p1 - c.crpix[0];
		const d2 = p2 - c.crpix[1];
		const x = c.m[0] * d1 + c.m[1] * d2;
		const y = c.m[2] * d1 + c.m[3] * d2;
		let phi: number;
		let theta: number;
		switch (c.proj) {
			case 'TAN': case 'ARC': case 'STG': case 'ZEA': {
				const r = Math.hypot(x, y);
				phi = r === 0 ? 0 : Math.atan2(x, -y);
				if (c.proj === 'TAN') {
					theta = Math.atan2(R2D, r);
				} else if (c.proj === 'ARC') {
					theta = (90 - r) * D2R;
				} else if (c.proj === 'STG') {
					theta = (90 - 2 * Math.atan(r * D2R / 2) * R2D) * D2R;
				} else {
					const s = r * D2R / 2;
					if (s > 1) {
						return null;
					}
					theta = (90 - 2 * Math.asin(s) * R2D) * D2R;
				}
				break;
			}
			case 'SIN': case 'NCP': {
				const xr = x * D2R;
				const yr = y * D2R;
				const xi = c.pv1;
				const eta = c.pv2;
				if (xi === 0 && eta === 0) {
					const r = Math.hypot(xr, yr);
					if (r > 1) {
						return null;
					}
					phi = r === 0 ? 0 : Math.atan2(xr, -yr);
					theta = Math.acos(r);
				} else {
					const a = xi * xi + eta * eta + 1;
					const b = xi * (xr - xi) + eta * (yr - eta);
					const cc = (xr - xi) ** 2 + (yr - eta) ** 2 - 1;
					const disc = b * b - a * cc;
					if (disc < 0) {
						return null;
					}
					const sq = Math.sqrt(disc);
					let st = (-b + sq) / a;
					if (st > 1) {
						st = (-b - sq) / a;
					}
					if (st < -1 || st > 1) {
						return null;
					}
					theta = Math.asin(st);
					phi = Math.atan2(xr - xi * (1 - st), -(yr - eta * (1 - st)));
				}
				break;
			}
			case 'CAR':
				phi = x * D2R;
				theta = y * D2R;
				break;
			case 'CEA': {
				const s = c.pv1 * y * D2R;
				if (Math.abs(s) > 1) {
					return null;
				}
				phi = x * D2R;
				theta = Math.asin(s);
				break;
			}
			case 'MER':
				phi = x * D2R;
				theta = 2 * Math.atan(Math.exp(y * D2R)) - Math.PI / 2;
				break;
			case 'SFL': case 'GLS': {
				theta = y * D2R;
				const ct = Math.cos(theta);
				if (ct === 0) {
					return null;
				}
				phi = (x / ct) * D2R;
				break;
			}
			case 'AIT': {
				const xr = x * D2R;
				const yr = y * D2R;
				const z2 = 1 - (xr / 4) ** 2 - (yr / 2) ** 2;
				if (z2 < 0.5) {
					return null;
				}
				const z = Math.sqrt(z2);
				const s = yr * z;
				if (Math.abs(s) > 1) {
					return null;
				}
				phi = 2 * Math.atan2(z * xr / 2, 2 * z2 - 1);
				theta = Math.asin(s);
				break;
			}
			default:
				return null;
		}
		if (Math.abs(theta) > Math.PI / 2 + 1e-12 || Math.abs(phi) > Math.PI + 1e-9) {
			return null;
		}
		const dphi = phi - c.phiP * D2R;
		const st = Math.sin(theta);
		const ct = Math.cos(theta);
		const sdp = Math.sin(c.deltaP * D2R);
		const cdp = Math.cos(c.deltaP * D2R);
		let lon = c.alphaP + Math.atan2(-ct * Math.sin(dphi), st * cdp - ct * sdp * Math.cos(dphi)) * R2D;
		const lat = Math.asin(Math.max(-1, Math.min(1, st * sdp + ct * cdp * Math.cos(dphi)))) * R2D;
		lon = ((lon % 360) + 360) % 360;
		return { lon, lat };
	}

	/**
	 * Pixel-space offset (dx, dy) for a small sky offset of `east` and `north`
	 * degrees at the reference pixel. Used to draw the beam.
	 */
	skyOffsetToPix(east: number, north: number): [number, number] | null {
		const c = this.celestial;
		if (!c) {
			return null;
		}
		const det = c.m[0] * c.m[3] - c.m[1] * c.m[2];
		if (det === 0) {
			return null;
		}
		return [(c.m[3] * east - c.m[1] * north) / det, (-c.m[2] * east + c.m[0] * north) / det];
	}

	/** World coordinate of a non-celestial axis at FITS pixel coordinate p (1-based). */
	linearWorld(axis: AxisInfo, p: number): number {
		return axis.crval + axis.cdelt * (p - axis.crpix);
	}

	/** Spectral coordinate at FITS pixel p (1-based) along the spectral axis. */
	spectralAt(p: number, axis: AxisInfo | undefined = this.spectralAxis): SpectralValue | null {
		if (!axis) {
			return null;
		}
		const native = this.linearWorld(axis, p);
		const type = axis.ctype.toUpperCase().slice(0, 4);
		const out: SpectralValue = { native, nativeUnit: axis.cunit, nativeType: type };
		const f0 = this.restFreq;
		let freq: number | undefined;
		if (type === 'FREQ') {
			out.nativeUnit = axis.cunit || 'Hz';
			freq = native * unitFactor(FREQ_UNITS, out.nativeUnit);
		} else if (type === 'WAVE' || type === 'AWAV') {
			out.nativeUnit = axis.cunit || 'm';
			const lam = native * unitFactor(LEN_UNITS, out.nativeUnit);
			freq = lam > 0 ? C_MS / lam : undefined;
		} else if (type === 'VRAD' || type === 'VOPT' || type === 'VELO' || type === 'FELO') {
			out.nativeUnit = axis.cunit || 'm/s';
			const v = native * unitFactor(VEL_UNITS, out.nativeUnit);
			let conv: VelocityConvention;
			if (type === 'VRAD') {
				conv = 'radio';
			} else if (type === 'VOPT' || type === 'FELO') {
				conv = 'optical';
			} else if (axis.ctype.length > 4 && this.velref !== 0) {
				// AIPS-style VELO-LSR etc.: VELREF tells the convention.
				conv = this.velref > 256 ? 'radio' : 'optical';
			} else {
				conv = 'relativistic';
			}
			if (f0) {
				const beta = v / C_MS;
				if (conv === 'radio') {
					freq = f0 * (1 - beta);
				} else if (conv === 'optical') {
					freq = f0 / (1 + beta);
				} else {
					freq = f0 * Math.sqrt((1 - beta) / (1 + beta));
				}
			} else {
				// No rest frequency: only the native velocity is known.
				if (conv === 'radio') { out.vRadio = v; }
				if (conv === 'optical') { out.vOptical = v; }
				if (conv === 'relativistic') { out.vRelativistic = v; }
			}
		}
		if (freq !== undefined && Number.isFinite(freq)) {
			out.freqHz = freq;
			if (f0) {
				const r = freq / f0;
				out.vRadio = C_MS * (1 - r);
				out.vOptical = C_MS * (1 / r - 1);
				out.vRelativistic = C_MS * (1 - r * r) / (1 + r * r);
			}
		}
		return out;
	}
}

// ---- formatting ----

function sexagesimal(value: number, decimals: number, signed: boolean): string {
	const sign = value < 0 ? '-' : signed ? '+' : '';
	const scale = 10 ** decimals;
	let total = Math.round(Math.abs(value) * 3600 * scale);
	const sec = total % (60 * scale);
	total = (total - sec) / (60 * scale);
	const min = total % 60;
	const deg = (total - min) / 60;
	const s = (sec / scale).toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0');
	return `${sign}${String(deg).padStart(2, '0')}:${String(min).padStart(2, '0')}:${s}`;
}

/** Right ascension in degrees -> hh:mm:ss.ssss */
export function formatRa(deg: number, decimals = 4): string {
	let h = (((deg % 360) + 360) % 360) / 15;
	if (h >= 24 - 0.5 / 3600 / 10 ** decimals) {
		h = 0;
	}
	return sexagesimal(h, decimals, false);
}

/** Declination in degrees -> ±dd:mm:ss.sss */
export function formatDec(deg: number, decimals = 3): string {
	return sexagesimal(deg, decimals, true);
}

export function formatFreq(hz: number): string {
	const a = Math.abs(hz);
	if (a >= 1e9) { return `${(hz / 1e9).toFixed(6)} GHz`; }
	if (a >= 1e6) { return `${(hz / 1e6).toFixed(6)} MHz`; }
	if (a >= 1e3) { return `${(hz / 1e3).toFixed(6)} kHz`; }
	return `${hz.toFixed(3)} Hz`;
}

export function formatVelocity(ms: number): string {
	return `${(ms / 1e3).toFixed(3)} km/s`;
}

/** Angle in degrees -> a compact human string (deg, arcmin, arcsec, mas). */
export function formatAngle(deg: number): string {
	// Slightly generous thresholds so that e.g. exactly 1 arcsec is not printed as 1000 mas.
	const a = Math.abs(deg) * (1 + 1e-9);
	if (a >= 1) { return `${deg.toPrecision(5)}°`; }
	if (a >= 1 / 60) { return `${(deg * 60).toPrecision(5)}′`; }
	if (a >= 1 / 3600) { return `${(deg * 3600).toPrecision(5)}″`; }
	return `${(deg * 3.6e6).toPrecision(5)} mas`;
}

export function angleUnitToDeg(unit: string): number {
	return unitFactor(ANGLE_UNITS, unit);
}

export function headerFromCards(cards: { key: string; value: CardValue }[]): Header {
	const h: Header = new Map();
	for (const c of cards) {
		if (c.key && c.key !== 'COMMENT' && c.key !== 'HISTORY' && !h.has(c.key)) {
			h.set(c.key, c.value);
		}
	}
	return h;
}
