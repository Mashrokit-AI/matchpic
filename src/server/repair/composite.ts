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

/**
 * Clean a product cut's base: drop thin dark protrusions hanging below the
 * product's base line (SAM picking up the shadow/background under a can).
 * Two conservative passes, both leaving wide shapes untouched:
 * 1. narrow columns whose bottom sticks well below the median bottom are
 *    truncated at the base line when the protruding segment is dark;
 * 2. a radius-2 morphological opening on the alpha in the bottom band
 *    removes sparse spikes thinner than the kernel.
 * Returns the number of alpha pixels removed. Mutates the cut.
 */
export function cleanProductCutBase(cut: RgbaImage): number {
  const { width: W, height: H } = cut;
  if (W < 8 || H < 8) return 0;
  const alphaAt = (x: number, y: number): number => cut.data[(y * W + x) * 4 + 3] as number;
  const colBottom = new Array<number>(W).fill(-1);
  const bottoms: number[] = [];
  for (let x = 0; x < W; x++) {
    for (let y = H - 1; y >= 0; y--) {
      if (alphaAt(x, y) > 0) { colBottom[x] = y; break; }
    }
    if (colBottom[x]! >= 0) bottoms.push(colBottom[x]!);
  }
  if (bottoms.length < 8) return 0;
  const sorted = [...bottoms].sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) * 0.5)] as number;
  const tol = Math.max(3, Math.round(H * 0.01));
  let removed = 0;
  // Pass 1: narrow dark protrusions below the base line.
  const maxRun = Math.max(4, Math.round(W * 0.12));
  let runStart = -1;
  const flushRun = (end: number): void => {
    if (runStart < 0) return;
    if (end - runStart <= maxRun) {
      for (let x = runStart; x < end; x++) {
        // Dark segment only: a light rim/silver edge is product, not shard.
        let lumSum = 0;
        let n = 0;
        for (let y = median + tol + 1; y <= (colBottom[x] as number); y++) {
          const o = (y * W + x) * 4;
          lumSum += 0.299 * (cut.data[o] as number) + 0.587 * (cut.data[o + 1] as number) + 0.114 * (cut.data[o + 2] as number);
          n++;
        }
        if (n === 0 || lumSum / n >= 90) continue;
        for (let y = median + tol + 1; y < H; y++) {
          const o = (y * W + x) * 4 + 3;
          if ((cut.data[o] as number) > 0) { cut.data[o] = 0; removed++; }
        }
      }
    }
    runStart = -1;
  };
  for (let x = 0; x <= W; x++) {
    const deep = x < W && (colBottom[x] as number) > median + tol;
    if (deep && runStart < 0) runStart = x;
    if (!deep) flushRun(x);
  }
  // Pass 2: opening (erode then dilate, radius 2) on the bottom band.
  const bandTop = Math.max(0, median - Math.round(H * 0.08));
  const bin = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) bin[i] = (cut.data[i * 4 + 3] as number) > 0 ? 1 : 0;
  const erode = (srcBin: Uint8Array, r: number): Uint8Array => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let ok = 1;
        for (let dy = -r; dy <= r && ok; dy++) {
          for (let dx = -r; dx <= r && ok; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H || !srcBin[ny * W + nx]) ok = 0;
          }
        }
        out[y * W + x] = ok;
      }
    }
    return out;
  };
  const dilate = (srcBin: Uint8Array, r: number): Uint8Array => {
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let any = 0;
        for (let dy = -r; dy <= r && !any; dy++) {
          for (let dx = -r; dx <= r && !any; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < W && ny < H && srcBin[ny * W + nx]) any = 1;
          }
        }
        out[y * W + x] = any;
      }
    }
    return out;
  };
  const opened = dilate(erode(bin, 2), 2);
  for (let y = bandTop; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (bin[i] && !opened[i]) {
        cut.data[i * 4 + 3] = 0;
        removed++;
      }
    }
  }
  // Pass 3: fill legs. Base completion above (and in completeOccludedBase)
  // extends torn columns to a flat line, copying ONE pixel's colour down
  // the column. Where the real base curves away, those columns stick out
  // below the product as uniform dark legs (the NORTHBEAN shards). A leg
  // column carries a long run of identical RGB at its bottom; a group of
  // them whose bottom sits well below the neighbouring non-leg columns
  // is truncated to the shallower neighbour's base line.
  {
    const bot = new Array<number>(W).fill(-1);
    const runLen = new Array<number>(W).fill(0);
    for (let x = 0; x < W; x++) {
      for (let y = H - 1; y >= 0; y--) {
        if (alphaAt(x, y) > 0) { bot[x] = y; break; }
      }
      if (bot[x]! < 0) continue;
      const o = (bot[x]! * W + x) * 4;
      let run = 0;
      for (let y = bot[x]!; y >= 0; y--) {
        const p = (y * W + x) * 4;
        if ((cut.data[p + 3] as number) > 0
          && (cut.data[p] as number) === (cut.data[o] as number)
          && (cut.data[p + 1] as number) === (cut.data[o + 1] as number)
          && (cut.data[p + 2] as number) === (cut.data[o + 2] as number)) run++;
        else break;
      }
      runLen[x] = run;
    }
    const isLeg = (x: number): boolean => (runLen[x] as number) >= 8 && (bot[x] as number) >= 0;
    let gs = -1;
    const flushGroup = (end: number): void => {
      if (gs < 0) return;
      const groupW = end - gs;
      if (groupW <= Math.max(6, Math.round(W * 0.35))) {
        const groupBottom = Math.max(...bot.slice(gs, end));
        const neighBottom = (from: number, dir: -1 | 1): number | null => {
          for (let x = from; x >= 0 && x < W; x += dir) {
            if (!isLeg(x) && (bot[x] as number) >= 0) return bot[x] as number;
            if (Math.abs(x - from) > 6) break;
          }
          return null;
        };
        const left = neighBottom(gs - 1, -1);
        const right = neighBottom(end, 1);
        const sides = [left, right].filter((v): v is number => v !== null);
        if (sides.length > 0) {
          const cutLine = Math.min(...sides);
          if (groupBottom > cutLine + 6) {
            for (let x = gs; x < end; x++) {
              for (let y = cutLine + 3; y < H; y++) {
                const o = (y * W + x) * 4 + 3;
                if ((cut.data[o] as number) > 0) { cut.data[o] = 0; removed++; }
              }
            }
          }
        }
      }
      gs = -1;
    };
    for (let x = 0; x <= W; x++) {
      const leg = x < W && isLeg(x);
      if (leg && gs < 0) gs = x;
      if (!leg) flushGroup(x);
    }
  }
  return removed;
}

