import type { RgbaImage } from '../repair/composite.js';
import type { PixelBox } from '../../shared/geometry.js';

function hex(r: number, g: number, b: number): string {
  const h = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * Pixel-sampled panel fill: median color of a grid over the panel bbox,
 * IGNORING dark/light text outliers by taking the median (text pixels are a
 * minority). This is the color a rebuilt panel is filled with.
 */
function parseHex(hexColor: string): { r: number; g: number; b: number } {
  return {
    r: parseInt(hexColor.slice(1, 3), 16) || 0,
    g: parseInt(hexColor.slice(3, 5), 16) || 0,
    b: parseInt(hexColor.slice(5, 7), 16) || 0,
  };
}

const colorDist = (rgba: RgbaImage, o: number, f: { r: number; g: number; b: number }): number =>
  Math.abs((rgba.data[o] as number) - f.r) + Math.abs((rgba.data[o + 1] as number) - f.g) + Math.abs((rgba.data[o + 2] as number) - f.b);

/**
 * Tighten a Spark panel box to the button's own fill region: the connected
 * region of pixels near the sampled fill colour around the box. A separate
 * text line below the button (LUMA's "Free shipping" under "Shop now") is
 * not fill-coloured and never enters the region, so it can no longer be
 * baked into the panel cut. Garbage in → original box out.
 */
export function tightenPanelRect(rgba: RgbaImage, box: PixelBox, fillHex: string): PixelBox {
  const fill = parseHex(fillHex);
  const W = rgba.width;
  const H = rgba.height;
  const orig: PixelBox = {
    x: Math.max(0, Math.round(box.x)),
    y: Math.max(0, Math.round(box.y)),
    w: Math.max(1, Math.round(box.w)),
    h: Math.max(1, Math.round(box.h)),
  };
  const padX = Math.round(orig.w * 0.12);
  const padY = Math.round(orig.h * 0.12);
  const wx0 = Math.max(0, orig.x - padX);
  const wy0 = Math.max(0, orig.y - padY);
  const wx1 = Math.min(W, orig.x + orig.w + padX);
  const wy1 = Math.min(H, orig.y + orig.h + padY);
  const ww = wx1 - wx0;
  const wh = wy1 - wy0;
  if (ww < 8 || wh < 8) return orig;
  const near = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++) {
    for (let x = 0; x < ww; x++) {
      const o = ((wy0 + y) * W + (wx0 + x)) * 4;
      if (colorDist(rgba, o, fill) <= 100) near[y * ww + x] = 1;
    }
  }
  // Connected components (4-dir); keep the one overlapping the Spark box most.
  const seen = new Uint8Array(ww * wh);
  let best: { x0: number; y0: number; x1: number; y1: number; overlap: number; count: number } | null = null;
  for (let s = 0; s < ww * wh; s++) {
    if (!near[s] || seen[s]) continue;
    const stack = [s];
    seen[s] = 1;
    let x0 = s % ww;
    let x1 = x0;
    let y0 = Math.floor(s / ww);
    let y1 = y0;
    let count = 0;
    let overlap = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % ww;
      const y = Math.floor(i / ww);
      count++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const gx = wx0 + x;
      const gy = wy0 + y;
      if (gx >= orig.x && gx < orig.x + orig.w && gy >= orig.y && gy < orig.y + orig.h) overlap++;
      const nb = [x > 0 ? i - 1 : -1, x < ww - 1 ? i + 1 : -1, y > 0 ? i - ww : -1, y < wh - 1 ? i + ww : -1];
      for (const n of nb) {
        if (n >= 0 && near[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    if (!best || overlap > best.overlap) best = { x0, y0, x1, y1, overlap, count };
  }
  if (!best) return orig;
  const boxArea = orig.w * orig.h;
  const cx = orig.x + orig.w / 2;
  const cy = orig.y + orig.h / 2;
  const bx0 = wx0 + best.x0;
  const by0 = wy0 + best.y0;
  const bx1 = wx0 + best.x1 + 1;
  const by1 = wy0 + best.y1 + 1;
  // The fill region must carry most of the Spark box and contain its centre;
  // a sliver or a neighbouring same-colour region is not the button.
  if (best.overlap < boxArea * 0.35 || best.count < boxArea * 0.3) return orig;
  if (cx < bx0 || cx >= bx1 || cy < by0 || cy >= by1) return orig;
  return {
    x: Math.max(0, bx0 - 3),
    y: Math.max(0, by0 - 3),
    w: Math.min(W, bx1 + 3) - Math.max(0, bx0 - 3),
    h: Math.min(H, by1 + 3) - Math.max(0, by0 - 3),
  };
}

/**
 * Sample the panel's TEXT colour from the button's own pixels: the median
 * of pixels inside the (tightened) box that are far from the fill — the
 * glyphs. Null when there are too few glyph pixels to trust.
 */
export function samplePanelTextColor(rgba: RgbaImage, box: PixelBox, fillHex: string): string | null {
  const fill = parseHex(fillHex);
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(rgba.width, Math.round(box.x + box.w));
  const y1 = Math.min(rgba.height, Math.round(box.y + box.h));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = (y * rgba.width + x) * 4;
      if (colorDist(rgba, o, fill) <= 120) continue;
      rs.push(rgba.data[o] as number);
      gs.push(rgba.data[o + 1] as number);
      bs.push(rgba.data[o + 2] as number);
    }
  }
  const total = Math.max(1, (x1 - x0) * (y1 - y0));
  if (rs.length < total * 0.01 || rs.length < 40) return null;
  // Glyph cores form the largest colour cluster; anti-aliased edge pixels
  // spread thinly across many tones and would drag a plain median toward
  // the fill. Take the median of the biggest quantized cluster instead.
  const bins = new Map<number, number[]>();
  for (let i = 0; i < rs.length; i++) {
    const key = (((rs[i] as number) >> 5) << 10) | (((gs[i] as number) >> 5) << 5) | ((bs[i] as number) >> 5);
    const arr = bins.get(key) ?? [];
    arr.push(i);
    bins.set(key, arr);
  }
  let top: number[] = [];
  for (const arr of bins.values()) if (arr.length > top.length) top = arr;
  const med = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 255;
  };
  return hex(
    med(top.map((i) => rs[i] as number)),
    med(top.map((i) => gs[i] as number)),
    med(top.map((i) => bs[i] as number)),
  );
}

