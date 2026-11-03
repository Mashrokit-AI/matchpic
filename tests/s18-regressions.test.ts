import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { SourceAnalysis } from '../src/shared/schemas.js';
import { eraseRectByRowExtension, panelPixelFindings, type RgbaImage } from '../src/server/repair/composite.js';
import { dropSmallComponents } from '../src/server/repair/masks.js';
import { buildRebuiltPanelHtml } from '../src/server/repair/render.js';
import { planLayout } from '../src/server/adfit/planner.js';
import { checkManifestGeometry } from '../src/server/adfit/checks.js';
import { manifestFromPlan, enforceManifest } from '../src/server/adfit/manifest.js';

function canvas(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
  return { data, width: w, height: h };
}
function fillRect(c: RgbaImage, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const o = (yy * c.width + xx) * 4; c.data[o] = rgb[0]; c.data[o + 1] = rgb[1]; c.data[o + 2] = rgb[2];
  }
}
const FILL = { r: 90, g: 110, b: 125 };

describe('s18 CTA panel pixels', () => {
  it('flags clipped glyph ink and a ghost bar below the panel', () => {
    const c = canvas(400, 300, [170, 180, 190]);
    fillRect(c, 50, 100, 300, 60, [90, 110, 125]); // panel
    fillRect(c, 120, 102, 160, 14, [255, 255, 255]); // glyphs riding the top edge
    fillRect(c, 50, 161, 300, 18, [90, 110, 125]); // ghost bar below, top hidden behind panel
    const codes = panelPixelFindings(c, { x: 50, y: 100, w: 300, h: 60 }, FILL).map((f) => f.code);
    expect(codes).toContain('panel_text_clipped');
    expect(codes).toContain('panel_ghost_bar');
  });
  it('passes a clean centered panel over a full-width ledge', () => {
    const c = canvas(400, 300, [170, 180, 190]);
    fillRect(c, 0, 170, 400, 40, [200, 200, 200]); // ledge spans full width
    fillRect(c, 50, 100, 300, 60, [90, 110, 125]);
    fillRect(c, 140, 122, 120, 16, [255, 255, 255]); // centered glyphs
    expect(panelPixelFindings(c, { x: 50, y: 100, w: 300, h: 60 }, FILL)).toEqual([]);
  });
  it('eraseRectByRowExtension removes a ghost button under the panel area', () => {
    const c = canvas(400, 300, [170, 180, 190]);
    fillRect(c, 50, 100, 300, 80, [90, 110, 125]); // fake painted button
    eraseRectByRowExtension(c, { x: 40, y: 94, w: 320, h: 100 });
    expect(panelPixelFindings(c, { x: 50, y: 100, w: 300, h: 60 }, FILL).map((f) => f.code)).not.toContain('panel_ghost_bar');
    const o = (120 * 400 + 200) * 4;
    expect(c.data[o]).toBe(170); // ghost fill gone, background tone restored
  });
  it('rebuilt outline CTA paints its fill (plate ghost cannot show through)', () => {
    const html = buildRebuiltPanelHtml({
      width: 300, height: 60, radius: 8, fill: FILL, outline: { r: 255, g: 255, b: 255 },
      lines: [{ text: 'Shop now', weight: 700, color: { r: 255, g: 255, b: 255 } }],
      lang: 'en', align: 'center', fontCss: '', sizes: [24],
    });
    expect(html).toContain('background:rgb(90,110,125)');
    expect(html).not.toContain('background:transparent');
  });
});

describe('s18 logo speckle cleanup', () => {
  it('drops tiny disconnected speckles, keeps letter components', () => {
    const W = 100; const H = 40;
    const mask = new Uint8Array(W * H);
    const rect = (x: number, y: number, w: number, h: number): void => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) mask[yy * W + xx] = 1; };
    rect(5, 10, 20, 20); rect(35, 10, 20, 20); // letters
    rect(80, 5, 2, 2); rect(90, 30, 3, 1); // speckles
    const dropped = dropSmallComponents(mask, W, H);
    expect(dropped).toBe(7);
    expect(mask[5 * W + 80]).toBe(0);
    expect(mask[15 * W + 10]).toBe(1);
  });
});

