import { describe, expect, it } from 'vitest';
import { clipMaskToPaddedBox, clipProductMask, completeLogoMask, fillMaskHoles, growLogoMask, keepInstanceComponent, maskFillInBox, resolveMaskOverlaps } from '../src/server/repair/masks.js';
import { padBox } from '../src/shared/geometry.js';
import type { RgbaImage } from '../src/server/repair/composite.js';

/**
 * Synthetic lockup on light bg: dark mark (x2-9) + 3 dark letters
 * (x12-19, x22-29, x32-39) + a far dark blob (x80-87) + a light-gray smudge
 * next to the second letter. SAM core covers the mark + first letter only.
 */
function lockup(): { rgba: RgbaImage; core: Uint8Array } {
  const w = 96;
  const h = 20;
  const data = Buffer.alloc(w * h * 4);
  const paint = (x0: number, x1: number, rgb: [number, number, number]): void => {
    for (let y = 4; y < 16; y++) {
      for (let x = x0; x < x1; x++) {
        const o = (y * w + x) * 4;
        data[o] = rgb[0];
        data[o + 1] = rgb[1];
        data[o + 2] = rgb[2];
        data[o + 3] = 255;
      }
    }
  };
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 220;
    data[i * 4 + 1] = 230;
    data[i * 4 + 2] = 228;
    data[i * 4 + 3] = 255;
  }
  const ink: [number, number, number] = [15, 76, 92];
  paint(2, 10, ink);
  paint(12, 20, ink);
  paint(22, 30, ink);
  paint(32, 40, ink);
  paint(80, 88, ink); // far blob: 40px past the lockup, beyond completion range
  paint(22, 24, [200, 214, 210]); // light smudge over the second letter's edge
  const core = new Uint8Array(w * h);
  for (let y = 4; y < 16; y++) {
    for (let x = 2; x < 20; x++) core[y * w + x] = 1;
  }
  return { rgba: { data, width: w, height: h }, core };
}

const countIn = (mask: Uint8Array, w: number, x0: number, x1: number): number => {
  let n = 0;
  for (let y = 4; y < 16; y++) for (let x = x0; x < x1; x++) if (mask[y * w + x]) n++;
  return n;
};

describe('growLogoMask', () => {
  it('completes the wordmark from a partial SAM core', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 96, h: 20 });
    expect(countIn(grown, 96, 22, 30)).toBe(6 * 12); // second letter, minus smudge cols
    expect(countIn(grown, 96, 32, 40)).toBe(8 * 12); // third letter fully added
  });

  it('ignores near-background smudges and far blobs', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 96, h: 20 });
    expect(countIn(grown, 96, 22, 24)).toBe(0); // smudge: below threshold
    expect(countIn(grown, 96, 80, 88)).toBe(0); // far blob: beyond dilate range
  });

  it('refuses ink in a foreign color (branches behind the lockup)', () => {
    const { rgba, core } = lockup();
    // Dark olive branch bar within dilate range of the lockup: bright
    // enough vs the light bg to pass the ink threshold, but nowhere in the
    // lockup's own palette — DAFNA's halo was grown exactly like this.
    for (let y = 4; y < 16; y++) {
      for (let x = 42; x < 54; x++) {
        const o = (y * 96 + x) * 4;
        rgba.data[o] = 95;
        rgba.data[o + 1] = 110;
        rgba.data[o + 2] = 60;
      }
    }
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 96, h: 20 });
    expect(countIn(grown, 96, 42, 54)).toBe(0);
    // Same-ink letters still complete.
    expect(countIn(grown, 96, 32, 40)).toBe(8 * 12);
  });

  it('stays inside the given box', () => {
    const { rgba, core } = lockup();
    const grown = growLogoMask(rgba, core, { x: 0, y: 0, w: 30, h: 20 });
    expect(countIn(grown, 96, 32, 40)).toBe(0);
    expect(countIn(grown, 96, 24, 30)).toBeGreaterThan(0);
  });

  it('recovers a letter clipped by a tight Spark box once the box is padded', () => {
    const { rgba, core } = lockup();
    // Spark's box ends at x=30, clipping the third letter (x32-39) — seen
    // live as a "GAL" logo with a damaged "I".
    const tight = { x: 0, y: 0, w: 30, h: 20 };
    expect(countIn(growLogoMask(rgba, core, tight), 96, 32, 40)).toBe(0);
    const padded = padBox(tight, 15, 96, 20);
    expect(padded).toEqual({ x: 0, y: 0, w: 45, h: 20 });
    expect(countIn(growLogoMask(rgba, core, padded), 96, 32, 40)).toBe(8 * 12);
  });
});

