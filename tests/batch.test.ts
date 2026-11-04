import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { presetById } from '../src/shared/presets.js';
import type { LayoutPlan, SourceAnalysis, TemplateSpec } from '../src/shared/schemas.js';
import { manifestFromPlan } from '../src/server/adfit/manifest.js';
import { applyPatchesToManifest, computeChecks, consolidatePatches, cropTextRegions, dirtyPlates, expectedTextsFor, isContrastMiss, isGroundingMiss, isSeamDefect, labelReviewImage, regenGoesTextOnly } from '../src/server/adfit/batch.js';
import { logoOnBandPlaced, planForSize, recordDroppedElements, wonderToLayoutPlan, type OutputRequest, type PreparedSource } from '../src/server/adfit/pipeline.js';
import type { WonderSizePlan } from '../src/server/models/wonder.js';

function analysis(): SourceAnalysis {
  return {
    language: 'he',
    direction: 'rtl',
    products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 390, y: 210, w: 300, h: 560 } }],
    logo_bbox: { x: 850, y: 56, w: 170, h: 84 },
    headline: { text: '20% הנחה', bbox: { x: 90, y: 840, w: 900, h: 100 }, bold: true, color: '#ffffff' },
    subtext: null,
    panel: { bbox: { x: 90, y: 820, w: 900, h: 170 }, opaque: true, bg_color: '#ff5a3c', text_color: '#ffffff', texts: ['20% הנחה'] },
    other_texts: [{ text: '750 מ״ל', bbox: { x: 800, y: 150, w: 200, h: 50 }, bold: false, color: '#0f4c5c' }],
    background: { type: 'gradient', description: 'teal gradient', colors: ['#e9f5f3'] },
    unreadable: [],
  };
}

function source(over: Partial<PreparedSource> = {}): PreparedSource {
  const rgba = { data: Buffer.alloc(300 * 560 * 4, 255), width: 300, height: 560 };
  const logoRgba = { data: Buffer.alloc(170 * 84 * 4, 255), width: 170, height: 84 };
  return {
    id: 's', digest: 'd', bytes: Buffer.alloc(10), mimeType: 'image/png', width: 1080, height: 1080,
    analysis: analysis(),
    products: [{ id: 'product-0', rgba, srcX: 0, srcY: 0, fallbackRect: false }],
    logo: { id: 'logo', rgba: logoRgba, srcX: 0, srcY: 0, fallbackRect: false },
    panel: null, panelFill: '#ff5a3c', panelTextColor: null, panelComplex: false,
    masks: new Map(), maskLabels: {}, modelCalls: 0,
    ...over,
  };
}

function wonder(): WonderSizePlan {
  return {
    preset: 'fb-link',
    family: 'landscape_split',
    boxes: {
      products: [{ x: 0.05, y: 0.1, w: 0.35, h: 0.8 }],
      logo: { x: 0.8, y: 0.05, w: 0.15, h: 0.12 },
      panel: { x: 0.45, y: 0.6, w: 0.5, h: 0.3 },
      headline: null,
      subtext: null,
      others: [{ x: 0.45, y: 0.45, w: 0.3, h: 0.08 }],
    },
    align: 'right',
    background_brief: 'mint, clean right side',
    rationale: 'product left, text right',
  };
}

