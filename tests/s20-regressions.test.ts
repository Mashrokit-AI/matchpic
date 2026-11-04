import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { LayoutPlan, SourceAnalysis } from '../src/shared/schemas.js';
import { samplePanelColor, samplePanelTextColor, tightenPanelRect } from '../src/server/adfit/snap.js';
import { manifestFromPlan, enforceManifest, sourceOrderFor, productSrcBoxesFor, type ResolvedLayoutManifest } from '../src/server/adfit/manifest.js';
import { checkManifestGeometry } from '../src/server/adfit/checks.js';
import { cleanProductCutBase, inpaintRectSmooth, resolveGroupTextColors, trimLogoBottomStrip, type RgbaImage } from '../src/server/repair/composite.js';

function canvas(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}
function fillRect(c: RgbaImage, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue;
    const o = (yy * c.width + xx) * 4; c.data[o] = rgb[0]; c.data[o + 1] = rgb[1]; c.data[o + 2] = rgb[2];
  }
}
const alpha = (c: RgbaImage, x: number, y: number): number => c.data[(y * c.width + x) * 4 + 3] as number;

function lumaAnalysis(): SourceAnalysis {
  return {
    language: 'en', direction: 'ltr',
    products: [
      { label: 'bottle', sam_phrase: 'bottle', bbox: { x: 555, y: 281, w: 145, h: 330 } },
      { label: 'jar', sam_phrase: 'jar', bbox: { x: 695, y: 444, w: 210, h: 205 } },
    ],
    logo_bbox: { x: 112, y: 112, w: 130, h: 38 },
    headline: { text: 'Glow that lasts all day', bbox: { x: 108, y: 265, w: 295, h: 260 }, bold: true, color: '#1a2530' },
    subtext: { text: 'Free shipping over $50', bbox: { x: 368, y: 920, w: 344, h: 32 }, bold: false, color: '#1e2a36' },
    panel: { bbox: { x: 321, y: 826, w: 438, h: 90 }, opaque: true, bg_color: '#c9a44a', text_color: '#ffffff', texts: ['Shop now'] },
    other_texts: [{ text: '$42', bbox: { x: 406, y: 670, w: 92, h: 58 }, bold: true, color: '#1a1a1a' }],
    background: { type: 'photo', description: 'studio', colors: ['#f3ead9'] },
    unreadable: [],
  };
}

function plan(over: Partial<LayoutPlan>): LayoutPlan {
  return {
    preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
    safe: { x: 43, y: 43, w: 994, h: 994 }, logo: null, products: [], headline: null, subtext: null,
    panel: null, other_texts: [], product_scales: [], logo_scale: null, notes: [], ...over,
  };
}

describe('s20 D1 panel tightener', () => {
  it('tightens to the button fill region and excludes the shipping line below', () => {
    const c = canvas(400, 300, [250, 246, 238]);
    fillRect(c, 100, 100, 200, 62, [201, 164, 74]); // gold button
    fillRect(c, 170, 122, 60, 16, [255, 255, 255]); // "Shop now"
    fillRect(c, 120, 180, 160, 14, [30, 30, 30]); // "Free shipping" line
    const spark = { x: 95, y: 98, w: 210, h: 115 }; // Spark box swallows the line
    const fill = samplePanelColor(c, spark);
    const tight = tightenPanelRect(c, spark, fill);
    expect(tight.y + tight.h).toBeLessThanOrEqual(175); // line at y180 stays out
    expect(tight.h).toBeLessThan(spark.h);
    expect(samplePanelColor(c, tight)).toBe('#c9a44a');
    const text = samplePanelTextColor(c, tight, '#c9a44a');
    expect(text).not.toBeNull();
    const [r, g, b] = [parseInt(text!.slice(1, 3), 16), parseInt(text!.slice(3, 5), 16), parseInt(text!.slice(5, 7), 16)];
    expect(Math.min(r, g, b)).toBeGreaterThan(230); // white glyphs, not gold AA
  });
  it('keeps the original box when no fill region carries it', () => {
    const c = canvas(200, 200, [10, 20, 30]);
    const box = { x: 50, y: 50, w: 80, h: 40 };
    expect(tightenPanelRect(c, box, '#c9a44a')).toEqual(box);
  });
});

