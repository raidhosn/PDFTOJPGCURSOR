import "./style.css";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

const $app = document.querySelector("#app");

const SIX_MB = 6 * 1024 * 1024;

const state = {
  busy: false,
  appMode: "pdf", // pdf | img
  file: null,
  pdfData: null,
  pdfDoc: null,
  pdfNameBase: "document",
  format: "jpg", // jpg | jpeg
  mode: "individual", // individual | combined
  quality: 0.92, // default high for document legibility
  dpiScale: 2, // 2 | 3
  spacing: "small", // none | small | medium
  compress: true,
  maxSizeMB: 6,
  fitUnderMax: true,
  // Image -> Image compression mode (JPG/JPEG/PNG -> JPG)
  imgFiles:
    /** @type {Array<{id:string,file:File,origBytes:number,width:number,height:number,wasPng?:boolean,compressed?:{blob:Blob,url:string,bytes:number,usedQuality:number,tried:number,pass:boolean}}>} */ ([]),
  imgTargetKB: 600,
  imgUscisPreset: true,
  imgMinQuality: 0.55,
  pageCount: 0,
  pageOrder: /** @type {number[]} */ ([]),
  pages:
    /** @type {Array<{pageNumber:number, blob:Blob, url:string, filename:string, bytes:number, width:number, height:number}>} */ ([]),
  combined:
    /** @type {null|{blob:Blob,url:string,filename:string,bytes:number,width:number,height:number}} */ (null),
  theme: "light"
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[c] || c;
  });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function bytesToHuman(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 2)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
}

function kbToHuman(kb) {
  return bytesToHuman(kb * 1024);
}

function uid() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function isJpegLike(file) {
  const t = (file?.type || "").toLowerCase();
  const n = (file?.name || "").toLowerCase();
  return t === "image/jpeg" || n.endsWith(".jpg") || n.endsWith(".jpeg");
}

function isPng(file) {
  const t = (file?.type || "").toLowerCase();
  const n = (file?.name || "").toLowerCase();
  return t === "image/png" || n.endsWith(".png");
}

function isAcceptedImage(file) {
  return isJpegLike(file) || isPng(file);
}

function setTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  localStorage.setItem("pdf2img:theme", theme);
  const $toggle = document.querySelector("#darkToggle");
  if ($toggle) $toggle.checked = theme === "dark";
}

function toast(message, kind = "info") {
  const host = document.querySelector("#toastHost");
  if (!host) return;
  const el = document.createElement("div");
  el.className = "toast";
  const tag =
    kind === "success" ? "Success" : kind === "error" ? "Error" : kind === "warn" ? "Notice" : "Info";
  el.innerHTML = `<div class="msg">${escapeHtml(message)}</div><div class="tag">${escapeHtml(tag)}</div>`;
  host.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(8px)";
    el.style.transition = "opacity 240ms ease, transform 240ms ease";
    setTimeout(() => el.remove(), 260);
  }, kind === "error" ? 5200 : 3200);
}

function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("[data-disable-when-busy]").forEach((el) => {
    el.disabled = !!busy;
  });
  const dz = document.querySelector("#dropzone");
  if (dz) dz.setAttribute("aria-busy", busy ? "true" : "false");
}

function setProgress(pct, text) {
  const wrap = document.querySelector("#progressWrap");
  const bar = document.querySelector("#bar");
  const label = document.querySelector("#progressText");
  if (!wrap || !bar || !label) return;
  wrap.classList.add("show");
  bar.style.width = `${clamp(pct, 0, 100).toFixed(1)}%`;
  label.textContent = text || "";
}

function hideProgress() {
  const wrap = document.querySelector("#progressWrap");
  if (wrap) wrap.classList.remove("show");
}

function clearResults() {
  for (const p of state.pages) URL.revokeObjectURL(p.url);
  if (state.combined?.url) URL.revokeObjectURL(state.combined.url);
  if (state.pdfDoc?.destroy) {
    try {
      state.pdfDoc.destroy();
    } catch {
      // ignore
    }
  }
  state.pages = [];
  state.combined = null;
  state.file = null;
  state.pdfData = null;
  state.pdfDoc = null;
  state.pdfNameBase = "document";
  state.pageCount = 0;
  state.pageOrder = [];
  renderGrid();
  renderCombinedPreview();
  updateSizeUI();
  updateStepUI();
  renderReorderUI();
  hideProgress();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function fileToImageBitmap(file) {
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error("Failed to load image."));
      im.src = blobUrl;
    });
    // @ts-ignore - ImageBitmap may not exist in some typings, but supported in modern browsers.
    if (typeof createImageBitmap === "function") return await createImageBitmap(img);
    return img;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

async function imageFileToCanvas(file) {
  const bmp = await fileToImageBitmap(file);
  const w = /** @type {any} */ (bmp).width;
  const h = /** @type {any} */ (bmp).height;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.floor(w);
  canvas.height = Math.floor(h);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(/** @type {any} */ (bmp), 0, 0);
  return { canvas, width: canvas.width, height: canvas.height };
}

function canvasToJpegBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to export canvas to JPEG."))),
      "image/jpeg",
      quality
    );
  });
}

