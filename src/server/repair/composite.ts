import sharp from 'sharp';
import type { PixelBox } from '../../shared/geometry.js';

export interface RgbaImage {
  data: Buffer;
  width: number;
  height: number;
}

/** Decode any image to a canonical RGBA buffer (the proof's pixel space). */
export async function decodeRgba(bytes: Buffer): Promise<RgbaImage> {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Composite the rendered panel PNG at the edit rectangle onto the source.
 * Output is a lossless PNG with the same dimensions as the source. The panel
 * PNG is exactly rect-sized with transparency outside the rounded corners,
 * so only rect pixels can change.
 */
export async function compositePanel(
  beforeBytes: Buffer,
  panelPng: Buffer,
  rect: PixelBox,
): Promise<Buffer> {
  const left = Math.round(rect.x);
  const top = Math.round(rect.y);
  return sharp(beforeBytes)
    .composite([{ input: panelPng, left, top }])
    .png()
    .toBuffer();
}

export interface CompositeLayer {
  input: Buffer;
  left: number;
  top: number;
}

/** Composite layers in order onto a base image; output is a lossless PNG. */
export async function compositeLayers(base: Buffer, layers: CompositeLayer[]): Promise<Buffer> {
  return sharp(base)
    .composite(layers.map((l) => ({ input: l.input, left: Math.round(l.left), top: Math.round(l.top) })))
    .png()
    .toBuffer();
}

/**
 * Cut the masked element out of an RGBA image: tight crop + alpha from the
 * mask (255 inside, 0 outside). Returns the crop PNG and its source offset.
 */
export async function cutMaskedPng(
  rgba: RgbaImage,
  mask: Uint8Array,
): Promise<{ png: Buffer; x: number; y: number; w: number; h: number }> {
  const { width, height } = rgba;
  let x1 = width;
  let y1 = height;
  let x2 = -1;
  let y2 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) throw new Error('cutMaskedPng: empty mask');
  const w = x2 - x1 + 1;
  const h = y2 - y1 + 1;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y1 + y) * width + (x1 + x)) * 4;
      const di = (y * w + x) * 4;
      out[di] = rgba.data[si] as number;
      out[di + 1] = rgba.data[si + 1] as number;
      out[di + 2] = rgba.data[si + 2] as number;
      out[di + 3] = mask[(y1 + y) * width + (x1 + x)] ? 255 : 0;
    }
  }
  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  return { png, x: x1, y: y1, w, h };
}

/**
 * Resize/crop ANY input to the exact WxH with cover semantics (uniform scale,
 * center crop, no stretch), then verify the result is exactly WxH.
 * Muse Image returns the aspect ratio only — this is what makes it exact.
 */
export async function exactSize(bytes: Buffer, width: number, height: number): Promise<Buffer> {
  const out = await sharp(bytes).resize(width, height, { fit: 'cover', position: 'center' }).png().toBuffer();
  const meta = await sharp(out).metadata();
  if (meta.width !== width || meta.height !== height) {
    throw new Error(`exactSize: expected ${width}x${height}, got ${meta.width}x${meta.height}`);
  }
  return out;
}

/**
 * Uniform-scale an RGBA cutout by `scale` with nearest-neighbor sampling, so
 * pasted pixels equal the source pixels after the recorded transform.
 */
export function scaleRgbaNearest(src: RgbaImage, scale: number): RgbaImage {
  const width = Math.max(1, Math.round(src.width * scale));
  const height = Math.max(1, Math.round(src.height * scale));
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x / scale));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = src.data[si] as number;
      data[di + 1] = src.data[si + 1] as number;
      data[di + 2] = src.data[si + 2] as number;
      data[di + 3] = src.data[si + 3] as number;
    }
  }
  return { data, width, height };
}