describe('s20 D1 CTA source-relative size in the manifest', () => {
  it('a thin planner strip becomes the source button size (438x90 at scale 1)', () => {
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: plan({ panel: { x: 157, y: 750, w: 486, h: 43 } }),
      preset, planner: 'wonder', direction: 'ltr', ctaPanel: true,
      panelSrcBox: { x: 321, y: 826, w: 438, h: 90 }, sourceWidth: 1080,
    });
    const panel = m.elements.find((e) => e.id === 'panel')!;
    expect(panel.box.w).toBe(438);
    expect(panel.box.h).toBe(90);
    expect(panel.box.y + panel.box.h).toBe(793); // bottom anchor kept
  });
});

describe('s20 D2/D3 enforce restack + panel column', () => {
  it('restacks logo → headline → price → panel → subtext in source order after a Wonder-style scramble', () => {
    const a = lumaAnalysis();
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: plan({
        logo: { x: 76, y: 220, w: 216, h: 63 }, // logo UNDER the headline (s19 story defect)
        headline: { x: 76, y: 100, w: 929, h: 100 },
        panel: { x: 76, y: 330, w: 486, h: 70 },
        other_texts: [{ x: 76, y: 430, w: 173, h: 59 }],
        subtext: { x: 76, y: 520, w: 756, h: 65 },
      }),
      preset, planner: 'wonder', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr', sourceOrder: sourceOrderFor(a), productSrcBoxes: productSrcBoxesFor(a) });
    const byId = (id: string) => out.elements.find((e) => e.id === id)!;
    const order = ['logo', 'headline', 'other-0', 'panel', 'subtext']
      .map((id) => byId(id).box.y + byId(id).box.h / 2)
      .sort((x, y) => x - y);
    const expected = ['logo', 'headline', 'other-0', 'panel', 'subtext']
      .map((id) => byId(id).box.y + byId(id).box.h / 2);
    expect(expected).toEqual(order); // already in source order by centre
    for (let i = 1; i < expected.length; i++) {
      const prev = ['logo', 'headline', 'other-0', 'panel', 'subtext'][i - 1]!;
      const cur = ['logo', 'headline', 'other-0', 'panel', 'subtext'][i]!;
      expect(byId(cur).box.y, `${prev}→${cur}`).toBeGreaterThanOrEqual(byId(prev).box.y + byId(prev).box.h);
    }
    expect(checkManifestGeometry(out, a).filter((f) => f.code === 'overlap' || f.code === 'reading_order')).toEqual([]);
  });
  it('snaps the CTA panel onto the text column edge', () => {
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: plan({
        headline: { x: 65, y: 140, w: 855, h: 140 },
        subtext: { x: 65, y: 300, w: 795, h: 97 },
        panel: { x: 294, y: 954, w: 169, h: 61 }, // NORTHBEAN: CTA right of the column
      }),
      preset, planner: 'wonder', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    expect(out.elements.find((e) => e.id === 'panel')!.box.x).toBe(65);
  });
  it('text_column check includes the panel box', () => {
    const a = lumaAnalysis();
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: plan({
        headline: { x: 65, y: 140, w: 855, h: 140 },
        subtext: { x: 65, y: 300, w: 795, h: 97 },
        panel: { x: 294, y: 954, w: 169, h: 61 },
      }),
      preset, planner: 'code', direction: 'ltr',
    });
    expect(checkManifestGeometry(m, a).map((f) => f.code)).toContain('text_column');
  });
});

