import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { cutMaskedPng, debandFlatPlate, decodeRgba, exactSize, findSurfaceEdge, scaleRgbaNearest, textContrastRatio } from '../src/server/repair/composite.js';
import { applyFrameOverlay, pastePanelFallback, type OutputRequest } from '../src/server/adfit/pipeline.js';
import { elementProof } from '../src/server/repair/proof.js';

async function solidPng(w: number, h: number, r: number, g: number, b: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

describe('exactSize', () => {
  it('cover-fits any input to the exact preset and verifies', async () => {
    // Wire shape the model actually returns for 1080x1920 (aspect only).
    const wire = await solidPng(1152, 2048, 10, 20, 30);
    const out = await exactSize(wire, 1080, 1920);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1080, 1920]);
  });

  it('never stretches: square input to wide output keeps proportions', async () => {
    const wire = await solidPng(100, 100, 10, 20, 30);
    const out = await exactSize(wire, 1200, 628);
    const meta = await sharp(out).metadata();
    expect([meta.width, meta.height]).toEqual([1200, 628]);
  });
});

describe('cutMaskedPng', () => {
  it('cuts the tight masked crop with alpha from the mask', async () => {
    const rgba = await decodeRgba(await solidPng(10, 10, 200, 30, 30));
    const mask = new Uint8Array(100);
    for (let y = 2; y < 6; y++) for (let x = 3; x < 8; x++) mask[y * 10 + x] = 1;
    const cut = await cutMaskedPng(rgba, mask);
    expect([cut.x, cut.y, cut.w, cut.h]).toEqual([3, 2, 5, 4]);
    const back = await decodeRgba(cut.png);
    expect([back.width, back.height]).toEqual([5, 4]);
  });

  it('throws on an empty mask', async () => {
    const rgba = await decodeRgba(await solidPng(4, 4, 1, 2, 3));
    await expect(cutMaskedPng(rgba, new Uint8Array(16))).rejects.toThrow(/empty mask/);
  });
});

describe('scaleRgbaNearest', () => {
  it('scales uniformly without blending colors', () => {
    const src = { data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255]), width: 2, height: 2 };
    const out = scaleRgbaNearest(src, 2);
    expect([out.width, out.height]).toEqual([4, 4]);
    // Top-left 2x2 block repeats the first pixel exactly.
    expect([...out.data.slice(0, 4)]).toEqual([10, 20, 30, 255]);
    expect([...out.data.slice(4, 8)]).toEqual([10, 20, 30, 255]);
  });
});

describe('frame overlay', () => {
  it('stamps an exact-size frame last and leaves transparent pixels alone', async () => {
    const canvas = await decodeRgba(await solidPng(8, 8, 50, 60, 70));
    // 8x8 frame: opaque red left column, transparent elsewhere.
    const frameRaw = Buffer.alloc(8 * 8 * 4);
    for (let y = 0; y < 8; y++) {
      frameRaw[(y * 8) * 4] = 255;
      frameRaw[(y * 8) * 4 + 3] = 255;
    }
    const frame = await sharp(frameRaw, { raw: { width: 8, height: 8, channels: 4 } }).png().toBuffer();
    const note = await applyFrameOverlay(canvas, frame, 8, 8);
    expect(note).toBe('frame overlay applied');
    expect([canvas.data[0], canvas.data[1], canvas.data[2]]).toEqual([255, 0, 0]);
    expect([canvas.data[4], canvas.data[5], canvas.data[6]]).toEqual([50, 60, 70]);
  });

  it('skips a frame whose size does not match, with an honest note', async () => {
    const canvas = await decodeRgba(await solidPng(8, 8, 50, 60, 70));
    const frame = await solidPng(10, 10, 255, 0, 0);
    const note = await applyFrameOverlay(canvas, frame, 8, 8);
    expect(note).toMatch(/skipped/);
    expect([canvas.data[0], canvas.data[1], canvas.data[2]]).toEqual([50, 60, 70]);
  });
});