/**
 * Defringe a mask cutout's edge band (1-2 px): SAM masks often include a dark
 * halo of background pixels along the edge (seen as the stair-stepped dark
 * left edge of the GALI bottle). Every opaque pixel within `edgePx` of the
 * mask boundary gets its RGB replaced by the nearest interior opaque pixel
 * (search radius edgePx+4); alpha is untouched.
 *
 * Honesty note: the pixel proof erodes the core by `featherPx` before
 * comparing, so with featherPx >= edgePx the proof core is byte-identical to
 * the source and only the (reported, non-gated) feather ring is cleaned.
 */
export function defringeCut(src: RgbaImage, edgePx = 2): RgbaImage {
  const { width: w, height: h } = src;
  const opa = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) opa[i] = (src.data[i * 4 + 3] as number) > 0 ? 1 : 0;
  const opaque = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && opa[y * w + x] === 1;
  // Edge map, computed once: opaque within edgePx of a transparent pixel.
  const edge = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opaque(x, y)) continue;
      outer: for (let dy = -edgePx; dy <= edgePx; dy++) {
        for (let dx = -edgePx; dx <= edgePx; dx++) {
          if (!opaque(x + dx, y + dy)) {
            edge[y * w + x] = 1;
            break outer;
          }
        }
      }
    }
  }
  const data = Buffer.from(src.data);
  const R = edgePx + 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edge[y * w + x]) continue;
      // Nearest interior (non-edge) opaque pixel.
      let best = -1;
      let bestD = Infinity;
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (!opaque(nx, ny) || edge[ny * w + nx]) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) {
            bestD = d;
            best = (ny * w + nx) * 4;
          }
        }
      }
      if (best >= 0) {
        const di = (y * w + x) * 4;
        data[di] = src.data[best] as number;
        data[di + 1] = src.data[best + 1] as number;
        data[di + 2] = src.data[best + 2] as number;
      }
    }
  }
  return { data, width: w, height: h };
}

/**
 * Complete a product base torn by a foreground occluder (seen live on
 * טבע: fruit in front of the bottles in the source, so SAM's mask ends
 * where the fruit starts and the pasted bottles end in jagged bites and
 * drips). For each column whose bottom ends well above the group's robust
 * base line (90th percentile of column bottoms), with deep columns on
 * BOTH sides (an interior bite, not a naturally curved end like a lying
 * can), extend the column down to the base line. Filled pixels copy the
 * column's own lowest product pixel — the bottle continuing, never the
 * occluder's colours. Mutates the cut; returns the filled pixel count.
 */