async function encodeCanvasFitUnder(canvas, opts) {
  const targetBytes = opts?.targetBytes ?? null;
  const baseQuality = clamp(opts?.baseQuality ?? 0.85, 0.1, 1.0);
  const minQuality = clamp(opts?.minQuality ?? 0.55, 0.1, 1.0);

  // One-shot if no target.
  if (!targetBytes) {
    const blob = await canvasToJpegBlob(canvas, baseQuality);
    return { blob, usedQuality: baseQuality, tried: 1, pass: true };
  }

  // If already <= target at baseQuality, keep it.
  {
    const b = await canvasToJpegBlob(canvas, baseQuality);
    if (b.size <= targetBytes) return { blob: b, usedQuality: baseQuality, tried: 1, pass: true };
  }

  // Binary search quality to fit under target (resolution unchanged).
  let lo = minQuality;
  let hi = baseQuality;
  let bestBlob = await canvasToJpegBlob(canvas, minQuality);
  let bestQ = minQuality;
  let tried = 2;

  // If even minQuality can't reach the target, return "best clarity" at minQuality (fail).
  if (bestBlob.size > targetBytes) {
    return { blob: bestBlob, usedQuality: minQuality, tried, pass: false };
  }

  // Search highest quality that fits.
  for (let i = 0; i < 10 && hi - lo > 0.02; i++) {
    const mid = (lo + hi) / 2;
    const b = await canvasToJpegBlob(canvas, mid);
    tried++;
    if (b.size <= targetBytes) {
      bestBlob = b;
      bestQ = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }

  return { blob: bestBlob, usedQuality: bestQ, tried, pass: true };
}

async function encodeCanvasSmart(canvas) {
  // NOTE: Browser encoders only expose "quality" via canvas.toBlob; advanced options
  // like chroma subsampling / progressive / metadata stripping are CLI-only.
  const targetBytes = state.fitUnderMax ? Math.floor(state.maxSizeMB * 1024 * 1024) : null;
  const q = clamp(state.quality, 0.1, 1.0);
  if (!state.compress) {
    const blob = await canvasToJpegBlob(canvas, q);
    return { blob, usedQuality: q, tried: 1, pass: true };
  }
  return await encodeCanvasFitUnder(canvas, { targetBytes, baseQuality: q, minQuality: 0.55 });
}

function spacingPx() {
  if (state.spacing === "none") return 0;
  if (state.spacing === "medium") return 40;
  return 20; // small
}

function calcCombinedPlan(pageDims) {
  const spacing = spacingPx();
  const width = Math.max(...pageDims.map((d) => d.width));
  const height =
    pageDims.reduce((sum, d) => sum + d.height, 0) + spacing * Math.max(0, pageDims.length - 1);
  return { width, height, spacing };
}

function canvasSizeGuard(width, height) {
  // Conservative guardrails for canvas limits/memory.
  const maxDim = 16384;
  if (width > maxDim || height > maxDim) {
    return `Combined image is too large (${Math.round(width)}×${Math.round(
      height
    )}). Try DPI 2x, reduce pages, or use Individual Pages.`;
  }
  const pixels = width * height;
  if (pixels > 140_000_000) {
    return `Combined image is very large (~${Math.round(
      pixels / 1_000_000
    )}MP). Try DPI 2x or Individual Pages.`;
  }
  return null;
}

function pickSafeBaseName(fileName) {
  const base = (fileName || "document").replace(/\.[^.]+$/, "");
  const safe = base.replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "document";
}

async function convertPdfFile(file) {
  if (!file) return;
  if (state.busy) return;
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    toast("Please select a PDF file.", "error");
    return;
  }

  clearResults();
  state.file = file;
  state.pdfNameBase = pickSafeBaseName(file.name);
  setBusy(true);

  try {
    setProgress(0, "Loading PDF…");
    state.pdfData = await file.arrayBuffer();
    state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfData }).promise;

    const total = state.pdfDoc.numPages;
    if (!total || total < 1) throw new Error("No pages found in PDF.");

    state.pageCount = total;
    state.pageOrder = Array.from({ length: total }, (_, i) => i + 1);
    setProgress(100, `Loaded ${total} page${total === 1 ? "" : "s"}.`);
    toast(`PDF loaded: ${total} page${total === 1 ? "" : "s"}.`, "success");
    updateStepUI();
    renderReorderUI();
    updateCombinedEstimate();
  } catch (err) {
    console.error(err);
    toast(err?.message ? String(err.message) : "Conversion failed.", "error");
    hideProgress();
  } finally {
    setBusy(false);
    renderActions();
  }
}

function renderGrid() {
  const pages = state.pages;
  const grid = document.querySelector("#grid");
  if (!grid) return;

  if (state.mode !== "individual") {
    grid.innerHTML = "";
    return;
  }

  if (!pages.length) {
    grid.innerHTML = "";
    return;
  }

  grid.innerHTML = pages
    .map((p) => {
      const warn = p.bytes > SIX_MB;
      return `
      <div class="card">
        <div class="thumb">
          <img src="${p.url}" alt="Page ${p.pageNumber} preview" loading="lazy" />
        </div>
        <div class="meta">
          <div class="name" title="${escapeHtml(p.filename)}">Page ${p.pageNumber} • ${escapeHtml(
            bytesToHuman(p.bytes)
          )}${warn ? " • ⚠️ > 6MB" : ""}</div>
          <button class="btn primary" data-download-page="${p.pageNumber}" data-disable-when-busy>Download</button>
        </div>
      </div>
    `;
    })
    .join("");

  grid.querySelectorAll("[data-download-page]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.getAttribute("data-download-page"));
      const p = state.pages.find((x) => x.pageNumber === n);
      if (!p) return;
      downloadBlob(p.blob, p.filename);
      toast("Downloaded. Your images are ready for USCIS upload.", "success");
    });
  });

  // Keep per-page download buttons aligned with current busy state.
  if (state.busy) setBusy(true);
}

function renderActions() {
  const convertBtn = document.querySelector("#convertBtn");
  const downloadAllBtn = document.querySelector("#downloadAll");
  const downloadCombinedBtn = document.querySelector("#downloadCombined");
  const clearBtn = document.querySelector("#clearBtn");
  const imgCompressBtn = document.querySelector("#imgCompressBtn");
  const imgDownloadZipBtn = document.querySelector("#imgDownloadZipBtn");
  const imgClearBtn = document.querySelector("#imgClearBtn");
  if (convertBtn) convertBtn.disabled = state.busy || !state.file || state.pageCount === 0;
  if (downloadAllBtn)
    downloadAllBtn.disabled = state.busy || state.mode !== "individual" || state.pages.length === 0;
  if (downloadCombinedBtn)
    downloadCombinedBtn.disabled = state.busy || state.mode !== "combined" || !state.combined;
  if (clearBtn) clearBtn.disabled = state.busy || (state.pages.length === 0 && !state.file);

  if (imgCompressBtn) imgCompressBtn.disabled = state.busy || state.imgFiles.length === 0;
  if (imgDownloadZipBtn)
    imgDownloadZipBtn.disabled =
      state.busy || state.imgFiles.length === 0 || state.imgFiles.every((x) => !x.compressed?.blob);
  if (imgClearBtn) imgClearBtn.disabled = state.busy || state.imgFiles.length === 0;
}

