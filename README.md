# PDF to JPG Converter for USCIS (Client-side).

Single-page web app that converts PDF documents to **USCIS-accepted JPG/JPEG** fully in the browser using **pdf.js** (privacy-friendly: no uploads).

## Features

### PDF → JPG Conversion
- Drag-and-drop or file picker PDF upload
- Step-by-step workflow: upload → mode → settings → preview/download
- Two conversion modes:
  - Individual Pages (one JPG per page)
  - Single Combined Image (all pages stacked vertically)
- Output format selector (**JPG** / **JPEG**)
- Quality slider + DPI clarity selector (2x / 3x)
- 6MB warning (common USCIS limit)
- Page spacing option for combined mode
- Previews + per-page download + download all as ZIP (individual mode)
- Start Over reset

### Image → Image Compression (USCIS-safe ≤ 600 KB)
- Accepts **JPG/JPEG/PNG** files (PNG converts to JPG)
- **USCIS-safe compression preset**: targets ≤ 600 KB without resizing (resolution preserved)
- Editable target size (default 600 KB for USCIS-style limits)
- **Best-clarity safeguard**: min quality threshold prevents excessive artifacts
- **Pass/Fail reporting**: clearly shows which files meet the target
- Summary bar: total before/after sizes and saved percentage
- Batch support: compress multiple images at once
- Per-image recompress and download

### General
- Dark mode toggle
- Toast notifications
- Privacy: all processing is local (no server uploads)

## Run locally
1. Install dependencies:

```bash
npm install
```

2. Start dev server:

```bash
npm run dev
```

Then open the printed local URL.

## Understanding Compression vs Resizing

**This tool uses compression, NOT resizing:**

| Method | What it does | Resolution | Legibility |
|--------|-------------|------------|------------|
| **Compression** | Adjusts JPEG encoding (quality, subsampling) | Unchanged | Preserved |
| **Resizing** | Reduces pixel dimensions | Reduced | Can degrade |

For USCIS document uploads, **compression is the safer choice** — it reduces file size while preserving the original resolution and legibility of text and details.

## CLI Tool (Enterprise / Batch Workflows)

The web app compresses by re-encoding JPEG (resolution preserved). In browsers, the only controllable lever is JPEG quality.

For **batch-friendly, deterministic compression** with encoder-level controls (subsampling / progressive / metadata stripping), use the included **CLI tool**. This is recommended for **Cursor and Claude Code workflows**.

### Basic Usage (Cursor / Claude Code)

Compress one or more existing JPG/JPEG files:

```bash
npm run uscis:compress -- --quality 0.85 --max-size 6mb --subsample 4:4:4 --strip-metadata --out-dir out my-photo.jpg
```

### "Fit Under 600 KB" (USCIS-style limit)

If you need strict targeting for portals that require small uploads (common USCIS requirement), use:

```bash
npm run uscis:compress -- --fit-under 600kb --quality 0.85 --min-quality 0.55 --out-dir out "./input-folder"
```

This will deterministically try (in order):
1. **Progressive JPEG** encoding
2. **4:2:0 chroma subsampling**
3. **Quality adjustment** via binary search

If it can't hit the target above `--min-quality`, it will output the **best-clarity** result and mark it as `FAIL`.

### Batch Processing

Compress a whole folder of JPG/JPEGs:

```bash
npm run uscis:compress -- --fit-under 600kb --recursive --out-dir out "./input-folder"
```

### Show All Flags

```bash
npm run uscis:compress -- --help
```

### USCIS-safe Defaults (recommended)

| Flag | Value | Notes |
|------|-------|-------|
| `--fit-under` | `600kb` | Common USCIS portal limit |
| `--quality` | `0.85` | Good balance of size/quality |
| `--min-quality` | `0.55` | Prevents excessive artifacts |
| `--subsample` | `4:4:4` | Safer for text edges |
| `--strip-metadata` | (default) | Reduces size, removes EXIF |

### Example: Cursor/Claude Code Workflow

```bash
# Compress all images in current folder to meet USCIS 600KB limit
npm run uscis:compress -- --fit-under 600kb --recursive --out-dir uscis-ready .

# Check output
ls -la uscis-ready/
```

Output shows pass/fail status per file:

```
[ok] passport-scan.jpg  2.3MB → 412KB  (-82%)  q=0.72  PASS  subsample=4:2:0 progressive=on metadata=stripped
[ok] form-i20.jpg  1.8MB → 589KB  (-67%)  q=0.85  PASS  subsample=4:4:4 progressive=off metadata=stripped
[ok] large-photo.jpg  5.1MB → 623KB  (-88%)  q=0.55  [BEST-CLARITY] [FAIL target]  subsample=4:2:0 progressive=on metadata=stripped
```