export function completeOccludedBase(cut: RgbaImage): number {
  const { width: W, height: H } = cut;
  const alpha = (x: number, y: number): number => cut.data[(y * W + x) * 4 + 3] as number;
  const bottoms: number[] = [];
  const colBottom = new Array<number>(W).fill(-1);
  for (let x = 0; x < W; x++) {
    for (let y = H - 1; y >= 0; y--) {
      if (alpha(x, y) > 0) { colBottom[x] = y; break; }
    }
    if (colBottom[x]! >= 0) bottoms.push(colBottom[x]!);
  }
  if (bottoms.length < 8) return 0;
  const sorted = [...bottoms].sort((a, b) => a - b);
  // Trim narrow deep spikes first: mask strays below the base (a fruit stem
  // or table edge caught in the bottle mask) would otherwise set the base
  // line, and the fill below would paste striped "legs" under the bottle
  // (seen live on טבע). A spike is a narrow run of columns far deeper than
  // the median bottom; a real curved base is a wide run and stays.
  const medianY = sorted[Math.floor((sorted.length - 1) * 0.5)] as number;
  {
    let runStart = -1;
    for (let x = 0; x <= W; x++) {
      const deep = x < W && (colBottom[x] as number) > medianY + 4;
      if (deep && runStart < 0) runStart = x;
      if (!deep && runStart >= 0) {
        if (x - runStart <= Math.max(3, Math.round(W * 0.2))) {
          for (let cx = runStart; cx < x; cx++) {
            for (let y = medianY + 1; y < H; y++) cut.data[(y * W + cx) * 4 + 3] = 0;
            colBottom[cx] = medianY;
          }
        }
        runStart = -1;
      }
    }
  }
  const resorted = [...colBottom.filter((b) => b >= 0)].sort((a, b) => a - b);
  const baseY = resorted[Math.floor((resorted.length - 1) * 0.9)] as number;
  const maxExt = Math.round(H * 0.3);
  const reach = Math.max(6, Math.round(W * 0.3));
  const deepNear = (x: number, dir: -1 | 1): boolean => {
    for (let d = 1; d <= reach; d++) {
      const nx = x + dir * d;
      if (nx < 0 || nx >= W) break;
      if (colBottom[nx]! >= baseY - 4) return true;
    }
    return false;
  };
  // Edge bite: a fruit against the bottle's SIDE tears the columns at the
  // cut edge, where no deep column exists on the outward side. Complete
  // those too when the profile cliffs abruptly into the deep interior (a
  // naturally curved end rises gradually, never in one step).
  const abruptCliff = (x: number, dir: -1 | 1): boolean => {
    for (let d = 1; d < reach; d++) {
      const prev = colBottom[x + dir * (d - 1)] as number;
      const next = colBottom[x + dir * d] as number;
      if (prev >= 0 && next - prev >= 6) return true;
    }
    return false;
  };
  let filled = 0;
  for (let x = 0; x < W; x++) {
    const b = colBottom[x] as number;
    if (b < 0 || b >= baseY - 6) continue;
    const ext = baseY - b;
    if (ext > maxExt) continue;
    const deepL = deepNear(x, -1);
    const deepR = deepNear(x, 1);
    const interiorBite = deepL && deepR;
    const edgeBite = !interiorBite && ((deepR && x < W * 0.4 && abruptCliff(x, 1)) || (deepL && x >= W * 0.6 && abruptCliff(x, -1)));
    if (!interiorBite && !edgeBite) continue;
    const so = (b * W + x) * 4;
    const r = cut.data[so] as number; const g = cut.data[so + 1] as number; const bl = cut.data[so + 2] as number;
    for (let y = b + 1; y <= baseY; y++) {
      const o = (y * W + x) * 4;
      if (cut.data[o + 3] as number > 0) continue;
      cut.data[o] = r; cut.data[o + 1] = g; cut.data[o + 2] = bl; cut.data[o + 3] = 255;
      filled++;
    }
  }
  return filled;
}

export interface SupportPoint {
  /** Canvas-space center-x of the product's lowest opaque row. */
  cx: number;
  /** Canvas-space y of the lowest opaque row. */
  y: number;
  /** Width of the opaque run on that row (shadow width hint). */
  width: number;
}

/**
 * Lowest SUBSTANTIAL opaque row of a cutout in canvas space (the support
 * point). Rows narrower than ~8% of the cut width are stray mask pixels or
 * shadow remnants, never the product's footing — skipped (seen live as a
 * speck shadow under a stray pixel below the GALI bottle).
 */
export function supportPoint(cut: RgbaImage, left: number, top: number): SupportPoint | null {
  const minRun = Math.max(8, Math.round(cut.width * 0.08));
  for (let y = cut.height - 1; y >= 0; y--) {
    let x1 = -1;
    let x2 = -1;
    for (let x = 0; x < cut.width; x++) {
      if ((cut.data[(y * cut.width + x) * 4 + 3] as number) > 0) {
        if (x1 < 0) x1 = x;
        x2 = x;
      }
    }
    if (x1 >= 0 && x2 - x1 + 1 >= minRun) return { cx: left + (x1 + x2) / 2, y: top + y, width: x2 - x1 + 1 };
  }
  return null;
}

/**
 * Contact shadow in code: a soft dark ellipse under the product's actual
 * support point (lowest opaque pixels), drawn BEFORE the product is pasted.
 * Skipped for floating products (opts.floating) or implausible plate
 * lighting (opts.skip) — the caller decides, and the trace records it.
 */