async function downloadAllAsZip() {
  if (!state.pages.length || state.busy) return;
  setBusy(true);
  try {
    setProgress(0, "Preparing ZIP…");
    const zip = new JSZip();
    const folder = zip.folder(`${state.pdfNameBase}_${state.format.toUpperCase()}`) || zip;

    state.pages.forEach((p) => {
      folder.file(p.filename, p.blob);
    });

    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (meta) => {
        // meta.percent is 0..100
        setProgress(meta.percent || 0, `Building ZIP… ${Math.round(meta.percent || 0)}%`);
      }
    );

    downloadBlob(blob, `${state.pdfNameBase}_${state.format}.zip`);
    toast("Downloaded ZIP. Your images are ready for USCIS upload.", "success");
    setProgress(100, "ZIP ready.");
  } catch (err) {
    console.error(err);
    toast(err?.message ? String(err.message) : "Failed to create ZIP.", "error");
  } finally {
    setBusy(false);
    renderActions();
    setTimeout(() => hideProgress(), 900);
  }
}

function clearImageCompression() {
  state.imgFiles.forEach((x) => {
    if (x.compressed?.url) URL.revokeObjectURL(x.compressed.url);
  });
  state.imgFiles = [];
  renderImageCompressionList();
  renderActions();
}

function renderImageCompressionList() {
  const host = document.querySelector("#imgList");
  const summary = document.querySelector("#imgSummary");
  if (!host || !summary) return;

  if (!state.imgFiles.length) {
    host.innerHTML = "";
    summary.textContent = "";
    return;
  }

  const total = state.imgFiles.length;
  const done = state.imgFiles.filter((x) => x.compressed?.blob).length;
  const passed = state.imgFiles.filter((x) => x.compressed?.pass).length;
  const failed = done - passed;

  // Calculate totals for before/after/saved
  const totalBefore = state.imgFiles.reduce((s, x) => s + x.origBytes, 0);
  const totalAfter = state.imgFiles.filter((x) => x.compressed?.blob).reduce((s, x) => s + x.compressed.bytes, 0);
  const savedPct = totalBefore > 0 && totalAfter > 0 ? Math.round((1 - totalAfter / totalBefore) * 100) : 0;
  const pngCount = state.imgFiles.filter((x) => x.wasPng).length;

  let summaryText = "";
  if (done) {
    summaryText = `Compressed ${done}/${total} • Total: ${bytesToHuman(totalBefore)} → ${bytesToHuman(totalAfter)} (−${savedPct}%) • Pass: ${passed} • Fail: ${failed}`;
  } else {
    summaryText = `Loaded ${total} image${total === 1 ? "" : "s"}`;
    if (pngCount > 0) summaryText += ` (${pngCount} PNG → JPG)`;
    summaryText += `.`;
  }
  summary.textContent = summaryText;

  host.innerHTML = state.imgFiles
    .map((x) => {
      const out = x.compressed;
      const outSize = out ? bytesToHuman(out.bytes) : "—";
      const outQ = out ? `${Math.round(out.usedQuality * 100)}%` : "—";
      const pass = out ? out.pass : null;
      const tag =
        pass == null
          ? ""
          : pass
            ? `<span class="mini" style="color:var(--success);">PASS</span>`
            : `<span class="mini" style="color:var(--danger);">FAIL</span>`;
      const warn =
        out && !out.pass
          ? `<div class="mini" style="margin-top:6px;color:var(--muted);">Best clarity could not reach ≤ ${state.imgTargetKB} KB without dropping below min quality. Output is ${bytesToHuman(
              out.bytes
            )}.</div>`
          : "";
      const pngTag = x.wasPng ? `<span class="mini" style="color:var(--accent);">PNG→JPG</span>` : "";
      const resText = x.width && x.height ? `${x.width}×${x.height} (unchanged)` : "—";

      return `
      <div class="card">
        <div class="thumb">
          ${
            out?.url
              ? `<img src="${out.url}" alt="Compressed preview" loading="lazy" />`
              : `<div class="mini">Not compressed yet</div>`
          }
        </div>
        <div class="meta" style="flex-direction:column; align-items:stretch; gap:8px;">
          <div style="display:flex; justify-content:space-between; gap:10px; width:100%;">
            <div class="name" title="${escapeHtml(x.file.name)}" style="flex:1;">${escapeHtml(x.file.name)}</div>
            ${pngTag}
            ${tag}
          </div>
          <div class="mini">Resolution: ${resText}</div>
          <div class="mini">Before: ${escapeHtml(bytesToHuman(x.origBytes))} → After: ${escapeHtml(
            outSize
          )} • Quality used: ${escapeHtml(outQ)}</div>
          <div style="display:flex; gap:10px; justify-content:space-between; width:100%;">
            <button class="btn primary" data-img-download="${escapeHtml(x.id)}" ${
              out?.blob ? "" : "disabled"
            }>Download</button>
            <button class="btn" data-img-retry="${escapeHtml(x.id)}" data-disable-when-busy ${
              state.busy ? "disabled" : ""
            }>Recompress</button>
          </div>
          ${warn}
        </div>
      </div>
    `;
    })
    .join("");

  host.querySelectorAll("[data-img-download]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-img-download");
      const item = state.imgFiles.find((x) => x.id === id);
      if (!item?.compressed?.blob) return;
      const base = pickSafeBaseName(item.file.name);
      const ext = state.format;
      downloadBlob(item.compressed.blob, `${base}-uscis.${ext}`);
      toast("Downloaded. Your images are ready for USCIS upload.", "success");
    });
  });

  host.querySelectorAll("[data-img-retry]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.getAttribute("data-img-retry");
      const item = state.imgFiles.find((x) => x.id === id);
      if (!item) return;
      await compressImages([item]);
    });
  });
}

async function addImages(files) {
  const list = Array.from(files || []).filter((f) => isAcceptedImage(f));
  if (!list.length) {
    toast("Please select JPG/JPEG/PNG files.", "error");
    return;
  }
  const pngCount = list.filter((f) => isPng(f)).length;
  for (const f of list) {
    const id = uid();
    // width/height determined lazily on compress; store 0 for now
    // isPng flag helps track source format for warnings
    state.imgFiles.push({ id, file: f, origBytes: f.size, width: 0, height: 0, wasPng: isPng(f) });
  }
  if (pngCount > 0) {
    toast(`${pngCount} PNG file${pngCount > 1 ? "s" : ""} will be converted to JPG.`, "warn");
  }
  renderImageCompressionList();
  renderActions();
}

