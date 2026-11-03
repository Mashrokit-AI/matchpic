import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { SourceAnalysis } from '../src/shared/schemas.js';
import { panelComplexity } from '../src/server/adfit/snap.js';
import { planLayout, isPriceText } from '../src/server/adfit/planner.js';
import { checkManifestGeometry } from '../src/server/adfit/checks.js';
import { manifestFromPlan, enforceManifest } from '../src/server/adfit/manifest.js';
import { insetPanelCutToFill, panelRimFindings, plateEdgeUnderText, readableTextColor, type RgbaImage } from '../src/server/repair/composite.js';

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

function strideAnalysis(): SourceAnalysis {
  return {
    language: 'en', direction: 'ltr',
    products: [{ label: 'shoe', sam_phrase: 'shoe', bbox: { x: 228, y: 730, w: 570, h: 520 } }],
    logo_bbox: { x: 360, y: 105, w: 360, h: 70 },
    headline: { text: 'Run lighter.', bbox: { x: 115, y: 340, w: 850, h: 180 }, bold: true, color: '#ffffff' },
    subtext: { text: 'The new Aero 2', bbox: { x: 250, y: 495, w: 580, h: 70 }, bold: false, color: '#ffffff' },
    panel: { bbox: { x: 320, y: 1645, w: 440, h: 135 }, opaque: true, bg_color: '#5e7a8e', text_color: '#ffffff', texts: ['Shop now'] },
    other_texts: [{ text: '$129', bbox: { x: 440, y: 595, w: 200, h: 70 }, bold: false, color: '#ffffff' }],
    background: { type: 'photo', description: 'studio', colors: ['#4f6171'] },
    unreadable: [],
  };
}

describe('s19 D1 flat CTA misclassified as complex', () => {
  it('panelComplexity ignores the button edge/background transition ring', () => {
    // Photo-like varied background, flat button with a dark edge line.
    const c = canvas(300, 200, [120, 130, 140]);
    for (let y = 0; y < 200; y += 3) for (let x = 0; x < 300; x += 3) fillRect(c, x, y, 2, 2, [(x * 7 + y) % 255, (x + y * 5) % 255, 150]);
    fillRect(c, 80, 70, 140, 60, [94, 122, 142]); // flat fill
    fillRect(c, 80, 70, 140, 3, [40, 50, 60]); fillRect(c, 80, 127, 140, 3, [40, 50, 60]);
    fillRect(c, 120, 92, 60, 14, [255, 255, 255]); // text
    expect(panelComplexity(c, { x: 80, y: 70, w: 140, h: 60 }).complex).toBe(false);
  });
  it('planner sizes a single-line CTA from the source button, capped at 45% x 9%', () => {
    for (const id of ['ig-feed-11', 'ig-feed-45', 'ig-story-916']) {
      const preset = presetById(id)!;
      const plan = planLayout({ preset, source: strideAnalysis(), sourceWidth: 1080, sourceHeight: 1920, productCuts: [{ w: 570, h: 520 }], logoCut: { w: 360, h: 70 }, template: null });
      expect(plan.panel, id).not.toBeNull();
      expect(plan.panel!.w, id).toBeLessThanOrEqual(Math.round(preset.width * 0.45));
      expect(plan.panel!.h, id).toBeLessThanOrEqual(Math.round(preset.height * 0.09) + 2);
    }
  });
  it('insetPanelCutToFill strips surrounding plate pixels, keeps the button', () => {
    const c = canvas(120, 80, [200, 90, 80]); // rim: reddish plate pixels
    fillRect(c, 15, 15, 90, 50, [94, 122, 142]);
    fillRect(c, 45, 35, 30, 10, [255, 255, 255]);
    const out = insetPanelCutToFill(c, { r: 94, g: 122, b: 142 });
    expect(out.width).toBeLessThan(120);
    expect(out.height).toBeLessThan(80);
    expect(out.width).toBeGreaterThanOrEqual(80);
  });
  it('panelRimFindings flags a non-plate band around the panel, passes a clean one', () => {
    const dirty = canvas(400, 300, [170, 180, 190]);
    fillRect(dirty, 40, 90, 320, 80, [200, 90, 80]); // rim rectangle
    fillRect(dirty, 50, 100, 300, 60, [94, 122, 142]); // panel
    expect(panelRimFindings(dirty, { x: 50, y: 100, w: 300, h: 60 }, { r: 94, g: 122, b: 142 }).map((f) => f.code)).toContain('panel_rim');
    const clean = canvas(400, 300, [170, 180, 190]);
    fillRect(clean, 50, 100, 300, 60, [94, 122, 142]);
    expect(panelRimFindings(clean, { x: 50, y: 100, w: 300, h: 60 }, { r: 94, g: 122, b: 142 })).toEqual([]);
  });
});

