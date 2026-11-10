# Astro FITS Reviewer

View astronomy FITS images and spectral cubes directly in VS Code. Opening a `.fits`, `.fit`, `.fts`
(or gzipped `.fits.gz`) file shows the image with its header, world coordinates and analysis tools.
It is aimed at quick inspection of radio/mm data such as ALMA cubes, without leaving the editor.

## Features

### Image inspection

- **HDU selector** for multi-extension files. Table and empty HDUs show their header.
- **Searchable header**: filter cards by keyword, value or comment.
- **Zoom and pan**: mouse wheel zooms about the cursor, drag pans; Fit and 1:1 buttons.
- **Stretch**: linear, log, sqrt, squared, asinh.
- **Display limits**: min/max, percentile clips (99.9% … 90%), zscale, or typed low/high values.
  *Lock* keeps the limits fixed while you step through channels.
- **Colormaps**: gray, viridis, inferno, magma, plasma, heat, cubehelix, coolwarm, turbo; invertible.
- **Cursor readout** in the status bar: pixel, value with unit, sky position, frequency/velocity.

### Astronomy

- **Celestial WCS** with RA/Dec (sexagesimal) or Galactic/ecliptic coordinates under the cursor.
  Projections: TAN, SIN (including slant/NCP), ARC, STG, ZEA, CAR, CEA, MER, SFL/GLS, AIT.
  `CDi_j`, `PCi_j` + `CDELT`, and legacy `CROTA2` are all understood.
- **Spectral cubes**: a slider for every extra axis (frequency/velocity channel, Stokes, …) showing the
  channel's frequency and velocity. Radio, optical and relativistic velocity conventions are available
  when the header has a rest frequency.
- **Spectrum / profile plot**: click a pixel or draw a region to extract its spectrum along the
  spectral axis, plotted against channel, frequency or velocity. Click the plot to jump to a channel.
- **Beam**: the synthesized beam (`BMAJ`/`BMIN`/`BPA`, or a per-channel CASA `BEAMS` table) is drawn
  to scale in the corner of the image.
- **Units**: values are shown with `BUNIT` (for example `mJy/beam`).
- **Region statistics**: rectangle or ellipse regions give pixel count, number of beams, sum, mean,
  median, standard deviation, RMS, min/max with positions, and — for `Jy/beam` images — the
  integrated flux density in Jy.

## Usage

| Action | How |
| --- | --- |
| Open a file | Click a FITS file in the Explorer, or run **FITS: Open FITS File…** |
| Zoom | Mouse wheel, `+` / `-`, or the toolbar buttons; `0` fits the image |
| Pan | Drag with the **Pan** tool (or Shift-drag / middle-drag with any tool) |
| Pick a pixel | Click it — its value and spectrum appear in the **Analysis** tab |
| Measure a region | Choose **Rect** or **Ellipse** and drag; `Esc` or **Clear** removes it |
| Change channel | Axis slider, `←` / `→` (Shift for steps of 10), or click the spectrum |

Pixel coordinates and channel numbers are **0-based** (as in CASA and CARTA), so they are one less
than FITS/DS9 pixel numbers.

## Notes and limitations

- Large files are read lazily, one plane at a time, so multi-GB cubes open quickly. Gzipped files are
  decompressed fully into memory.
- Pixel values are held as 32-bit floats for display, so 64-bit data loses precision in the readout.
- Not supported yet: tile-compressed images (`.fz` / fpack), table contents, random-groups data, and
  distortion corrections (SIP, TPV). Sky positions for such images use the linear WCS only.
- Spectral conversions assume a linear axis (`FREQ`, `VRAD`, `VOPT`, `VELO`, `WAVE`).

## Development

```sh
npm install
npm run watch      # then press F5 in VS Code to launch an Extension Development Host
npm run compile    # type-check, lint and bundle
```

The extension host code (`src/fits`, `src/fitsEditorProvider.ts`) reads the file; the webview
(`src/webview`) renders it. `src/common` is shared by both.