export function drawContactShadow(
  canvas: RgbaImage,
  at: SupportPoint,
  opts: { liftPx?: number; strength?: number; floating?: boolean; skip?: boolean } = {},
): boolean {
  if (opts.floating || opts.skip) return false;
  const rx = Math.max(8, (at.width * 0.52) / 2);
  const ry = Math.max(5, Math.round(rx * 0.16));
  const cy = at.y + (opts.liftPx ?? 10);
  const strength = opts.strength ?? 0.28;
  const x0 = Math.max(0, Math.floor(at.cx - rx));
  const x1 = Math.min(canvas.width - 1, Math.ceil(at.cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(canvas.height - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - at.cx) / rx;
      const dy = (y - cy) / ry;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const alpha = strength * (1 - d2) * (1 - d2);
      const di = (y * canvas.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = Math.round((canvas.data[di + c] as number) * (1 - alpha));
      }
    }
  }
  return true;
}

export interface SurfaceEdge {
  /** Canvas y of the surface back edge (wall meets tabletop). */
  y: number;
  /** Edge strength 0-255 (min of local step and sustained shift). */
  score: number;
  /** True for a crisp table line (vs a soft focus falloff). */
  crisp: boolean;
}

/**
 * Find the plate's support-surface back edge under a planned product base:
 * the strongest sustained horizontal luminance step inside the product's
 * x-range within ±bandPx of yCenter. A pasted product reads as grounded
 * only when its base sits just below this edge; the grounding prompt asks
 * the painter for exactly that, and this verifies it (seen live: NOA's bag
 * sunk 33px into the table on fb-link, floating 60px over it on the story).
 * Returns null when the background is seamless (score < 5): texture noise
 * scores ~2-3, soft falloffs ~6-7, crisp table lines 50+.
 */
export function findSurfaceEdge(
  canvas: RgbaImage,
  x0: number,
  x1: number,
  yCenter: number,
  bandPx: number,
): SurfaceEdge | null {
  const W = canvas.width;
  const H = canvas.height;
  const xa = Math.max(0, Math.min(W - 1, Math.round(x0)));
  const xb = Math.max(xa + 1, Math.min(W, Math.round(x1)));
  const ya = Math.max(32, Math.min(H - 33, Math.round(yCenter - bandPx)));
  const yb = Math.max(ya + 1, Math.min(H - 33, Math.round(yCenter + bandPx)));
  const lum = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return 0.299 * (canvas.data[o] as number) + 0.587 * (canvas.data[o + 1] as number) + 0.114 * (canvas.data[o + 2] as number);
  };
  const rowMean = (y: number): number => {
    let s = 0;
    let n = 0;
    for (let x = xa; x < xb; x += 4) {
      s += lum(x, y);
      n++;
    }
    return n > 0 ? s / n : 0;
  };
  const means: number[] = [];
  for (let y = ya - 32; y <= yb + 32; y++) means.push(rowMean(Math.max(0, Math.min(H - 1, y))));
  const at = (y: number): number => means[y - (ya - 32)] as number;
  const avg = (lo: number, hi: number): number => {
    let s = 0;
    for (let y = lo; y <= hi; y++) s += at(y);
    return s / (hi - lo + 1);
  };
  let best = 0;
  let bestY = -1;
  for (let y = ya; y <= yb; y++) {
    const local = Math.abs(avg(y + 1, y + 3) - avg(y - 3, y - 1));
    const sustained = Math.abs(avg(y + 10, y + 30) - avg(y - 30, y - 10));
    const score = Math.min(local, sustained);
    if (score > best) {
      best = score;
      bestY = y;
    }
  }
  if (bestY < 0 || best < 5) return null;
  return { y: bestY, score: Math.round(best * 10) / 10, crisp: best >= 15 };
}

/**
 * Luminance drift across a vertical gap (mean of 8 rows at each end): tells
 * air from fabric under a product base. A surface edge BELOW the base with a
 * uniform gap (~fabric, drift < 10) means the product already sits on a
 * seamless support — only a falling-off gap (drift ≥ 10) reads as floating.
 * Seen live: VELA's jar over uniform fabric (no flag) vs NOA's bag over a
 * bright-to-dark falloff (flag).
 */
