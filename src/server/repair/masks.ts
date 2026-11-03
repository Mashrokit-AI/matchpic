import type OpenAI from 'openai';
import { buildBoxPromptText, segment } from '../models/sam.js';
import { maskArea, maskBoundingBox, padBox, unionMasks, type PixelBox } from '../../shared/geometry.js';
import type { RgbaImage } from './composite.js';

export const DILATE_PX = 4;
/** A mask whose fill inside its own bbox is below this is unusable. */
export const TINY_MASK_FILL = 0.2;

export interface MaskTarget {
  /** Stable id, e.g. "product-0" or "logo". */
  id: string;
  /** Noun phrase for the SAM phrase prompt, e.g. "bottle". */
  phrase: string;
  /** Spark box for the box prompt, or null for phrase-only. */
  box: PixelBox | null;
}

export interface MasksInput {
  imageBytes: Buffer;
  mimeType: string;
  width: number;
  height: number;
  model: string;
  targets: MaskTarget[];
}

export interface MasksResult {
  masks: Map<string, Uint8Array>;
  blockers: string[];
  labels: Record<string, string>;
  latencyMs: number;
  calls: number;
}

function usableBox(b: PixelBox | null): b is PixelBox {
  return !!b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.w > 0 && b.h > 0;
}

/**
 * Segment one target: the union of the phrase mask with a box prompt on
 * Spark's box (the phrase alone misses parts — e.g. "logo" sees the circle
 * mark but not the wordmark). Phrase-only when no box is known.
 */
export async function segmentTarget(
  client: OpenAI,
  input: MasksInput,
  target: MaskTarget,
): Promise<{ mask: Uint8Array; labels: string[]; calls: number; latencyMs: number }> {
  const base = {
    imageBytes: input.imageBytes,
    mimeType: input.mimeType,
    width: input.width,
    height: input.height,
    model: input.model,
  };
  const phrase = await segment(client, { ...base, inputText: target.phrase });
  let mask = phrase.mask;
  let calls = 1;
  let latencyMs = phrase.latencyMs;
  const labels = [`phrase "${target.phrase}"`];
  if (usableBox(target.box)) {
    const boxed = await segment(client, { ...base, inputText: buildBoxPromptText(target.box, input.width, input.height) });
    calls++;
    latencyMs += boxed.latencyMs;
    mask = unionMasks(mask, boxed.mask);
    labels.push(`box ${JSON.stringify(target.box)}`);
  }
  return { mask, labels, calls, latencyMs };
}

/**
 * Quality gates per target. Each target is judged on its OWN bbox fill —
 * never on a union bbox, which is inherently sparse when elements sit far
 * apart. Empty/tiny results are blockers, never silent.
 */
export function maskBlockers(masks: Map<string, Uint8Array>, width: number, height: number): string[] {
  const blockers: string[] = [];
  for (const [id, mask] of masks) {
    if (maskArea(mask) === 0) {
      blockers.push(`mask_empty:${id}`);
      continue;
    }
    const box = maskBoundingBox(mask, width, height);
    const fill = box ? maskArea(mask) / (box.w * box.h) : 0;
    if (fill < TINY_MASK_FILL) blockers.push(`mask_tiny:${id}`);
  }
  return blockers;
}

/**
 * Complete a logo mask by contrast. SAM sometimes returns only part of a
 * lockup (the mark but half the wordmark). Logos are high-contrast graphics,
 * so within Spark's logo box we add every pixel that differs strongly from
 * the box background — but only within `dilatePx` of the SAM core, so far
 * background texture can never join. Returns the grown mask.
 */