async function compressImages(subset) {
  const items = subset || state.imgFiles;
  if (!items.length || state.busy) return;

  const targetBytes = state.imgUscisPreset ? 600 * 1024 : Math.floor(state.imgTargetKB * 1024);
  const minQ = clamp(state.imgMinQuality, 0.1, 1.0);
  const baseQ = clamp(state.quality, 0.1, 1.0);

  setBusy(true);
  try {
    const total = items.length;
    for (let i = 0; i < total; i++) {
      const item = items[i];
      setProgress(((i + 1) / total) * 100, `Compressing ${i + 1} / ${total}…`);

      // Clean old
      if (item.compressed?.url) URL.revokeObjectURL(item.compressed.url);

      const { canvas, width, height } = await imageFileToCanvas(item.file);
      item.width = width;
      item.height = height;

      const res = await encodeCanvasFitUnder(canvas, {
        targetBytes,
        baseQuality: baseQ,
        minQuality: minQ
      });

      item.compressed = {
        blob: res.blob,
        url: URL.createObjectURL(res.blob),
        bytes: res.blob.size,
        usedQuality: res.usedQuality,
        tried: res.tried,
        pass: res.blob.size <= targetBytes && res.pass
      };

      renderImageCompressionList();
      await new Promise((r) => setTimeout(r, 0));
    }

    toast("Compression complete. Review pass/fail before downloading.", "success");
  } catch (e) {
    console.error(e);
    toast(e?.message ? String(e.message) : "Image compression failed.", "error");
  } finally {
    setBusy(false);
    hideProgress();
    renderActions();
  }
}