describe('s19 D2/D5 reading order + price cohesion', () => {
  it('isPriceText recognises prices, not taglines', () => {
    expect(isPriceText('$129')).toBe(true);
    expect(isPriceText('$42')).toBe(true);
    expect(isPriceText('Free shipping over $50')).toBe(false); // sentence subtext, not a price token
    expect(isPriceText('Shop now')).toBe(false);
  });
  it('planner keeps source order headline < subtext < price < panel in square, story and wide', () => {
    for (const id of ['ig-feed-11', 'ig-story-916', 'fb-link']) {
      const preset = presetById(id)!;
      const plan = planLayout({ preset, source: strideAnalysis(), sourceWidth: 1080, sourceHeight: 1920, productCuts: [{ w: 570, h: 520 }], logoCut: { w: 360, h: 70 }, template: null });
      expect(plan.headline!.y, id).toBeLessThan(plan.subtext!.y);
      expect(plan.subtext!.y, id).toBeLessThan(plan.other_texts[0]!.y);
      expect(plan.other_texts[0]!.y, id).toBeLessThan(plan.panel!.y);
    }
  });
  it('checkManifestGeometry flags reversed headline/subtext as reading_order', () => {
    const a = strideAnalysis();
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
        safe: { x: 43, y: 43, w: 994, h: 994 }, logo: { x: 65, y: 60, w: 300, h: 60 },
        products: [{ x: 340, y: 200, w: 400, h: 400 }],
        headline: { x: 65, y: 700, w: 800, h: 100 }, subtext: { x: 65, y: 600, w: 700, h: 60 },
        panel: { x: 300, y: 900, w: 300, h: 80 }, other_texts: [{ x: 65, y: 820, w: 200, h: 40 }],
        product_scales: [1], logo_scale: 1, notes: [],
      },
      preset, planner: 'code', direction: 'ltr',
    });
    expect(checkManifestGeometry(m, a).map((f) => f.code)).toContain('reading_order');
  });
  it('enforcement pulls an orphaned price next to the offer group on square (not only landscape)', () => {
    const preset = presetById('ig-feed-11')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
        safe: { x: 43, y: 43, w: 994, h: 994 }, logo: { x: 86, y: 60, w: 200, h: 50 },
        products: [{ x: 335, y: 250, w: 300, h: 400 }],
        headline: { x: 86, y: 140, w: 800, h: 100 }, subtext: { x: 86, y: 850, w: 800, h: 60 },
        panel: { x: 86, y: 730, w: 300, h: 80 }, other_texts: [{ x: 86, y: 560, w: 150, h: 50 }],
        product_scales: [1], logo_scale: 1, notes: [],
      },
      preset, planner: 'code', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const price = out.elements.find((e) => e.id === 'other-0')!;
    const panel = out.elements.find((e) => e.id === 'panel')!;
    const sub = out.elements.find((e) => e.id === 'subtext')!;
    const near = Math.min(Math.abs(price.box.y - (panel.box.y + panel.box.h)), Math.abs(panel.box.y - (price.box.y + price.box.h)), Math.abs(price.box.y - (sub.box.y + sub.box.h)), Math.abs(sub.box.y - (price.box.y + price.box.h)));
    expect(near).toBeLessThanOrEqual(40);
  });
});