/**
 * Inpaint a rect on a plate with a smooth bilinear patch from the rect's
 * border ring (never a streak: every interior pixel blends the four edge
 * tones by distance). Used under pasted logos/badges where plate painters
 * leave a dark ghost remnant; the element stamped over it hides the patch
 * centre and the feathered border hides the seam.
 */
export function inpaintRectSmooth(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
  featherPx = 10,
): void {
  const W = canvas.width;
  const H = canvas.height;
  const x0 = Math.max(1, Math.round(box.x));
  const y0 = Math.max(1, Math.round(box.y));
  const x1 = Math.min(W - 1, Math.round(box.x + box.w));
  const y1 = Math.min(H - 1, Math.round(box.y + box.h));
  if (x1 - x0 < 4 || y1 - y0 < 4) return;
  const px = (x: number, y: number, c: number): number => canvas.data[(y * W + x) * 4 + c] as number;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const tx = (x - x0) / Math.max(1, x1 - 1 - x0);
      const ty = (y - y0) / Math.max(1, y1 - 1 - y0);
      const o = (y * W + x) * 4;
      const edgeD = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
      const a = Math.max(0, Math.min(1, edgeD / Math.max(1, featherPx)));
      for (let c = 0; c < 3; c++) {
        const horiz = px(x0 - 1, y, c) * (1 - tx) + px(x1, y, c) * tx;
        const vert = px(x, y0 - 1, c) * (1 - ty) + px(x, y1, c) * ty;
        const fill = horiz * 0.5 + vert * 0.5;
        canvas.data[o + c] = Math.round(fill * a + (canvas.data[o + c] as number) * (1 - a));
      }
      canvas.data[o + 3] = 255;
    }
  }
}