async function downloadCompressedImagesZip() {
  const done = state.imgFiles.filter((x) => x.compressed?.blob);
  if (!done.length || state.busy) return;
  setBusy(true);
  try {
    setProgress(0, "Preparing ZIP…");
    const zip = new JSZip();
    const folder = zip.folder(`uscis_compressed_${state.format.toUpperCase()}`) || zip;

    done.forEach((x) => {
      const base = pickSafeBaseName(x.file.name);
      const ext = state.format;
      folder.file(`${base}-uscis.${ext}`, x.compressed.blob);
    });

    const blob = await zip.generateAsync(
      { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
      (meta) => setProgress(meta.percent || 0, `Building ZIP… ${Math.round(meta.percent || 0)}%`)
    );
    downloadBlob(blob, `uscis-compressed-${state.format}.zip`);
    toast("Downloaded ZIP. Your images are ready for USCIS upload.", "success");
  } finally {
    setBusy(false);
    renderActions();
    setTimeout(() => hideProgress(), 900);
  }
}

function updateSizeUI() {
  const host = document.querySelector("#sizeHost");
  const warnHost = document.querySelector("#warnHost");
  if (!host || !warnHost) return;

  let line = "Convert to see file sizes";
  let warn = "";

  if (state.mode === "individual" && state.pages.length) {
    const totalBytes = state.pages.reduce((s, p) => s + p.bytes, 0);
    line = `Estimated total download: ${bytesToHuman(totalBytes)} (pages: ${state.pages.length})`;
    const over = state.pages.filter((p) => p.bytes > SIX_MB);
    if (over.length) {
      warn = `Warning: ${over.length} file${over.length === 1 ? "" : "s"} exceed 6MB (common USCIS limit). Try lowering quality, using DPI 2x, or splitting your document.`;
    }
  }

  if (state.mode === "combined" && state.combined) {
    line = `Combined image: ${state.combined.width}×${state.combined.height} • ${bytesToHuman(
      state.combined.bytes
    )}`;
    if (state.combined.bytes > SIX_MB) {
      warn =
        "Warning: combined output exceeds 6MB (common USCIS limit). Try lower quality, DPI 2x, or use Individual Pages.";
    }
  }

  host.textContent = line;
  warnHost.innerHTML = warn ? `<div class="warn">${escapeHtml(warn)}</div>` : "";
}

function updateStepUI() {
  const s1 = document.querySelector("#step1");
  const s2 = document.querySelector("#step2");
  const s3 = document.querySelector("#step3");
  const s4 = document.querySelector("#step4");
  if (!s1 || !s2 || !s3 || !s4) return;

  const uploaded = !!state.file && state.pageCount > 0;
  const converted =
    (state.mode === "individual" && state.pages.length > 0) || (state.mode === "combined" && !!state.combined);

  s1.className = `step ${uploaded ? "done" : "active"}`;
  s2.className = `step ${uploaded ? "active" : ""} ${converted ? "done" : ""}`;
  s3.className = `step ${uploaded && !converted ? "active" : ""} ${converted ? "done" : ""}`;
  s4.className = `step ${converted ? "active" : ""} ${converted ? "done" : ""}`;

  const pageCountEl = document.querySelector("#pageCountLabel");
  if (pageCountEl) pageCountEl.textContent = uploaded ? `${state.pageCount}` : "—";
}

function renderCombinedPreview() {
  const host = document.querySelector("#combinedPreviewHost");
  if (!host) return;
  if (state.mode !== "combined" || !state.combined) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `
    <div class="previewSingle">
      <div class="top">
        <div class="mini">${escapeHtml(state.combined.filename)} • ${escapeHtml(
          bytesToHuman(state.combined.bytes)
        )}</div>
        <button id="downloadCombined" class="btn primary" type="button" data-disable-when-busy>Download JPG</button>
      </div>
      <div class="imgWrap">
        <img src="${state.combined.url}" alt="Combined document preview" />
      </div>
    </div>
  `;

  host.querySelector("#downloadCombined")?.addEventListener("click", () => {
    if (!state.combined) return;
    downloadBlob(state.combined.blob, state.combined.filename);
    toast("Downloaded. Your images are ready for USCIS upload.", "success");
  });

  if (state.busy) setBusy(true);
  renderActions();
}

let _estimateToken = 0;
async function updateCombinedEstimate() {
  const el = document.querySelector("#combinedPlan");
  if (!el) return;
  if (!state.pdfDoc || state.pageCount < 1 || state.mode !== "combined") {
    el.textContent = "";
    return;
  }
  const token = ++_estimateToken;
  el.textContent = "Estimating combined dimensions…";

  try {
    const dpi = state.dpiScale === 3 ? 3 : 2;
    const order = state.pageOrder.length ? state.pageOrder : Array.from({ length: state.pageCount }, (_, i) => i + 1);
    const dims = [];
    for (let i = 0; i < order.length; i++) {
      if (token !== _estimateToken) return;
      const page = await state.pdfDoc.getPage(order[i]);
      const vp = page.getViewport({ scale: dpi });
      dims.push({ width: Math.floor(vp.width), height: Math.floor(vp.height) });
    }
    const plan = calcCombinedPlan(dims);
    const guard = canvasSizeGuard(plan.width, plan.height);
    el.textContent = `Estimated combined: ${plan.width}×${plan.height} (${order.length} pages, spacing ${plan.spacing}px)${
      guard ? " • Too large (adjust settings)" : ""
    }`;
  } catch {
    el.textContent = "";
  }
}

function renderReorderUI() {
  const host = document.querySelector("#reorderHost");
  if (!host) return;
  if (!state.pdfDoc || state.pageCount < 2 || state.mode !== "combined") {
    host.innerHTML = "";
    return;
  }
  const order = state.pageOrder.length ? state.pageOrder : Array.from({ length: state.pageCount }, (_, i) => i + 1);
  host.innerHTML = `
    <div class="mini" style="margin-top:12px;">Reorder pages before combining (drag to reorder):</div>
    <div class="reorderList" id="reorderList">
      ${order
        .map(
          (n) => `
        <div class="reorderItem" draggable="true" data-page="${n}">
          <div class="handle">≡ <span>Page ${n}</span></div>
          <div class="mini">Drag</div>
        </div>
      `
        )
        .join("")}
    </div>
  `;

  const list = host.querySelector("#reorderList");
  let dragging = null;

  list.querySelectorAll(".reorderItem").forEach((item) => {
    item.addEventListener("dragstart", (e) => {
      dragging = item;
      item.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      item.classList.remove("dragging");
      dragging = null;
      // Commit new order
      const next = Array.from(list.querySelectorAll(".reorderItem")).map((x) =>
        Number(x.getAttribute("data-page"))
      );
      state.pageOrder = next;
      updateCombinedEstimate();
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      const target = item;
      if (!dragging || dragging === target) return;
      const rect = target.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      list.insertBefore(dragging, after ? target.nextSibling : target);
    });
  });
}

async function runConversion() {
  if (!state.pdfDoc || !state.file || state.pageCount < 1 || state.busy) return;

  // clear prior outputs
  state.pages.forEach((p) => URL.revokeObjectURL(p.url));
  if (state.combined?.url) URL.revokeObjectURL(state.combined.url);
  state.pages = [];
  state.combined = null;
  renderGrid();
  renderCombinedPreview();
  updateSizeUI();
  updateStepUI();

  setBusy(true);
  try {
    const dpi = state.dpiScale === 3 ? 3 : 2;
    const order = state.pageOrder.length ? state.pageOrder : Array.from({ length: state.pageCount }, (_, i) => i + 1);

    if (state.mode === "individual") {
      toast("Converting pages to JPG…", "info");
      const out = [];
      for (let i = 0; i < order.length; i++) {
        const pageNumber = order[i];
        const page = await state.pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: dpi });

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: ctx, viewport }).promise;

        const { blob } = await encodeCanvasSmart(canvas);
        const ext = state.format;
        const filename = `${state.pdfNameBase}-page${pageNumber}.${ext}`;
        const url = URL.createObjectURL(blob);
        out.push({
          pageNumber,
          blob,
          url,
          filename,
          bytes: blob.size,
          width: canvas.width,
          height: canvas.height
        });
        state.pages = out;

        setProgress(((i + 1) / order.length) * 100, `Rendering page ${i + 1} / ${order.length}…`);
        renderGrid();
        updateSizeUI();
        await new Promise((r) => setTimeout(r, 0));
      }
      setProgress(100, "Done.");
      toast("Conversion complete.", "success");
    } else {
      toast("Building combined JPG…", "info");
      // dimensions-only pass
      const dims = [];
      for (let i = 0; i < order.length; i++) {
        const page = await state.pdfDoc.getPage(order[i]);
        const vp = page.getViewport({ scale: dpi });
        dims.push({ pageNumber: order[i], width: Math.floor(vp.width), height: Math.floor(vp.height) });
      }
      const plan = calcCombinedPlan(dims);
      const guard = canvasSizeGuard(plan.width, plan.height);
      if (guard) throw new Error(guard);

      const combinedCanvas = document.createElement("canvas");
      const combinedCtx = combinedCanvas.getContext("2d", { alpha: false });
      combinedCanvas.width = plan.width;
      combinedCanvas.height = plan.height;
      combinedCtx.fillStyle = "#ffffff";
      combinedCtx.fillRect(0, 0, combinedCanvas.width, combinedCanvas.height);

      let y = 0;
      for (let i = 0; i < dims.length; i++) {
        const pageNumber = dims[i].pageNumber;
        const page = await state.pdfDoc.getPage(pageNumber);
        const viewport = page.getViewport({ scale: dpi });

        const tmp = document.createElement("canvas");
        const tctx = tmp.getContext("2d", { alpha: false });
        tmp.width = Math.floor(viewport.width);
        tmp.height = Math.floor(viewport.height);
        await page.render({ canvasContext: tctx, viewport }).promise;

        combinedCtx.drawImage(tmp, 0, y);
        y += tmp.height + plan.spacing;

        setProgress(((i + 1) / dims.length) * 100, `Stacking page ${i + 1} / ${dims.length}…`);
        await new Promise((r) => setTimeout(r, 0));
      }

      const { blob } = await encodeCanvasSmart(combinedCanvas);
      const ext = state.format;
      const filename = `${state.pdfNameBase}-combined.${ext}`;
      state.combined = {
        blob,
        url: URL.createObjectURL(blob),
        filename,
        bytes: blob.size,
        width: combinedCanvas.width,
        height: combinedCanvas.height
      };
      setProgress(100, "Done.");
      renderCombinedPreview();
      updateSizeUI();
      toast("Combined image ready.", "success");
    }
  } catch (err) {
    console.error(err);
    toast(err?.message ? String(err.message) : "Conversion failed.", "error");
    hideProgress();
  } finally {
    setBusy(false);
    renderActions();
    updateStepUI();
    if (state.mode === "combined") updateCombinedEstimate();
  }
}