export function samplePanelColor(rgba: RgbaImage, box: PixelBox): string {
  const x1 = Math.max(0, Math.min(rgba.width - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(rgba.height - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(rgba.width, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(rgba.height, Math.round(box.y + box.h)));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 24));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const o = (y * rgba.width + x) * 4;
      rs.push(rgba.data[o] as number);
      gs.push(rgba.data[o + 1] as number);
      bs.push(rgba.data[o + 2] as number);
    }
  }
  const med = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 255;
  };
  return hex(med(rs), med(gs), med(bs));
}

/**
 * Panel complexity: per-channel standard deviation over the panel's BORDER
 * ring only (outer 12% — background, not text). A flat or gradient panel
 * scores low (rebuild it); photo texture or illustration scores high (paste
 * it, flagged when too small). Sampling the full box would mistake text for
 * texture (seen live: white type on flat orange scored "complex").
 * Threshold tuned on flat panels (~2-8) vs photographic regions (>40).
 */
export function panelComplexity(rgba: RgbaImage, box: PixelBox): { stdev: number; complex: boolean } {
  // Sample INSIDE the button: the outer ring of a Spark/snap box mixes the
  // button's edge line, its shadow and the surrounding photo, which scored
  // a flat slate CTA (stdev 41) as "complex" and forced a blurry paste.
  // Shrinking 10% lands on flat fill for a real flat button (stdev ~2),
  // while photo/illustration texture stays varied at any inset.
  const insetX = Math.round(box.w * 0.1);
  const insetY = Math.round(box.h * 0.1);
  const shrunk: PixelBox = box.w - insetX * 2 > 16 && box.h - insetY * 2 > 12
    ? { x: box.x + insetX, y: box.y + insetY, w: box.w - insetX * 2, h: box.h - insetY * 2 }
    : box;
  const x1 = Math.max(0, Math.min(rgba.width - 1, Math.round(shrunk.x)));
  const y1 = Math.max(0, Math.min(rgba.height - 1, Math.round(shrunk.y)));
  const x2 = Math.max(x1 + 1, Math.min(rgba.width, Math.round(shrunk.x + shrunk.w)));
  const y2 = Math.max(y1 + 1, Math.min(rgba.height, Math.round(shrunk.y + shrunk.h)));
  const ring = Math.max(2, Math.round(Math.min(x2 - x1, y2 - y1) * 0.12));
  const vals: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.floor(Math.min(x2 - x1, y2 - y1) / 24));
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      const border = x < x1 + ring || x >= x2 - ring || y < y1 + ring || y >= y2 - ring;
      if (!border) continue;
      const o = (y * rgba.width + x) * 4;
      vals.push([rgba.data[o] as number, rgba.data[o + 1] as number, rgba.data[o + 2] as number]);
    }
  }
  if (vals.length === 0) return { stdev: 0, complex: false };
  const mean = [0, 1, 2].map((c) => vals.reduce((s, v) => s + (v[c] as number), 0) / vals.length);
  const variance =
    vals.reduce((s, v) => s + [0, 1, 2].reduce((t, c) => t + ((v[c] as number) - (mean[c] as number)) ** 2, 0), 0) /
    (vals.length * 3);
  const stdev = Math.sqrt(variance);
  return { stdev, complex: stdev > 28 };
}