/**
 * Trim a fragmented strip hanging below a logo cut: contrast growth/SAM
 * can grab the top sliver of a dark band printed under the badge (the
 * Hebrew poster's black text band), which pastes as a ghost streak under
 * the lockup. Signature: in the bottom quarter, a row whose opaque
 * fraction drops sharply (but not to a clean gap — a real tagline sits
 * below an EMPTY gap and is kept) with only fragmented rows beneath it.
 * Returns removed alpha pixels. Mutates the cut.
 */
export function trimLogoBottomStrip(cut: RgbaImage): number {
  const { width: W, height: H } = cut;
  if (W < 16 || H < 24) return 0;
  const rowFrac = new Array<number>(H).fill(0);
  let total = 0;
  for (let y = 0; y < H; y++) {
    let n = 0;
    for (let x = 0; x < W; x++) if ((cut.data[(y * W + x) * 4 + 3] as number) > 0) n++;
    rowFrac[y] = n / W;
    total += n;
  }
  if (total === 0) return 0;
  let lastOpaque = H - 1;
  while (lastOpaque > 0 && rowFrac[lastOpaque] === 0) lastOpaque--;
  for (let y = Math.floor(H * 0.72); y < lastOpaque; y++) {
    const f = rowFrac[y] as number;
    if (f < 0.03 || f > 0.4) continue; // empty gap (tagline) or solid body
    const prevMax = Math.max(...rowFrac.slice(Math.max(0, y - 6), y));
    if (prevMax < 0.45 || f > prevMax * 0.55) continue;
    const belowMax = Math.max(...rowFrac.slice(y, lastOpaque + 1));
    const stripH = lastOpaque - y + 1;
    if (belowMax > 0.45 || stripH > H * 0.18) continue;
    let removed = 0;
    for (let yy = Math.max(0, y - 2); yy < H; yy++) {
      for (let x = 0; x < W; x++) {
        const o = (yy * W + x) * 4 + 3;
        if ((cut.data[o] as number) > 0) { cut.data[o] = 0; removed++; }
      }
    }
    return removed;
  }
  return 0;
}

export type GroupColorDecision =
  | { mode: 'source' }
  | { mode: 'uniform'; color: { r: number; g: number; b: number } }
  | { mode: 'source-shadow' };

/**
 * One colour decision for a whole free-text group: source colours when every
 * line already reads; otherwise ONE colour (black/white) that works for
 * every line; otherwise keep source colours and add a glyph shadow. A swap
 * is never made for a single line alone (STRIDE's subtext flipping black
 * while the headline stayed white).
 */
export function resolveGroupTextColors(
  items: Array<{
    srcRatio: number;
    blackRatio: number;
    whiteRatio: number;
  }>,
  floor = 2.0,
): GroupColorDecision {
  if (items.length === 0) return { mode: 'source' };
  if (items.every((i) => i.srcRatio >= floor)) return { mode: 'source' };
  // A near miss keeps the brand's colour with a shadow: flipping white copy to
  // black over one light ledge looked worse than the contrast it gained.
  if (items.every((i) => i.srcRatio >= 1.5)) return { mode: 'source-shadow' };
  const blackMin = Math.min(...items.map((i) => i.blackRatio));
  const whiteMin = Math.min(...items.map((i) => i.whiteRatio));
  if (Math.max(blackMin, whiteMin) >= floor) {
    return { mode: 'uniform', color: blackMin >= whiteMin ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 } };
  }
  return { mode: 'source-shadow' };
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