describe('wonder conversion', () => {
  const req = (): OutputRequest => ({ source: source(), preset: presetById('fb-link')!, mode: 'protected', template: null, framePng: null, brandName: 'GALI' });

  it('converts usable wonder boxes to a layout plan', () => {
    const out = wonderToLayoutPlan(wonder(), req());
    expect(out).not.toBeNull();
    expect(out?.plan.products).toHaveLength(1);
    expect(out?.plan.product_scales[0]).toBeGreaterThan(0);
    expect(out?.note).toMatch(/landscape_split/);
  });

  it('rejects wonder plans that drop a product', () => {
    const w = wonder();
    w.boxes.products = [];
    expect(wonderToLayoutPlan(w, req())).toBeNull();
  });

  it('rejects non-finite wonder boxes', () => {
    const w = wonder();
    w.boxes.logo = { x: NaN, y: 0, w: 0.1, h: 0.1 };
    expect(wonderToLayoutPlan(w, req())).toBeNull();
  });

  it('uses the full text zone when a wonder text box covers less than half of it', () => {
    const spec = {
      logo: null,
      headline_zone: { x: 0.058, y: 0.207, w: 0.4, h: 0.207 },
      subtext_zone: { x: 0.058, y: 0.433, w: 0.35, h: 0.061 },
      panel_zone: null,
      product_zone: { x: 0.65, y: 0.111, w: 0.3, h: 0.78 },
      frames: [],
      background_style: 'light photo',
      text_align: 'start',
      direction: 'ltr',
    } satisfies TemplateSpec;
    const a = analysis();
    a.direction = 'ltr';
    a.headline = { text: 'Morning glow', bbox: { x: 100, y: 100, w: 400, h: 60 }, bold: true, color: '#0f4c5c' };
    a.panel = null;
    const s = source({ analysis: a });
    const r: OutputRequest = { source: s, preset: presetById('fb-link')!, mode: 'protected', template: { id: 't', spec: { ...spec }, imageBytes: Buffer.alloc(8), mimeType: 'image/png' }, framePng: null, brandName: 'VELA' };
    const w = wonder();
    w.boxes.products = [{ x: 0.66, y: 0.12, w: 0.28, h: 0.76 }];
    w.boxes.headline = { x: 0.35, y: 0.25, w: 0.1, h: 0.05 };
    const out = wonderToLayoutPlan(w, r);
    expect(out).not.toBeNull();
    // 120x31 inside a 480x130 zone (6% of the area) is a shrunk side note:
    // the full designed zone wins.
    expect(out?.plan.headline).toEqual({ x: 70, y: 130, w: 480, h: 130 });
  });

  it('expands a small 9:16 template product zone before binding wonder boxes', () => {
    const spec = {
      logo: null,
      headline_zone: { x: 0.06, y: 0.078, w: 0.88, h: 0.06 },
      subtext_zone: null,
      panel_zone: { box: { x: 0.083, y: 0.672, w: 0.833, h: 0.115 }, color: '#fff8ee', shape: 'rounded_rect' },
      product_zone: { x: 0.194, y: 0.208, w: 0.657, h: 0.292 },
      frames: [],
      background_style: 'light photo',
      text_align: 'start',
      direction: 'ltr',
    } satisfies TemplateSpec;
    const a = analysis();
    a.direction = 'ltr';
    a.panel = null;
    const s = source({ analysis: a });
    const r: OutputRequest = { source: s, preset: presetById('ig-story-916')!, mode: 'protected', template: { id: 't', spec: { ...spec }, imageBytes: Buffer.alloc(8), mimeType: 'image/png' }, framePng: null, brandName: 'VELA' };
    const w = wonder();
    w.preset = 'ig-story-916';
    w.family = 'portrait_stack';
    w.boxes.products = [{ x: 0.2, y: 0.22, w: 0.6, h: 0.28 }];
    const out = wonderToLayoutPlan(w, r);
    expect(out).not.toBeNull();
    expect(out?.note).toMatch(/expanded for 9:16 fill/);
  });

  it('reconciles wonder slots against the analysis (ZAZO: nulls + phantom others)', () => {
    // No-template source: headline + subtext + panel + logo, zero other_texts.
    // Wonder left every named slot null and emitted 7 phantom others — the
    // outputs rendered no text at all. Named slots fall back to the code
    // planner; the phantom others are dropped.
    const a = analysis();
    a.direction = 'ltr';
    a.headline = { text: 'Shade season is on', bbox: { x: 68, y: 132, w: 505, h: 128 }, bold: true, color: '#17323d' };
    a.subtext = { text: 'Polarized lenses', bbox: { x: 68, y: 275, w: 365, h: 32 }, bold: false, color: '#17323d' };
    a.panel = { bbox: { x: 69, y: 401, w: 545, h: 139 }, opaque: true, bg_color: '#17323d', text_color: '#ffffff', texts: ['$49'] };
    a.other_texts = [];
    const s = source({ analysis: a, width: 1200, height: 628 });
    const r: OutputRequest = { source: s, preset: presetById('ig-feed-11')!, mode: 'protected', template: null, framePng: null, brandName: 'ZAZO' };
    const w = wonder();
    w.preset = 'ig-feed-11';
    w.family = 'square_balanced';
    w.boxes.logo = null;
    w.boxes.panel = null;
    w.boxes.headline = null;
    w.boxes.subtext = null;
    w.boxes.others = Array.from({ length: 7 }, (_, i) => ({ x: 0.07, y: 0.07 + i * 0.12, w: 0.86, h: 0.06 }));
    const out = wonderToLayoutPlan(w, r);
    expect(out).not.toBeNull();
    expect(out?.plan.headline).not.toBeNull();
    expect(out?.plan.subtext).not.toBeNull();
    expect(out?.plan.panel).not.toBeNull();
    expect(out?.plan.logo).not.toBeNull();
    expect(out?.plan.logo_scale).not.toBeNull();
    expect(out?.plan.other_texts).toHaveLength(0);
    expect(out?.note).toMatch(/code planner/);
  });

  it('planForSize falls back to code and records the planner used', () => {
    const good = planForSize(req(), wonder());
    expect(good.planner).toBe('wonder');
    expect(good.manifest.planner).toBe('wonder');
    expect(good.manifest.family).toBe('landscape_split');
    const bad = planForSize(req(), null);
    expect(bad.planner).toBe('code');
    expect(bad.manifest.planner).toBe('code');
    const broken = wonder();
    broken.boxes.products = [];
    const fb = planForSize(req(), broken);
    expect(fb.planner).toBe('code');
  });
});