function mount() {
  const savedTheme = localStorage.getItem("pdf2img:theme");
  setTheme(savedTheme === "dark" ? "dark" : "light");

  $app.innerHTML = `
    <div class="container">
      <div class="header">
        <div class="title">
          <h1>PDF to JPG Converter for USCIS</h1>
          <p>Convert your documents to USCIS-accepted format</p>
        </div>
        <div class="toolbar">
          <div class="badge" title="Your documents never leave your device">Local processing • No uploads</div>
          <label class="toggle" title="Toggle dark mode">
            <span style="font-size:12px;color:var(--muted);">Dark</span>
            <input id="darkToggle" type="checkbox" />
          </label>
        </div>
      </div>

      <div class="panel">
        <div class="control" style="margin-bottom:12px;">
          <label>
            <span>Tool</span>
            <span class="mini">PDF conversion or Image compression</span>
          </label>
          <div class="segmented" role="tablist" aria-label="Tool mode">
            <button id="toolPdf" type="button" class="active" data-disable-when-busy>PDF → JPG</button>
            <button id="toolImg" type="button" data-disable-when-busy>Image → Image</button>
          </div>
        </div>

        <div id="pdfSection">
        <div class="steps" aria-label="Steps">
          <div id="step1" class="step active">
            <div class="k">Step 1</div>
            <div class="v">Upload PDF</div>
          </div>
          <div id="step2" class="step">
            <div class="k">Step 2</div>
            <div class="v">Choose Mode</div>
          </div>
          <div id="step3" class="step">
            <div class="k">Step 3</div>
            <div class="v">Adjust Settings</div>
          </div>
          <div id="step4" class="step">
            <div class="k">Step 4</div>
            <div class="v">Preview & Download</div>
          </div>
        </div>

        <div id="dropzone" class="dropzone" role="button" tabindex="0" aria-label="Upload PDF">
          <div class="icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M7 7.5V5a2 2 0 0 1 2-2h5l3 3v1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M7 17V7.5h10V21H9a2 2 0 0 1-2-2v-2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M12 10v6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              <path d="M9.5 12.5 12 10l2.5 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <div>
            <div style="font-weight:650; letter-spacing:-0.01em;">Drop a PDF here</div>
            <div class="hint">Accepted: .pdf • We’ll show page count after upload</div>
          </div>
          <button class="btn primary" id="pickBtn" type="button" data-disable-when-busy>Choose PDF</button>
          <input id="fileInput" type="file" accept="application/pdf,.pdf" hidden />
        </div>

        <div class="controls">
          <div class="control">
            <label>
              <span>Mode</span>
              <span class="mini">Pages: <span id="pageCountLabel">—</span></span>
            </label>
            <div class="segmented" role="tablist" aria-label="Conversion mode">
              <button id="modeIndividual" type="button" class="active" data-disable-when-busy>Individual Pages</button>
              <button id="modeCombined" type="button" data-disable-when-busy>Single Combined Image</button>
            </div>
          </div>

          <div class="control">
            <label>
              <span>Output format</span>
              <span id="formatLabel" style="font-variant-numeric: tabular-nums;">.${escapeHtml(state.format)}</span>
            </label>
            <select id="formatSelect" data-disable-when-busy>
              <option value="jpg">JPG</option>
              <option value="jpeg">JPEG</option>
            </select>
          </div>

          <div class="control">
            <label>
              <span>Quality (legibility)</span>
              <span id="qualityLabel" style="font-variant-numeric: tabular-nums;">${Math.round(
                state.quality * 100
              )}%</span>
            </label>
            <input id="qualityRange" type="range" min="10" max="100" step="1" value="${Math.round(
              state.quality * 100
            )}" data-disable-when-busy />
          </div>

          <div class="control">
            <label>
              <span>Clarity (DPI)</span>
              <span class="mini">2x recommended</span>
            </label>
            <select id="dpiSelect" data-disable-when-busy>
              <option value="2">2x</option>
              <option value="3">3x (sharper, larger)</option>
            </select>
          </div>

          <div class="control" id="spacingControl" style="display:none;">
            <label>
              <span>Page spacing (combined)</span>
              <span class="mini">Helps readability</span>
            </label>
            <select id="spacingSelect" data-disable-when-busy>
              <option value="none">None</option>
              <option value="small" selected>Small</option>
              <option value="medium">Medium</option>
            </select>
          </div>

          <div class="control">
            <label>
              <span>Estimate</span>
              <span class="mini">6MB USCIS check</span>
            </label>
            <div class="hint" id="sizeHost">Convert to see file sizes</div>
          </div>

          <div class="control">
            <label>
              <span>Smart Compression</span>
              <span class="mini">No resolution loss</span>
            </label>
            <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
              <label class="mini" style="display:flex; gap:8px; align-items:center;">
                <input id="compressToggle" type="checkbox" ${state.compress ? "checked" : ""} data-disable-when-busy />
                Compress
              </label>
              <label class="mini" style="display:flex; gap:8px; align-items:center;">
                <input id="fitToggle" type="checkbox" ${state.fitUnderMax ? "checked" : ""} data-disable-when-busy />
                Fit under
              </label>
              <input id="maxSizeInput" type="number" min="1" max="25" step="0.5" value="${state.maxSizeMB}" style="width:90px;" data-disable-when-busy />
              <span class="mini">MB</span>
            </div>
            <div class="hint mini">Advanced encoder flags (subsampling/progressive/metadata) are available via CLI.</div>
          </div>
        </div>

        <div id="combinedPlan" class="mini" style="margin-top:10px;"></div>
        <div id="reorderHost"></div>
        <div id="warnHost"></div>

        <div id="progressWrap" class="progressWrap">
          <div class="progress"><div id="bar" class="bar"></div></div>
          <div id="progressText" class="progressText"></div>
        </div>

        <div class="actions">
          <div class="left">
            <button id="convertBtn" class="btn primary" type="button" data-disable-when-busy disabled>
              Convert to JPG
            </button>
            <button id="downloadAll" class="btn" type="button" data-disable-when-busy disabled>
              Download All (ZIP)
            </button>
            <button id="clearBtn" class="btn danger" type="button" data-disable-when-busy disabled>
              Start Over
            </button>
          </div>
          <div class="right">
            <div class="hint" id="fileHint"></div>
          </div>
        </div>

        <div class="notice">
          <strong>Privacy:</strong> Your documents are processed locally in your browser. No files are uploaded to any server.
        </div>
        </div> <!-- /pdfSection -->

        <div id="imgSection" style="display:none;">
          <div class="steps" aria-label="Steps">
            <div class="step active">
              <div class="k">Step 1</div>
              <div class="v">Upload Images</div>
            </div>
            <div class="step">
              <div class="k">Step 2</div>
              <div class="v">USCIS-safe settings</div>
            </div>
            <div class="step">
              <div class="k">Step 3</div>
              <div class="v">Compress & download</div>
            </div>
            <div class="step">
              <div class="k">Step 4</div>
              <div class="v">Verify ≤ 600 KB</div>
            </div>
          </div>

          <div id="imgDropzone" class="dropzone" role="button" tabindex="0" aria-label="Upload JPG/JPEG/PNG">
            <div class="icon" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <path d="M4 7a2 2 0 0 1 2-2h5l2 2h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                <path d="M8 16l2-2 2 2 4-4 2 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <div>
              <div style="font-weight:650; letter-spacing:-0.01em;">Drop JPG/JPEG/PNG files here</div>
              <div class="hint">USCIS-safe compression (≤ 600 KB, no resize). PNG converts to JPG. Batch supported.</div>
            </div>
            <button class="btn primary" id="imgPickBtn" type="button" data-disable-when-busy>Choose Images</button>
            <input id="imgInput" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" multiple hidden />
          </div>

          <div class="controls">
            <div class="control">
              <label>
                <span>USCIS-safe compression (≤ 600 KB, no resize)</span>
                <span class="mini">Default</span>
              </label>
              <label class="mini" style="display:flex; gap:8px; align-items:center;">
                <input id="imgUscisPreset" type="checkbox" ${state.imgUscisPreset ? "checked" : ""} data-disable-when-busy />
                Enable preset
              </label>
              <div class="hint mini">Preserves resolution. Encoder tuning is quality-only in browser; full encoder knobs are in CLI.</div>
            </div>

            <div class="control">
              <label>
                <span>Fit under</span>
                <span class="mini">editable</span>
              </label>
              <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <input id="imgTargetKB" type="number" min="50" max="6000" step="10" value="${state.imgTargetKB}" style="width:110px;" data-disable-when-busy />
                <span class="mini">KB</span>
              </div>
              <div class="hint mini">Recommended: 600 KB for USCIS-style limits.</div>
            </div>

            <div class="control">
              <label>
                <span>Best-clarity safeguard</span>
                <span class="mini">min quality</span>
              </label>
              <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                <input id="imgMinQuality" type="number" min="0.1" max="0.95" step="0.05" value="${state.imgMinQuality}" style="width:110px;" data-disable-when-busy />
                <span class="mini">(0.1–0.95)</span>
              </div>
              <div class="hint mini">If target can’t be met above this quality, we output “best clarity” and mark FAIL.</div>
            </div>
          </div>

          <div class="actions">
            <div class="left">
              <button id="imgCompressBtn" class="btn primary" type="button" data-disable-when-busy disabled>Compress Images</button>
              <button id="imgDownloadZipBtn" class="btn" type="button" data-disable-when-busy disabled>Download All (ZIP)</button>
              <button id="imgClearBtn" class="btn danger" type="button" data-disable-when-busy disabled>Clear Images</button>
            </div>
            <div class="right">
              <div class="hint" id="imgSummary"></div>
            </div>
          </div>

          <div id="imgList" class="grid"></div>

          <div class="notice">
            <strong>Privacy:</strong> Your images are processed locally in your browser. No files are uploaded to any server.
          </div>
        </div> <!-- /imgSection -->
      </div>

      <div id="grid" class="grid"></div>
      <div id="combinedPreviewHost"></div>
    </div>

    <div id="toastHost" class="toastHost" aria-live="polite" aria-atomic="true"></div>
  `;

  const dropzone = document.querySelector("#dropzone");
  const pickBtn = document.querySelector("#pickBtn");
  const fileInput = document.querySelector("#fileInput");
  const toolPdf = document.querySelector("#toolPdf");
  const toolImg = document.querySelector("#toolImg");
  const pdfSection = document.querySelector("#pdfSection");
  const imgSection = document.querySelector("#imgSection");

  const imgDropzone = document.querySelector("#imgDropzone");
  const imgPickBtn = document.querySelector("#imgPickBtn");
  const imgInput = document.querySelector("#imgInput");
  const imgUscisPreset = document.querySelector("#imgUscisPreset");
  const imgTargetKB = document.querySelector("#imgTargetKB");
  const imgMinQuality = document.querySelector("#imgMinQuality");
  const imgCompressBtn = document.querySelector("#imgCompressBtn");
  const imgDownloadZipBtn = document.querySelector("#imgDownloadZipBtn");
  const imgClearBtn = document.querySelector("#imgClearBtn");
  const formatSelect = document.querySelector("#formatSelect");
  const formatLabel = document.querySelector("#formatLabel");
  const qualityRange = document.querySelector("#qualityRange");
  const qualityLabel = document.querySelector("#qualityLabel");
  const dpiSelect = document.querySelector("#dpiSelect");
  const spacingControl = document.querySelector("#spacingControl");
  const spacingSelect = document.querySelector("#spacingSelect");
  const modeIndividual = document.querySelector("#modeIndividual");
  const modeCombined = document.querySelector("#modeCombined");
  const convertBtn = document.querySelector("#convertBtn");
  const compressToggle = document.querySelector("#compressToggle");
  const fitToggle = document.querySelector("#fitToggle");
  const maxSizeInput = document.querySelector("#maxSizeInput");
  const downloadAllBtn = document.querySelector("#downloadAll");
  const clearBtn = document.querySelector("#clearBtn");
  const fileHint = document.querySelector("#fileHint");
  const darkToggle = document.querySelector("#darkToggle");

  formatSelect.value = state.format;
  dpiSelect.value = String(state.dpiScale);
  darkToggle.checked = state.theme === "dark";

  darkToggle.addEventListener("change", () => setTheme(darkToggle.checked ? "dark" : "light"));

  function setToolMode(mode) {
    state.appMode = mode === "img" ? "img" : "pdf";
    toolPdf.classList.toggle("active", state.appMode === "pdf");
    toolImg.classList.toggle("active", state.appMode === "img");
    pdfSection.style.display = state.appMode === "pdf" ? "" : "none";
    imgSection.style.display = state.appMode === "img" ? "" : "none";
    hideProgress();
    renderActions();
  }

  toolPdf.addEventListener("click", () => setToolMode("pdf"));
  toolImg.addEventListener("click", () => setToolMode("img"));

  function setFileHint(file) {
    if (!fileHint) return;
    if (!file) {
      fileHint.textContent = "";
      return;
    }
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    fileHint.textContent = `${file.name} • ${sizeMB} MB`;
  }

  pickBtn.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target && /** @type {HTMLElement} */ (e.target).closest("button")) return;
    fileInput.click();
  });
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    setFileHint(f);
    await convertPdfFile(f);
  });

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.add("hover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.classList.remove("hover");
    });
  });

  dropzone.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    const f = dt?.files?.[0];
    if (!f) return;
    if (state.busy) return;
    fileInput.value = "";
    setFileHint(f);
    await convertPdfFile(f);
  });

  formatSelect.addEventListener("change", () => {
    state.format = formatSelect.value === "jpeg" ? "jpeg" : "jpg";
    if (formatLabel) formatLabel.textContent = `.${state.format}`;
    toast(`Format set to .${state.format}`, "info");
  });

  qualityRange.addEventListener("input", () => {
    const v = Number(qualityRange.value) / 100;
    state.quality = clamp(v, 0.1, 1.0);
    qualityLabel.textContent = `${Math.round(state.quality * 100)}%`;
  });

  qualityRange.addEventListener("change", () => {
    toast(`Quality set to ${Math.round(state.quality * 100)}%`, "info");
  });

  dpiSelect.addEventListener("change", () => {
    state.dpiScale = dpiSelect.value === "3" ? 3 : 2;
    toast(`Clarity set to ${state.dpiScale}x`, "info");
    if (state.mode === "combined") updateCombinedEstimate();
  });

  spacingSelect.addEventListener("change", () => {
    state.spacing = ["none", "small", "medium"].includes(spacingSelect.value) ? spacingSelect.value : "small";
    toast(`Spacing set to ${state.spacing}`, "info");
    if (state.mode === "combined") updateCombinedEstimate();
  });

  compressToggle.addEventListener("change", () => {
    state.compress = !!compressToggle.checked;
    toast(state.compress ? "Compression enabled (resolution preserved)." : "Compression disabled.", "info");
  });

  fitToggle.addEventListener("change", () => {
    state.fitUnderMax = !!fitToggle.checked;
    toast(state.fitUnderMax ? "Fit-under max size enabled." : "Fit-under max size disabled.", "info");
  });

  maxSizeInput.addEventListener("change", () => {
    const v = Number(maxSizeInput.value);
    state.maxSizeMB = clamp(v, 1, 25);
    maxSizeInput.value = String(state.maxSizeMB);
    toast(`Max size set to ${state.maxSizeMB} MB`, "info");
  });

  function setMode(mode) {
    state.mode = mode === "combined" ? "combined" : "individual";
    modeIndividual.classList.toggle("active", state.mode === "individual");
    modeCombined.classList.toggle("active", state.mode === "combined");
    spacingControl.style.display = state.mode === "combined" ? "" : "none";

    // Clear outputs when switching modes
    state.pages.forEach((p) => URL.revokeObjectURL(p.url));
    if (state.combined?.url) URL.revokeObjectURL(state.combined.url);
    state.pages = [];
    state.combined = null;
    renderGrid();
    renderCombinedPreview();
    renderReorderUI();
    updateSizeUI();
    updateStepUI();
    renderActions();
    if (state.mode === "combined") updateCombinedEstimate();
  }

  modeIndividual.addEventListener("click", () => setMode("individual"));
  modeCombined.addEventListener("click", () => setMode("combined"));

  convertBtn.addEventListener("click", runConversion);
  downloadAllBtn.addEventListener("click", downloadAllAsZip);

  clearBtn.addEventListener("click", () => {
    clearResults();
    setFileHint(null);
    fileInput.value = "";
    renderActions();
    toast("Start over ready.", "success");
  });

  // Image -> Image events
  imgPickBtn.addEventListener("click", () => imgInput.click());
  imgDropzone.addEventListener("click", (e) => {
    if (e.target && /** @type {HTMLElement} */ (e.target).closest("button")) return;
    imgInput.click();
  });
  imgDropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") imgInput.click();
  });
  imgInput.addEventListener("change", async () => {
    const files = imgInput.files;
    if (!files?.length) return;
    await addImages(files);
    imgInput.value = "";
  });
  ["dragenter", "dragover"].forEach((evt) => {
    imgDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      imgDropzone.classList.add("hover");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    imgDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      imgDropzone.classList.remove("hover");
    });
  });
  imgDropzone.addEventListener("drop", async (e) => {
    const dt = e.dataTransfer;
    if (!dt?.files?.length) return;
    if (state.busy) return;
    await addImages(dt.files);
  });

  imgUscisPreset.addEventListener("change", () => {
    state.imgUscisPreset = !!imgUscisPreset.checked;
    if (state.imgUscisPreset) {
      state.imgTargetKB = 600;
      imgTargetKB.value = String(state.imgTargetKB);
    }
    toast(state.imgUscisPreset ? "USCIS-safe preset enabled (≤ 600 KB)." : "Preset disabled.", "info");
  });
  imgTargetKB.addEventListener("change", () => {
    const v = Number(imgTargetKB.value);
    state.imgTargetKB = clamp(v, 50, 6000);
    imgTargetKB.value = String(state.imgTargetKB);
    if (state.imgTargetKB !== 600) {
      state.imgUscisPreset = false;
      imgUscisPreset.checked = false;
    }
    toast(`Target set to ≤ ${state.imgTargetKB} KB`, "info");
  });
  imgMinQuality.addEventListener("change", () => {
    const v = Number(imgMinQuality.value);
    state.imgMinQuality = clamp(v, 0.1, 0.95);
    imgMinQuality.value = String(state.imgMinQuality);
    toast(`Min quality safeguard: ${Math.round(state.imgMinQuality * 100)}%`, "info");
  });

  imgCompressBtn.addEventListener("click", async () => {
    await compressImages();
  });
  imgDownloadZipBtn.addEventListener("click", downloadCompressedImagesZip);
  imgClearBtn.addEventListener("click", () => {
    clearImageCompression();
    toast("Cleared images.", "success");
  });

  setMode("individual");
  setToolMode("pdf");
  updateStepUI();
  updateSizeUI();
  renderImageCompressionList();
  renderActions();
}

mount();