export function growLogoMask(rgba: RgbaImage, mask: Uint8Array, box: PixelBox, dilatePx = 25, threshold = 48): Uint8Array {
  const { width: W, height: H } = rgba;
  const x1 = Math.max(0, Math.min(W - 1, Math.round(box.x)));
  const y1 = Math.max(0, Math.min(H - 1, Math.round(box.y)));
  const x2 = Math.max(x1 + 1, Math.min(W, Math.round(box.x + box.w)));
  const y2 = Math.max(y1 + 1, Math.min(H, Math.round(box.y + box.h)));
  // Background = median of the box border pixels (the lockup never touches all four borders).
  const border: Array<[number, number]> = [];
  for (let x = x1; x < x2; x++) {
    border.push([x, y1], [x, y2 - 1]);
  }
  for (let y = y1 + 1; y < y2 - 1; y++) {
    border.push([x1, y], [x2 - 1, y]);
  }
  const chan = (c: number): number => {
    const vals = border.map(([x, y]) => rgba.data[(y * W + x) * 4 + c] as number).sort((a, b) => a - b);
    return vals[Math.floor(vals.length / 2)] ?? 255;
  };
  const bg: [number, number, number] = [chan(0), chan(1), chan(2)];
  const isInk = (x: number, y: number): boolean => {
    const o = (y * W + x) * 4;
    return (
      Math.abs((rgba.data[o] as number) - bg[0]) > threshold ||
      Math.abs((rgba.data[o + 1] as number) - bg[1]) > threshold ||
      Math.abs((rgba.data[o + 2] as number) - bg[2]) > threshold
    );
  };
  // Ink palette from the SAM core: on photo backgrounds "different from bg"
  // also matches bokeh and branches, so grown pixels must look like the
  // lockup itself (a coarse color shared with ≥2% of core pixels). Seen
  // live: DAFNA's logo grown into a white halo over olive branches.
  const quant = (x: number, y: number): number => {
    const o = (y * W + x) * 4;
    return (((rgba.data[o] as number) >> 3) << 10) | (((rgba.data[o + 1] as number) >> 3) << 5) | ((rgba.data[o + 2] as number) >> 3);
  };
  const buckets = new Map<number, number>();
  let coreN = 0;
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      // Ink core pixels only: background caught in a loose SAM core must
      // not authorize further background growth.
      if (!mask[y * W + x] || !isInk(x, y)) continue;
      const q = quant(x, y);
      buckets.set(q, (buckets.get(q) ?? 0) + 1);
      coreN++;
    }
  }
  const minBucket = Math.max(8, Math.round(coreN * 0.02));
  const palette = new Set([...buckets.entries()].filter(([, n]) => n >= minBucket).map(([c]) => c));
  const addable = (x: number, y: number): boolean => isInk(x, y) && (palette.size === 0 || palette.has(quant(x, y)));
  // BFS outward from SAM core pixels, bounded by dilatePx and the box.
  const out = Uint8Array.from(mask);
  const depth = new Int16Array(W * H).fill(-1);
  const queue: number[] = [];
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      if (mask[y * W + x]) {
        depth[y * W + x] = 0;
        queue.push(y * W + x);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++] as number;
    const d = depth[i] as number;
    if (d >= dilatePx) continue;
    const x = i % W;
    const y = Math.floor(i / W);
    const neighbors = [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ];
    for (const [nx, ny] of neighbors) {
      if (nx < x1 || nx >= x2 || ny < y1 || ny >= y2) continue;
      const ni = ny * W + nx;
      if (depth[ni] !== -1) continue;
      depth[ni] = d + 1;
      if (!out[ni] && addable(nx, ny)) {
        out[ni] = 1;
        queue.push(ni);
      } else if (out[ni]) {
        queue.push(ni);
      }
      // Non-addable pixels are traversed (depth recorded) but never added,
      // so the grow can cross small gaps between letters.
      if (!out[ni] && !addable(nx, ny)) queue.push(ni);
    }
  }
  return out;
}

export const LOGO_BOX_PAD_PX = 15;
/** Horizontal completion reach past the padded box (wordmark clipping). */
export const LOGO_COMPLETE_X_PX = 60;
/** BFS reach for the completion pass (must exceed the widest letter gap). */
export const LOGO_GROW_DILATE_PX = 40;

/**
 * The full logo-mask strategy in one call. Spark's logo box can end tens of
 * pixels short of the lockup (seen live: box ended mid-wordmark, pasting
 * "GAL" with a missing "I"), and both SAM's box prompt and the contrast
 * grow treat the box as a hard bound. So: pad the box, then grow with the
 * bound widened horizontally past the padded box — wordmark clipping is
 * horizontal, while widening vertically would risk the tagline below.
 * Anything farther than LOGO_COMPLETE_X_PX sideways stays excluded.
 */
export function completeLogoMask(rgba: RgbaImage, samMask: Uint8Array, sparkBox: PixelBox): Uint8Array {
  const W = rgba.width;
  const H = rgba.height;
  const padded = padBox(sparkBox, LOGO_BOX_PAD_PX, W, H);
  const x1 = Math.max(0, padded.x - LOGO_COMPLETE_X_PX);
  const x2 = Math.min(W, padded.x + padded.w + LOGO_COMPLETE_X_PX);
  return growLogoMask(rgba, samMask, { x: x1, y: padded.y, w: Math.max(1, x2 - x1), h: padded.h }, LOGO_GROW_DILATE_PX);
}