export function gapDrift(canvas: RgbaImage, x0: number, x1: number, yA: number, yB: number): number {
  const W = canvas.width;
  const H = canvas.height;
  const xa = Math.max(0, Math.min(W - 1, Math.round(x0)));
  const xb = Math.max(xa + 1, Math.min(W, Math.round(x1)));
  const lum = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return 0.299 * (canvas.data[o] as number) + 0.587 * (canvas.data[o + 1] as number) + 0.114 * (canvas.data[o + 2] as number);
  };
  const rows = (y: number): number => {
    let s = 0;
    let n = 0;
    for (let r = 0; r < 8; r++) {
      const yy = Math.max(0, Math.min(H - 1, Math.round(y) + r));
      for (let x = xa; x < xb; x += 4) {
        s += lum(x, yy);
        n++;
      }
    }
    return n > 0 ? s / n : 0;
  };
  return Math.abs(rows(yA) - rows(Math.min(yB, H - 1)));
}

export interface DebandResult {
  corrected: boolean;
  rows: number;
}

/**
 * Remove full-width banding strips from a flat-design plate: per-row median
 * luminance is equalized toward the global median, but only for uniform
 * off-tone runs that touch the top or bottom edge (the observed defect is
 * footer/header strips the painter adds — interior stripes are design,
 * multi-content rows like disc crossings are never touched, and gradients
 * are intentional and never pass through here). Relative contrast inside
 * each row is preserved, so discs and shapes keep their edges. Seen live:
 * ZAZO's text-only regens come back with 2-3 darker footer bands (row
 * medians 182/201 vs a 242 field).
 */
export function debandFlatPlate(canvas: RgbaImage): DebandResult {
  const W = canvas.width;
  const H = canvas.height;
  const rowStats = (y: number): { med: number; sd: number } => {
    const a: number[] = [];
    for (let x = 0; x < W; x += 6) {
      const o = (y * W + x) * 4;
      a.push(0.299 * (canvas.data[o] as number) + 0.587 * (canvas.data[o + 1] as number) + 0.114 * (canvas.data[o + 2] as number));
    }
    a.sort((p, q) => p - q);
    const med = a[Math.floor(a.length / 2)] as number;
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    const sd = Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length);
    return { med, sd };
  };
  const meds: number[] = [];
  const sds: number[] = [];
  for (let y = 0; y < H; y++) {
    const s = rowStats(y);
    meds.push(s.med);
    sds.push(s.sd);
  }
  const sorted = [...meds].sort((p, q) => p - q);
  const global = sorted[Math.floor(sorted.length / 2)] as number;
  // Deviant = off-tone AND uniform: multi-content rows (a disc crossing the
  // row) are never "corrected", or a bottom-cropped disc would wash out. The
  // 4-unit threshold pulls gradient transition rows into the run, so no
  // visible step survives at the corrected/uncorrected boundary.
  const deviant = meds.map((m, y) => Math.abs(global - m) > 4 && (sds[y] as number) < 12);
  // Keep deviant runs touching an edge; interior runs are design.
  const fix = new Array<boolean>(H).fill(false);
  for (let y = 0; y < H && deviant[y]; y++) fix[y] = true;
  for (let y = H - 1; y >= 0 && deviant[y]; y--) fix[y] = true;
  let rows = 0;
  for (let y = 0; y < H; y++) {
    if (!fix[y]) continue;
    const off = global - (meds[y] as number);
    rows++;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[o + c] = Math.max(0, Math.min(255, Math.round((canvas.data[o + c] as number) + off)));
      }
    }
  }
  return { corrected: rows > 0, rows };
}

/** WCAG relative luminance of an sRGB triple. */
export function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export interface TextContrast {
  ratio: number;
  /** Plate luminance the text was judged against (hostile tercile). */
  plateLum: number;
  textLum: number;
}