describe('completeLogoMask', () => {
  it('completes a wordmark far outside a short Spark box, ignoring far ink', () => {
    const { rgba, core } = lockup();
    // Spark's box ends at x=20; the third letter (x32-39) is well outside
    // it — completion must reach it anyway (padding alone does not).
    const done = completeLogoMask(rgba, core, { x: 0, y: 0, w: 20, h: 20 });
    expect(countIn(done, 96, 32, 40)).toBe(8 * 12); // third letter fully added
    expect(countIn(done, 96, 80, 88)).toBe(0); // far blob stays out
  });
});

describe('clipMaskToPaddedBox', () => {
  it('drops a sibling product matched by the unbounded phrase mask', () => {
    // Two blobs 40px apart; the target box covers only the left one.
    const W = 96;
    const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 2; x < 20; x++) mask[y * W + x] = 1;
      for (let x = 60; x < 78; x++) mask[y * W + x] = 1;
    }
    const { kept, dropped } = clipMaskToPaddedBox(mask, W, H, { x: 0, y: 0, w: 24, h: 20 }, 4);
    expect(kept).toBe(18 * 12);
    expect(dropped).toBe(18 * 12);
    expect(countIn(mask, 96, 60, 78)).toBe(0);
    expect(countIn(mask, 96, 2, 20)).toBe(18 * 12);
  });
});

describe('clipProductMask (straight-edge regression)', () => {
  it('expands the clip bound when the mask is sliced by it, instead of cutting the product', () => {
    // Headphones extend past Spark's box: mask blob x10-70, box ends x44,
    // padded bound ends x48 — a long opaque run on the bound is a slice.
    const W = 96; const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) for (let x = 10; x < 70; x++) mask[y * W + x] = 1;
    const r = clipProductMask(mask, W, H, { x: 10, y: 2, w: 34, h: 16 }, 4);
    expect(r.expanded).toBe(true);
    expect(countIn(r.mask, 96, 60, 70)).toBe(10 * 12); // far side of the product kept
    expect(countIn(r.mask, 96, 10, 70)).toBe(60 * 12);
  });

  it('does not expand into a sibling product box (touching cans stay separate)', () => {
    const W = 96; const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) for (let x = 10; x < 70; x++) mask[y * W + x] = 1;
    // Sibling box starts at x50: expansion rightward is blocked there.
    const r = clipProductMask(mask, W, H, { x: 10, y: 2, w: 34, h: 16 }, 4, [{ x: 50, y: 2, w: 30, h: 16 }]);
    expect(countIn(r.mask, 96, 56, 70)).toBe(0);
  });

  it('does not expand toward a detached sibling that never touches the bound', () => {
    const W = 96; const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 2; x < 20; x++) mask[y * W + x] = 1;
      for (let x = 60; x < 78; x++) mask[y * W + x] = 1;
    }
    const r = clipProductMask(mask, W, H, { x: 0, y: 0, w: 24, h: 20 }, 4);
    expect(r.expanded).toBe(false);
    expect(countIn(r.mask, 96, 60, 78)).toBe(0);
  });
});

describe('keepInstanceComponent', () => {
  it('drops a detached neighbour sliver, keeps the can that owns the box', () => {
    const W = 96;
    const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 10; x < 30; x++) mask[y * W + x] = 1; // own can
      for (let x = 34; x < 38; x++) mask[y * W + x] = 1; // neighbour sliver inside padded box
    }
    const dropped = keepInstanceComponent(mask, W, H, { x: 8, y: 2, w: 26, h: 16 });
    expect(dropped).toBe(4 * 12);
    expect(countIn(mask, 96, 10, 30)).toBe(20 * 12);
    expect(countIn(mask, 96, 34, 38)).toBe(0);
  });
});