describe('patch application', () => {
  function manifest() {
    const plan: LayoutPlan = {
      preset: 'fb-link', width: 1200, height: 628, from_template: false, template_id: null,
      safe: { x: 48, y: 25, w: 1104, h: 578 },
      logo: { x: 950, y: 60, w: 170, h: 60 },
      products: [{ x: 100, y: 90, w: 300, h: 440 }],
      headline: null, subtext: null, panel: { x: 500, y: 380, w: 600, h: 150 },
      other_texts: [], product_scales: [1], logo_scale: 1, notes: [],
    };
    return manifestFromPlan({ plan, preset: presetById('fb-link')!, planner: 'code', direction: 'rtl' });
  }

  it('moves and scales elements, clamped to ±15% travel and the safe area', () => {
    const { manifest: out, result } = applyPatchesToManifest(manifest(), [
      { size: 'fb-link', element: 'logo', group: null, action: 'scale', by: 1.3, reason: 'too small' },
      { size: 'fb-link', element: null, group: 'offer', action: 'move', dy: -0.08, reason: 'lift panel' },
    ], 'rtl');
    expect(result.recompose).toBe(true);
    expect(result.applied).toHaveLength(2);
    const logo = out.elements.find((e) => e.id === 'logo')!;
    expect(logo.box.w).toBeGreaterThan(170);
    expect(logo.scale).toBeCloseTo(1.3, 1);
    const panel = out.elements.find((e) => e.id === 'panel')!;
    expect(panel.box.y).toBeLessThan(380);
  });

  it('lets same-group text stacks keep tight designed gaps', () => {
    const plan: LayoutPlan = {
      preset: 'ig-feed-11', width: 1080, height: 1080, from_template: false, template_id: null,
      safe: { x: 43, y: 43, w: 994, h: 994 },
      logo: null, products: [], headline: { x: 65, y: 130, w: 646, h: 80 }, subtext: { x: 65, y: 224, w: 540, h: 41 },
      panel: null, other_texts: [], product_scales: [], logo_scale: null, notes: [],
    };
    const before = manifestFromPlan({ plan, preset: presetById('ig-feed-11')!, planner: 'wonder', direction: 'ltr' });
    // Headline moves down 10px: 14px gap becomes 4px — tight but designed.
    const { result } = applyPatchesToManifest(before, [
      { size: 'ig-feed-11', element: 'headline', group: null, action: 'move', dy: 10 / 1080, reason: 'nudge' },
    ], 'ltr');
    expect(result.applied).toHaveLength(1);
    expect(result.unfixed).toHaveLength(0);
  });

  it('flags unknown targets and routes plate defects to regen', () => {
    const { result } = applyPatchesToManifest(manifest(), [
      { size: 'fb-link', element: 'ghost', group: null, action: 'move', dx: 0.1, reason: 'nope' },
      { size: 'fb-link', element: null, group: null, action: 'regenerate_plate', reason: 'dirty bg' },
      { size: 'fb-link', element: 'logo', group: null, action: 'flag', reason: 'human look' },
    ], 'rtl');
    expect(result.needsPlate).toBe(true);
    expect(result.recompose).toBe(true);
    expect(result.flagged).toHaveLength(2);
    expect(result.unfixed).toHaveLength(1);
  });

  it('reverts a move that would leave the target touching another element', () => {
    // Logo bottom 10px above the panel top edge (y=380); a +9px move lands 1px above it.
    const plan: LayoutPlan = {
      preset: 'fb-link', width: 1200, height: 628, from_template: false, template_id: null,
      safe: { x: 48, y: 25, w: 1104, h: 578 },
      logo: { x: 950, y: 310, w: 170, h: 60 },
      products: [{ x: 100, y: 90, w: 300, h: 440 }], headline: null, subtext: null,
      panel: { x: 500, y: 380, w: 600, h: 150 }, other_texts: [],
      product_scales: [1], logo_scale: 1, notes: [],
    };
    const before = manifestFromPlan({ plan, preset: presetById('fb-link')!, planner: 'code', direction: 'rtl' });
    const { manifest: out, result } = applyPatchesToManifest(before, [
      { size: 'fb-link', element: 'logo', group: null, action: 'move', dy: 9 / 628, reason: 'test touch' },
    ], 'rtl');
    expect(result.recompose).toBe(false); // nothing changed: no recompose
    expect(result.applied).toHaveLength(0);
    expect(result.unfixed).toHaveLength(1);
    expect(result.unfixed[0]).toMatch(/reverted/);
    const logo = out.elements.find((e) => e.id === 'logo')!;
    expect(logo.box).toEqual({ x: 950, y: 310, w: 170, h: 60 });
  });
});