/**
 * Snap a Spark panel bbox out to the panel's visual edges. Spark tends to fit
 * the text block, clipping the panel's padding (and with it, sub-line
 * bottoms). Corner-seeded flood fill on quantized color recovers the full
 * uniform region: seeds whose region does not touch the box center (text
 * glyphs, background) are discarded, and the union bbox of the rest is the
 * panel. Text inside the panel is harmless (holes don't move the bbox).
 * A kept region's bbox must also be substantially covered by the original
 * box: on flat-design sources a background flood can come in under the
 * pixel cap with a full-frame bbox that merely surrounds the box (seen live
 * on ZAZO: cream background kept, panel cut became the whole source).
 * Expansion-only in effect; garbage in → original box out.
 */
export function snapPanelRect(rgba: RgbaImage, box: PixelBox): PixelBox {
  const { width: W, height: H } = rgba;
  const x1 = Math.max(0, Math.min(W - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(H - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(W, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(H, Math.round(box.y + box.h)));
  const cx = Math.floor((x1 + x2) / 2);
  const cy = Math.floor((y1 + y2) / 2);

  const quant = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return (((rgba.data[o] as number) >> 3) << 10) | (((rgba.data[o + 1] as number) >> 3) << 5) | ((rgba.data[o + 2] as number) >> 3);
  };
  const cap = Math.floor(W * H * 0.5);

  const flood = (sx: number, sy: number): PixelBox | null => {
    const target = quant(sx, sy);
    const seen = new Uint8Array(W * H);
    const stack: number[] = [sy * W + sx];
    seen[sy * W + sx] = 1;
    let minX = sx;
    let minY = sy;
    let maxX = sx;
    let maxY = sy;
    let n = 0;
    while (stack.length > 0) {
      const i = stack.pop() as number;
      n++;
      if (n > cap) return null; // Ran into the background: discard this seed.
      const x = i % W;
      const y = Math.floor(i / W);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (x > 0 && !seen[i - 1] && quant(x - 1, y) === target) {
        seen[i - 1] = 1;
        stack.push(i - 1);
      }
      if (x < W - 1 && !seen[i + 1] && quant(x + 1, y) === target) {
        seen[i + 1] = 1;
        stack.push(i + 1);
      }
      if (y > 0 && !seen[i - W] && quant(x, y - 1) === target) {
        seen[i - W] = 1;
        stack.push(i - W);
      }
      if (y < H - 1 && !seen[i + W] && quant(x, y + 1) === target) {
        seen[i + W] = 1;
        stack.push(i + W);
      }
    }
    // Keep regions whose bbox contains the box center (a text glyph's own
    // bbox rarely does; the panel's always does).
    if (!(minX <= cx && cx <= maxX && minY <= cy && cy <= maxY)) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  // 15 seeds across the box, INCLUDING its edge rows/columns: on a tight
  // box the surviving padding rows are exactly at the edges. Seeds that hit
  // the background flood into the cap and are discarded.
  const clamp = (x: number, y: number): [number, number] => [
    Math.max(0, Math.min(W - 1, x)),
    Math.max(0, Math.min(H - 1, y)),
  ];
  const mx = Math.floor((x1 + x2) / 2);
  const my = Math.floor((y1 + y2) / 2);
  const rows = [y1, y1 + 2, my, y2 - 3, y2 - 1];
  const cols = [x1, mx, x2 - 1];
  const seeds = rows.flatMap((y) => cols.map((x) => clamp(x, y)));
  // Expansion-only: the original box is always part of the union, so the
  // snap can never shrink below it (glyph-only unions on huge panels).
  const regions: PixelBox[] = [{ x: x1, y: y1, w: x2 - x1, h: y2 - y1 }];
  for (const [sx, sy] of seeds) {
    const r = flood(sx, sy);
    if (!r) continue;
    const ox1 = Math.max(r.x, x1);
    const oy1 = Math.max(r.y, y1);
    const ox2 = Math.min(r.x + r.w, x2);
    const oy2 = Math.min(r.y + r.h, y2);
    const covered = Math.max(0, ox2 - ox1) * Math.max(0, oy2 - oy1);
    if (covered < r.w * r.h * 0.18) continue;
    regions.push(r);
  }
  const ux1 = Math.min(...regions.map((r) => r.x));
  const uy1 = Math.min(...regions.map((r) => r.y));
  const ux2 = Math.max(...regions.map((r) => r.x + r.w));
  const uy2 = Math.max(...regions.map((r) => r.y + r.h));
  const snapped = { x: ux1, y: uy1, w: ux2 - ux1, h: uy2 - uy1 };
  // Sanity: the snap must cover the original center, overlap at least 40% of
  // the original box, and stay within 12x its area. Otherwise the floods ran
  // somewhere unexpected and the original box is the honest answer.
  const origArea = (x2 - x1) * (y2 - y1);
  const coversCenter = ux1 <= cx && cx <= ux2 && uy1 <= cy && cy <= uy2;
  const ix1 = Math.max(ux1, x1);
  const iy1 = Math.max(uy1, y1);
  const ix2 = Math.min(ux2, x2);
  const iy2 = Math.min(uy2, y2);
  const overlap = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  if (!coversCenter || overlap < origArea * 0.4 || snapped.w * snapped.h > origArea * 12) {
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }
  return snapped;
}