/**
 * Contrast of re-rendered text against the plate behind its box. WCAG ratio
 * of the text color vs the plate's worse tercile (darkest vs brightest
 * third, whichever reads worse): on a gradient half the glyphs can vanish
 * while the mean looks fine (seen live: NOA's headline half-sunk in a wood
 * band at 1.85, invisible on the story at 1.07 — good outputs score 2.4+).
 */
export function textContrastRatio(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
  text: { r: number; g: number; b: number },
): TextContrast {
  const W = canvas.width;
  const H = canvas.height;
  const x0 = Math.max(0, Math.min(W - 1, Math.round(box.x)));
  const y0 = Math.max(0, Math.min(H - 1, Math.round(box.y)));
  const x1 = Math.max(x0 + 1, Math.min(W, Math.round(box.x + box.w)));
  const y1 = Math.max(y0 + 1, Math.min(H, Math.round(box.y + box.h)));
  const ls: number[] = [];
  for (let y = y0; y < y1; y += 6) {
    for (let x = x0; x < x1; x += 6) {
      const o = (y * W + x) * 4;
      ls.push(relativeLuminance(canvas.data[o] as number, canvas.data[o + 1] as number, canvas.data[o + 2] as number));
    }
  }
  ls.sort((a, b) => a - b);
  const textLum = relativeLuminance(text.r, text.g, text.b);
  if (ls.length === 0) return { ratio: 21, plateLum: 1, textLum };
  const lo = ls[Math.floor(ls.length * 0.3)]!;
  const hi = ls[Math.floor(ls.length * 0.7)]!;
  const ratioOf = (p: number): number => (Math.max(textLum, p) + 0.05) / (Math.min(textLum, p) + 0.05);
  const plateLum = ratioOf(lo) <= ratioOf(hi) ? lo : hi;
  return { ratio: Math.round(ratioOf(plateLum) * 100) / 100, plateLum, textLum };
}

/**
 * Trim flat background caught in a loose panel cut: edge rows/columns that
 * are uniform AND far from the panel's center tone (photo corners, white
 * strips below the box — seen live on DAFNA's pasted panel) are shaved off,
 * so the cut hugs the panel. Textured edges (photo panels) and gradients
 * never trim: the row must be uniform and >40 units from center tone.
 */
export function trimFlatBorders(rgba: RgbaImage): RgbaImage {
  const W = rgba.width;
  const H = rgba.height;
  const lum = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return 0.299 * (rgba.data[o] as number) + 0.587 * (rgba.data[o + 1] as number) + 0.114 * (rgba.data[o + 2] as number);
  };
  const center: number[] = [];
  for (let y = Math.floor(H * 0.35); y < Math.floor(H * 0.65); y++) {
    for (let x = Math.floor(W * 0.2); x < Math.floor(W * 0.8); x += 3) center.push(lum(x, y));
  }
  center.sort((a, b) => a - b);
  const tone = center.length > 0 ? (center[Math.floor(center.length / 2)] as number) : 128;
  const rowStats = (y: number): { med: number; sd: number } => {
    const a: number[] = [];
    for (let x = 0; x < W; x += 3) a.push(lum(x, y));
    a.sort((p, q) => p - q);
    const med = a[Math.floor(a.length / 2)] as number;
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return { med, sd: Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length) };
  };
  const colStats = (x: number): { med: number; sd: number } => {
    const a: number[] = [];
    for (let y = 0; y < H; y += 3) a.push(lum(x, y));
    a.sort((p, q) => p - q);
    const med = a[Math.floor(a.length / 2)] as number;
    const mean = a.reduce((s, v) => s + v, 0) / a.length;
    return { med, sd: Math.sqrt(a.reduce((s, v) => s + (v - mean) * (v - mean), 0) / a.length) };
  };
  const flat = (med: number, sd: number): boolean => sd < 10 && Math.abs(med - tone) > 40;
  let x0 = 0;
  let y0 = 0;
  let x1 = W;
  let y1 = H;
  while (y0 < y1 - 8) {
    const s = rowStats(y0);
    if (!flat(s.med, s.sd)) break;
    y0++;
  }
  while (y1 > y0 + 8) {
    const s = rowStats(y1 - 1);
    if (!flat(s.med, s.sd)) break;
    y1--;
  }
  while (x0 < x1 - 8) {
    const s = colStats(x0);
    if (!flat(s.med, s.sd)) break;
    x0++;
  }
  while (x1 > x0 + 8) {
    const s = colStats(x1 - 1);
    if (!flat(s.med, s.sd)) break;
    x1--;
  }
  if (x0 === 0 && y0 === 0 && x1 === W && y1 === H) return rgba;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (((y0 + y) * W + (x0 + x)) * 4);
      const di = ((y * w + x) * 4);
      data[di] = rgba.data[si] as number;
      data[di + 1] = rgba.data[si + 1] as number;
      data[di + 2] = rgba.data[si + 2] as number;
      data[di + 3] = rgba.data[si + 3] as number;
    }
  }
  return { data, width: w, height: h };
}