/**
 * Erase a rect from a plate by extending each row's surrounding pixels
 * inward (median of the 24px strips left/right of the rect, blended by
 * proximity). Plate painters routinely retain a fake button/text/logo at
 * roughly the guided position; whatever will be stamped over the region
 * must not let that ghost show through or peek out from behind. Row-wise
 * extension preserves horizontal bands (ledges, tile lines) crossing it.
 */
export function eraseRectByRowExtension(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
): void {
  const W = canvas.width;
  const H = canvas.height;
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(W, Math.round(box.x + box.w));
  const y1 = Math.min(H, Math.round(box.y + box.h));
  if (x1 <= x0 || y1 <= y0) return;
  const med = (vals: number[]): number => {
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] ?? 0;
  };
  for (let y = y0; y < y1; y++) {
    const left: number[][] = [[], [], []];
    const right: number[][] = [[], [], []];
    for (let x = Math.max(0, x0 - 24); x < x0; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) (left[c] as number[]).push(canvas.data[o + c] as number);
    }
    for (let x = x1; x < Math.min(W, x1 + 24); x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) (right[c] as number[]).push(canvas.data[o + c] as number);
    }
    if (left[0]!.length === 0 && right[0]!.length === 0) continue;
    const lm = left[0]!.length > 0 ? left.map((v) => med([...v])) : right.map((v) => med([...v]));
    const rm = right[0]!.length > 0 ? right.map((v) => med([...v])) : lm;
    const span = Math.max(1, x1 - x0 - 1);
    for (let x = x0; x < x1; x++) {
      const t = (x - x0) / span;
      const o = (y * W + x) * 4;
      // Feather the rect border (10px ramp): a hard-edged flat patch on a
      // gradient/textured field reads as a visible band behind the text.
      const edgeD = Math.min(x - x0, x1 - 1 - x, y - y0, y1 - 1 - y);
      const a = Math.max(0, Math.min(1, edgeD / 10));
      for (let c = 0; c < 3; c++) {
        const ext = Math.round((lm[c] as number) * (1 - t) + (rm[c] as number) * t);
        canvas.data[o + c] = Math.round(ext * a + (canvas.data[o + c] as number) * (1 - a));
      }
      canvas.data[o + 3] = 255;
    }
  }
}

export interface PanelPixelFinding {
  code: 'panel_text_clipped' | 'panel_ghost_bar';
  detail: string;
}

/**
 * Deterministic pixel verdict on a composed panel/CTA: glyph ink touching
 * the panel's top/bottom inner edge is clipped text; a wide bar in the
 * strip below the panel whose tone diverges from the same row outside the
 * panel's x-range is a leftover ghost rectangle (a full-width ledge or
 * horizon spans outside too and never triggers). Pure pixel math.
 */
