// Single-series line plot for spectral / axis profiles, with a hover crosshair,
// a tooltip, and a marker for the channel currently shown in the image.

export interface ProfileData {
	x: Float64Array;
	y: Float32Array;
	xLabel: string;
	yLabel: string;
	formatX: (v: number) => string;
	formatY: (v: number) => string;
}

function niceTicks(lo: number, hi: number, target: number): number[] {
	if (!(hi > lo)) {
		return [lo];
	}
	const raw = (hi - lo) / Math.max(1, target);
	const mag = 10 ** Math.floor(Math.log10(raw));
	const norm = raw / mag;
	const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
	const out: number[] = [];
	for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
		out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
	}
	return out;
}

function tickLabel(v: number, step: number): string {
	const a = Math.abs(v);
	if (a !== 0 && (a >= 1e6 || a < 1e-3)) {
		return v.toExponential(1).replace('e+', 'e');
	}
	const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
	return v.toFixed(digits);
}

export class ProfilePlot {
	private readonly canvas: HTMLCanvasElement;
	private readonly tip: HTMLDivElement;
	private data?: ProfileData;
	private marker = -1;
	private hover = -1;
	private box = { l: 0, t: 0, w: 0, h: 0 };
	private range = { x0: 0, x1: 1, y0: 0, y1: 1 };
	onPick?: (index: number) => void;

	constructor(private readonly host: HTMLElement) {
		host.classList.add('plot');
		this.canvas = document.createElement('canvas');
		this.tip = document.createElement('div');
		this.tip.className = 'plot-tip';
		this.tip.hidden = true;
		host.append(this.canvas, this.tip);
		new ResizeObserver(() => this.draw()).observe(host);
		this.canvas.addEventListener('mousemove', e => {
			this.hover = this.indexAt(e.offsetX);
			this.draw();
		});
		this.canvas.addEventListener('mouseleave', () => {
			this.hover = -1;
			this.draw();
		});
		this.canvas.addEventListener('click', e => {
			const i = this.indexAt(e.offsetX);
			if (i >= 0) {
				this.onPick?.(i);
			}
		});
	}

	setData(d: ProfileData | undefined): void {
		this.data = d;
		this.hover = -1;
		this.draw();
	}

	setMarker(index: number): void {
		this.marker = index;
		this.draw();
	}

	private px(x: number): number {
		const { x0, x1 } = this.range;
		return this.box.l + ((x - x0) / (x1 - x0 || 1)) * this.box.w;
	}

	private py(y: number): number {
		const { y0, y1 } = this.range;
		return this.box.t + this.box.h - ((y - y0) / (y1 - y0 || 1)) * this.box.h;
	}

	private indexAt(mx: number): number {
		const d = this.data;
		if (!d || d.x.length === 0) {
			return -1;
		}
		let best = -1;
		let bestD = Infinity;
		for (let i = 0; i < d.x.length; i++) {
			const dist = Math.abs(this.px(d.x[i]) - mx);
			if (dist < bestD) {
				bestD = dist;
				best = i;
			}
		}
		return best;
	}

	draw(): void {
		const w = this.host.clientWidth;
		const h = this.host.clientHeight;
		if (w < 10 || h < 10) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
			this.canvas.width = Math.round(w * dpr);
			this.canvas.height = Math.round(h * dpr);
		}
		const ctx = this.canvas.getContext('2d')!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const css = getComputedStyle(this.host);
		const ink = css.getPropertyValue('--vscode-foreground').trim() || '#ccc';
		const muted = css.getPropertyValue('--vscode-descriptionForeground').trim() || '#999';
		const grid = css.getPropertyValue('--vscode-editorWidget-border').trim() || 'rgba(128,128,128,0.3)';
		const series = css.getPropertyValue('--vscode-charts-blue').trim() || '#3794ff';
		const accent = css.getPropertyValue('--vscode-charts-orange').trim() || '#d18616';
		ctx.font = `11px ${css.fontFamily}`;

		const d = this.data;
		if (!d || d.x.length === 0) {
			this.tip.hidden = true;
			return;
		}
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (let i = 0; i < d.x.length; i++) {
			if (d.x[i] < x0) { x0 = d.x[i]; }
			if (d.x[i] > x1) { x1 = d.x[i]; }
			const v = d.y[i];
			if (Number.isFinite(v)) {
				if (v < y0) { y0 = v; }
				if (v > y1) { y1 = v; }
			}
		}
		if (!Number.isFinite(y0)) {
			y0 = 0;
			y1 = 1;
		}
		if (y0 === y1) {
			y0 -= Math.abs(y0) * 0.1 || 1;
			y1 += Math.abs(y1) * 0.1 || 1;
		}
		const pad = (y1 - y0) * 0.06;
		this.range = { x0, x1, y0: y0 - pad, y1: y1 + pad };
		this.box = { l: 58, t: 8, w: Math.max(10, w - 58 - 12), h: Math.max(10, h - 8 - 34) };
		const b = this.box;