describe('sequential repair', () => {
  it('rolls a violating patch back to the validated state, keeping earlier patches', () => {
    const plan: LayoutPlan = {
      preset: 'fb-link', width: 1200, height: 628, from_template: false, template_id: null,
      safe: { x: 48, y: 25, w: 1104, h: 578 },
      // The second product blocks the below-panel escape, so the dropped
      // subtext has nowhere legal to go and the patch must roll back.
      logo: null, products: [{ x: 100, y: 90, w: 300, h: 440 }, { x: 500, y: 520, w: 600, h: 70 }], headline: null,
      subtext: { x: 500, y: 280, w: 600, h: 40 }, panel: { x: 500, y: 380, w: 600, h: 150 },
      other_texts: [], product_scales: [1, 1], logo_scale: null, notes: [],
    };
    const before = manifestFromPlan({ plan, preset: presetById('fb-link')!, planner: 'wonder', direction: 'ltr' });
    const { manifest: out, result } = applyPatchesToManifest(before, [
      { size: 'fb-link', element: 'panel', group: null, action: 'move', dy: -0.05, reason: 'lift' },
      { size: 'fb-link', element: 'subtext', group: null, action: 'move', dy: 94 / 628, reason: 'drop into panel' },
    ], 'ltr');
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/^panel: move/);
    expect(result.unfixed).toHaveLength(1);
    expect(result.unfixed[0]).toMatch(/subtext.*reverted/);
    // Panel keeps its validated move; subtext is back where it started.
    expect(out.elements.find((e) => e.id === 'panel')?.box.y).toBeLessThan(380);
    expect(out.elements.find((e) => e.id === 'subtext')?.box.y).toBe(280);
  });
});

