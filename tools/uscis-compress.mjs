import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const SIX_MB = 6 * 1024 * 1024;

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function printHelp() {
  console.log(`
USCIS JPG/JPEG Smart Compressor (preserve resolution)

Usage:
  node tools/uscis-compress.mjs [options] <fileOrDir...>

Options:
  --compress                 Enable compression (default: true)
  --quality <0.1..1.0>       JPEG quality target (default: 0.85)
  --max-size <size>          Target max output size (e.g. 6mb, 600kb, 5000000)
  --fit-under <size>         Alias for --max-size (recommended: 600kb for USCIS-style limits)
  --preserve-resolution      Keep pixel dimensions (default: on; tool never resizes)
  --subsample <4:4:4|4:2:0>  Chroma subsampling (default: 4:4:4 for text)
  --progressive              Write progressive JPEG (default: off)
  --strip-metadata           Strip metadata (default: on)
  --min-quality <0.1..1.0>   Safeguard against aggressive artifacts (default: 0.55)
  --out-dir <dir>            Output directory (default: out)
  --suffix <text>            Output suffix before extension (default: -uscis)
  --overwrite                Overwrite output files (default: off)
  --recursive                If inputs are directories, scan recursively
  --help                     Show help

Notes:
  - Inputs must be .jpg/.jpeg (this is a JPEG compressor, not a converter).
  - Deterministic output: same input + flags => same output (best effort).
  - USCIS commonly rejects files > 6MB; this tool warns when outputs exceed that.
`.trim());
}

function parseArgs(argv) {
  const args = {
    compress: true,
    quality: 0.85,
    maxSize: null,
    fitUnder: null,
    preserveResolution: true,
    subsample: "4:4:4",
    progressive: false,
    stripMetadata: true,
    minQuality: 0.55,
    outDir: "out",
    suffix: "-uscis",
    overwrite: false,
    recursive: false,
    inputs: []
  };

  const it = argv[Symbol.iterator]();
  for (let cur = it.next(); !cur.done; cur = it.next()) {
    const a = cur.value;
    if (!a.startsWith("--")) {
      args.inputs.push(a);
      continue;
    }
    const [k, inlineV] = a.split("=", 2);
    const nextVal = () => {
      if (inlineV != null) return inlineV;
      const n = it.next();
      if (n.done) die(`Missing value for ${k}`);
      return n.value;
    };

    switch (k) {
      case "--help":
        args.help = true;
        break;
      case "--compress":
        args.compress = true;
        break;
      case "--no-compress":
        args.compress = false;
        break;
      case "--quality":
        args.quality = Number(nextVal());
        break;
      case "--max-size":
        args.maxSize = nextVal();
        break;
      case "--fit-under":
        args.fitUnder = nextVal();
        break;
      case "--preserve-resolution":
        args.preserveResolution = true;
        break;
      case "--subsample":
        args.subsample = nextVal();
        break;
      case "--progressive":
        args.progressive = true;
        break;
      case "--strip-metadata":
        args.stripMetadata = true;
        break;
      case "--keep-metadata":
        args.stripMetadata = false;
        break;
      case "--min-quality":
        args.minQuality = Number(nextVal());
        break;
      case "--out-dir":
        args.outDir = nextVal();
        break;
      case "--suffix":
        args.suffix = nextVal();
        break;
      case "--overwrite":
        args.overwrite = true;
        break;
      case "--recursive":
        args.recursive = true;
        break;
      default:
        die(`Unknown option: ${k}\nRun with --help`);
    }
  }

  args.quality = clamp01(args.quality);
  args.minQuality = clamp01(args.minQuality);
  args.subsample = normalizeSubsample(args.subsample);
  const size = args.fitUnder ?? args.maxSize;
  args.maxSizeBytes = size ? parseSizeToBytes(size) : null;
  return args;
}

function clamp01(x) {
  if (!Number.isFinite(x)) die(`Invalid --quality (must be number 0.1..1.0)`);
  return Math.max(0.1, Math.min(1.0, x));
}

function normalizeSubsample(s) {
  const v = String(s || "").trim();
  if (v === "4:4:4" || v === "444") return "4:4:4";
  if (v === "4:2:0" || v === "420") return "4:2:0";
  die(`Invalid --subsample "${v}" (use 4:4:4 or 4:2:0)`);
}

function parseSizeToBytes(s) {
  const raw = String(s).trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(\d+(\.\d+)?)(kb|mb|gb)$/);
  if (!m) die(`Invalid --max-size "${s}" (examples: 6mb, 5500kb, 5000000)`);
  const n = Number(m[1]);
  const unit = m[3];
  const mult = unit === "kb" ? 1024 : unit === "mb" ? 1024 * 1024 : 1024 * 1024 * 1024;
  return Math.floor(n * mult);
}

function isJpegFile(p) {
  const ext = path.extname(p).toLowerCase();
  return ext === ".jpg" || ext === ".jpeg";
}

async function listInputs(inputs, recursive) {
  const out = [];
  for (const input of inputs) {
    const abs = path.resolve(input);
    let st;
    try {
      st = await fs.stat(abs);
    } catch {
      die(`Input not found: ${input}`);
    }
    if (st.isFile()) {
      if (!isJpegFile(abs)) die(`Unsupported file (only .jpg/.jpeg): ${input}`);
      out.push(abs);
      continue;
    }
    if (!st.isDirectory()) die(`Unsupported input: ${input}`);
    const files = await scanDir(abs, recursive);
    out.push(...files);
  }
  return out;
}

async function scanDir(dir, recursive) {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...(await scanDir(full, recursive)));
      continue;
    }
    if (e.isFile() && isJpegFile(full)) out.push(full);
  }
  return out;
}