		// Grid and ticks stay recessive; labels use text tokens.
		const yt = niceTicks(this.range.y0, this.range.y1, Math.max(2, Math.floor(b.h / 36)));
		const xt = niceTicks(x0, x1, Math.max(2, Math.floor(b.w / 80)));
		ctx.strokeStyle = grid;
		ctx.lineWidth = 1;
		ctx.fillStyle = muted;
		ctx.textBaseline = 'middle';
		ctx.textAlign = 'right';
		const ystep = yt.length > 1 ? yt[1] - yt[0] : 1;
		for (const v of yt) {
			const y = Math.round(this.py(v)) + 0.5;
			ctx.beginPath();
			ctx.moveTo(b.l, y);
			ctx.lineTo(b.l + b.w, y);
			ctx.stroke();
			ctx.fillText(tickLabel(v, ystep), b.l - 6, y);
		}
		ctx.textAlign = 'center';
		ctx.textBaseline = 'top';
		const xstep = xt.length > 1 ? xt[1] - xt[0] : 1;
		for (const v of xt) {
			ctx.fillText(tickLabel(v, xstep), this.px(v), b.t + b.h + 5);
		}
		ctx.fillText(d.xLabel, b.l + b.w / 2, b.t + b.h + 19);
		ctx.strokeStyle = muted;
		ctx.beginPath();
		ctx.moveTo(b.l, b.t + b.h + 0.5);
		ctx.lineTo(b.l + b.w, b.t + b.h + 0.5);
		ctx.stroke();

		// Marker for the displayed channel.
		if (this.marker >= 0 && this.marker < d.x.length) {
			const mx = Math.round(this.px(d.x[this.marker])) + 0.5;
			ctx.strokeStyle = accent;
			ctx.lineWidth = 1;
			ctx.setLineDash([4, 3]);
			ctx.beginPath();
			ctx.moveTo(mx, b.t);
			ctx.lineTo(mx, b.t + b.h);
			ctx.stroke();
			ctx.setLineDash([]);
		}

		// The series; NaN gaps break the line.
		ctx.save();
		ctx.beginPath();
		ctx.rect(b.l, b.t, b.w, b.h);
		ctx.clip();
		ctx.strokeStyle = series;
		ctx.lineWidth = d.x.length > b.w ? 1.25 : 2;
		ctx.lineJoin = 'round';
		ctx.beginPath();
		let pen = false;
		for (let i = 0; i < d.x.length; i++) {
			const v = d.y[i];
			if (!Number.isFinite(v)) {
				pen = false;
				continue;
			}
			if (pen) {
				ctx.lineTo(this.px(d.x[i]), this.py(v));
			} else {
				ctx.moveTo(this.px(d.x[i]), this.py(v));
				pen = true;
			}
		}
		ctx.stroke();
		if (d.x.length === 1 && Number.isFinite(d.y[0])) {
			ctx.fillStyle = series;
			ctx.beginPath();
			ctx.arc(this.px(d.x[0]), this.py(d.y[0]), 4, 0, 2 * Math.PI);
			ctx.fill();
		}
		ctx.restore();

		// Hover crosshair + tooltip.
		const i = this.hover;
		if (i >= 0 && i < d.x.length) {
			const hx = this.px(d.x[i]);
			ctx.strokeStyle = muted;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(Math.round(hx) + 0.5, b.t);
			ctx.lineTo(Math.round(hx) + 0.5, b.t + b.h);
			ctx.stroke();
			if (Number.isFinite(d.y[i])) {
				ctx.fillStyle = series;
				ctx.strokeStyle = css.getPropertyValue('--vscode-sideBar-background').trim() || '#000';
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.arc(hx, this.py(d.y[i]), 4, 0, 2 * Math.PI);
				ctx.fill();
				ctx.stroke();
			}
			this.tip.textContent = `${d.formatX(d.x[i])}\n${d.formatY(d.y[i])}`;
			this.tip.hidden = false;
			const tw = this.tip.offsetWidth;
			this.tip.style.left = `${hx + 10 + tw > w ? hx - 10 - tw : hx + 10}px`;
			this.tip.style.top = `${b.t + 4}px`;
		} else {
			this.tip.hidden = true;
		}
		void ink;
	}
}
