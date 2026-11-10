import { Beam, HduSummary, HeaderCard, RegionSpec, ToHost, ToWebview } from '../common/protocol';
import {
	AxisInfo, Header, SpectralValue, VelocityConvention, Wcs, formatAngle, formatDec, formatFreq, formatRa,
	formatVelocity, headerFromCards, stokesLabel,
} from '../common/wcs';
import { COLORMAPS, LUT_SIZE, STRETCHES, Stretch, buildLut } from './colormaps';
import { PlaneStats, computeStats, percentileLimits, regionStats, zscale } from './scaling';
import { ProfilePlot } from './profilePlot';

declare function acquireVsCodeApi(): { postMessage(msg: ToHost): void };
const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------- DOM

document.getElementById('app')!.innerHTML = `
<div class="toolbar">
	<label>HDU <select id="hdu"></select></label>
	<label>Stretch <select id="stretch"></select></label>
	<label>Colormap <select id="cmap"></select></label>
	<label class="check"><input type="checkbox" id="invert"> Invert</label>
	<span class="sep"></span>
	<label>Limits <select id="limits"></select></label>
	<input id="lo" type="number" step="any" title="Low display limit">
	<input id="hi" type="number" step="any" title="High display limit">
	<label class="check" title="Keep these limits when the channel changes"><input type="checkbox" id="lock"> Lock</label>
	<span class="sep"></span>
	<span class="group" id="tools">
		<button data-tool="pan" class="active" title="Drag to pan, click a pixel to pick it">Pan</button>
		<button data-tool="rect" title="Drag to draw a rectangular region">Rect</button>
		<button data-tool="ellipse" title="Drag to draw an elliptical region">Ellipse</button>
	</span>
	<button id="clear-region" title="Remove the region">Clear</button>
	<span class="sep"></span>
	<span class="group">
		<button id="zoom-out" title="Zoom out (-)">−</button>
		<button id="zoom-in" title="Zoom in (+)">+</button>
		<button id="zoom-fit" title="Fit image to window (0)">Fit</button>
		<button id="zoom-one" title="One image pixel per screen pixel">1:1</button>
	</span>
	<label class="check"><input type="checkbox" id="beam" checked> Beam</label>
	<span class="spacer"></span>
	<button id="toggle-side" title="Show or hide the side panel">Panel</button>
</div>
<div class="axes" id="axes" hidden></div>
<div class="main">
	<div class="view" id="view" tabindex="0">
		<canvas id="img"></canvas>
		<canvas id="overlay"></canvas>
		<div class="message" id="message" hidden></div>
		<div class="colorbar" id="colorbar">
			<span id="cb-lo"></span><canvas id="cbar" width="256" height="1"></canvas><span id="cb-hi"></span><span id="cb-unit"></span>
		</div>
	</div>
	<div class="side" id="side">
		<div class="tabs" id="tabs">
			<button data-tab="header" class="active">Header</button>
			<button data-tab="info">Info</button>
			<button data-tab="analysis">Analysis</button>
		</div>
		<div class="tab" id="tab-header">
			<input id="search" type="search" placeholder="Search keyword, value or comment" spellcheck="false">
			<div class="muted" id="search-count"></div>
			<div class="scroll"><table class="header" id="header-table"></table></div>
		</div>
		<div class="tab scroll" id="tab-info" hidden></div>
		<div class="tab scroll" id="tab-analysis" hidden>
			<h3>Region statistics</h3>
			<div id="region-stats"></div>
			<h3 id="profile-heading">Profile</h3>
			<div class="profile-controls">
				<select id="profile-x" title="Profile x axis"></select>
				<select id="velconv" title="Velocity convention">
					<option value="radio">Radio velocity</option>
					<option value="optical">Optical velocity</option>
					<option value="relativistic">Relativistic velocity</option>
				</select>
			</div>
			<div class="muted" id="profile-title"></div>
			<div id="profile"></div>
		</div>
	</div>
</div>
<div class="status">
	<span id="st-pix" class="cell"></span>
	<span id="st-val" class="cell"></span>
	<span id="st-sky" class="cell"></span>
	<span id="st-spec" class="cell"></span>
	<span class="spacer"></span>
	<span id="st-zoom" class="cell"></span>
	<span id="st-err" class="cell error"></span>
</div>`;

function $<T extends HTMLElement = HTMLElement>(id: string): T {
	return document.getElementById(id) as T;
}

const hduSel = $<HTMLSelectElement>('hdu');
const stretchSel = $<HTMLSelectElement>('stretch');
const cmapSel = $<HTMLSelectElement>('cmap');
const limitsSel = $<HTMLSelectElement>('limits');
const loInput = $<HTMLInputElement>('lo');
const hiInput = $<HTMLInputElement>('hi');
const invertChk = $<HTMLInputElement>('invert');
const lockChk = $<HTMLInputElement>('lock');
const beamChk = $<HTMLInputElement>('beam');
const viewEl = $('view');
const imgCanvas = $<HTMLCanvasElement>('img');
const ovCanvas = $<HTMLCanvasElement>('overlay');
const messageEl = $('message');
const searchInput = $<HTMLInputElement>('search');
const profileXSel = $<HTMLSelectElement>('profile-x');
const velconvSel = $<HTMLSelectElement>('velconv');

const LIMIT_MODES: [string, string][] = [
	['minmax', 'Min / max'], ['99.9', '99.9%'], ['99.5', '99.5%'], ['99', '99%'], ['98', '98%'],
	['95', '95%'], ['90', '90%'], ['zscale', 'zscale'], ['custom', 'Custom'],
];
for (const s of STRETCHES) { stretchSel.add(new Option(s, s)); }
for (const c of COLORMAPS) { cmapSel.add(new Option(c, c)); }
for (const [v, label] of LIMIT_MODES) { limitsSel.add(new Option(label, v)); }
cmapSel.value = 'inferno';
limitsSel.value = '99.5';

// ---------------------------------------------------------------- state

interface Plane { nx: number; ny: number; data: Float32Array; indices: number[] }
interface Profile { axis: number; values: Float32Array; npix: number; region: RegionSpec }

