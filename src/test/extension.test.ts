import * as assert from 'assert';
import { FitsFile, MemorySource, parseCard } from '../fits/reader';
import { Wcs, formatDec, formatRa, headerFromCards } from '../common/wcs';
import { inRegion } from '../common/protocol';

function card(key: string, value: string): string {
	return `${key.padEnd(8)}= ${value.padStart(20)}`.padEnd(80);
}

/** Build a minimal single-HDU FITS file in memory. */
function makeFits(cards: string[], data: Buffer): Buffer {
	const header = Buffer.alloc(2880, ' ');
	header.write([...cards, 'END'.padEnd(80)].join(''), 'latin1');
	const body = Buffer.alloc(Math.ceil(data.length / 2880) * 2880);
	data.copy(body);
	return Buffer.concat([header, body]);
}

suite('FITS reader', () => {
	test('parses header cards', () => {
		assert.deepStrictEqual(parseCard(card('NAXIS', '2') + '').value, 2);
		assert.strictEqual(parseCard("OBJECT  = 'O''Neil  '           / target".padEnd(80)).value, "O'Neil");
		assert.strictEqual(parseCard("OBJECT  = 'a / b   '           / target".padEnd(80)).comment, 'target');
		assert.strictEqual(parseCard(card('SIMPLE', 'T')).value, true);
		assert.strictEqual(parseCard(card('CDELT1', '-1.5D-03')).value, -1.5e-3);
		assert.strictEqual(parseCard('HISTORY made by a test'.padEnd(80)).comment, 'made by a test');
	});

	test('reads a scaled 16-bit cube plane by plane', async () => {
		const data = Buffer.alloc(3 * 2 * 2 * 2);
		for (let i = 0; i < 12; i++) {
			data.writeInt16BE(i === 5 ? -999 : i, i * 2);
		}
		const file = makeFits([
			card('SIMPLE', 'T'), card('BITPIX', '16'), card('NAXIS', '3'), card('NAXIS1', '3'), card('NAXIS2', '2'),
			card('NAXIS3', '2'), card('BSCALE', '2.0'), card('BZERO', '10.0'), card('BLANK', '-999'),
		], data);
		const fits = await FitsFile.open(new MemorySource(file));
		assert.deepStrictEqual(fits.hdus[0].summary.shape, [3, 2, 2]);
		const p0 = await fits.readPlane(0, [0]);
		assert.deepStrictEqual([...p0.data], [10, 12, 14, 16, 18, NaN]);
		const p1 = await fits.readPlane(0, [1]);
		assert.deepStrictEqual([...p1.data], [22, 24, 26, 28, 30, 32]);
		const prof = await fits.readProfile(0, 2, [0], { shape: 'rect', x0: 1, x1: 2, y0: 1, y1: 1 }, () => false);
		assert.deepStrictEqual([...prof!.values], [18, 31]);
	});

	test('rejects non-FITS input', async () => {
		await assert.rejects(FitsFile.open(new MemorySource(Buffer.alloc(2880, 'x'))));
	});
});

suite('WCS', () => {
	const header = headerFromCards(Object.entries({
		NAXIS: 3, NAXIS1: 100, NAXIS2: 100, NAXIS3: 10,
		CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRVAL1: 150, CRVAL2: 2, CRPIX1: 50, CRPIX2: 50,
		CDELT1: -0.001, CDELT2: 0.001,
		CTYPE3: 'FREQ', CRVAL3: 100e9, CDELT3: 1e6, CRPIX3: 1, RESTFRQ: 100e9,
	}).map(([key, value]) => ({ key, value })));
	const wcs = new Wcs(header);

	test('reference pixel maps to CRVAL', () => {
		const s = wcs.pixToSky(50, 50)!;
		assert.ok(Math.abs(s.lon - 150) < 1e-10 && Math.abs(s.lat - 2) < 1e-10);
	});

	test('RA increases to the left, Dec upwards', () => {
		assert.ok(wcs.pixToSky(40, 50)!.lon > 150);
		assert.ok(wcs.pixToSky(50, 60)!.lat > 2);
		assert.ok(Math.abs(wcs.pixToSky(50, 60)!.lat - 2.01) < 1e-6);
	});

	test('spectral axis gives frequency and velocity', () => {
		const sv = wcs.spectralAt(2)!;
		assert.strictEqual(sv.freqHz, 100.001e9);
		assert.ok(Math.abs(sv.vRadio! + 2997.92458) < 1e-6);
	});

	test('sexagesimal formatting carries correctly', () => {
		assert.strictEqual(formatRa(15, 2), '01:00:00.00');
		assert.strictEqual(formatRa(359.9999999, 2), '00:00:00.00');
		assert.strictEqual(formatDec(-0.5, 1), '-00:30:00.0');
		assert.strictEqual(formatDec(29.99999999, 1), '+30:00:00.0');
	});

	test('ellipse membership', () => {
		const r = { shape: 'ellipse' as const, x0: 0, x1: 4, y0: 0, y1: 4 };
		assert.ok(inRegion(r, 2, 2) && inRegion(r, 0, 2) && !inRegion(r, 0, 0));
	});
});
