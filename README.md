# PDF Utilities

A private, fully client-side PDF toolkit. Everything runs in your browser — **no uploads, no servers, no tracking**. A Content Security Policy blocks all network requests and remote images, and every library is vendored locally, so it also works offline.

## Tools

| Tool | Description |
|---|---|
| **Organize** | Drag to reorder pages, delete, rotate, undo, and add pages from other PDFs, then export. |
| **Merge** | Combine multiple PDFs into one with drag / arrow reordering. |
| **Split** | Custom ranges (separate files), extract pages into one file, every N pages, or every page. Multi-file output is zipped. |
| **Compress** | Lossless optimize, or Balanced / Strong / Maximum (re-renders pages as JPEG at 150 / 110 / 72 DPI). Shows before/after size. |
| **Flipbook** | Page-turning viewer with zoom (50–400%, slider, Ctrl+scroll, double-click), drag-to-pan, page jump, keyboard shortcuts and fullscreen. |
| **Image → PDF** | JPG, PNG, WebP, GIF, BMP → PDF with page size, orientation and margin options. |
| **HTML → PDF** | Paste or open HTML, live preview, paginated PDF output. |
| **PDF → Text** | Extracts text, shows word/character counts, copy or save as `.txt`. |

## Run locally

No build step. Serve the folder with any static server:

```bash
python -m http.server 8765
```

Then open <http://localhost:8765>.

## Flipbook shortcuts

`←` / `→` turn pages · `+` / `-` zoom · `0` reset zoom · `Home` / `End` first / last page · `F` fullscreen

## Limitations

- **Compress** (non-lossless modes) and **HTML → PDF** produce image-based pages, so text is not selectable.
- **HTML → PDF** disables scripts and blocks remote resources (embed images as data URIs). Modern CSS colours are converted to RGB for rendering; colours in `::before` / `::after` may not render.
- **PDF → Text** has no OCR, so scanned PDFs yield no text.
- Password-protected PDFs are not supported.

## Built with

[pdf-lib](https://pdf-lib.js.org/) · [pdf.js](https://mozilla.github.io/pdf.js/) · [jsPDF](https://github.com/parallax/jsPDF) · [html2canvas](https://html2canvas.hertzen.com/) · [JSZip](https://stuk.github.io/jszip/) — bundled under `vendor/`, each under its own license.

## Project layout

```
index.html   UI + CSP
style.css    styles (light/dark)
app.js       all tool logic
vendor/      third-party libraries
```