describe('s20 D5 product group arrangement', () => {
  it('separates identically-placed products back into the source arrangement', () => {
    const a: SourceAnalysis = {
      language: 'en', direction: 'ltr',
      products: [
        { label: 'can a', sam_phrase: 'can', bbox: { x: 572, y: 68, w: 163, h: 362 } },
        { label: 'can b', sam_phrase: 'can', bbox: { x: 723, y: 163, w: 175, h: 359 } },
        { label: 'lying can', sam_phrase: 'can', bbox: { x: 875, y: 290, w: 250, h: 205 } },
      ],
      logo_bbox: { x: 77, y: 52, w: 201, h: 120 },
      headline: { text: 'Cold brew', bbox: { x: 77, y: 238, w: 365, h: 140 }, bold: true, color: '#ffffff' },
      subtext: { text: '$24', bbox: { x: 77, y: 397, w: 222, h: 38 }, bold: false, color: '#ffffff' },
      panel: { bbox: { x: 77, y: 481, w: 188, h: 68 }, opaque: false, bg_color: '#2a1a0e', text_color: '#ffffff', texts: ['Order now'] },
      other_texts: [],
      background: { type: 'photo', description: 'wood', colors: ['#3a2415'] },
      unreadable: [],
    };
    const preset = presetById('fb-link')!;
    const m = manifestFromPlan({
      plan: plan({
        preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 },
        logo: { x: 48, y: 38, w: 200, h: 95 },
        products: [
          { x: 825, y: 150, w: 190, h: 440 },
          { x: 825, y: 150, w: 190, h: 440 }, // same box: one blob
          { x: 695, y: 211, w: 451, h: 379 },
        ],
        headline: { x: 48, y: 333, w: 400, h: 100 },
        subtext: { x: 48, y: 446, w: 400, h: 63 },
        panel: { x: 48, y: 522, w: 188, h: 68 },
        product_scales: [1, 1, 1], logo_scale: 1,
      }),
      preset, planner: 'wonder', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr', sourceOrder: sourceOrderFor(a), productSrcBoxes: productSrcBoxesFor(a) });
    const prods = [0, 1, 2].map((i) => out.elements.find((e) => e.id === `product-${i}`)!.box);
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
      const a1 = prods[i]!, b = prods[j]!;
      const inter = Math.max(0, Math.min(a1.x + a1.w, b.x + b.w) - Math.max(a1.x, b.x)) * Math.max(0, Math.min(a1.y + a1.h, b.y + b.h) - Math.max(a1.y, b.y));
      expect(inter, `product-${i} vs product-${j}`).toBeLessThanOrEqual(0.12 * Math.min(a1.w * a1.h, b.w * b.h));
    }
    expect(prods[0]!.x).toBeLessThan(prods[1]!.x);
    expect(prods[1]!.x).toBeLessThan(prods[2]!.x);
  });
});

describe('s20 D8 hero measured as group union', () => {
  it('two products each below the bar pass when their union clears it', () => {
    const a = lumaAnalysis();
    const preset = presetById('ig-story-916')!;
    const m = manifestFromPlan({
      plan: plan({
        preset: 'ig-story-916', width: 1080, height: 1920, safe: { x: 54, y: 269, w: 972, h: 1267 },
        logo: { x: 76, y: 285, w: 194, h: 57 },
        products: [
          { x: 200, y: 600, w: 200, h: 400 }, // 400px each < 672px bar
          { x: 500, y: 1100, w: 300, h: 400 }, // union 600..1500 = 900px
        ],
        headline: { x: 76, y: 380, w: 929, h: 100 },
        product_scales: [1, 1], logo_scale: 1,
      }),
      preset, planner: 'code', direction: 'ltr',
    });
    expect(checkManifestGeometry(m, a).map((f) => f.code)).not.toContain('hero_too_small');
  });
});

describe('s20 D4 product base shard cleaning', () => {
  it('drops a thin dark shard below the base, keeps the can body and its curved base', () => {
    const c = canvas(120, 220, [0, 0, 0]);
    fillRect(c, 10, 0, 100, 180, [30, 30, 30]); // can body
    fillRect(c, 30, 180, 60, 10, [30, 30, 30]); // wide curved base
    fillRect(c, 55, 190, 4, 29, [15, 15, 15]); // thin dark shard hanging below
    // canvas() starts opaque everywhere: clear outside the product first.
    for (let y = 0; y < 220; y++) for (let x = 0; x < 120; x++) {
      const inside = (x >= 10 && x < 110 && y < 180) || (x >= 30 && x < 90 && y >= 180 && y < 190) || (x >= 55 && x < 59 && y >= 190);
      if (!inside) c.data[(y * 120 + x) * 4 + 3] = 0;
    }
    const removed = cleanProductCutBase(c);
    expect(removed).toBeGreaterThan(0);
    expect(alpha(c, 56, 210)).toBe(0); // shard gone
    expect(alpha(c, 60, 100)).toBe(255); // body intact
    expect(alpha(c, 60, 185)).toBe(255); // curved base intact
    expect(alpha(c, 15, 175)).toBe(255); // body bottom edge intact
  });
});