/**
 * Clip a mask to a box + margin (mutates). The SAM phrase mask is unbounded,
 * so with 2+ products one phrase can match a sibling ("bottle" also matching
 * the jar — seen live as one cut containing both products). Clipping to the
 * target's own Spark box keeps phrase completion inside while bounding the
 * extent. Returns kept/dropped pixel counts for the trace.
 */
export function clipMaskToPaddedBox(mask: Uint8Array, W: number, H: number, box: PixelBox, margin: number): { kept: number; dropped: number } {
  const bound = padBox({ ...box }, margin, W, H);
  let kept = 0;
  let dropped = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      if (x >= bound.x && x < bound.x + bound.w && y >= bound.y && y < bound.y + bound.h) kept++;
      else {
        mask[y * W + x] = 0;
        dropped++;
      }
    }
  }
  return { kept, dropped };
}

/**
 * Clip a product mask to its Spark box + margin, expanding the bound when
 * the mask is sliced by it. Spark boxes can end inside the product (seen
 * live: שקט headphones, box ending mid-headband — the padded clip then cut
 * the product with a straight vertical edge, a long opaque run sitting
 * exactly on the bound). A long run on a bound edge means the bound, not
 * the product, ends there: widen that side (capped, frame-clamped) and
 * re-clip from the original mask until no side is sliced or the cap hits.
 * Detached siblings never touch the bound, so they stay excluded; the
 * caller's instance separation removes any detached sliver an expansion
 * does reach. Returns a NEW mask (input untouched).
 */
export function clipProductMask(
  mask: Uint8Array,
  W: number,
  H: number,
  box: PixelBox,
  margin: number,
  blockers: PixelBox[] = [],
): { mask: Uint8Array; kept: number; dropped: number; expanded: boolean } {
  let bound = padBox({ ...box }, margin, W, H);
  const maxExpandX = Math.round(box.w);
  const maxExpandY = Math.round(box.h);
  let expanded = false;
  for (let iter = 0; iter < 5; iter++) {
    // Count opaque pixels of the ORIGINAL mask sitting on each bound edge.
    const onEdge = { l: 0, r: 0, t: 0, b: 0 };
    for (let y = bound.y; y < bound.y + bound.h; y++) {
      if (mask[y * W + bound.x]) onEdge.l++;
      if (mask[y * W + bound.x + bound.w - 1]) onEdge.r++;
    }
    for (let x = bound.x; x < bound.x + bound.w; x++) {
      if (mask[bound.y * W + x]) onEdge.t++;
      if (mask[(bound.y + bound.h - 1) * W + x]) onEdge.b++;
    }
    const sliced = (n: number, span: number): boolean => n >= Math.max(8, Math.round(span * 0.08));
    const growX = Math.max(margin, Math.round(box.w * 0.2));
    const growY = Math.max(margin, Math.round(box.h * 0.2));
    // Never expand into a sibling product's box: touching instances share
    // one phrase mask, and expanding there merges the neighbour in (seen
    // live: NORTHBEAN's rear can absorbing the front can).
    const stripBlocked = (strip: PixelBox): boolean => blockers.some((b) => {
      const ix = Math.max(0, Math.min(strip.x + strip.w, b.x + b.w) - Math.max(strip.x, b.x));
      const iy = Math.max(0, Math.min(strip.y + strip.h, b.y + b.h) - Math.max(strip.y, b.y));
      return ix * iy > 0.05 * Math.max(1, strip.w * strip.h);
    });
    const next = { ...bound };
    if (sliced(onEdge.l, bound.h) && bound.x > 0 && box.x - bound.x < maxExpandX && !stripBlocked({ x: bound.x - growX, y: bound.y, w: growX, h: bound.h })) next.x = Math.max(0, bound.x - growX);
    if (sliced(onEdge.r, bound.h) && bound.x + bound.w < W && bound.x + bound.w - (box.x + box.w) < maxExpandX && !stripBlocked({ x: bound.x + bound.w, y: bound.y, w: growX, h: bound.h })) next.w = Math.min(W, bound.x + bound.w + growX) - next.x;
    if (sliced(onEdge.t, bound.w) && bound.y > 0 && box.y - bound.y < maxExpandY && !stripBlocked({ x: bound.x, y: bound.y - growY, w: bound.w, h: growY })) next.y = Math.max(0, bound.y - growY);
    if (sliced(onEdge.b, bound.w) && bound.y + bound.h < H && bound.y + bound.h - (box.y + box.h) < maxExpandY && !stripBlocked({ x: bound.x, y: bound.y + bound.h, w: bound.w, h: growY })) next.h = Math.min(H, bound.y + bound.h + growY) - next.y;
    if (next.x === bound.x && next.y === bound.y && next.w === bound.w && next.h === bound.h) break;
    bound = next;
    expanded = true;
  }
  const out = new Uint8Array(W * H);
  let kept = 0;
  let dropped = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      if (x >= bound.x && x < bound.x + bound.w && y >= bound.y && y < bound.y + bound.h) {
        out[y * W + x] = 1;
        kept++;
      } else dropped++;
    }
  }
  return { mask: out, kept, dropped, expanded };
}