export function panelPixelFindings(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
  fill: { r: number; g: number; b: number },
  text?: { r: number; g: number; b: number },
): PanelPixelFinding[] {
  const out: PanelPixelFinding[] = [];
  const W = canvas.width;
  const H = canvas.height;
  // Glyph ink: text-coloured when the text colour is known (rims, ledges
  // and shadows inside a loose panel box are not), else far-from-fill.
  const dist = (o: number): number =>
    text
      ? 999 - (Math.abs((canvas.data[o] as number) - text.r) + Math.abs((canvas.data[o + 1] as number) - text.g) + Math.abs((canvas.data[o + 2] as number) - text.b))
      : Math.abs((canvas.data[o] as number) - fill.r) + Math.abs((canvas.data[o + 1] as number) - fill.g) + Math.abs((canvas.data[o + 2] as number) - fill.b);
  const inkAt = (o: number): boolean => (text ? dist(o) > 999 - 140 : dist(o) > 90);
  const cx0 = Math.round(box.x + box.w * 0.15);
  const cx1 = Math.round(box.x + box.w * 0.85);
  const inkFrac = (y: number): number => {
    let ink = 0;
    let n = 0;
    for (let x = Math.max(0, cx0); x < Math.min(W, cx1); x++) {
      n++;
      if (inkAt((y * W + x) * 4)) ink++;
    }
    return n > 0 ? ink / n : 0;
  };
  const y0 = Math.max(0, Math.round(box.y));
  const y1 = Math.min(H - 1, Math.round(box.y + box.h) - 1);
  // Ink near the box's left/right edges in the same row = a border line
  // (design), not clipped glyphs: glyph rows never reach the box edges.
  const edgeInkFrac = (y: number): number => {
    let ink = 0;
    let n = 0;
    for (const [ex0, ex1] of [[Math.round(box.x + box.w * 0.02), Math.round(box.x + box.w * 0.1)], [Math.round(box.x + box.w * 0.9), Math.round(box.x + box.w * 0.98)]] as const) {
      for (let x = Math.max(0, ex0); x < Math.min(W, ex1); x++) {
        n++;
        if (inkAt((y * W + x) * 4)) ink++;
      }
    }
    return n > 0 ? ink / n : 0;
  };
  const glyphInk = (y: number): number => (edgeInkFrac(y) > 0.5 ? 0 : inkFrac(y));
  if (y1 > y0) {
    // Offset 3px in: a CTA border row is design, glyph ink there is not.
    const topInk = Math.max(glyphInk(Math.min(y1, y0 + 3)), glyphInk(Math.min(y1, y0 + 4)), glyphInk(Math.min(y1, y0 + 5)));
    const botInk = Math.max(glyphInk(Math.max(y0, y1 - 3)), glyphInk(Math.max(y0, y1 - 4)), glyphInk(Math.max(y0, y1 - 5)));
    if (topInk > 0.02) out.push({ code: 'panel_text_clipped', detail: `panel glyph ink touches the top edge (frac ${topInk.toFixed(2)})` });
    if (botInk > 0.02) out.push({ code: 'panel_text_clipped', detail: `panel glyph ink touches the bottom edge (frac ${botInk.toFixed(2)})` });
  }
  // Ghost bar below the panel: a panel-coloured rectangle starting right
  // at the panel's bottom edge (its top hides behind the real panel). A
  // ledge the panel sits on starts lower and is not panel-coloured.
  const stripH = Math.min(48, Math.max(8, Math.round(box.h * 0.6)));
  let run = 0;
  let worst = 0;
  for (let y = y1 + 1; y < Math.min(H, y1 + 1 + stripH); y++) {
    let inner = 0;
    let outer = 0;
    let diff = 0;
    let fillDist = Infinity;
    const inLums: number[] = [];
    const outLums: number[] = [];
    const inRgb: number[][] = [[], [], []];
    for (let x = Math.max(0, cx0); x < Math.min(W, cx1); x += 2) {
      const o = (y * W + x) * 4;
      inLums.push(0.299 * (canvas.data[o] as number) + 0.587 * (canvas.data[o + 1] as number) + 0.114 * (canvas.data[o + 2] as number));
      for (let c = 0; c < 3; c++) (inRgb[c] as number[]).push(canvas.data[o + c] as number);
    }
    for (const [ox0, ox1] of [[Math.max(0, Math.round(box.x) - Math.round(box.w * 0.4)), Math.round(box.x)], [Math.round(box.x + box.w), Math.min(W, Math.round(box.x + box.w * 1.4))]] as const) {
      for (let x = ox0; x < ox1; x += 2) {
        const o = (y * W + x) * 4;
        outLums.push(0.299 * (canvas.data[o] as number) + 0.587 * (canvas.data[o + 1] as number) + 0.114 * (canvas.data[o + 2] as number));
      }
    }
    if (inLums.length > 4 && outLums.length > 4) {
      inLums.sort((a, b) => a - b);
      outLums.sort((a, b) => a - b);
      inner = inLums[Math.floor(inLums.length / 2)] as number;
      outer = outLums[Math.floor(outLums.length / 2)] as number;
      diff = Math.abs(inner - outer);
      const med3 = inRgb.map((v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] as number; });
      fillDist = Math.abs((med3[0] as number) - fill.r) + Math.abs((med3[1] as number) - fill.g) + Math.abs((med3[2] as number) - fill.b);
    }
    const isGhostRow = diff > 28 && fillDist < 75 && y - y1 <= 4 + run;
    if (isGhostRow) { run++; worst = Math.max(worst, run); } else if (y - y1 > 4 && run === 0) { /* bar must start at the panel edge */ } else run = 0;
  }
  if (worst >= 6) out.push({ code: 'panel_ghost_bar', detail: `ghost bar below the panel (${worst} divergent rows under the panel x-range)` });
  return out;
}