describe('s20 D6 group text colour', () => {
  it('keeps source colours when every line reads', () => {
    expect(resolveGroupTextColors([{ srcRatio: 3, blackRatio: 5, whiteRatio: 1 }]).mode).toBe('source');
  });
  it('swaps the WHOLE group to one colour when one line fails', () => {
    const d = resolveGroupTextColors([
      { srcRatio: 4, blackRatio: 6, whiteRatio: 2.5 }, // headline fine in white
      { srcRatio: 1.1, blackRatio: 7, whiteRatio: 1.2 }, // subtext yellow-on-cream fails
    ]);
    expect(d.mode).toBe('uniform');
    if (d.mode === 'uniform') expect(d.color).toEqual({ r: 0, g: 0, b: 0 });
  });
  it('keeps a near-miss source colour with a shadow instead of flipping the group', () => {
    expect(resolveGroupTextColors([{ srcRatio: 1.7, blackRatio: 8, whiteRatio: 1.7 }]).mode).toBe('source-shadow');
  });
  it('falls back to source colours + shadow when no single colour works for all', () => {
    const d = resolveGroupTextColors([
      { srcRatio: 1.5, blackRatio: 1.8, whiteRatio: 1.9 },
      { srcRatio: 1.4, blackRatio: 1.9, whiteRatio: 1.7 },
    ]);
    expect(d.mode).toBe('source-shadow');
  });
});

describe('s20 D7b logo cut bottom strip', () => {
  it('trims the fragmented band sliver below the badge, keeps a tagline below an empty gap', () => {
    const badge = canvas(200, 120, [0, 0, 0]);
    for (let y = 0; y < 120; y++) for (let x = 0; x < 200; x++) badge.data[(y * 200 + x) * 4 + 3] = 0;
    fillRect(badge, 20, 10, 160, 78, [250, 200, 0]); // badge body rows 10..87
    for (let x = 20; x < 180; x++) for (let y = 10; y < 88; y++) badge.data[(y * 200 + x) * 4 + 3] = 255;
    fillRect(badge, 20, 88, 160, 10, [15, 15, 15]); // fragmented dark strip directly under the body
    for (let x = 20; x < 180; x += 3) for (let y = 88; y < 98; y++) badge.data[(y * 200 + x) * 4 + 3] = 255;
    for (let x = 21; x < 180; x += 3) for (let y = 88; y < 98; y++) badge.data[(y * 200 + x) * 4 + 3] = 0;
    expect(trimLogoBottomStrip(badge)).toBeGreaterThan(0);
    expect(alpha(badge, 30, 92)).toBe(0); // strip gone
    expect(alpha(badge, 60, 50)).toBe(255); // badge intact

    const lockup = canvas(200, 140, [0, 0, 0]);
    for (let y = 0; y < 140; y++) for (let x = 0; x < 200; x++) lockup.data[(y * 200 + x) * 4 + 3] = 0;
    fillRect(lockup, 20, 10, 160, 60, [20, 20, 20]);
    for (let x = 20; x < 180; x++) for (let y = 10; y < 70; y++) lockup.data[(y * 200 + x) * 4 + 3] = 255;
    fillRect(lockup, 40, 110, 120, 16, [20, 20, 20]); // tagline below an EMPTY gap (rows 70..109 clear)
    for (let x = 40; x < 160; x++) for (let y = 110; y < 126; y++) lockup.data[(y * 200 + x) * 4 + 3] = 255;
    expect(trimLogoBottomStrip(lockup)).toBe(0);
    expect(alpha(lockup, 60, 118)).toBe(255); // tagline kept
  });
});