/**
 * Fill enclosed holes in a mask (mutates). Flood-fills the background from
 * the frame border; zero pixels NOT reached are interior holes and get filled.
 * Products are opaque solids, so interior holes are always segmentation
 * errors (seen live: a jar mask missing its lid and label, pasting with plate
 * showing through as grey mottling). Never use on logos — lockup counters
 * (A, e, o) are genuine holes.
 */
export function fillMaskHoles(mask: Uint8Array, W: number, H: number): number {
  const seen = new Uint8Array(W * H);
  const queue: number[] = [];
  const push = (x: number, y: number): void => {
    const i = y * W + x;
    if (!mask[i] && !seen[i]) {
      seen[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 1; y < H - 1; y++) {
    push(0, y);
    push(W - 1, y);
  }
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++] as number;
    const x = i % W;
    const y = Math.floor(i / W);
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  let filled = 0;
  for (let i = 0; i < W * H; i++) {
    if (!mask[i] && !seen[i]) {
      mask[i] = 1;
      filled++;
    }
  }
  return filled;
}

/**
 * Instance separation for identical products: the SAM phrase prompt matches
 * EVERY instance ("can" finds all three cans), and clipping to the padded
 * Spark box still keeps detached slivers of a neighbour that fall inside the
 * margin (seen live on NORTHBEAN: thin can fragments beside each can).
 * Keep only the connected component with the largest overlap with the
 * target's own box; drop every detached component. Touching/occluding
 * instances stay merged in one component and are kept whole.
 * Returns dropped pixel count.
 */
export function keepInstanceComponent(mask: Uint8Array, W: number, H: number, box: PixelBox): number {
  const seen = new Uint8Array(W * H);
  const comps: Array<{ px: number[]; overlap: number }> = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    const queue = [s];
    seen[s] = 1;
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++] as number;
      comp.push(i);
      const x = i % W;
      const y = Math.floor(i / W);
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue.push(i + 1); }
      if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; queue.push(i - W); }
      if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; queue.push(i + W); }
    }
    let overlap = 0;
    for (const i of comp) {
      const x = i % W;
      const y = Math.floor(i / W);
      if (x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h) overlap++;
    }
    comps.push({ px: comp, overlap });
  }
  if (comps.length <= 1) return 0;
  const totalPx = comps.reduce((s, c) => s + c.px.length, 0);
  const best = comps.reduce((a, b) => (b.overlap * 100000 + b.px.length > a.overlap * 100000 + a.px.length ? b : a));
  let dropped = 0;
  for (const c of comps) {
    if (c === best) continue;
    // Drop only true slivers: small fragments that barely touch the target
    // box. A large component overlapping the box belongs to the product
    // itself (seen live: headphones whose thin headband split the mask —
    // the far earcup was deleted as a "neighbour").
    // A component carrying a large share of the whole mask is part of the
    // product even when Spark's box barely overlaps it (the box itself was
    // sliced: שקט's right earcup past the box edge, split off by the thin
    // headband). Only genuine fragments — small against both the best
    // component and the whole mask — are dropped.
    const sliver = c.px.length < best.px.length * 0.35 && c.px.length < totalPx * 0.2 && c.overlap < c.px.length * 0.25;
    if (!sliver) continue;
    dropped += c.px.length;
    for (const i of c.px) mask[i] = 0;
  }
  return dropped;
}