describe('findSurfaceEdge', () => {
  // 200x200 canvas: bright wall (225) above y=120, dark wood (120) below.
  async function tableCanvas(): Promise<{ data: Buffer; width: number; height: number }> {
    const data = Buffer.alloc(200 * 200 * 4);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const o = (y * 200 + x) * 4;
        const v = y < 120 ? 225 : 120;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    return { data, width: 200, height: 200 };
  }

  it('finds a crisp table back edge near the planned base', async () => {
    const edge = findSurfaceEdge(await tableCanvas(), 40, 160, 130, 30);
    expect(edge).not.toBeNull();
    expect(edge!.y).toBeGreaterThanOrEqual(116);
    expect(edge!.y).toBeLessThanOrEqual(124);
    expect(edge!.crisp).toBe(true);
  });

  it('returns null on a seamless background', async () => {
    const data = Buffer.alloc(200 * 200 * 4);
    for (let i = 0; i < 200 * 200; i++) {
      // Gentle noise around mid-grey (texture-level, no step).
      const v = 150 + ((i * 37) % 7) - 3;
      data[i * 4] = v;
      data[i * 4 + 1] = v;
      data[i * 4 + 2] = v;
      data[i * 4 + 3] = 255;
    }
    expect(findSurfaceEdge({ data, width: 200, height: 200 }, 40, 160, 130, 30)).toBeNull();
  });

  it('judges a gradient by its worse tercile, not the mean', async () => {
    // Left half bright (230), right half dark (60): dark text vanishes on
    // the dark half even though the mean looks passable.
    const data = Buffer.alloc(120 * 60 * 4);
    for (let y = 0; y < 60; y++) {
      for (let x = 0; x < 120; x++) {
        const o = (y * 120 + x) * 4;
        const v = x < 60 ? 230 : 60;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    const img = { data, width: 120, height: 60 };
    const dark = textContrastRatio(img, { x: 0, y: 0, w: 120, h: 60 }, { r: 40, g: 40, b: 40 });
    expect(dark.ratio).toBeLessThan(2.0);
    const light = textContrastRatio(img, { x: 0, y: 0, w: 120, h: 60 }, { r: 245, g: 245, b: 245 });
    expect(light.ratio).toBeLessThan(2.0);
    // Same dark text on a fully bright field passes comfortably.
    const bright = textContrastRatio(img, { x: 0, y: 0, w: 50, h: 60 }, { r: 40, g: 40, b: 40 });
    expect(bright.ratio).toBeGreaterThan(5);
  });

  it('equalizes footer bands but leaves interior stripes and discs alone', () => {
    // 100x60 field at 240; footer bands at 200/180; an interior stripe at
    // 200; a dark disc mid-frame (multi-content rows are never corrected).
    const W = 100;
    const H = 60;
    const data = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        let v = 240;
        if (y >= 52 && y < 56) v = 200;
        if (y >= 56) v = 180;
        if (y >= 24 && y < 28) v = 200;
        const dx = x - 80;
        const dy = y - 14;
        if (dx * dx + dy * dy <= 64) v = 120;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    const img = { data, width: W, height: H };
    const out = debandFlatPlate(img);
    expect(out.corrected).toBe(true);
    expect(out.rows).toBe(8);
    const lum = (x: number, y: number): number => img.data[(y * W + x) * 4] as number;
    // Footer bands lifted into the field…
    expect(lum(10, 54)).toBeGreaterThan(230);
    expect(lum(10, 58)).toBeGreaterThan(230);
    // …interior stripe kept (design)…
    expect(lum(10, 26)).toBeLessThan(210);
    // …disc pixels kept (multi-content rows untouched).
    expect(lum(80, 14)).toBe(120);
  });

  it('ignores a thin line (not a sustained surface step)', async () => {
    const data = Buffer.alloc(200 * 200 * 4);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 200; x++) {
        const o = (y * 200 + x) * 4;
        const v = y === 125 ? 60 : 180;
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
    }
    // A 1px dark line has a strong local step but no sustained shift.
    expect(findSurfaceEdge({ data, width: 200, height: 200 }, 40, 160, 130, 30)).toBeNull();
  });
});

describe('pastePanelFallback', () => {
  it('trims flat background caught in a loose panel cut (no light fringe on the plate)', async () => {
    // 100x60 cut: dark panel (92x52) + flat light border (right 8px, bottom 8px).
    const CW = 100;
    const CH = 60;
    const cutData = Buffer.alloc(CW * CH * 4);
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        const o = (y * CW + x) * 4;
        const border = x >= 92 || y >= 52;
        const v = border ? [225, 220, 205] : [30, 30, 45];
        cutData[o] = v[0] as number;
        cutData[o + 1] = v[1] as number;
        cutData[o + 2] = v[2] as number;
        cutData[o + 3] = 255;
      }
    }
    const cut = { id: 'panel', rgba: { data: cutData, width: CW, height: CH }, srcX: 0, srcY: 0, fallbackRect: true };
    // Mid-grey canvas; the dst box is bigger than the trimmed panel.
    const W = 200;
    const H = 140;
    const canvasData = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      canvasData[i * 4] = 128;
      canvasData[i * 4 + 1] = 128;
      canvasData[i * 4 + 2] = 128;
      canvasData[i * 4 + 3] = 255;
    }
    const req = { source: { panel: cut } } as unknown as OutputRequest;
    const placed: Parameters<typeof pastePanelFallback>[3] = [];
    const notes: string[] = [];
    const skipped = await pastePanelFallback(req, { x: 40, y: 34, w: 120, h: 72 }, { data: canvasData, width: W, height: H }, placed, notes);
    expect(skipped).toBe(false);
    expect(placed).toHaveLength(1);
    const lum = (x: number, y: number): number => canvasData[(y * W + x) * 4] as number;
    // Panel centre is pasted dark…
    expect(lum(100, 70)).toBeLessThan(60);
    // …and no light fringe pixel survives anywhere in the dst box.
    for (let y = 34; y < 106; y += 2) {
      for (let x = 40; x < 160; x += 2) {
        expect(lum(x, y)).toBeLessThan(200);
      }
    }
    // The trim + pre-scale rounding keep the zero-tolerance pixel proof green.
    const p = placed[0]!;
    const proof = elementProof({
      sourceCut: p.cut.rgba,
      output: { data: canvasData, width: W, height: H },
      left: p.left,
      top: p.top,
      scale: p.scale,
      featherPx: p.featherPx,
    });
    expect(proof.pass).toBe(true);
    expect(proof.core_differ).toBe(0);
  });
});