describe('patch consolidation', () => {
  const els = [
    { id: 'headline', group: 'text' },
    { id: 'subtext', group: 'text' },
    { id: 'logo', group: null },
  ];
  it('sums same-target moves and multiplies scales, deduping the rest', () => {
    const out = consolidatePatches([
      { size: 's', element: 'subtext', group: null, action: 'move', dx: 0, dy: 0.03, reason: 'down a touch' },
      { size: 's', element: 'subtext', group: null, action: 'move', dx: 0, dy: -0.15, reason: 'up a lot' },
      { size: 's', element: 'logo', group: null, action: 'scale', by: 1.3, reason: 'bigger' },
      { size: 's', element: 'logo', group: null, action: 'scale', by: 1.1, reason: 'bit more' },
      { size: 's', element: null, group: null, action: 'regenerate_plate', reason: 'dirty' },
      { size: 's', element: null, group: null, action: 'regenerate_plate', reason: 'dirty' },
    ], els);
    expect(out).toHaveLength(3);
    expect(out[0]?.dy).toBeCloseTo(-0.12, 10);
    expect(out[1]?.by).toBeCloseTo(1.43, 10);
    expect(out[2]?.action).toBe('regenerate_plate');
  });

  it('expands group selectors and dedupes identical element+group deltas', () => {
    const out = consolidatePatches([
      { size: 's', element: 'headline', group: null, action: 'move', dx: 0, dy: -0.15, reason: 'lift' },
      { size: 's', element: null, group: 'text', action: 'move', dx: 0, dy: -0.15, reason: 'lift all text' },
    ], els);
    // headline's -0.15 said twice (element + group form) applies once;
    // subtext gets its own -0.15 from the group patch.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ element: 'headline', group: null, dy: -0.15 });
    expect(out[1]).toMatchObject({ element: 'subtext', group: null, dy: -0.15 });
  });

  it('keeps unknown targets for the honest downstream flag', () => {
    const out = consolidatePatches([
      { size: 's', element: null, group: 'nope', action: 'move', dx: 0.1, reason: 'void' },
    ], els);
    expect(out).toHaveLength(1);
    expect(out[0]?.group).toBe('nope');
  });
});

describe('seam defects', () => {
  it('routes seam-class plate reasons to the text-only regen', () => {
    expect(isSeamDefect('Hard empty cream strip with a straight seam behind the product')).toBe(true);
    expect(isSeamDefect('Solid dark-brown band across the top')).toBe(true);
    expect(isSeamDefect('duplicated bottle and garbled lettering')).toBe(false);
  });

  it('routes duplicated-content plate reasons to the text-only regen (ZAZO miniature)', () => {
    expect(regenGoesTextOnly('Plate contains a baked-in miniature copy of the full source ad with duplicate ZAZO logo')).toBe(true);
    expect(regenGoesTextOnly('ghost product residual in the corner')).toBe(true);
    expect(regenGoesTextOnly('Not empty - distinct vase with green foliage plus blurred cups and bread')).toBe(true);
    expect(regenGoesTextOnly('contains illustrated headphone product on the left side')).toBe(true);
    expect(regenGoesTextOnly('Solid dark-brown band across the top')).toBe(true);
    expect(regenGoesTextOnly('garbled lettering in the corner')).toBe(true);
    expect(regenGoesTextOnly('colors drift from the source palette')).toBe(false);
  });

  it('routes grounding-miss plate reasons to the text-only regen (NOA table)', () => {
    expect(regenGoesTextOnly('fb-link: the product base sits at y≈89% but the painted table back edge is at y≈83% — repaint')).toBe(true);
    expect(isGroundingMiss('table back edge is at y≈83%')).toBe(true);
    expect(isGroundingMiss('straight horizontal seam across the middle')).toBe(false);
  });

  it('routes unreadable-text plate reasons to the text-only regen (NOA headline)', () => {
    expect(regenGoesTextOnly('ig-feed-11: headline unreadable on the plate (contrast 1.07 < 2.0) — repaint')).toBe(true);
    expect(isContrastMiss('headline unreadable on the plate')).toBe(true);
    expect(isContrastMiss('table back edge is at y≈83%')).toBe(false);
  });
});