let fileName = '';
let fileSize = 0;
let hdus: HduSummary[] = [];
let curHdu = -1;
let cards: HeaderCard[] = [];
let header: Header = new Map();
let wcs = new Wcs(header);
let beams: Beam[] = [];
let indices: number[] = [];
let plane: Plane | undefined;
let stats: PlaneStats | undefined;
let lo = 0;
let hi = 1;
let lut = buildLut(cmapSel.value, 'linear', false);
let needFit = true;
let tool: 'pan' | 'rect' | 'ellipse' = 'pan';
let region: RegionSpec | undefined;
let profile: Profile | undefined;
let velConv: VelocityConvention = 'radio';
const view = { scale: 1, ox: 0, oy: 0 };
let cursor: { x: number; y: number } | undefined;

let seq = 0;
let planeReq = 0;
let planeInFlight = false;
let planeQueued = false;
let profileReq = 0;

const plot = new ProfilePlot($('profile'));

// ---------------------------------------------------------------- formatting

function fmt(v: number, digits = 6): string {
	if (!Number.isFinite(v)) {
		return Number.isNaN(v) ? 'NaN' : String(v);
	}
	const a = Math.abs(v);
	if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
		return v.toExponential(Math.max(1, digits - 2));
	}
	return String(Number(v.toPrecision(digits)));
}

function unit(): string {
	const u = header.get('BUNIT');
	return typeof u === 'string' ? u.trim() : '';
}

/** Value with its brightness unit; small Jy and K values get an SI prefix. */
function fmtUnit(v: number, u = unit()): string {
	if (!u || !Number.isFinite(v)) {
		return fmt(v);
	}
	const a = Math.abs(v);
	if (/^(Jy|K)(?![a-zA-Z])/.test(u) && a > 0 && a < 1) {
		const [f, p] = a >= 1e-3 ? [1e3, 'm'] : a >= 1e-6 ? [1e6, 'µ'] : [1e9, 'n'];
		return `${fmt(v * f, 5)} ${p}${u}`;
	}
	return `${fmt(v)} ${u}`;
}