/**
 * Resolve pixels claimed by more than one product mask. Touching or
 * occluding products share mask territory (the lying can's cut carried a
 * full-height strip of the upright can in front of it, which pasted as a
 * detached "AN" slice once the products were spaced apart). A contested
 * pixel belongs to the product whose Spark box centre is nearer — the
 * occluder's silhouette is centred on its own box, the occluded product's
 * centre is away from the strip it lost. Mutates the masks; returns the
 * removed pixel count per id.
 */
export function resolveMaskOverlaps(
  masks: Map<string, Uint8Array>,
  W: number,
  H: number,
  boxes: PixelBox[],
): Record<string, number> {
  const removed: Record<string, number> = {};
  const ids = [...masks.keys()];
  if (ids.length < 2) return removed;
  const centers = ids.map((_, i) => {
    const b = boxes[i] ?? { x: 0, y: 0, w: W, h: H };
    return { cx: b.x + b.w / 2, cy: b.y + b.h / 2 };
  });
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      let owner = -1;
      let ownerD = Infinity;
      let claimants = 0;
      for (let k = 0; k < ids.length; k++) {
        if (!masks.get(ids[k] as string)?.[idx]) continue;
        claimants++;
        const c = centers[k] as { cx: number; cy: number };
        const d = (x - c.cx) * (x - c.cx) + (y - c.cy) * (y - c.cy);
        if (d < ownerD) { ownerD = d; owner = k; }
      }
      if (claimants < 2) continue;
      for (let k = 0; k < ids.length; k++) {
        if (k === owner) continue;
        const m = masks.get(ids[k] as string) as Uint8Array;
        if (m[idx]) { m[idx] = 0; removed[ids[k] as string] = (removed[ids[k] as string] ?? 0) + 1; }
      }
    }
  }
  return removed;
}

/**
 * Drop tiny disconnected components from a logo mask (mutates): contrast
 * growth on a busy background adds background speckles whose quantized
 * colour matches the lockup palette; pasted, they read as erosion/mottling
 * on the logo. Real lockup components (letters, marks) are never below
 * 2% of the largest component or 20px. Returns dropped pixel count.
 */
export function dropSmallComponents(mask: Uint8Array, W: number, H: number): number {
  const seen = new Uint8Array(W * H);
  const comps: number[][] = [];
  for (let s = 0; s < W * H; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    const queue = [s];
    seen[s] = 1;
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++] as number;
      comp.push(i);
      const x = i % W;
      const y = Math.floor(i / W);
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue.push(i - 1); }
      if (x < W - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue.push(i + 1); }
      if (y > 0 && mask[i - W] && !seen[i - W]) { seen[i - W] = 1; queue.push(i - W); }
      if (y < H - 1 && mask[i + W] && !seen[i + W]) { seen[i + W] = 1; queue.push(i + W); }
    }
    comps.push(comp);
  }
  if (comps.length <= 1) return 0;
  const largest = Math.max(...comps.map((c) => c.length));
  const floor = Math.max(20, Math.round(largest * 0.02));
  let dropped = 0;
  for (const c of comps) {
    if (c.length >= floor) continue;
    dropped += c.length;
    for (const i of c) mask[i] = 0;
  }
  return dropped;
}

/** Fill ratio of a mask within its own bounding box (1 = solid). */
export function maskFillInBox(mask: Uint8Array, W: number, H: number): number {
  const box = maskBoundingBox(mask, W, H);
  if (!box) return 0;
  return maskArea(mask) / Math.max(1, box.w * box.h);
}

/** Segment every target in parallel; see segmentTarget for the phrase+box union rule. */
export async function segmentTargets(client: OpenAI, input: MasksInput): Promise<MasksResult> {
  const started = Date.now();
  const results = await Promise.all(input.targets.map((target) => segmentTarget(client, input, target)));
  const masks = new Map<string, Uint8Array>();
  const labels: Record<string, string> = {};
  let calls = 0;
  input.targets.forEach((target, i) => {
    const r = results[i] as { mask: Uint8Array; labels: string[]; calls: number; latencyMs: number };
    masks.set(target.id, r.mask);
    labels[target.id] = r.labels.join(' + ');
    calls += r.calls;
  });
  return { masks, blockers: maskBlockers(masks, input.width, input.height), labels, latencyMs: Date.now() - started, calls };
}