function human(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 2)}MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(kb >= 10 ? 0 : 1)}KB`;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

function outputPathFor(inputPath, outDir, suffix) {
  const base = path.basename(inputPath, path.extname(inputPath));
  return path.join(outDir, `${base}${suffix}.jpg`);
}

function jpegOpts(args, quality01) {
  return {
    quality: Math.round(quality01 * 100),
    progressive: !!args.progressive,
    chromaSubsampling: args.subsample,
    mozjpeg: true,
    optimizeCoding: true
  };
}

async function encodeAtQuality(inputPath, args, quality01, overrides) {
  let img = sharp(inputPath, { failOn: "error" });
  // Default: strip metadata by not calling withMetadata().
  const stripMetadata = overrides?.stripMetadata ?? args.stripMetadata;
  const progressive = overrides?.progressive ?? args.progressive;
  const subsample = overrides?.subsample ?? args.subsample;
  if (!stripMetadata) img = img.withMetadata();
  const buf = await img.jpeg(jpegOpts({ ...args, progressive, subsample }, quality01)).toBuffer();
  return buf;
}

async function compressWithTarget(inputPath, args) {
  const target = args.maxSizeBytes;
  if (!target) {
    const buf = await encodeAtQuality(inputPath, args, args.quality);
    return {
      buf,
      usedQuality: args.quality,
      used: { subsample: args.subsample, progressive: args.progressive, stripMetadata: args.stripMetadata },
      pass: true
    };
  }

  // Deterministic search order (best clarity first):
  // 1) 4:4:4, baseline
  // 2) progressive on
  // 3) 4:2:0 subsampling
  // 4) progressive + 4:2:0
  const variants = [
    { subsample: "4:4:4", progressive: false, stripMetadata: true },
    { subsample: "4:4:4", progressive: true, stripMetadata: true },
    { subsample: "4:2:0", progressive: false, stripMetadata: true },
    { subsample: "4:2:0", progressive: true, stripMetadata: true }
  ];

  const baseQ = clamp01(args.quality);
  const minQ = clamp01(args.minQuality);

  let bestFit = null; // {buf, q, used}
  let bestClarity = null; // smallest file at baseQ across variants

  for (const v of variants) {
    // Try at base quality first
    const atBase = await encodeAtQuality(inputPath, args, baseQ, v);
    if (!bestClarity || atBase.length < bestClarity.buf.length) bestClarity = { buf: atBase, q: baseQ, used: v };
    if (atBase.length <= target) {
      // We can fit at baseQ; that's the best clarity for this variant.
      if (!bestFit) bestFit = { buf: atBase, q: baseQ, used: v };
      // Prefer earlier variants deterministically.
      return { buf: atBase, usedQuality: baseQ, used: v, pass: true };
    }

    // If even minQ can't fit, track and continue.
    const atMin = await encodeAtQuality(inputPath, args, minQ, v);
    if (atMin.length > target) continue;

    // Binary search highest q that fits for this variant.
    let lo = minQ;
    let hi = baseQ;
    let best = atMin;
    let bestQ = minQ;
    for (let i = 0; i < 10 && hi - lo > 0.015; i++) {
      const mid = (lo + hi) / 2;
      const b = await encodeAtQuality(inputPath, args, mid, v);
      if (b.length <= target) {
        best = b;
        bestQ = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    if (!bestFit) bestFit = { buf: best, q: bestQ, used: v };
  }

  // No variant could fit above minQ => return best-clarity attempt (deterministic).
  return {
    buf: bestClarity.buf,
    usedQuality: bestClarity.q,
    used: bestClarity.used,
    pass: false
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.inputs.length) {
    printHelp();
    die("\nMissing input files/directories.");
  }
  if (!args.compress) die("Nothing to do: --no-compress was set.");
  if (args.preserveResolution !== true) die("This tool only supports --preserve-resolution.");

  const inputs = await listInputs(args.inputs, args.recursive);
  if (!inputs.length) die("No .jpg/.jpeg inputs found.");

  const outDir = path.resolve(args.outDir);
  await ensureDir(outDir);

  let ok = 0;
  let fail = 0;

  for (const inputPath of inputs) {
    const outPath = outputPathFor(inputPath, outDir, args.suffix);
    try {
      if (!args.overwrite) {
        try {
          await fs.stat(outPath);
          console.log(`[skip] ${path.basename(outPath)} (exists)`);
          continue;
        } catch {
          // not exists
        }
      }

      const before = (await fs.stat(inputPath)).size;
      const { buf, usedQuality, used, pass } = await compressWithTarget(inputPath, args);
      const after = buf.length;
      await fs.writeFile(outPath, buf);

      const ratio = before > 0 ? Math.round((1 - after / before) * 100) : 0;
      const warn6mb = after > SIX_MB ? "  [WARN >6MB]" : "";
      const warnTarget = args.maxSizeBytes && after > args.maxSizeBytes ? "  [FAIL target]" : "";
      const usedFlags = used
        ? ` subsample=${used.subsample} progressive=${used.progressive ? "on" : "off"} metadata=${
            used.stripMetadata ? "stripped" : "kept"
          }`
        : "";
      console.log(
        `[ok] ${path.basename(inputPath)}  ${human(before)} → ${human(after)}  (-${ratio}%)  q=${usedQuality.toFixed(2)}${
          pass ? "" : "  [BEST-CLARITY]"
        }${warn6mb}${warnTarget}${usedFlags}`
      );
      ok++;
    } catch (e) {
      fail++;
      console.error(`[fail] ${path.basename(inputPath)}: ${e?.message ? e.message : String(e)}`);
    }
  }

  if (fail) process.exitCode = 2;
  console.log(`\nDone. ok=${ok} fail=${fail} outDir=${outDir}`);
}

main().catch((e) => die(e?.stack || String(e)));