function hebrewAnalysis(): SourceAnalysis {
  return {
    language: 'he', direction: 'rtl',
    products: [{ label: 'poster', sam_phrase: 'poster', bbox: { x: 300, y: 300, w: 400, h: 500 } }],
    logo_bbox: null, headline: null, subtext: null, panel: null,
    other_texts: [
      { text: '5$', bbox: { x: 100, y: 850, w: 120, h: 40 }, bold: true, color: '#000000' },
      { text: 'בלבד', bbox: { x: 100, y: 895, w: 120, h: 36 }, bold: true, color: '#000000' },
      { text: 'חוזר', bbox: { x: 100, y: 936, w: 120, h: 36 }, bold: true, color: '#000000' },
    ],
    background: { type: 'flat', description: 'yellow', colors: ['#ffe600'] },
    unreadable: [],
  };
}

describe('s18 grouped texts', () => {
  it('planner keeps source-stacked lines as one tight stack on a tall size', () => {
    const preset = presetById('ig-story-916')!;
    const plan = planLayout({ preset, source: hebrewAnalysis(), sourceWidth: 1080, sourceHeight: 1080, productCuts: [{ w: 400, h: 500 }], logoCut: null, template: null });
    expect(plan.other_texts).toHaveLength(3);
    const sorted = [...plan.other_texts].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]!.y - (sorted[i - 1]!.y + sorted[i - 1]!.h);
      expect(gap).toBeLessThanOrEqual(60);
      expect(sorted[i]!.x).toBe(sorted[0]!.x);
    }
    expect(plan.notes.join(' ')).toMatch(/kept as one source group/);
  });
  it('check flags a split source group and a ragged text column', () => {
    const a = hebrewAnalysis();
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
        safe: { x: 43, y: 43, w: 994, h: 994 }, logo: null,
        products: [{ x: 340, y: 200, w: 400, h: 500 }], headline: null, subtext: null, panel: null,
        other_texts: [{ x: 100, y: 700, w: 200, h: 40 }, { x: 180, y: 880, w: 200, h: 40 }, { x: 260, y: 1000, w: 200, h: 36 }],
        product_scales: [1], logo_scale: null, notes: [],
      },
      preset, planner: 'code', direction: 'rtl',
    });
    const codes = checkManifestGeometry(m, a).map((f) => f.code);
    expect(codes).toContain('text_group_split');
    expect(codes).toContain('text_column');
  });
  it('enforcement keeps a too-wide headline on the shared edge (shrink-to-fit, not clamp-off)', () => {
    const preset = presetById('ig-feed-45')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-feed-45', width: 1080, height: 1350, from_template: false, template_id: null,
        safe: { x: 43, y: 54, w: 994, h: 1242 }, logo: { x: 98, y: 70, w: 280, h: 63 },
        products: [{ x: 259, y: 499, w: 563, h: 552 }], headline: { x: 86, y: 153, w: 929, h: 89 }, subtext: { x: 98, y: 263, w: 702, h: 50 }, panel: null,
        other_texts: [{ x: 98, y: 333, w: 324, h: 45 }], product_scales: [1], logo_scale: 1, notes: [],
      },
      preset, planner: 'code', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const head = out.elements.find((e) => e.id === 'headline')!;
    const logo = out.elements.find((e) => e.id === 'logo')!;
    expect(head.box.x).toBe(logo.box.x);
  });
  it('enforcement snaps the text column to a near logo edge', () => {
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
        safe: { x: 43, y: 43, w: 994, h: 994 }, logo: { x: 120, y: 60, w: 200, h: 50 },
        products: [{ x: 340, y: 300, w: 400, h: 400 }], headline: { x: 150, y: 150, w: 500, h: 60 }, subtext: { x: 170, y: 230, w: 400, h: 40 }, panel: null,
        other_texts: [], product_scales: [1], logo_scale: 1, notes: [],
      },
      preset, planner: 'code', direction: 'ltr',
    });
    const a = hebrewAnalysis(); a.other_texts = []; a.products = [{ label: 'p', sam_phrase: 'p', bbox: { x: 0, y: 0, w: 10, h: 10 } }];
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const logo = out.elements.find((e) => e.id === 'logo')!;
    const head = out.elements.find((e) => e.id === 'headline')!;
    expect(head.box.x).toBe(logo.box.x);
    expect(checkManifestGeometry(out, a).filter((f) => f.code === 'text_column')).toEqual([]);
  });
});