/**
 * Round the corners of a pasted panel cut: source panels are rounded rects
 * but the cut bbox is square, so the corners carry photo background that
 * stamps as grey squares on the plate (seen live on every pasted panel).
 * Multiplies alpha by a rounded-rect mask (1px soft edge); the radius is a
 * proportion of the cut size, matching typical panel radii.
 */
export function roundPanelCorners(rgba: RgbaImage, radiusPx?: number): RgbaImage {
  const W = rgba.width;
  const H = rgba.height;
  const r = Math.max(1, Math.min(Math.floor(Math.min(W, H) / 2), radiusPx ?? Math.round(Math.min(W, H) * 0.09)));
  const data = Buffer.from(rgba.data);
  const inside = (x: number, y: number): number => {
    const dx = Math.min(x, W - 1 - x);
    const dy = Math.min(y, H - 1 - y);
    if (dx >= r || dy >= r) return 1;
    const d = Math.sqrt((r - dx - 0.5) * (r - dx - 0.5) + (r - dy - 0.5) * (r - dy - 0.5));
    if (d <= r - 1) return 1;
    if (d >= r) return 0;
    return r - d;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = inside(x, y);
      if (m >= 1) continue;
      const o = (y * W + x) * 4;
      data[o + 3] = Math.round((data[o + 3] as number) * m);
    }
  }
  return { data, width: W, height: H };
}

/**
 * Paste an RGBA cutout onto an RGBA canvas at (left, top) with a soft 1-2 px
 * edge feather: alpha comes from the cutout, but the outermost 2 px ring of
 * the opaque core is feathered (linear ramp) to avoid hard seams. Pixels
 * strictly inside the eroded core are copied bit-identically.
 */
export function pasteWithFeather(canvas: RgbaImage, cut: RgbaImage, left: number, top: number, featherPx = 2): void {
  const { width: cw, height: ch } = canvas;
  const opaque = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < cut.width && y < cut.height && (cut.data[(y * cut.width + x) * 4 + 3] as number) > 0;
  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) {
      if (!opaque(x, y)) continue;
      // Distance to the nearest transparent pixel (capped): the feather ramp.
      let d = featherPx + 1;
      for (let dy = -featherPx; dy <= featherPx && d > 1; dy++) {
        for (let dx = -featherPx; dx <= featherPx; dx++) {
          if (!opaque(x + dx, y + dy)) {
            d = Math.min(d, Math.max(Math.abs(dx), Math.abs(dy)));
            if (d <= 1) break;
          }
        }
      }
      const alpha = d > featherPx ? 1 : d / (featherPx + 1);
      const cx = left + x;
      const cy = top + y;
      if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
      const si = (y * cut.width + x) * 4;
      const di = (cy * cw + cx) * 4;
      for (let c = 0; c < 3; c++) {
        canvas.data[di + c] = Math.round((cut.data[si + c] as number) * alpha + (canvas.data[di + c] as number) * (1 - alpha));
      }
      canvas.data[di + 3] = 255;
    }
  }
}