describe('s20 D7 smooth plate inpaint under the badge', () => {
  it('removes a dark ghost streak without streaking the gradient', () => {
    const c = canvas(200, 200, [240, 220, 120]);
    for (let y = 0; y < 200; y++) fillRect(c, 0, y, 200, 1, [240 - Math.floor(y / 2), 220 - Math.floor(y / 2), 120]);
    fillRect(c, 50, 80, 100, 40, [20, 15, 10]); // dark ghost where the badge was
    inpaintRectSmooth(c, { x: 50, y: 80, w: 100, h: 40 });
    const o = (100 * 200 + 100) * 4;
    const lum = 0.299 * (c.data[o] as number) + 0.587 * (c.data[o + 1] as number) + 0.114 * (c.data[o + 2] as number);
    expect(lum).toBeGreaterThan(120); // streak gone (was ~16)
    expect(lum).toBeLessThan(210); // follows the gradient, not a flat block
  });
});

describe('Nov 4 hotfix: stack, CTA column and landscape product group', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const element = (id: string, kind: string, b: ReturnType<typeof box>, extra: Record<string, unknown> = {}) => ({
    id, kind, box: b, scale: null, source: 'plan', group: kind === 'headline' || kind === 'subtext' || kind === 'other_text' ? 'text' : kind, align: 'left', ...extra,
  });

  it('settles an overflowing stack without moving the logo, and the CTA joins the column (STRIDE square)', () => {
    const manifest = {
      preset: 'ig-feed-11', width: 1080, height: 1080, family: 'square_balanced', planner: 'wonder',
      safe: box(43, 43, 994, 994),
      elements: [
        element('product-0', 'product', box(316, 338, 448, 439), { scale: 0.8, group: 'product' }),
        element('panel', 'panel', box(65, 885, 440, 97), { group: 'panel' }),
        element('headline', 'headline', box(111, 135, 756, 181)),
        element('subtext', 'subtext', box(111, 799, 432, 62)),
        element('other-0', 'other_text', box(111, 877, 144, 41)),
        element('logo', 'logo', box(111, 65, 221, 49), { scale: 0.7, group: 'logo' }),
      ],
      templateZones: {}, corrections: [], rationale: null,
    } as unknown as ResolvedLayoutManifest;
    const out = enforceManifest({
      manifest, direction: 'ltr',
      sourceOrder: [
        { id: 'logo', srcY: 40, srcH: 30 }, { id: 'headline', srcY: 100, srcH: 60 },
        { id: 'subtext', srcY: 170, srcH: 30 }, { id: 'other-0', srcY: 210, srcH: 24 }, { id: 'panel', srcY: 800, srcH: 50 },
      ],
    });
    const at = (id: string) => out.elements.find((e) => e.id === id)!.box;
    expect(at('logo').y).toBe(65);
    expect(at('subtext').y + at('subtext').h).toBeLessThanOrEqual(at('other-0').y);
    expect(at('other-0').y + at('other-0').h).toBeLessThanOrEqual(at('panel').y);
    expect(at('panel').x).toBe(at('headline').x);
  });

  it('re-lays a landscape product group from its source arrangement beside the text (NORTHBEAN fb-link)', () => {
    const manifest = {
      preset: 'fb-link', width: 1200, height: 628, family: 'landscape_split', planner: 'code',
      safe: box(48, 25, 1104, 578),
      elements: [
        element('product-0', 'product', box(823, 356, 64, 140), { scale: 0.4258, group: 'product' }),
        element('product-1', 'product', box(887, 410, 42, 86), { scale: 0.2642, group: 'product' }),
        element('product-2', 'product', box(929, 427, 85, 69), { scale: 0.3259, group: 'product' }),
        element('panel', 'panel', box(48, 522, 188, 68), { group: 'panel' }),
        element('headline', 'headline', box(48, 333, 614, 100)),
        element('subtext', 'subtext', box(48, 446, 614, 63)),
        element('logo', 'logo', box(48, 38, 200, 95), { scale: 0.96, group: 'logo' }),
      ],
      templateZones: {}, corrections: [], rationale: null,
    } as unknown as ResolvedLayoutManifest;
    const out = enforceManifest({
      manifest, direction: 'ltr',
      productSrcBoxes: [box(585, 70, 150, 330), box(740, 140, 160, 360), box(895, 265, 240, 210)],
    });
    const prods = out.elements.filter((e) => e.kind === 'product');
    const headline = out.elements.find((e) => e.id === 'headline')!;
    const scales = prods.map((p) => p.scale as number);
    expect(Math.max(...scales) / Math.min(...scales)).toBeLessThan(1.15);
    expect(Math.max(...prods.map((p) => p.box.h))).toBeGreaterThan(300);
    expect(Math.min(...prods.map((p) => p.box.x))).toBeGreaterThanOrEqual(headline.box.x + headline.box.w);
  });

  it('keeps source-overlapping products together on square, in the free band (NORTHBEAN)', () => {
    const manifest = {
      preset: 'ig-feed-11', width: 1080, height: 1080, family: 'square_balanced', planner: 'wonder',
      safe: box(43, 43, 994, 994),
      elements: [
        element('product-0', 'product', box(140, 476, 182, 418), { scale: 1.1, group: 'product' }),
        element('product-1', 'product', box(360, 451, 193, 443), { scale: 1.1, group: 'product' }),
        element('product-2', 'product', box(612, 638, 307, 256), { scale: 1.1, group: 'product' }),
        element('panel', 'panel', box(76, 931, 173, 58), { group: 'panel' }),
        element('headline', 'headline', box(76, 194, 929, 162)),
        element('subtext', 'subtext', box(76, 376, 497, 54)),
        element('logo', 'logo', box(76, 76, 205, 95), { scale: 1, group: 'logo' }),
      ],
      templateZones: {}, corrections: [], rationale: null,
    } as unknown as ResolvedLayoutManifest;
    const srcs = [box(585, 70, 150, 330), box(740, 140, 160, 360), box(895, 265, 240, 210)];
    const out = enforceManifest({ manifest, direction: 'ltr', productSrcBoxes: [box(585, 70, 170, 330), box(740, 140, 170, 360), srcs[2]!] });
    const prods = out.elements.filter((e) => e.kind === 'product').map((e) => e.box);
    const overlap = (a: (typeof prods)[number], b: (typeof prods)[number]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    expect(overlap(prods[0]!, prods[1]!)).toBe(true);
    const subtext = out.elements.find((e) => e.id === 'subtext')!.box;
    const panel = out.elements.find((e) => e.id === 'panel')!.box;
    for (const p of prods) {
      expect(p.y).toBeGreaterThanOrEqual(subtext.y + subtext.h);
      expect(p.y + p.h).toBeLessThanOrEqual(panel.y);
    }
  });

  it('makes room when a settled stack hits the product instead of giving up (STRIDE square)', () => {
    const manifest = {
      preset: 'ig-feed-11', width: 1080, height: 1080, family: 'square_balanced', planner: 'wonder',
      safe: box(43, 43, 994, 994),
      elements: [
        element('product-0', 'product', box(335, 155, 411, 403), { scale: 0.7, group: 'product' }),
        element('panel', 'panel', box(65, 918, 440, 97), { group: 'panel' }),
        element('headline', 'headline', box(65, 585, 950, 210)),
        element('subtext', 'subtext', box(65, 800, 795, 95)),
        element('other-0', 'other_text', box(65, 911, 196, 41)),
        element('logo', 'logo', box(65, 65, 302, 68), { scale: 1, group: 'logo' }),
      ],
      templateZones: {}, corrections: [], rationale: null,
    } as unknown as ResolvedLayoutManifest;
    const out = enforceManifest({
      manifest, direction: 'ltr',
      sourceOrder: [
        { id: 'logo', srcY: 40, srcH: 30 }, { id: 'headline', srcY: 100, srcH: 60 },
        { id: 'subtext', srcY: 170, srcH: 30 }, { id: 'other-0', srcY: 210, srcH: 24 }, { id: 'panel', srcY: 800, srcH: 50 },
      ],
    });
    const at = (id: string) => out.elements.find((e) => e.id === id)!.box;
    expect(at('other-0').y + at('other-0').h).toBeLessThanOrEqual(at('panel').y);
    expect(at('subtext').y + at('subtext').h).toBeLessThanOrEqual(at('other-0').y);
    expect(at('product-0').y + at('product-0').h).toBeLessThanOrEqual(at('headline').y);
    expect(at('product-0').y).toBeGreaterThanOrEqual(at('logo').y + at('logo').h);
  });
});

