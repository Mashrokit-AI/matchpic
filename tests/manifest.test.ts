import { describe, expect, it } from 'vitest';
import { presetById } from '../src/shared/presets.js';
import type { LayoutPlan } from '../src/shared/schemas.js';
import { enforceManifest, familyForPreset, manifestFromPlan, paintOrder, templateZonesPx } from '../src/server/adfit/manifest.js';

describe('vertical fill and text hierarchy', () => {
  const story = { preset: 'ig-story-916', width: 1080, height: 1920, safe: { x: 54, y: 269, w: 972, h: 1267 } } as const;

  it('resyncs the product scale when enforcement grows the box', () => {
    const p = plan({
      ...story,
      logo: null,
      products: [{ x: 400, y: 700, w: 280, h: 400 }],
      headline: null,
      subtext: null,
      panel: { x: 110, y: 1240, w: 860, h: 200 },
      product_scales: [1],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-story-916')!, planner: 'wonder', direction: 'ltr' });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod.box.h).toBeGreaterThanOrEqual(Math.round(1267 * 0.45));
    // Grown box, grown scale: the compositor pastes cut pixels at e.scale, so
    // a stale scale would render small and centered (the shrunk-products bug).
    expect(prod.scale).toBeCloseTo(prod.box.w / 280, 5);
  });

  it('grows a lone tall product past the floor toward 60% of the safe height', () => {
    const p = plan({
      ...story,
      logo: null,
      products: [{ x: 416, y: 441, w: 206, h: 576 }],
      headline: null,
      subtext: null,
      panel: { x: 110, y: 1240, w: 860, h: 200 },
      product_scales: [1.03],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-story-916')!, planner: 'wonder', direction: 'rtl' });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod.box.h).toBe(Math.round(1267 * 0.6));
    expect(prod.scale).toBeCloseTo(1.03 * (prod.box.w / 206), 5);
    expect(out.corrections.join(' ')).toMatch(/60% safe-height/);
  });

  it('keeps the headline dominant on square canvases', () => {
    const m = manifestFromPlan({
      plan: plan({
        logo: null,
        products: [{ x: 60, y: 372, w: 300, h: 480 }],
        headline: { x: 761, y: 499, w: 232, h: 59 },
        subtext: { x: 782, y: 562, w: 211, h: 60 },
        panel: null,
        product_scales: [1],
        logo_scale: null,
        notes: [],
      }),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(h.box.w).toBeGreaterThanOrEqual(Math.round(994 * 0.55));
    expect(h.box.h).toBeGreaterThanOrEqual(Math.ceil(s.box.h * 1.25));
    expect(out.corrections.join(' ')).toMatch(/dominance|taller than the subtext/);
  });

  it('stacks landscape text into one tight group with uniform gaps', () => {
    const m = manifestFromPlan({
      plan: plan({
        preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 },
        logo: null, products: [], product_scales: [], logo_scale: null, panel: null,
        headline: { x: 70, y: 130, w: 480, h: 59 },
        subtext: { x: 70, y: 272, w: 420, h: 31 },
        notes: [],
      }),
      preset: presetById('fb-link')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(s.box.y).toBe(h.box.y + h.box.h + Math.max(8, Math.round(628 * 0.02)));
    expect(out.corrections.join(' ')).toMatch(/tight stack/);
  });
});

function plan(over: Partial<LayoutPlan> = {}): LayoutPlan {
  const safe = { x: 43, y: 43, w: 994, h: 994 };
  return {
    preset: 'ig-feed-11',
    width: 1080,
    height: 1080,
    from_template: true,
    template_id: 't1',
    safe,
    logo: { x: 850, y: 60, w: 170, h: 60 },
    products: [{ x: 390, y: 200, w: 300, h: 560 }],
    headline: { x: 140, y: 845, w: 800, h: 60 },
    subtext: null,
    panel: { x: 90, y: 840, w: 900, h: 170 },
    other_texts: [],
    product_scales: [1],
    logo_scale: 1,
    notes: ['logo: template zone', 'products: template zone', 'panel: template zone', 'headline: template zone'],
    ...over,
  };
}

describe('layout manifest', () => {
  it('assigns composition families by aspect', () => {
    expect(familyForPreset(presetById('fb-link')!)).toBe('landscape_split');
    expect(familyForPreset(presetById('ig-story-916')!)).toBe('portrait_stack');
    expect(familyForPreset(presetById('ig-feed-11')!)).toBe('square_balanced');
    expect(familyForPreset(presetById('ig-feed-45')!)).toBe('square_balanced');
  });

  it('builds one element per placed box with z-order, group, align and scale', () => {
    const m = manifestFromPlan({ plan: plan(), preset: presetById('ig-feed-11')!, planner: 'code', direction: 'rtl' });
    expect(m.family).toBe('square_balanced');
    expect(m.planner).toBe('code');
    const ids = m.elements.map((e) => e.id).sort();
    expect(ids).toEqual(['headline', 'logo', 'panel', 'product-0']);
    const byId = Object.fromEntries(m.elements.map((e) => [e.id, e]));
    expect(byId['product-0']?.group).toBe('products');
    expect(byId['product-0']?.scale).toBe(1);
    expect(byId['headline']?.group).toBe('text');
    expect(byId['headline']?.align).toBe('right');
    expect(byId['panel']?.group).toBe('offer');
    // Paint order: panel < product < headline < logo.
    const zs = paintOrder(m).map((e) => e.id);
    expect(zs).toEqual(['panel', 'product-0', 'headline', 'logo']);
    // Template-zone sources are detected from plan notes.
    expect(byId['product-0']?.source).toBe('template');
  });

  it('uses the left edge for LTR text', () => {
    const m = manifestFromPlan({ plan: plan(), preset: presetById('ig-feed-11')!, planner: 'code', direction: 'ltr' });
    expect(m.elements.find((e) => e.id === 'headline')?.align).toBe('left');
  });

  it('clamps out-of-safe boxes and records corrections', () => {
    const m = manifestFromPlan({
      plan: plan({ logo: { x: 1000, y: 10, w: 200, h: 60 } }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const logo = out.elements.find((e) => e.id === 'logo')!;
    expect(logo.box.x + logo.box.w).toBeLessThanOrEqual(out.safe.x + out.safe.w);
    expect(logo.source).toBe('corrected');
    expect(out.corrections.join(' ')).toMatch(/logo.*safe area/);
  });

  it('grows a small 9:16 product toward the 45% floor', () => {
    const p = plan({
      preset: 'ig-story-916',
      width: 1080,
      height: 1920,
      safe: { x: 54, y: 269, w: 972, h: 1267 },
      logo: null,
      products: [{ x: 400, y: 700, w: 280, h: 400 }],
      headline: null,
      panel: { x: 110, y: 1240, w: 860, h: 200 },
      product_scales: [1],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-story-916')!, planner: 'code', direction: 'rtl' });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod.box.h).toBeGreaterThan(400);
    expect(out.corrections.join(' ')).toMatch(/45% safe-height/);
  });

  it('stops growing a width-capped product instead of inflating empty box height', () => {
    // ZAZO story: flat sunglasses at full safe width. Growing height alone
    // would inflate empty collision area (the compositor pastes at e.scale,
    // which follows the width) and squeeze text into unresolvable overlaps.
    const p = plan({
      preset: 'ig-story-916',
      width: 1080,
      height: 1920,
      safe: { x: 54, y: 269, w: 972, h: 1267 },
      logo: null,
      products: [{ x: 65, y: 700, w: 950, h: 280 }],
      headline: { x: 76, y: 300, w: 929, h: 100 },
      subtext: { x: 76, y: 1150, w: 929, h: 80 },
      panel: { x: 76, y: 1260, w: 929, h: 250 },
      product_scales: [1],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-story-916')!, planner: 'wonder', direction: 'ltr' });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod.box).toEqual({ x: 65, y: 700, w: 950, h: 280 });
    expect(prod.scale).toBe(1);
    expect(out.corrections.join(' ')).toMatch(/below size floor but blocked from growing/);
  });

  it('restores the pre-shrink size when shrinking cannot clear an overlap', () => {
    // Two fully nested products: 12 shrink iterations cannot separate
    // concentric boxes, so the loop must restore (not strand a sliver).
    const p = plan({
      logo: null,
      products: [
        { x: 340, y: 340, w: 400, h: 400 },
        { x: 340, y: 340, w: 400, h: 400 },
      ],
      headline: null,
      subtext: null,
      panel: null,
      product_scales: [1, 1],
      logo_scale: null,
    });
    const m = manifestFromPlan({ plan: p, preset: presetById('ig-feed-11')!, planner: 'code', direction: 'ltr' });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const prod0 = out.elements.find((e) => e.id === 'product-0')!;
    expect(prod0.box).toEqual({ x: 340, y: 340, w: 400, h: 400 });
    expect(prod0.scale).toBe(1);
    expect(out.corrections.join(' ')).toMatch(/product-0: still overlaps product-1 after shrinking/);
  });

  it('moves text/logo clear of overlaps, including panel-nested text', () => {
    const m = manifestFromPlan({
      plan: plan({ products: [{ x: 800, y: 40, w: 300, h: 300 }] }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    // The logo yields to the product (products never move for text/logo).
    expect(out.corrections.join(' ')).toMatch(/logo: pushed clear of product-0/);
    const logo = out.elements.find((e) => e.id === 'logo')!;
    const prod = out.elements.find((e) => e.id === 'product-0')!;
    expect(logo.box.y).toBeGreaterThanOrEqual(prod.box.y + prod.box.h);
    // A free-text box inside the panel box always collides: pushed out.
    expect(out.corrections.join(' ')).toMatch(/headline: pushed clear of panel/);
    const h = out.elements.find((e) => e.id === 'headline')!;
    const p = out.elements.find((e) => e.id === 'panel')!;
    expect(h.box.y + h.box.h).toBeLessThanOrEqual(p.box.y);
  });

  it('pushes overlapping free text apart in reading order', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: null, headline: { x: 140, y: 200, w: 800, h: 60 }, subtext: { x: 140, y: 220, w: 600, h: 40 }, products: [], product_scales: [], notes: [] }),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(s.box.y).toBeGreaterThanOrEqual(h.box.y + h.box.h);
    expect(out.corrections.join(' ')).toMatch(/subtext: pushed clear of headline/);
  });

  it('clamps overlap pushes to the margin bound, not just the safe area', () => {
    // fb-link: safe bottom is 603 but the 6% margin bound is 590. A push that
    // would strand the subtext at 563..603 (safe-legal, margin-busting) must
    // fall back above the headline instead.
    const m = manifestFromPlan({
      plan: plan({ preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 }, panel: null, logo: null, products: [], product_scales: [], logo_scale: null, headline: { x: 500, y: 500, w: 600, h: 60 }, subtext: { x: 500, y: 520, w: 600, h: 40 }, notes: [] }),
      preset: presetById('fb-link')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(s.box.y + s.box.h).toBeLessThanOrEqual(590);
    expect(h.box.y + h.box.h).toBeLessThanOrEqual(590);
    expect(s.box.y + s.box.h <= h.box.y || h.box.y + h.box.h <= s.box.y).toBe(true);
  });

  it('grows a tiny logo to the minimum instead of shrinking it away', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: null, logo: { x: 156, y: 302, w: 23, h: 8 }, headline: { x: 65, y: 269, w: 931, h: 115 }, products: [], product_scales: [], notes: [] }),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const logo = out.elements.find((e) => e.id === 'logo')!;
    const h = out.elements.find((e) => e.id === 'headline')!;
    expect(logo.box.h).toBeGreaterThanOrEqual(38);
    expect(logo.box.y).toBeGreaterThanOrEqual(h.box.y + h.box.h);
    expect(out.corrections.join(' ')).toMatch(/logo: grew to the logo minimum/);
    expect(out.corrections.join(' ')).toMatch(/logo: pushed clear of headline/);
  });

  it('flags empty bands over 25% of the canvas', () => {
    const m = manifestFromPlan({
      plan: plan({ products: [{ x: 400, y: 80, w: 280, h: 200 }], headline: null, panel: null, logo: null, product_scales: [1], logo_scale: null }),
      preset: presetById('ig-feed-11')!,
      planner: 'code',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    expect(out.corrections.join(' ')).toMatch(/empty band/);
  });

  it('omits panel-carried text from the manifest (no ghost layer)', () => {
    const m = manifestFromPlan({
      plan: plan(),
      preset: presetById('ig-feed-11')!,
      planner: 'wonder',
      direction: 'rtl',
      freeText: { headline: false, subtext: true },
    });
    expect(m.elements.map((e) => e.id).sort()).toEqual(['logo', 'panel', 'product-0']);
  });

  it('grows undersized text boxes to the legible minimum', () => {
    const m = manifestFromPlan({
      plan: plan({ preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 }, panel: null, headline: { x: 400, y: 300, w: 222, h: 24 }, subtext: null, notes: [] }),
      preset: presetById('fb-link')!,
      planner: 'wonder',
      direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    expect(h.box.h).toBeGreaterThanOrEqual(Math.ceil(18 * 1.7));
    expect(h.box.w).toBeGreaterThanOrEqual(18 * 4);
    expect(out.corrections.join(' ')).toMatch(/headline.*text minimum/);
  });

  it('denormalizes template zones for the target overlay', () => {
    const zones = templateZonesPx(
      {
        logo: { box: { x: 0.78, y: 0.03, w: 0.17, h: 0.08 }, corner: 'top-right' },
        headline_zone: null,
        subtext_zone: null,
        panel_zone: null,
        product_zone: { x: 0.3, y: 0.15, w: 0.4, h: 0.55 },
        frames: [],
        background_style: 'x',
        text_align: 'center',
        direction: 'rtl',
      },
      1080,
      1080,
      false,
    );
    expect(zones['logo']).toEqual({ x: Math.round(0.78 * 1080), y: Math.round(0.03 * 1080), w: Math.round(0.17 * 1080), h: Math.round(0.08 * 1080) });
    expect(zones['product_zone']?.h).toBe(Math.round(0.55 * 1080));
  });
});

describe('session-15 demo regressions', () => {
  it('grows the hero product to 40% of safe height on square and aligns product bases', () => {
    const m = manifestFromPlan({
      plan: plan({
        logo: null,
        products: [
          { x: 100, y: 200, w: 70, h: 225 },
          { x: 400, y: 210, w: 71, h: 225 },
          { x: 700, y: 190, w: 224, h: 181 },
        ],
        product_scales: [0.65, 0.62, 1.15],
        headline: { x: 100, y: 700, w: 800, h: 90 },
        subtext: { x: 100, y: 620, w: 700, h: 60 },
        panel: { x: 100, y: 900, w: 300, h: 90 },
      }),
      preset: presetById('ig-feed-11')!, planner: 'code', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const prods = out.elements.filter((e) => e.kind === 'product');
    const hero = Math.max(...prods.map((p) => p.box.h));
    expect(hero).toBeGreaterThanOrEqual(Math.round(994 * 0.4));
    const bottoms = prods.map((p) => p.box.y + p.box.h);
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(2);
    // Scale stayed in sync with the grown box (compositor pastes at scale).
    for (const p of prods) expect(p.scale).toBeGreaterThan(0);
  });

  it('keeps a free price with the headline/CTA group on landscape (luma)', () => {
    const m = manifestFromPlan({
      plan: plan({
        preset: 'fb-link', width: 1200, height: 628, safe: { x: 48, y: 25, w: 1104, h: 578 },
        logo: { x: 84, y: 45, w: 192, h: 56 },
        products: [{ x: 647, y: 88, w: 153, h: 452 }, { x: 807, y: 208, w: 341, h: 382 }],
        product_scales: [1.37, 1.79],
        headline: { x: 84, y: 119, w: 504, h: 176 },
        subtext: { x: 84, y: 314, w: 504, h: 50 },
        panel: { x: 84, y: 383, w: 456, h: 69 },
        other_texts: [{ x: 84, y: 549, w: 168, h: 31 }],
      }),
      preset: presetById('fb-link')!, planner: 'wonder', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const price = out.elements.find((e) => e.id === 'other-0')!;
    const panel = out.elements.find((e) => e.id === 'panel')!;
    const gapToGroup = Math.min(
      Math.abs(price.box.y - (panel.box.y + panel.box.h)),
      Math.abs(panel.box.y - (price.box.y + price.box.h)),
    );
    expect(gapToGroup).toBeLessThanOrEqual(30); // adjacent to the CTA, not orphaned at the bottom
  });

  it('sizes a transparent CTA panel as a button, not a full-width panel', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: { x: 122, y: 745, w: 836, h: 270 } }),
      preset: presetById('ig-feed-11')!, planner: 'code', direction: 'ltr', ctaPanel: true,
    });
    const panel = m.elements.find((e) => e.id === 'panel')!;
    expect(panel.box.h).toBeLessThanOrEqual(Math.round(1080 * 0.12));
    expect(panel.box.w).toBeLessThanOrEqual(Math.round(994 * 0.55));
    expect(panel.box.y + panel.box.h).toBe(745 + 270); // bottom anchored
  });
});

describe('panel cap and text restack (demo regressions)', () => {
  const overlaps = (a: {x:number;y:number;w:number;h:number}, b: {x:number;y:number;w:number;h:number}) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  it('caps a giant panel at 25% of canvas height (teva)', () => {
    const m = manifestFromPlan({
      plan: plan({ panel: { x: 90, y: 300, w: 900, h: 700 }, headline: null, products: [], product_scales: [] }),
      preset: presetById('ig-feed-11')!, planner: 'wonder', direction: 'rtl',
    });
    const out = enforceManifest({ manifest: m, direction: 'rtl' });
    const panel = out.elements.find((e) => e.id === 'panel')!;
    expect(panel.box.h).toBeLessThanOrEqual(Math.round(1080 * 0.25));
  });

  it('separates overlapping headline and subtext (northbean story)', () => {
    const m = manifestFromPlan({
      plan: plan({
        preset: 'ig-story-916', width: 1080, height: 1920,
        safe: { x: 54, y: 269, w: 972, h: 1267 },
        logo: null, products: [], product_scales: [], logo_scale: null, panel: null,
        headline: { x: 100, y: 1200, w: 800, h: 90 },
        subtext: { x: 100, y: 1240, w: 800, h: 70 },
      }),
      preset: presetById('ig-story-916')!, planner: 'wonder', direction: 'ltr',
    });
    const out = enforceManifest({ manifest: m, direction: 'ltr' });
    const h = out.elements.find((e) => e.id === 'headline')!;
    const s = out.elements.find((e) => e.id === 'subtext')!;
    expect(overlaps(h.box, s.box)).toBe(false);
  });
});