describe('keepInstanceComponent large product parts', () => {
  it('keeps a detached part carrying a large share of the mask (headphone earcup past a sliced box)', () => {
    const W = 96; const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 2; x < 62; x++) mask[y * W + x] = 1; // headband + left cup: 60x12
      for (let x = 72; x < 90; x++) mask[y * W + x] = 1; // right cup: 18x12, ~23% of the whole mask
    }
    // Spark box ends before the right cup, so the cup barely overlaps it.
    const dropped = keepInstanceComponent(mask, W, H, { x: 0, y: 2, w: 66, h: 16 });
    expect(dropped).toBe(0);
    expect(countIn(mask, 96, 72, 90)).toBe(18 * 12);
  });
});

describe('resolveMaskOverlaps', () => {
  it('assigns contested pixels to the product whose box centre is nearer (occluder strip removed)', () => {
    const W = 96; const H = 20;
    const front = new Uint8Array(W * H);
    const lying = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 10; x < 50; x++) front[y * W + x] = 1;
      for (let x = 40; x < 90; x++) lying[y * W + x] = 1; // contested strip x40-49
    }
    const masks = new Map([['product-0', front], ['product-1', lying]]);
    const removed = resolveMaskOverlaps(masks, W, H, [{ x: 10, y: 2, w: 40, h: 16 }, { x: 40, y: 2, w: 50, h: 16 }]);
    // Front centre x30, lying centre x65: contested x40-47 nearer the front,
    // x48-49 nearer the lying can (the Voronoi split between the centres).
    expect(countIn(lying, 96, 40, 48)).toBe(0);
    expect(countIn(front, 96, 40, 48)).toBe(8 * 12);
    expect(removed['product-1']).toBe(8 * 12);
    expect(countIn(lying, 96, 50, 90)).toBe(40 * 12); // own body untouched
  });
});

describe('fillMaskHoles', () => {
  it('fills enclosed holes but keeps border-connected background', () => {
    const W = 20;
    const H = 10;
    const mask = new Uint8Array(W * H).fill(1);
    // Enclosed 2x2 hole.
    mask[4 * W + 5] = 0; mask[4 * W + 6] = 0; mask[5 * W + 5] = 0; mask[5 * W + 6] = 0;
    // Border-connected notch (top edge).
    mask[0 * W + 10] = 0; mask[0 * W + 11] = 0; mask[1 * W + 10] = 0; mask[1 * W + 11] = 0;
    const filled = fillMaskHoles(mask, W, H);
    expect(filled).toBe(4);
    expect(mask[4 * W + 5]).toBe(1);
    expect(mask[0 * W + 10]).toBe(0);
  });

  it('scores sparse masks low', () => {
    const W = 10;
    const H = 10;
    const solid = new Uint8Array(W * H).fill(1);
    expect(maskFillInBox(solid, W, H)).toBe(1);
    const sparse = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i += 2) sparse[i] = 1;
    expect(maskFillInBox(sparse, W, H)).toBeLessThan(0.7);
    expect(maskFillInBox(new Uint8Array(W * H), W, H)).toBe(0);
  });
});

describe('padBox', () => {
  it('expands on all sides and clamps to the frame', () => {
    expect(padBox({ x: 100, y: 50, w: 200, h: 80 }, 15, 1080, 1080)).toEqual({ x: 85, y: 35, w: 230, h: 110 });
    expect(padBox({ x: 5, y: 5, w: 100, h: 100 }, 15, 1080, 1080)).toEqual({ x: 0, y: 0, w: 120, h: 120 });
    expect(padBox({ x: 1000, y: 1000, w: 70, h: 70 }, 15, 1080, 1080)).toEqual({ x: 985, y: 985, w: 95, h: 95 });
  });
});

describe('keepInstanceComponent product parts', () => {
  it('keeps a large second part of the same product (headphone earcup)', () => {
    const W = 96; const H = 20;
    const mask = new Uint8Array(W * H);
    for (let y = 4; y < 16; y++) {
      for (let x = 10; x < 30; x++) mask[y * W + x] = 1;
      for (let x = 40; x < 58; x++) mask[y * W + x] = 1;
    }
    const dropped = keepInstanceComponent(mask, W, H, { x: 8, y: 2, w: 54, h: 16 });
    expect(dropped).toBe(0);
  });
});