describe('plate verdicts', () => {
  it('fails closed on presets missing from the response', () => {
    const { dirty, reasons } = dirtyPlates(['a', 'b'], [{ preset: 'a', clean: true, reason: 'empty' }]);
    expect([...dirty]).toEqual(['b']);
    expect(reasons.join(' ')).toMatch(/fail-closed/);
  });

  it('collects dirty reasons for the trace', () => {
    const { dirty, reasons } = dirtyPlates(
      ['a', 'b'],
      [{ preset: 'a', clean: false, reason: 'lettering top right' }, { preset: 'b', clean: true, reason: 'empty' }],
    );
    expect([...dirty]).toEqual(['a']);
    expect(reasons.join(' ')).toContain('lettering');
  });
});

describe('logo on band', () => {
  it('reads the enforced logo geometry against frame bands, not notes', () => {
    const plan: LayoutPlan = {
      preset: 'ig-story-916', width: 1080, height: 1920, from_template: true, template_id: 't',
      safe: { x: 54, y: 269, w: 972, h: 1267 },
      logo: { x: 415, y: 1174, w: 238, h: 65 }, products: [], headline: null, subtext: null,
      panel: null, other_texts: [], product_scales: [], logo_scale: 1, notes: [],
    };
    const m = manifestFromPlan({ plan, preset: presetById('ig-story-916')!, planner: 'wonder', direction: 'rtl' });
    const zones = { frame_0: { x: 0, y: 1560, w: 1080, h: 360 } };
    // Logo center (534,1206) sits above the footer band -> off-band, no footer.
    expect(logoOnBandPlaced(m, zones, true, [])).toBe(false);
    const onBand = { ...m, elements: m.elements.map((e) => (e.id === 'logo' ? { ...e, box: { x: 415, y: 1650, w: 238, h: 65 } } : e)) };
    expect(logoOnBandPlaced(onBand, zones, true, [])).toBe(true);
    expect(logoOnBandPlaced(m, {}, true, [])).toBe(true); // no frames -> notes fallback
    expect(logoOnBandPlaced(m, zones, false, [])).toBeUndefined();
  });
});

describe('dropped elements', () => {
  it('records unplaced source elements, skipping panel-carried and on-product strings', () => {
    const analysis = {
      language: 'he', direction: 'rtl',
      products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 390, y: 210, w: 300, h: 560 } }],
      logo_bbox: { x: 850, y: 56, w: 170, h: 84 },
      headline: { text: '20% הנחה', bbox: { x: 90, y: 840, w: 900, h: 100 }, bold: true, color: '#fff' },
      subtext: null,
      panel: { bbox: { x: 90, y: 820, w: 900, h: 170 }, opaque: true, bg_color: '#ff5a3c', text_color: '#fff', texts: ['20% הנחה'] },
      other_texts: [
        { text: 'בקבוק תרמי', bbox: { x: 740, y: 145, w: 250, h: 30 }, bold: false, color: '#000' },
        { text: 'GALI', bbox: { x: 462, y: 505, w: 116, h: 38 }, bold: true, color: '#fff' },
      ],
      background: { type: 'flat', description: 'mint', colors: [] },
      unreadable: [],
    } as unknown as SourceAnalysis;
    const plan: LayoutPlan = {
      preset: 'fb-link', width: 1200, height: 628, from_template: false, template_id: null,
      safe: { x: 48, y: 25, w: 1104, h: 578 },
      logo: { x: 950, y: 60, w: 170, h: 60 }, products: [{ x: 100, y: 90, w: 300, h: 440 }],
      headline: null, subtext: null, panel: { x: 500, y: 380, w: 600, h: 150 }, other_texts: [],
      product_scales: [1], logo_scale: 1, notes: [],
    };
    const m = manifestFromPlan({ plan, preset: presetById('fb-link')!, planner: 'wonder', direction: 'rtl' });
    recordDroppedElements(m, { source: { analysis } } as unknown as OutputRequest, 'wonder');
    expect(m.corrections).toHaveLength(1);
    expect(m.corrections[0]).toContain('other-0');
    expect(m.corrections[0]).not.toContain('headline'); // carried by the panel
    expect(m.corrections[0]).not.toContain('other-1'); // printed on the product
  });
});