/**
 * Crop a pasted panel cut in to the button's own edge: outer rows/columns
 * whose median colour is far from the sampled fill are surrounding plate
 * pixels (the grey/red rim pasted around STRIDE's button), not button.
 * Stops at 55% of the cut in each dimension so a mis-sampled fill can
 * never crop the button away.
 */
export function insetPanelCutToFill(
  rgba: RgbaImage,
  fill: { r: number; g: number; b: number },
): RgbaImage {
  const W = rgba.width;
  const H = rgba.height;
  const lum = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return Math.abs((rgba.data[o] as number) - fill.r) + Math.abs((rgba.data[o + 1] as number) - fill.g) + Math.abs((rgba.data[o + 2] as number) - fill.b);
  };
  const rowDist = (y: number): number => {
    const vals: number[] = [];
    for (let x = 0; x < W; x += 3) vals.push(lum(x, y));
    vals.sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] as number;
  };
  const colDist = (x: number, y0: number, y1: number): number => {
    const vals: number[] = [];
    for (let y = y0; y < y1; y += 3) vals.push(lum(x, y));
    vals.sort((a, b) => a - b);
    return vals.length > 0 ? (vals[Math.floor(vals.length / 2)] as number) : 0;
  };
  let x0 = 0;
  let y0 = 0;
  let x1 = W;
  let y1 = H;
  const maxCropX = Math.floor(W * 0.45);
  const maxCropY = Math.floor(H * 0.45);
  while (y1 - y0 > 12 && y0 < maxCropY && rowDist(y0) > 70) y0++;
  while (y1 - y0 > 12 && H - y1 < maxCropY && rowDist(y1 - 1) > 70) y1--;
  while (x1 - x0 > 16 && x0 < maxCropX && colDist(x0, y0, y1) > 70) x0++;
  while (x1 - x0 > 16 && W - x1 < maxCropX && colDist(x1 - 1, y0, y1) > 70) x1--;
  if (x0 === 0 && y0 === 0 && x1 === W && y1 === H) return rgba;
  const w = x1 - x0;
  const h = y1 - y0;
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * W + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      data[di] = rgba.data[si] as number;
      data[di + 1] = rgba.data[si + 1] as number;
      data[di + 2] = rgba.data[si + 2] as number;
      data[di + 3] = rgba.data[si + 3] as number;
    }
  }
  return { data, width: w, height: h };
}

export interface PanelRimFinding {
  code: 'panel_rim';
  detail: string;
}

/**
 * A band of non-plate, non-panel colour hugging the panel: compare the
 * ring just OUTSIDE the panel box with the plate a little further out.
 * When the inner ring differs from the outer plate on most sides, it is
 * pasted source surround, not plate.
 */