describe('s19 D3 story fill', () => {
  it('flags a tiny hero and a >20% empty band inside the safe area on 9:16', () => {
    const a = strideAnalysis();
    const preset = presetById('ig-story-916')!;
    const m = manifestFromPlan({
      plan: {
        preset: 'ig-story-916', width: 1080, height: 1920, from_template: false, template_id: null,
        safe: { x: 54, y: 268, w: 972, h: 1268 }, logo: { x: 70, y: 280, w: 300, h: 60 },
        products: [{ x: 414, y: 360, w: 250, h: 240 }],
        headline: { x: 70, y: 650, w: 800, h: 100 }, subtext: { x: 70, y: 770, w: 700, h: 60 },
        panel: { x: 100, y: 900, w: 300, h: 80 }, other_texts: [{ x: 70, y: 850, w: 200, h: 40 }],
        product_scales: [0.5], logo_scale: 1, notes: [],
      },
      preset, planner: 'code', direction: 'ltr',
    });
    const codes = checkManifestGeometry(m, a).map((f) => `${f.code}:${f.severity}`);
    expect(codes).toContain('hero_too_small:fail');
    expect(codes).toContain('empty_band:fail');
  });
  it('planner gives the story hero a large share of the canvas', () => {
    const preset = presetById('ig-story-916')!;
    const plan = planLayout({ preset, source: strideAnalysis(), sourceWidth: 1080, sourceHeight: 1920, productCuts: [{ w: 570, h: 520 }], logoCut: { w: 360, h: 70 }, template: null });
    expect(plan.products[0]!.h).toBeGreaterThanOrEqual(Math.round(preset.height * 0.35));
    expect(plan.headline!.h).toBeGreaterThanOrEqual(Math.round(preset.height * 0.04));
  });
});

describe('s19 D4/D6 plate edge + contrast', () => {
  it('plateEdgeUnderText flags text straddling a strong horizontal edge', () => {
    const c = canvas(400, 300, [180, 180, 180]);
    fillRect(c, 0, 150, 400, 150, [60, 60, 60]); // ledge line at y=150
    expect(plateEdgeUnderText(c, { x: 50, y: 120, w: 300, h: 60 })).not.toBeNull();
    expect(plateEdgeUnderText(c, { x: 50, y: 40, w: 300, h: 50 })).toBeNull();
  });
  it('readableTextColor swaps illegible yellow-on-cream to a dark colour', () => {
    const c = canvas(300, 120, [245, 240, 210]);
    const out = readableTextColor(c, { x: 20, y: 20, w: 260, h: 80 }, { r: 255, g: 230, b: 0 });
    expect(out.changed).toBe(true);
    expect(out.color.r + out.color.g + out.color.b).toBeLessThan(200);
    const ok = readableTextColor(c, { x: 20, y: 20, w: 260, h: 80 }, { r: 20, g: 20, b: 20 });
    expect(ok.changed).toBe(false);
  });
});

describe('s19 LUMA source order (price → CTA → subtext)', () => {
  it('planner keeps source vertical order, not canonical headline→subtext→price', () => {
    const a = strideAnalysis();
    a.other_texts = [{ text: '$42', bbox: { x: 100, y: 600, w: 100, h: 50 }, bold: true, color: '#111111' }];
    a.panel = { bbox: { x: 100, y: 700, w: 300, h: 80 }, opaque: true, bg_color: '#eeeeee', text_color: '#111111', texts: ['Shop now'] };
    a.subtext = { text: 'Free shipping', bbox: { x: 100, y: 850, w: 300, h: 50 }, bold: false, color: '#111111' };
    const preset = presetById('ig-feed-11')!;
    const plan = planLayout({ preset, source: a, sourceWidth: 1080, sourceHeight: 1080, productCuts: [{ w: 570, h: 520 }], logoCut: { w: 360, h: 70 }, template: null });
    const order = [plan.headline, plan.subtext, plan.panel, ...(plan.other_texts ?? [])]
      .filter(Boolean)
      .map((b: any) => b!.y);
    // headline < price(other) < panel < subtext in output y
    const ys = { h: plan.headline!.y, s: plan.subtext!.y, p: plan.panel!.y, o: (plan.other_texts as any[])[0].y };
    expect(ys.h).toBeLessThan(ys.o);
    expect(ys.o).toBeLessThan(ys.p);
    expect(ys.p).toBeLessThan(ys.s);
    expect(order.length).toBeGreaterThan(0);
  });
});