describe('text crops', () => {
  it('cuts padded 2x crops of text regions, labeled per output', async () => {
    const png = await sharp({ create: { width: 1200, height: 628, channels: 4, background: { r: 9, g: 9, b: 9, alpha: 1 } } }).png().toBuffer();
    const plan: LayoutPlan = {
      preset: 'fb-link', width: 1200, height: 628, from_template: false, template_id: null,
      safe: { x: 48, y: 25, w: 1104, h: 578 },
      logo: null, products: [], headline: { x: 500, y: 100, w: 200, h: 40 }, subtext: null,
      panel: { x: 500, y: 380, w: 600, h: 150 }, other_texts: [],
      product_scales: [], logo_scale: null, notes: [],
    };
    const m = manifestFromPlan({ plan, preset: presetById('fb-link')!, planner: 'code', direction: 'rtl' });
    const crops = await cropTextRegions(png, m, 2);
    expect(crops).toHaveLength(2);
    expect(crops.map((c) => c.label).sort()).toEqual(['OUTPUT2:headline', 'OUTPUT2:panel']);
    const head = crops.find((c) => c.label === 'OUTPUT2:headline')!;
    const meta = await sharp(head.imageBytes).metadata();
    expect(meta.width).toBe((200 + 20) * 2); // padded, upscaled 2x
    expect(meta.height).toBe((40 + 20) * 2);
  });
});

describe('output checks', () => {
  const proofs = { 'product-0': { scale: 1, core_differ: 0, core_total: 100, feather_total: 10, coverage: 0.9, pass: true } };

  it('passes a clean repaired output as fixed', () => {
    const c = computeChecks({
      proofs, panelFlagged: false, textSizes: { headline: [60] },
      textVerdict: { all_exact: true, wrong: [] }, findings: [], wonderFlags: [],
      appliedPatches: ['logo: scale x1.3'], reviewRan: true, repaired: true,
    });
    expect(c.protected_pixels.status).toBe('passed');
    expect(c.protected_pixels.detail).toMatch(/Protected core matches the resized source \(90% compared\)/);
    expect(c.text.status).toBe('fixed');
    expect(c.layout_review.status).toBe('fixed');
  });

  it('needs review on proof failure, text mismatch, flags and deterministic fails', () => {
    const badProof = computeChecks({
      proofs: { 'product-0': { ...proofs['product-0']!, core_differ: 5, pass: false } },
      panelFlagged: false, textSizes: {}, textVerdict: { all_exact: true, wrong: [] },
      findings: [], wonderFlags: [], appliedPatches: [], reviewRan: true, repaired: false,
    });
    expect(badProof.protected_pixels.status).toBe('needs_review');
    const badText = computeChecks({
      proofs, panelFlagged: false, textSizes: { headline: [60] },
      textVerdict: { all_exact: false, wrong: ['headline'] }, findings: [], wonderFlags: [],
      appliedPatches: [], reviewRan: true, repaired: false,
    });
    expect(badText.text.status).toBe('needs_review');
    const flagged = computeChecks({
      proofs, panelFlagged: true, textSizes: {}, textVerdict: null,
      findings: [{ code: 'overlap', severity: 'fail', element: 'logo', detail: 'x' }], wonderFlags: ['look'],
      appliedPatches: [], reviewRan: true, repaired: false,
    });
    expect(flagged.text.status).toBe('needs_review');
    expect(flagged.layout_review.status).toBe('needs_review');
  });

  it('builds the verbatim inventory in compositor order', () => {
    const texts = expectedTextsFor({ headline: [60], panel: [50, 28], 'other-0': [30] }, source());
    expect(texts).toContain('20% הנחה');
    expect(texts).toContain('750 מ״ל');
  });
});

describe('review image labeling', () => {
  it('scales the long side to 768px with a badge', async () => {
    const png = await sharp({ create: { width: 1200, height: 628, channels: 3, background: { r: 200, g: 220, b: 210 } } }).png().toBuffer();
    const out = await labelReviewImage(png, 'fb-link');
    const meta = await sharp(out).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(768);
    expect(out.length).toBeGreaterThan(1000);
  });
});