export function panelRimFindings(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
  fill: { r: number; g: number; b: number },
): PanelRimFinding[] {
  const W = canvas.width;
  const H = canvas.height;
  const px = (x: number, y: number): [number, number, number] | null => {
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const o = (y * W + x) * 4;
    return [canvas.data[o] as number, canvas.data[o + 1] as number, canvas.data[o + 2] as number];
  };
  const median = (pts: Array<[number, number, number]>): [number, number, number] | null => {
    if (pts.length < 4) return null;
    const out: number[] = [];
    for (let c = 0; c < 3; c++) {
      const v = pts.map((p) => p[c] as number).sort((a, b) => a - b);
      out.push(v[Math.floor(v.length / 2)] as number);
    }
    return [out[0] as number, out[1] as number, out[2] as number];
  };
  const dist = (a: [number, number, number], b: { r: number; g: number; b: number }): number =>
    Math.abs(a[0] - b.r) + Math.abs(a[1] - b.g) + Math.abs(a[2] - b.b);
  const x0 = Math.round(box.x);
  const y0 = Math.round(box.y);
  const x1 = Math.round(box.x + box.w);
  const y1 = Math.round(box.y + box.h);
  // Inner ring: 4px outside the panel. Outer ring: 16px outside.
  const ring = (off: number): Array<[number, number, number]> => {
    const pts: Array<[number, number, number]> = [];
    for (let x = x0 - off; x < x1 + off; x += 4) {
      for (const y of [y0 - off, y1 + off - 1]) {
        const p = px(x, y);
        if (p) pts.push(p);
      }
    }
    for (let y = y0 - off; y < y1 + off; y += 4) {
      for (const x of [x0 - off, x1 + off - 1]) {
        const p = px(x, y);
        if (p) pts.push(p);
      }
    }
    return pts;
  };
  const inner = median(ring(4));
  const outer = median(ring(16));
  if (!inner || !outer) return [];
  const innerVsPlate = Math.abs(inner[0] - outer[0]) + Math.abs(inner[1] - outer[1]) + Math.abs(inner[2] - outer[2]);
  const innerVsFill = dist(inner, fill);
  if (innerVsPlate > 45 && innerVsFill > 45) {
    return [{ code: 'panel_rim', detail: `rim band around the panel differs from the plate (Δ${Math.round(innerVsPlate)}) and the panel fill (Δ${Math.round(innerVsFill)})` }];
  }
  return [];
}

/**
 * Strong horizontal plate edge through a text box (a ledge/shelf line the
 * glyphs straddle). Reuses the sustained-step logic of findSurfaceEdge,
 * restricted to the middle of the box so a line at the box edge (an
 * underline or the panel top) never triggers.
 */
export function plateEdgeUnderText(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
): { y: number; score: number } | null {
  const mid = { x: box.x, y: box.y + box.h * 0.2, w: box.w, h: box.h * 0.6 };
  const edge = findSurfaceEdge(canvas, mid.x, mid.x + mid.w, mid.y + mid.h / 2, Math.max(4, Math.round(mid.h / 2)));
  if (!edge || !edge.crisp) return null;
  return { y: edge.y, score: edge.score };
}

/**
 * Pick a readable colour for re-rendered text on the plate under its box:
 * the source colour when it already clears the floor, else whichever of
 * black/white reads better. (Yellow tagline on cream tiles scored ~1.2.)
 */
export function readableTextColor(
  canvas: RgbaImage,
  box: { x: number; y: number; w: number; h: number },
  src: { r: number; g: number; b: number },
): { color: { r: number; g: number; b: number }; changed: boolean; ratio: number } {
  const cur = textContrastRatio(canvas, box, src);
  if (cur.ratio >= 2.0) return { color: src, changed: false, ratio: cur.ratio };
  const black = { r: 0, g: 0, b: 0 };
  const white = { r: 255, g: 255, b: 255 };
  const rb = textContrastRatio(canvas, box, black).ratio;
  const rw = textContrastRatio(canvas, box, white).ratio;
  const best = rb >= rw ? black : white;
  const bestRatio = Math.max(rb, rw);
  return { color: best, changed: bestRatio > cur.ratio, ratio: bestRatio };
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