function fmtBytes(n: number): string {
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let i = 0;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${i ? n.toFixed(1) : n} ${units[i]}`;
}

function esc(s: string): string {
	return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function velocity(sv: SpectralValue): number | undefined {
	return velConv === 'radio' ? sv.vRadio : velConv === 'optical' ? sv.vOptical : sv.vRelativistic;
}

function fmtSky(lon: number, lat: number): string {
	if (wcs.isEquatorial) {
		return `${formatRa(lon)}  ${formatDec(lat)}`;
	}
	return `${lon.toFixed(6)}°  ${lat >= 0 ? '+' : ''}${lat.toFixed(6)}°`;
}

function axisWorldLabel(axis: AxisInfo, k: number): string {
	const p = k + 1;
	if (axis.kind === 'spectral') {
		const sv = wcs.spectralAt(p, axis);
		if (sv) {
			const parts: string[] = [];
			if (sv.freqHz !== undefined) {
				parts.push(formatFreq(sv.freqHz));
			}
			const v = velocity(sv);
			if (v !== undefined) {
				parts.push(formatVelocity(v));
			}
			if (parts.length === 0) {
				parts.push(`${fmt(sv.native, 9)} ${sv.nativeUnit}`);
			}
			return parts.join('  ·  ');
		}
	}
	const w = wcs.linearWorld(axis, p);
	if (axis.kind === 'stokes') {
		return `Stokes ${stokesLabel(w)}`;
	}
	return axis.ctype ? `${fmt(w, 9)} ${axis.cunit}`.trim() : '';
}

// ---------------------------------------------------------------- messaging

function post(msg: ToHost): void {
	vscode.postMessage(msg);
}

function toF32(x: unknown): Float32Array {
	if (x instanceof Float32Array) {
		return x;
	}
	if (x instanceof ArrayBuffer) {
		return new Float32Array(x);
	}
	return Float32Array.from(Object.values(x as Record<string, number>));
}

function showError(text: string): void {
	const el = $('st-err');
	el.textContent = text;
	if (text) {
		setTimeout(() => {
			if (el.textContent === text) {
				el.textContent = '';
			}
		}, 8000);
	}
}

window.addEventListener('message', (e: MessageEvent<ToWebview>) => {
	const msg = e.data;
	switch (msg.type) {
		case 'init': {
			fileName = msg.fileName;
			fileSize = msg.fileSize;
			hdus = msg.hdus;
			hduSel.innerHTML = '';
			for (const h of hdus) {
				const dims = h.shape.length ? h.shape.join(' × ') : 'no data';
				hduSel.add(new Option(`${h.index}: ${h.name} (${h.kind}, ${dims})`, String(h.index)));
			}
			const first = hdus.find(h => h.displayable) ?? hdus[0];
			selectHdu(first.index);
			break;
		}
		case 'hdu':
			if (msg.hdu === curHdu) {
				onHdu(msg.cards, msg.beams);
			}
			break;
		case 'plane':
			if (msg.reqId !== planeReq) {
				break;
			}
			planeInFlight = false;
			if (msg.hdu === curHdu) {
				onPlane({ nx: msg.nx, ny: msg.ny, data: toF32(msg.data), indices: msg.indices });
			}
			if (planeQueued) {
				planeQueued = false;
				requestPlane();
			}
			break;
		case 'profile':
			if (msg.reqId === profileReq && msg.hdu === curHdu) {
				profile = { axis: msg.axis, values: toF32(msg.values), npix: msg.npix, region: msg.region };
				updateProfile();
			}
			break;
		case 'error':
			if (msg.reqId === planeReq) {
				planeInFlight = false;
				if (!plane) {
					showMessage(msg.message);
				}
			}
			showError(msg.message);
			break;
	}
});

// ---------------------------------------------------------------- HDU / plane loading

function selectHdu(index: number): void {
	curHdu = index;
	hduSel.value = String(index);
	plane = undefined;
	stats = undefined;
	region = undefined;
	profile = undefined;
	needFit = true;
	planeInFlight = false;
	planeQueued = false;
	post({ type: 'selectHdu', hdu: index });
}

function showMessage(text: string): void {
	messageEl.textContent = text;
	messageEl.hidden = !text;
	$('colorbar').hidden = !!text;
}

function profileAxis(): AxisInfo | undefined {
	const sp = wcs.spectralAxis;
	if (sp && sp.index >= 2 && sp.n > 1) {
		return sp;
	}
	return wcs.axes.find(a => a.index >= 2 && a.n > 1);
}

function onHdu(newCards: HeaderCard[], newBeams: Beam[]): void {
	cards = newCards;
	header = headerFromCards(cards);
	wcs = new Wcs(header);
	beams = newBeams;
	const summary = hdus[curHdu];
	indices = summary.shape.slice(2).map(() => 0);
	const spType = wcs.spectralAxis?.ctype.toUpperCase().slice(0, 4);
	velConv = spType === 'VOPT' || spType === 'FELO' ? 'optical' : spType === 'VELO' && !header.has('VELREF') ? 'relativistic' : 'radio';
	velconvSel.value = velConv;

	renderHeaderTable();
	buildAxisBar();
	buildProfileXOptions();
	updateRegionPanel();
	updateProfile();
	if (summary.displayable) {
		showMessage('Loading…');
		requestPlane();
	} else {
		const why: Record<string, string> = {
			bintable: 'This HDU is a binary table. Its header is shown in the side panel.',
			table: 'This HDU is an ASCII table. Its header is shown in the side panel.',
			compressed: 'This HDU is a tile-compressed image (fpack), which is not supported yet. Its header is shown in the side panel.',
			empty: 'This HDU has no data. Its header is shown in the side panel.',
			unknown: 'This HDU type cannot be displayed. Its header is shown in the side panel.',
		};
		showMessage(why[summary.kind] ?? why.unknown);
		invalidate();
	}
	renderInfo();
}

function requestPlane(): void {
	if (planeInFlight) {
		planeQueued = true;
		return;
	}
	planeInFlight = true;
	planeReq = ++seq;
	post({ type: 'getPlane', reqId: planeReq, hdu: curHdu, indices: indices.slice() });
}

function onPlane(p: Plane): void {
	plane = p;
	stats = computeStats(p.data);
	showMessage('');
	if (!(lockChk.checked && limitsReady)) {
		applyLimitMode();
	}
	limitsReady = true;
	if (needFit) {
		needFit = false;
		resizeCanvases();
		fitView();
	}
	updateColorbar();
	updateRegionPanel();
	renderInfo();
	updateCursorReadout();
	invalidate();
}

let limitsReady = false;

function applyLimitMode(): void {
	if (!stats) {
		return;
	}
	const mode = limitsSel.value;
	if (mode === 'custom') {
		return;
	}
	let range: [number, number];
	if (mode === 'minmax') {
		range = [stats.min, stats.max];
	} else if (mode === 'zscale') {
		range = zscale(stats);
	} else {
		range = percentileLimits(stats, Number(mode));
	}
	if (!Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
		range = [0, 1];
	}
	if (range[0] === range[1]) {
		range = [stats.min, stats.max];
	}
	[lo, hi] = range;
	loInput.value = fmt(lo);
	hiInput.value = fmt(hi);
}

// ---------------------------------------------------------------- header table

function renderHeaderTable(): void {
	const q = searchInput.value.trim().toLowerCase();
	const rows: string[] = [];
	let shown = 0;
	for (const c of cards) {
		if (q && !c.raw.toLowerCase().includes(q)) {
			continue;
		}
		shown++;
		if (c.value === null) {
			rows.push(`<tr class="commentary"><td class="k">${esc(c.key)}</td><td colspan="2">${esc(c.comment)}</td></tr>`);
		} else {
			const v = typeof c.value === 'boolean' ? (c.value ? 'T' : 'F') : String(c.value);
			const cls = typeof c.value === 'string' ? 'v s' : 'v';
			rows.push(`<tr><td class="k">${esc(c.key)}</td><td class="${cls}">${esc(v)}</td><td class="c">${esc(c.comment)}</td></tr>`);
		}
	}
	$('header-table').innerHTML = rows.join('');
	$('search-count').textContent = q ? `${shown} of ${cards.length} cards` : `${cards.length} cards`;
}
searchInput.addEventListener('input', renderHeaderTable);

// ---------------------------------------------------------------- axis sliders

function buildAxisBar(): void {
	const bar = $('axes');
	bar.innerHTML = '';
	const extra = wcs.axes.filter(a => a.index >= 2 && a.n > 1);
	// Axes beyond the header's WCS description still need sliders.
	const shape = hdus[curHdu].shape;
	for (let i = 2; i < shape.length; i++) {
		if (shape[i] > 1 && !extra.some(a => a.index === i)) {
			extra.push({ index: i, n: shape[i], ctype: '', cunit: '', crval: 0, crpix: 0, cdelt: 1, kind: 'linear' });
		}
	}
	bar.hidden = extra.length === 0 || !hdus[curHdu].displayable;
	for (const axis of extra) {
		const row = document.createElement('div');
		row.className = 'axis';
		row.dataset.axis = String(axis.index);
		const name = axis.ctype || `Axis ${axis.index + 1}`;
		row.innerHTML = `<span class="name" title="Axis ${axis.index + 1}">${esc(name)}</span>
			<button class="step" data-d="-1" title="Previous">◀</button>
			<input type="range" min="0" max="${axis.n - 1}" value="0">
			<button class="step" data-d="1" title="Next">▶</button>
			<input type="number" min="0" max="${axis.n - 1}" value="0" title="0-based index">
			<span class="muted">/ ${axis.n - 1}</span>
			<span class="world"></span>`;
		const range = row.querySelector<HTMLInputElement>('input[type=range]')!;
		const numInput = row.querySelector<HTMLInputElement>('input[type=number]')!;
		range.addEventListener('input', () => setIndex(axis, Number(range.value)));
		numInput.addEventListener('change', () => setIndex(axis, Number(numInput.value)));
		row.querySelectorAll<HTMLButtonElement>('button.step').forEach(b =>
			b.addEventListener('click', () => setIndex(axis, indices[axis.index - 2] + Number(b.dataset.d))));
		bar.append(row);
		refreshAxisRow(axis);
	}
}

function axisByIndex(i: number): AxisInfo | undefined {
	return wcs.axes.find(a => a.index === i);
}

function refreshAxisRow(axis: AxisInfo): void {
	const row = $('axes').querySelector<HTMLElement>(`.axis[data-axis="${axis.index}"]`);
	if (!row) {
		return;
	}
	const k = indices[axis.index - 2];
	row.querySelector<HTMLInputElement>('input[type=range]')!.value = String(k);
	row.querySelector<HTMLInputElement>('input[type=number]')!.value = String(k);
	row.querySelector<HTMLElement>('.world')!.textContent = axisWorldLabel(axis, k);
}

function setIndex(axis: AxisInfo, k: number): void {
	if (!Number.isFinite(k)) {
		return;
	}
	k = Math.max(0, Math.min(axis.n - 1, Math.round(k)));
	if (indices[axis.index - 2] === k) {
		refreshAxisRow(axis);
		return;
	}
	indices[axis.index - 2] = k;
	refreshAxisRow(axis);
	requestPlane();
	const pa = profileAxis();
	if (pa && pa.index === axis.index) {
		plot.setMarker(k);
	} else {
		requestProfile();
	}
	updateCursorReadout();
}

// ---------------------------------------------------------------- beam

function currentBeam(): Beam | undefined {
	if (beams.length) {
		const sp = wcs.spectralAxis;
		const chan = sp && sp.index >= 2 ? indices[sp.index - 2] : 0;
		return beams.find(b => b.chan === chan) ?? beams[0];
	}
	const bmaj = header.get('BMAJ');
	const bmin = header.get('BMIN');
	if (typeof bmaj === 'number' && typeof bmin === 'number' && bmaj > 0 && bmin > 0) {
		const bpa = header.get('BPA');
		return { bmaj, bmin, bpa: typeof bpa === 'number' ? bpa : 0 };
	}
	return undefined;
}

/** Beam solid angle in pixels (Gaussian beam: pi * maj * min / (4 ln 2)). */
function beamAreaPix(): number | undefined {
	const b = currentBeam();
	const pa = wcs.pixelAreaDeg2;
	if (!b || !pa) {
		return undefined;
	}
	return (Math.PI * b.bmaj * b.bmin) / (4 * Math.LN2) / pa;
}

// ---------------------------------------------------------------- info panel

function renderInfo(): void {
	const s = hdus[curHdu];
	if (!s) {
		return;
	}
	const rows: [string, string][] = [];
	const section = (title: string) => rows.push(['#', title]);
	const hs = (k: string) => {
		const v = header.get(k);
		return v === undefined || v === null ? '' : String(v).trim();
	};

	section('File');
	rows.push(['Name', fileName], ['Size', fmtBytes(fileSize)]);
	rows.push(['HDU', `${s.index}: ${s.name} (${s.kind})`]);
	rows.push(['Dimensions', s.shape.length ? s.shape.join(' × ') : '—'], ['BITPIX', String(s.bitpix)]);
	for (const [k, label] of [['OBJECT', 'Object'], ['TELESCOP', 'Telescope'], ['INSTRUME', 'Instrument'], ['DATE-OBS', 'Observed']]) {
		if (hs(k)) {
			rows.push([label, hs(k)]);
		}
	}
	if (unit()) {
		rows.push(['Brightness unit', unit()]);
	}

	const c = wcs.celestial;
	if (c) {
		section('Celestial WCS');
		rows.push(['System', c.system], ['Projection', c.proj]);
		const ref = wcs.pixToSky(c.crpix[0], c.crpix[1]);
		if (ref) {
			rows.push(['Reference', fmtSky(ref.lon, ref.lat)]);
		}
		const scale = Math.sqrt(wcs.pixelAreaDeg2 ?? 0);
		rows.push(['Pixel scale', formatAngle(scale)]);
		rows.push(['Field of view', `${formatAngle(scale * s.shape[0])} × ${formatAngle(scale * (s.shape[1] ?? 1))}`]);
	} else if (wcs.unsupportedProjection) {
		section('Celestial WCS');
		rows.push(['Projection', `${wcs.unsupportedProjection} (not supported)`]);
	}

	const b = currentBeam();
	if (b) {
		section('Beam');
		rows.push(['Size', `${formatAngle(b.bmaj)} × ${formatAngle(b.bmin)}`], ['Position angle', `${fmt(b.bpa, 5)}°`]);
		const area = beamAreaPix();
		if (area) {
			rows.push(['Area', `${fmt(area, 5)} px`]);
		}
		if (beams.length > 1) {
			rows.push(['Source', `per-channel BEAMS table (${beams.length} rows)`]);
		}
	}

	const sp = wcs.spectralAxis;
	if (sp) {
		section('Spectral axis');
		rows.push(['Type', `${sp.ctype} (axis ${sp.index + 1}, ${sp.n} channel${sp.n === 1 ? '' : 's'})`]);
		if (wcs.specsys) {
			rows.push(['Frame', wcs.specsys]);
		}
		if (wcs.restFreq) {
			rows.push(['Rest frequency', formatFreq(wcs.restFreq)]);
		}
		const a = wcs.spectralAt(1, sp);
		const z = wcs.spectralAt(2, sp);
		if (a && z) {
			if (a.freqHz !== undefined && z.freqHz !== undefined) {
				rows.push(['Channel width', formatFreq(z.freqHz - a.freqHz)]);
			}
			const va = velocity(a);
			const vz = velocity(z);
			if (va !== undefined && vz !== undefined) {
				rows.push(['Velocity width', formatVelocity(vz - va)]);
			}
		}
	}

	if (stats && plane) {
		section('Displayed plane');
		rows.push(['Min', fmtUnit(stats.min)], ['Max', fmtUnit(stats.max)], ['Mean', fmtUnit(stats.mean)]);
		rows.push(['Std dev', fmtUnit(stats.std)]);
		rows.push(['Blank pixels', `${stats.nTotal - stats.nFinite} of ${stats.nTotal}`]);
	}

	$('tab-info').innerHTML = '<table class="kv">' + rows.map(([k, v]) =>
		k === '#' ? `<tr class="section"><th colspan="2">${esc(v)}</th></tr>` : `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`,
	).join('') + '</table>';
}

// ---------------------------------------------------------------- region statistics

function updateRegionPanel(): void {
	const el = $('region-stats');
	if (!region || !plane) {
		el.innerHTML = '<p class="muted">Choose <b>Rect</b> or <b>Ellipse</b> and drag on the image to measure a region. ' +
			'Click a pixel to pick it.</p>';
		return;
	}
	const r = region;
	const rows: [string, string][] = [];
	const w = r.x1 - r.x0 + 1;
	const h = r.y1 - r.y0 + 1;
	if (r.shape === 'point') {
		rows.push(['Pixel', `(${r.x0}, ${r.y0})`]);
	} else {
		rows.push(['Shape', r.shape === 'rect' ? 'Rectangle' : 'Ellipse']);
		rows.push(['Bounds', `x ${r.x0}–${r.x1}, y ${r.y0}–${r.y1}`]);
	}
	const centre = wcs.pixToSky((r.x0 + r.x1) / 2 + 1, (r.y0 + r.y1) / 2 + 1);
	if (centre) {
		rows.push([r.shape === 'point' ? 'Position' : 'Centre', fmtSky(centre.lon, centre.lat)]);
	}
	const pa = wcs.pixelAreaDeg2;
	if (pa && r.shape !== 'point') {
		const scale = Math.sqrt(pa);
		rows.push(['Size', `${formatAngle(w * scale)} × ${formatAngle(h * scale)}`]);
	}
	const st = regionStats(plane.data, plane.nx, plane.ny, r);
	if (r.shape === 'point') {
		rows.push(['Value', fmtUnit(st.mean)]);
	} else {
		rows.push(['Pixels', st.nFinite === st.npix ? String(st.npix) : `${st.nFinite} finite of ${st.npix}`]);
		const area = beamAreaPix();
		if (area) {
			rows.push(['Beams', fmt(st.npix / area, 4)]);
		}
		rows.push(['Sum', fmtUnit(st.sum)], ['Mean', fmtUnit(st.mean)], ['Median', fmtUnit(st.median)]);
		rows.push(['Std dev', fmtUnit(st.std)], ['RMS', fmtUnit(st.rms)]);
		rows.push(['Min', st.minPos ? `${fmtUnit(st.min)}  at (${st.minPos[0]}, ${st.minPos[1]})` : fmtUnit(st.min)]);
		rows.push(['Max', st.maxPos ? `${fmtUnit(st.max)}  at (${st.maxPos[0]}, ${st.maxPos[1]})` : fmtUnit(st.max)]);
		const u = unit();
		if (area && /\/\s*beam/i.test(u)) {
			// Sum of (Jy/beam) pixels divided by the beam area in pixels gives Jy.
			const fluxUnit = u.replace(/\s*\/\s*beam/i, '').trim();
			rows.push(['Flux density', fmtUnit(st.sum / area, fluxUnit)]);
		} else if (/\/\s*pix(el)?/i.test(u)) {
			rows.push(['Flux density', fmtUnit(st.sum, u.replace(/\s*\/\s*pix(el)?/i, '').trim())]);
		}
	}
	el.innerHTML = '<table class="kv">' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('') + '</table>';
}

// ---------------------------------------------------------------- profile

function buildProfileXOptions(): void {
	const axis = profileAxis();
	profileXSel.innerHTML = '';
	profileXSel.add(new Option('Channel', 'channel'));
	let preferred = 'channel';
	if (axis) {
		if (axis.kind === 'spectral') {
			const sv = wcs.spectralAt(1, axis);
			if (sv?.freqHz !== undefined) {
				profileXSel.add(new Option('Frequency', 'frequency'));
				preferred = 'frequency';
			}
			if (sv && (sv.vRadio !== undefined || sv.vOptical !== undefined || sv.vRelativistic !== undefined)) {
				profileXSel.add(new Option('Velocity', 'velocity'));
				preferred = 'velocity';
			}
		} else if (axis.ctype && axis.kind !== 'stokes') {
			profileXSel.add(new Option(axis.ctype, 'world'));
			preferred = 'world';
		}
	}
	profileXSel.value = preferred;
	velconvSel.hidden = !wcs.restFreq || axis?.kind !== 'spectral';
}

function requestProfile(): void {
	const axis = profileAxis();
	if (!axis || !region || !hdus[curHdu]?.displayable) {
		profile = undefined;
		updateProfile();
		return;
	}
	profileReq = ++seq;
	$('profile-title').textContent = 'Extracting profile…';
	post({ type: 'getProfile', reqId: profileReq, hdu: curHdu, axis: axis.index, indices: indices.slice(), region });
}

function updateProfile(): void {
	const axis = profileAxis();
	const heading = $('profile-heading');
	const host = $('profile');
	const controls = profileXSel.parentElement!;
	if (!axis) {
		heading.hidden = host.hidden = controls.hidden = true;
		$('profile-title').textContent = '';
		plot.setData(undefined);
		return;
	}
	heading.hidden = host.hidden = controls.hidden = false;
	heading.textContent = axis.kind === 'spectral' ? 'Spectrum' : `Profile along ${axis.ctype || `axis ${axis.index + 1}`}`;
	if (!profile || profile.axis !== axis.index) {
		$('profile-title').textContent = region ? '' : 'Click a pixel or draw a region to extract its profile.';
		plot.setData(undefined);
		return;
	}
	const n = profile.values.length;
	const x = new Float64Array(n);
	const mode = profileXSel.value;
	let xLabel = 'Channel';
	let formatX = (v: number) => `Channel ${v}`;
	if (mode === 'frequency') {
		const mid = wcs.spectralAt((n + 1) / 2, axis)?.freqHz ?? 1;
		const [f, u] = mid >= 1e9 ? [1e9, 'GHz'] : mid >= 1e6 ? [1e6, 'MHz'] : mid >= 1e3 ? [1e3, 'kHz'] : [1, 'Hz'];
		for (let k = 0; k < n; k++) {
			x[k] = (wcs.spectralAt(k + 1, axis)?.freqHz ?? NaN) / f;
		}
		xLabel = `Frequency (${u})${wcs.specsys ? `, ${wcs.specsys}` : ''}`;
		formatX = v => `${v.toFixed(6)} ${u}`;
	} else if (mode === 'velocity') {
		for (let k = 0; k < n; k++) {
			const sv = wcs.spectralAt(k + 1, axis);
			x[k] = ((sv && velocity(sv)) ?? NaN) / 1e3;
		}
		xLabel = `${velConv[0].toUpperCase()}${velConv.slice(1)} velocity (km/s)${wcs.specsys ? `, ${wcs.specsys}` : ''}`;
		formatX = v => `${v.toFixed(3)} km/s`;
	} else if (mode === 'world') {
		for (let k = 0; k < n; k++) {
			x[k] = wcs.linearWorld(axis, k + 1);
		}
		xLabel = `${axis.ctype}${axis.cunit ? ` (${axis.cunit})` : ''}`;
		formatX = v => `${fmt(v, 8)} ${axis.cunit}`.trim();
	} else {
		for (let k = 0; k < n; k++) {
			x[k] = k;
		}
	}
	const r = profile.region;
	const what = r.shape === 'point' ? `Pixel (${r.x0}, ${r.y0})` : `Mean over ${profile.npix} px (${r.shape === 'rect' ? 'rectangle' : 'ellipse'})`;
	$('profile-title').textContent = unit() ? `${what} · ${unit()}` : what;
	plot.setData({ x, y: profile.values, xLabel, yLabel: unit(), formatX, formatY: v => fmtUnit(v) });
	plot.setMarker(indices[axis.index - 2]);
}

plot.onPick = i => {
	const axis = profileAxis();
	if (axis) {
		setIndex(axis, i);
	}
};
profileXSel.addEventListener('change', updateProfile);
velconvSel.addEventListener('change', () => {
	velConv = velconvSel.value as VelocityConvention;
	wcs.axes.filter(a => a.index >= 2).forEach(refreshAxisRow);
	updateProfile();
	renderInfo();
	updateCursorReadout();
});

// ---------------------------------------------------------------- rendering

let dirty = false;
function invalidate(): void {
	if (!dirty) {
		dirty = true;
		requestAnimationFrame(() => {
			dirty = false;
			renderImage();
			renderOverlay();
		});
	}
}

function resizeCanvases(): void {
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.round(viewEl.clientWidth * dpr));
	const h = Math.max(1, Math.round(viewEl.clientHeight * dpr));
	for (const c of [imgCanvas, ovCanvas]) {
		if (c.width !== w || c.height !== h) {
			c.width = w;
			c.height = h;
		}
	}
}

function fitView(): void {
	if (!plane) {
		return;
	}
	const w = viewEl.clientWidth;
	const h = viewEl.clientHeight - 30;
	view.scale = Math.max(1e-6, Math.min(w / plane.nx, h / plane.ny) * 0.96);
	view.ox = (w - plane.nx * view.scale) / 2;
	view.oy = (h + plane.ny * view.scale) / 2;
	invalidate();
}

function zoomAt(factor: number, mx: number, my: number): void {
	const u = (mx - view.ox) / view.scale;
	const v = (view.oy - my) / view.scale;
	view.scale = Math.max(1e-4, Math.min(512, view.scale * factor));
	view.ox = mx - u * view.scale;
	view.oy = my + v * view.scale;
	invalidate();
}

function background(): number {
	const c = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
	const m = /^#([0-9a-f]{6})/i.exec(c);
	if (!m) {
		return 0xff1e1e1e;
	}
	const n = parseInt(m[1], 16);
	return (255 << 24) | ((n & 0xff) << 16) | (n & 0xff00) | (n >> 16);
}

const NAN_COLOR = (255 << 24) | (72 << 16) | (48 << 8) | 48;
let frame: ImageData | undefined;
let xIndex = new Int32Array(0);

function renderImage(): void {
	const ctx = imgCanvas.getContext('2d')!;
	const W = imgCanvas.width;
	const H = imgCanvas.height;
	if (!plane || !hdus[curHdu]?.displayable) {
		ctx.clearRect(0, 0, W, H);
		$('st-zoom').textContent = '';
		return;
	}
	if (!frame || frame.width !== W || frame.height !== H) {
		frame = ctx.createImageData(W, H);
		xIndex = new Int32Array(W);
	}
	const out = new Uint32Array(frame.data.buffer);
	const dpr = window.devicePixelRatio || 1;
	const s = view.scale * dpr;
	const ox = view.ox * dpr;
	const oy = view.oy * dpr;
	const { nx, ny, data } = plane;
	const bg = background();
	for (let c = 0; c < W; c++) {
		const i = Math.floor((c + 0.5 - ox) / s);
		xIndex[c] = i >= 0 && i < nx ? i : -1;
	}
	const k = hi > lo ? (LUT_SIZE - 1) / (hi - lo) : 0;
	const top = LUT_SIZE - 1;
	for (let r = 0; r < H; r++) {
		const j = Math.floor((oy - (r + 0.5)) / s);
		const row = r * W;
		if (j < 0 || j >= ny) {
			out.fill(bg, row, row + W);
			continue;
		}
		const base = j * nx;
		for (let c = 0; c < W; c++) {
			const i = xIndex[c];
			if (i < 0) {
				out[row + c] = bg;
				continue;
			}
			const v = data[base + i];
			if (v !== v) {
				out[row + c] = NAN_COLOR;
				continue;
			}
			const t = (v - lo) * k;
			out[row + c] = lut[t <= 0 ? 0 : t >= top ? top : t | 0];
		}
	}
	ctx.putImageData(frame, 0, 0);
	$('st-zoom').textContent = `Zoom ${view.scale >= 1 ? fmt(view.scale, 3) + '×' : '1/' + fmt(1 / view.scale, 3)}`;
}

function renderOverlay(): void {
	const ctx = ovCanvas.getContext('2d')!;
	const dpr = window.devicePixelRatio || 1;
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	const w = ovCanvas.width / dpr;
	const h = ovCanvas.height / dpr;
	ctx.clearRect(0, 0, w, h);
	if (!plane || !hdus[curHdu]?.displayable) {
		return;
	}
	const sx = (u: number) => view.ox + u * view.scale;
	const sy = (v: number) => view.oy - v * view.scale;

	if (region) {
		const r = region;
		const x0 = sx(r.x0);
		const x1 = sx(r.x1 + 1);
		const y0 = sy(r.y1 + 1);
		const y1 = sy(r.y0);
		// Dark halo under a bright stroke keeps the outline visible on any colormap.
		for (const [style, width] of [['rgba(0,0,0,0.75)', 3.5], ['#39ff88', 1.5]] as const) {
			ctx.strokeStyle = style;
			ctx.lineWidth = width;
			ctx.beginPath();
			if (r.shape === 'point') {
				const cx = (x0 + x1) / 2;
				const cy = (y0 + y1) / 2;
				const g = Math.max(4, (x1 - x0) / 2 + 2);
				ctx.moveTo(cx - g - 8, cy); ctx.lineTo(cx - g, cy);
				ctx.moveTo(cx + g, cy); ctx.lineTo(cx + g + 8, cy);
				ctx.moveTo(cx, cy - g - 8); ctx.lineTo(cx, cy - g);
				ctx.moveTo(cx, cy + g); ctx.lineTo(cx, cy + g + 8);
			} else if (r.shape === 'rect') {
				ctx.rect(x0, y0, x1 - x0, y1 - y0);
			} else {
				ctx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, 0, 0, 2 * Math.PI);
			}
			ctx.stroke();
		}
	}

	const b = beamChk.checked ? currentBeam() : undefined;
	if (b && wcs.celestial) {
		// Trace the beam ellipse on the sky and map each point through the pixel matrix,
		// so rotation, flips and non-square pixels are all handled.
		const pa = b.bpa * Math.PI / 180;
		const pts: [number, number][] = [];
		let ext = 0;
		for (let i = 0; i < 72; i++) {
			const t = (i / 72) * 2 * Math.PI;
			const a = (b.bmaj / 2) * Math.cos(t);
			const m = (b.bmin / 2) * Math.sin(t);
			const east = a * Math.sin(pa) + m * Math.cos(pa);
			const north = a * Math.cos(pa) - m * Math.sin(pa);
			const p = wcs.skyOffsetToPix(east, north);
			if (!p) {
				return;
			}
			const q: [number, number] = [p[0] * view.scale, -p[1] * view.scale];
			ext = Math.max(ext, Math.abs(q[0]), Math.abs(q[1]));
			pts.push(q);
		}
		if (ext <= Math.min(w, h) * 0.3) {
			const half = Math.max(ext, 3) + 8;
			const cx = 12 + half;
			const cy = h - 40 - half;
			ctx.fillStyle = 'rgba(0,0,0,0.55)';
			ctx.strokeStyle = 'rgba(255,255,255,0.5)';
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.rect(cx - half, cy - half, 2 * half, 2 * half);
			ctx.fill();
			ctx.stroke();
			ctx.fillStyle = 'rgba(255,255,255,0.85)';
			ctx.beginPath();
			if (ext < 1.5) {
				ctx.arc(cx, cy, 1.5, 0, 2 * Math.PI);
			} else {
				pts.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x, cy + y) : ctx.moveTo(cx + x, cy + y)));
				ctx.closePath();
			}
			ctx.fill();
		}
	}
}

function updateColorbar(): void {
	const c = $<HTMLCanvasElement>('cbar');
	const ctx = c.getContext('2d')!;
	const img = ctx.createImageData(256, 1);
	const px = new Uint32Array(img.data.buffer);
	for (let i = 0; i < 256; i++) {
		px[i] = lut[Math.round((i / 255) * (LUT_SIZE - 1))];
	}
	ctx.putImageData(img, 0, 0);
	$('cb-lo').textContent = fmt(lo, 4);
	$('cb-hi').textContent = fmt(hi, 4);
	$('cb-unit').textContent = unit();
}

function refreshLut(): void {
	lut = buildLut(cmapSel.value, stretchSel.value as Stretch, invertChk.checked);
	updateColorbar();
	invalidate();
}

// ---------------------------------------------------------------- cursor readout

function pixelAt(mx: number, my: number): { u: number; v: number; i: number; j: number; inside: boolean } {
	const u = (mx - view.ox) / view.scale;
	const v = (view.oy - my) / view.scale;
	const i = Math.floor(u);
	const j = Math.floor(v);
	return { u, v, i, j, inside: !!plane && i >= 0 && j >= 0 && i < plane.nx && j < plane.ny };
}

function updateCursorReadout(): void {
	const pixEl = $('st-pix');
	const valEl = $('st-val');
	const skyEl = $('st-sky');
	const specEl = $('st-spec');
	const sp = wcs.spectralAxis;
	specEl.textContent = sp && sp.index >= 2 ? axisWorldLabel(sp, indices[sp.index - 2]) : '';
	if (!cursor || !plane) {
		pixEl.textContent = valEl.textContent = skyEl.textContent = '';
		return;
	}
	const p = pixelAt(cursor.x, cursor.y);
	if (!p.inside) {
		pixEl.textContent = valEl.textContent = skyEl.textContent = '';
		return;
	}
	pixEl.textContent = `x ${p.i}  y ${p.j}`;
	valEl.textContent = fmtUnit(plane.data[p.j * plane.nx + p.i]);
	// FITS pixel coordinates are 1-based with integer pixel centres.
	const sky = wcs.pixToSky(p.u + 0.5, p.v + 0.5);
	if (sky) {
		skyEl.textContent = `${fmtSky(sky.lon, sky.lat)}  ${wcs.celestial!.system}`;
	} else {
		const parts: string[] = [];
		for (const [axisIndex, coord] of [[0, p.u + 0.5], [1, p.v + 0.5]] as const) {
			const a = axisByIndex(axisIndex);
			if (a?.ctype) {
				parts.push(`${a.ctype} ${fmt(wcs.linearWorld(a, coord), 8)} ${a.cunit}`.trim());
			}
		}
		skyEl.textContent = parts.join('   ');
	}
}

// ---------------------------------------------------------------- interaction

interface Drag { mode: 'pan' | 'draw'; x: number; y: number; ox: number; oy: number; moved: boolean; i: number; j: number }
let drag: Drag | undefined;

function localXY(e: MouseEvent): { x: number; y: number } {
	const r = viewEl.getBoundingClientRect();
	return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function clampPix(i: number, j: number): [number, number] {
	return [Math.max(0, Math.min(plane!.nx - 1, i)), Math.max(0, Math.min(plane!.ny - 1, j))];
}

ovCanvas.addEventListener('mousedown', e => {
	if (!plane || (e.button !== 0 && e.button !== 1)) {
		return;
	}
	e.preventDefault();
	viewEl.focus();
	const { x, y } = localXY(e);
	const p = pixelAt(x, y);
	const mode = tool === 'pan' || e.button === 1 || e.shiftKey ? 'pan' : 'draw';
	drag = { mode, x, y, ox: view.ox, oy: view.oy, moved: false, i: p.i, j: p.j };
});

window.addEventListener('mousemove', e => {
	const { x, y } = localXY(e);
	if (drag && plane) {
		if (!drag.moved && Math.hypot(x - drag.x, y - drag.y) < 3) {
			return;
		}
		drag.moved = true;
		if (drag.mode === 'pan') {
			view.ox = drag.ox + (x - drag.x);
			view.oy = drag.oy + (y - drag.y);
		} else {
			const p = pixelAt(x, y);
			const [i0, j0] = clampPix(drag.i, drag.j);
			const [i1, j1] = clampPix(p.i, p.j);
			region = {
				shape: tool === 'ellipse' ? 'ellipse' : 'rect',
				x0: Math.min(i0, i1), x1: Math.max(i0, i1), y0: Math.min(j0, j1), y1: Math.max(j0, j1),
			};
		}
		invalidate();
	}
	const inside = e.target === ovCanvas || !!drag;
	cursor = inside ? { x, y } : undefined;
	updateCursorReadout();
});

window.addEventListener('mouseup', e => {
	if (!drag || !plane) {
		drag = undefined;
		return;
	}
	const d = drag;
	drag = undefined;
	if (!d.moved) {
		// A plain click picks one pixel.
		const { x, y } = localXY(e);
		const p = pixelAt(x, y);
		if (!p.inside) {
			return;
		}
		region = { shape: 'point', x0: p.i, x1: p.i, y0: p.j, y1: p.j };
	} else if (d.mode === 'pan') {
		return;
	}
	onRegionChanged();
});

function onRegionChanged(): void {
	updateRegionPanel();
	requestProfile();
	invalidate();
	if (region) {
		showTab('analysis');
	}
}

ovCanvas.addEventListener('mouseleave', () => {
	if (!drag) {
		cursor = undefined;
		updateCursorReadout();
	}
});

ovCanvas.addEventListener('wheel', e => {
	if (!plane) {
		return;
	}
	e.preventDefault();
	const { x, y } = localXY(e);
	zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), x, y);
	updateCursorReadout();
}, { passive: false });

function zoomCentre(f: number): void {
	zoomAt(f, viewEl.clientWidth / 2, viewEl.clientHeight / 2);
}

viewEl.addEventListener('keydown', e => {
	const axis = profileAxis();
	if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && axis) {
		setIndex(axis, indices[axis.index - 2] + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
	} else if (e.key === '+' || e.key === '=') {
		zoomCentre(1.25);
	} else if (e.key === '-') {
		zoomCentre(0.8);
	} else if (e.key === '0') {
		fitView();
	} else if (e.key === 'Escape') {
		region = undefined;
		onRegionChanged();
	} else {
		return;
	}
	e.preventDefault();
});

$('zoom-in').addEventListener('click', () => zoomCentre(1.5));
$('zoom-out').addEventListener('click', () => zoomCentre(1 / 1.5));
$('zoom-fit').addEventListener('click', fitView);
$('zoom-one').addEventListener('click', () => {
	const dpr = window.devicePixelRatio || 1;
	zoomCentre(1 / dpr / view.scale);
});
$('clear-region').addEventListener('click', () => {
	region = undefined;
	onRegionChanged();
});

$('tools').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.addEventListener('click', () => {
	tool = b.dataset.tool as typeof tool;
	$('tools').querySelectorAll('button').forEach(o => o.classList.toggle('active', o === b));
	ovCanvas.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
}));

function showTab(name: string): void {
	$('tabs').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
	for (const t of ['header', 'info', 'analysis']) {
		$(`tab-${t}`).hidden = t !== name;
	}
	plot.draw();
}
$('tabs').querySelectorAll<HTMLButtonElement>('button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab!)));

$('toggle-side').addEventListener('click', () => {
	$('side').hidden = !$('side').hidden;
});

hduSel.addEventListener('change', () => {
	limitsReady = false;
	selectHdu(Number(hduSel.value));
});
stretchSel.addEventListener('change', refreshLut);
cmapSel.addEventListener('change', refreshLut);
invertChk.addEventListener('change', refreshLut);
beamChk.addEventListener('change', invalidate);
limitsSel.addEventListener('change', () => {
	applyLimitMode();
	updateColorbar();
	invalidate();
});
for (const input of [loInput, hiInput]) {
	input.addEventListener('change', () => {
		const a = Number(loInput.value);
		const b = Number(hiInput.value);
		if (loInput.value === '' || hiInput.value === '' || !Number.isFinite(a) || !Number.isFinite(b)) {
			return;
		}
		lo = a;
		hi = b;
		limitsSel.value = 'custom';
		updateColorbar();
		invalidate();
	});
}

new ResizeObserver(() => {
	resizeCanvases();
	if (needFit) {
		fitView();
	}
	invalidate();
}).observe(viewEl);

ovCanvas.style.cursor = 'grab';
refreshLut();
post({ type: 'ready' });
