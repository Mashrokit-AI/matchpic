import { z } from 'zod';
import { minLegiblePx } from '../repair/render.js';
import { presetSafeRect, type Preset } from '../../shared/presets.js';
import { planBoxSchema, type LayoutPlan, type NormBox, type PlanBox, type SourceAnalysis, type TemplateSpec } from '../../shared/schemas.js';
import { ctaPanelSize, freeOtherTexts } from './planner.js';

/**
 * Resolved layout manifest: the single object every downstream reader uses.
 * Written once per output AFTER constraint enforcement — the compositor,
 * overlays, proof and review all read these final boxes, never the raw
 * planner output or the template zones directly.
 */

export type CompositionFamily = 'landscape_split' | 'portrait_stack' | 'square_balanced';
export type PlannerUsed = 'wonder' | 'code';

export const manifestElementSchema = z.object({
  id: z.string(),
  kind: z.enum(['product', 'logo', 'panel', 'headline', 'subtext', 'other_text', 'frame', 'shadow']),
  box: planBoxSchema,
  /** Layout group: products / logo / text / offer. Text shares one alignment edge. */
  group: z.string().nullable(),
  /** Paint order, low first. */
  z: z.number().int(),
  /** Alignment edge within the group (right for RTL, left for LTR). */
  align: z.enum(['left', 'right', 'center']).nullable(),
  /** Uniform scale applied to source pixels (null for re-rendered text). */
  scale: z.number().nullable(),
  source: z.enum(['template', 'wonder', 'default', 'corrected']),
  /** Source-frame box in source pixels (protected pixels only; null when unknown or re-rendered). */
  srcBox: planBoxSchema.nullable().optional(),
});

export type ManifestElement = z.infer<typeof manifestElementSchema>;

export const manifestSchema = z.object({
  preset: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  family: z.enum(['landscape_split', 'portrait_stack', 'square_balanced']),
  planner: z.enum(['wonder', 'code']),
  safe: planBoxSchema,
  elements: z.array(manifestElementSchema),
  /** Template target zones in output pixels (what the brand asked for) — distinct from actual placement. */
  templateZones: z.record(planBoxSchema).nullable(),
  /** Every deterministic correction applied during enforcement. */
  corrections: z.array(z.string()),
  rationale: z.string().nullable(),
});

export type ResolvedLayoutManifest = z.infer<typeof manifestSchema>;

/** Composition family from canvas aspect ratio. */
export function familyForPreset(preset: Preset): CompositionFamily {
  if (preset.width / preset.height > 1.3) return 'landscape_split';
  if (preset.height / preset.width >= 1.5) return 'portrait_stack';
  return 'square_balanced';
}

function el(
  id: string,
  kind: ManifestElement['kind'],
  box: PlanBox,
  group: string | null,
  z: number,
  align: ManifestElement['align'],
  scale: number | null,
  source: ManifestElement['source'],
): ManifestElement {
  return { id, kind, box, group, z, align, scale, source };
}

/** Denormalize template zones to output pixels (for the "template target" overlay). */
export function templateZonesPx(spec: TemplateSpec, W: number, H: number, mirrored: boolean): Record<string, PlanBox> {
  const px = (n: NormBox): PlanBox => {
    const m = mirrored ? { x: 1 - n.x - n.w, y: n.y, w: n.w, h: n.h } : n;
    return { x: Math.round(m.x * W), y: Math.round(m.y * H), w: Math.max(1, Math.round(m.w * W)), h: Math.max(1, Math.round(m.h * H)) };
  };
  const out: Record<string, PlanBox> = {};
  if (spec.logo) out['logo'] = px(spec.logo.box);
  if (spec.product_zone) out['product_zone'] = px(spec.product_zone);
  if (spec.headline_zone) out['headline_zone'] = px(spec.headline_zone);
  if (spec.subtext_zone) out['subtext_zone'] = px(spec.subtext_zone);
  if (spec.panel_zone) out['panel_zone'] = px(spec.panel_zone.box);
  spec.frames.forEach((f, i) => {
    out[`frame_${i}`] = px(f.box);
  });
  return out;
}

export interface ManifestFromPlanInput {
  plan: LayoutPlan;
  preset: Preset;
  planner: PlannerUsed;
  family?: CompositionFamily;
  direction: 'rtl' | 'ltr';
  templateZones?: Record<string, PlanBox> | null;
  rationale?: string | null;
  /** Which elements came from template zones (vs defaults). */
  fromTemplateNotes?: string[];
  /** Headline/subtext render free (false when they travel with panel pixels). */
  freeText?: { headline: boolean; subtext: boolean };
  /** True when the source panel is transparent (a CTA button, not a panel). */
  ctaPanel?: boolean;
  /** Source-frame panel box + source width: CTA size comes from the source button. */
  panelSrcBox?: PlanBox | null;
  sourceWidth?: number;
}

/** Build the manifest element list from a layout plan (pre-enforcement). */
export function manifestFromPlan(input: ManifestFromPlanInput): ResolvedLayoutManifest {
  const { plan, preset } = input;
  const textAlign = input.direction === 'rtl' ? 'right' : 'left';
  const elements: ManifestElement[] = [];
  const notes = input.fromTemplateNotes ?? plan.notes;
  const noted = (label: string): ManifestElement['source'] =>
    notes.some((n) => n.startsWith(label) && n.includes('template')) ? 'template' : 'default';

  plan.products.forEach((b, i) => {
    elements.push(el(`product-${i}`, 'product', { ...b }, 'products', 20 + i, null, plan.product_scales[i] ?? null, noted('products')));
  });
  if (plan.panel) {
    let panelBox = { ...plan.panel };
    if (input.ctaPanel && input.panelSrcBox && input.sourceWidth) {
      // CTA size from the SOURCE button (source-relative), not from
      // whatever thin/wide box a planner proposed: keep the proposed
      // box's bottom anchor, take the source-derived size.
      const size = ctaPanelSize(
        { bbox: input.panelSrcBox, opaque: true, bg_color: '#000000', text_color: '#ffffff', texts: [] },
        plan.width, plan.height, input.sourceWidth,
      );
      panelBox = {
        x: Math.round(panelBox.x + panelBox.w / 2 - size.w / 2),
        y: panelBox.y + panelBox.h - size.h,
        w: size.w,
        h: size.h,
      };
    } else if (input.ctaPanel) {
      // A CTA keeps button proportions on every planner path: bottom-
      // anchored, at most 45% of canvas width / 9% of canvas height in
      // square/portrait (40% / 20% on landscape), aspect preserved.
      const wideCanvas = plan.width / plan.height > 1.3;
      const maxW = Math.round(plan.width * (wideCanvas ? 0.4 : 0.45));
      const maxH = Math.round(plan.height * (wideCanvas ? 0.2 : 0.09));
      const aspect = panelBox.w / Math.max(1, panelBox.h);
      let h = Math.min(panelBox.h, maxH);
      let w = Math.min(panelBox.w, Math.round(h * aspect), maxW);
      if (w >= maxW) h = Math.round(w / Math.max(0.1, aspect));
      w = Math.max(24, w);
      h = Math.max(24, h);
      panelBox = {
        x: Math.round(panelBox.x + panelBox.w / 2 - w / 2),
        y: panelBox.y + panelBox.h - h,
        w,
        h,
      };
    }
    elements.push(el('panel', 'panel', panelBox, 'offer', 10, textAlign, null, noted('panel')));
  }
  const freeText = input.freeText ?? { headline: true, subtext: true };
  if (plan.headline && freeText.headline) elements.push(el('headline', 'headline', { ...plan.headline }, 'text', 30, textAlign, null, noted('headline')));
  if (plan.subtext && freeText.subtext) elements.push(el('subtext', 'subtext', { ...plan.subtext }, 'text', 31, textAlign, null, noted('subtext')));
  plan.other_texts.forEach((b, i) => {
    elements.push(el(`other-${i}`, 'other_text', { ...b }, 'text', 32 + i, textAlign, null, 'default'));
  });
  if (plan.logo) elements.push(el('logo', 'logo', { ...plan.logo }, 'logo', 40, null, plan.logo_scale, noted('logo')));

  return manifestSchema.parse({
    preset: preset.id,
    width: plan.width,
    height: plan.height,
    family: input.family ?? familyForPreset(preset),
    planner: input.planner,
    safe: presetSafeRect(preset),
    elements,
    templateZones: input.templateZones ?? null,
    corrections: [],
    rationale: input.rationale ?? null,
  });
}

function overlaps(a: PlanBox, b: PlanBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function intersectArea(a: PlanBox, b: PlanBox): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/** True when inner sits (mostly) inside outer — intended nesting, not a collision. */
function nestedIn(inner: PlanBox, outer: PlanBox): boolean {
  return intersectArea(inner, outer) / Math.max(1, inner.w * inner.h) > 0.6;
}

export interface EnforceInput {
  manifest: ResolvedLayoutManifest;
  direction: 'rtl' | 'ltr';
  /** Source-frame vertical order of text/panel/logo elements (restack input). */
  sourceOrder?: Array<{ id: string; srcY: number; srcH: number }>;
  /** Source-frame product boxes by product index (group arrangement input). */
  productSrcBoxes?: Array<PlanBox | null>;
}

/** Source vertical order (logo, headline, subtext, others, panel) for the enforce restack. */
export function sourceOrderFor(analysis: SourceAnalysis): Array<{ id: string; srcY: number; srcH: number }> {
  const out: Array<{ id: string; srcY: number; srcH: number }> = [];
  if (analysis.logo_bbox) out.push({ id: 'logo', srcY: analysis.logo_bbox.y, srcH: analysis.logo_bbox.h });
  if (analysis.headline) out.push({ id: 'headline', srcY: analysis.headline.bbox.y, srcH: analysis.headline.bbox.h });
  if (analysis.subtext) out.push({ id: 'subtext', srcY: analysis.subtext.bbox.y, srcH: analysis.subtext.bbox.h });
  freeOtherTexts(analysis).forEach((t, i) => out.push({ id: `other-${i}`, srcY: t.bbox.y, srcH: t.bbox.h }));
  if (analysis.panel) out.push({ id: 'panel', srcY: analysis.panel.bbox.y, srcH: analysis.panel.bbox.h });
  return out;
}

/** Source product boxes by index for the enforce group relayout. */
export function productSrcBoxesFor(analysis: SourceAnalysis): Array<PlanBox | null> {
  return analysis.products.map((p) => ({ ...p.bbox }));
}

/**
 * Deterministic hard-constraint enforcement. Mutates element boxes in place
 * and records every correction:
 * - margins ≥ 6% of the short side, key content inside safe areas;
 * - no unintended overlap (nesting inside the panel is intended);
 * - product ≥ ~45% of safe height on 9:16, ~70-80% of height on landscape;
 * - text group shares one alignment edge with consistent gaps;
 * - no empty horizontal band > ~25% of the canvas height.
 */
export function enforceManifest(input: EnforceInput): ResolvedLayoutManifest {
  const m = input.manifest;
  const W = m.width;
  const H = m.height;
  const corrections = [...m.corrections];
  const margin = Math.round(Math.min(W, H) * 0.06);
  const safe = m.safe;
  const tall = H / W >= 1.5;
  const wide = W / H > 1.3;
  // Separation floor shared with the repair validator (same formula in
  // applyPatchesToManifest): every settled box keeps this clearance, so a
  // valid Wonder patch is never reverted for the base state's own crowding.
  const minGap = Math.max(8, Math.round(Math.min(W, H) * 0.015));

  const clampInto = (b: PlanBox, outer: PlanBox): PlanBox => {
    const w = Math.min(b.w, outer.w);
    const h = Math.min(b.h, outer.h);
    return {
      x: Math.min(Math.max(b.x, outer.x), outer.x + outer.w - w),
      y: Math.min(Math.max(b.y, outer.y), outer.y + outer.h - h),
      w,
      h,
    };
  };

  // 1. Margins + safe area for every key element.
  const marginRect: PlanBox = { x: margin, y: margin, w: W - margin * 2, h: H - margin * 2 };
  const bound: PlanBox = {
    x: Math.max(safe.x, marginRect.x),
    y: Math.max(safe.y, marginRect.y),
    w: Math.min(safe.x + safe.w, marginRect.x + marginRect.w) - Math.max(safe.x, marginRect.x),
    h: Math.min(safe.y + safe.h, marginRect.y + marginRect.h) - Math.max(safe.y, marginRect.y),
  };
  // Every later step clamps to this same bound: safe area AND the 6% margin
  // (a push/clamp to safe alone can strand a box past the margin edge).
  const BB = bound.w > 0 && bound.h > 0 ? bound : safe;
  for (const e of m.elements) {
    if (e.kind === 'frame' || e.kind === 'shadow') continue;
    const before = { ...e.box };
    e.box = clampInto(e.box, BB);
    if (e.box.x !== before.x || e.box.y !== before.y || e.box.w !== before.w || e.box.h !== before.h) {
      corrections.push(`${e.id}: clamped into safe area + 6% margin`);
      e.source = 'corrected';
    }
  }

  // 1b. Panel cap: a CTA/panel never takes more than a quarter of the canvas
  // height (seen live on teva: a giant white panel swallowing the bottom
  // half, its text clipped). Shrink toward the bottom edge, keep centered.
  for (const e of m.elements) {
    if (e.kind !== 'panel') continue;
    const maxH = Math.round(H * 0.25);
    if (e.box.h > maxH) {
      const bottom = e.box.y + e.box.h;
      e.box = clampInto({ ...e.box, y: bottom - maxH, h: maxH }, BB);
      e.source = 'corrected';
      corrections.push(`panel: capped at 25% of canvas height (${e.box.w}x${e.box.h})`);
    }
  }

  // 2. Product size floors: ≥45% of safe height on 9:16, ≥70% of canvas height on landscape.
  // On tall canvases text never blocks growth — the text push below re-settles
  // around the grown products (text blocking growth stranded small products in
  // the top third while the subtext sat underneath them).
  const growProductsTowardFloor = (ignoreText: boolean, pass: string): void => {
    // Multi-product groups grow as ONE group toward the hero floor —
    // growing every product individually would inflate secondary products
    // (a lying can as tall as the upright cans) and break their source
    // proportions, and per-product growth is blocked by the siblings
    // themselves (NORTHBEAN fb-link shipped thumbnail cans). Positions
    // scale around the group union origin, so the source arrangement
    // (relative offsets, pair overlap fractions) is preserved exactly;
    // the factor steps down until the group fits beside the text column.
    if (!tall && pass === '') {
      const prods = m.elements.filter((e) => e.kind === 'product');
      const targetH = wide ? Math.round(H * 0.7) : Math.round(safe.h * 0.4);
      const hero = prods.reduce((a, b) => (b.box.h > a.box.h ? b : a), prods[0] as ManifestElement);
      if (prods.length > 1 && hero && hero.box.h < targetH) {
        const solids = m.elements.filter((o) => o.kind !== 'product' && o.kind !== 'shadow' && o.kind !== 'frame' && o.group !== 'text');
        const ux = Math.min(...prods.map((e) => e.box.x));
        const uy = Math.min(...prods.map((e) => e.box.y));
        const desired = targetH / hero.box.h;
        let applied = false;
        for (let step = 0; step < 14 && !applied; step++) {
          const factor = desired * Math.pow(0.92, step);
          if (factor <= 1.02) break;
          const grown = prods.map((e) => ({
            x: Math.round(ux + (e.box.x - ux) * factor),
            y: Math.round(uy + (e.box.y - uy) * factor),
            w: Math.max(8, Math.round(e.box.w * factor)),
            h: Math.max(8, Math.round(e.box.h * factor)),
          }));
          // Shift (never resize) the scaled union into the bound.
          const gx = Math.min(...grown.map((g) => g.x));
          const gy = Math.min(...grown.map((g) => g.y));
          const gx2 = Math.max(...grown.map((g) => g.x + g.w));
          const gy2 = Math.max(...grown.map((g) => g.y + g.h));
          if (gx2 - gx > BB.w || gy2 - gy > BB.h) continue;
          const dx = gx < BB.x ? BB.x - gx : gx2 > BB.x + BB.w ? BB.x + BB.w - gx2 : 0;
          const dy = gy < BB.y ? BB.y - gy : gy2 > BB.y + BB.h ? BB.y + BB.h - gy2 : 0;
          const shifted = grown.map((g) => ({ ...g, x: g.x + dx, y: g.y + dy }));
          if (shifted.some((g) => solids.some((o) => overlaps(g, o.box)))) continue;
          prods.forEach((e, i) => {
            const prevW = e.box.w;
            e.box = shifted[i] as PlanBox;
            if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
            e.source = 'corrected';
          });
          corrections.push(`products: group grew proportionally toward ${wide ? '70% canvas-height' : '40% safe-height'} hero floor (x${factor.toFixed(2)})`);
          applied = true;
        }
        if (!applied) corrections.push('products: below size floor but group growth blocked — needs review');
      }
    }
    const productCount = m.elements.filter((e) => e.kind === 'product').length;
    for (const e of m.elements) {
      if (e.kind !== 'product') continue;
      // Square/portrait groups already grew proportionally above; only the
      // hero carries the floor there, secondaries keep source proportions.
      if (!tall && !wide && productCount > 1) continue;
      const targetH = tall ? Math.round(safe.h * 0.45) : wide ? Math.round(H * 0.7) : Math.round(safe.h * 0.4);
      if (targetH <= 0 || e.box.h >= targetH) continue;
      const others = m.elements.filter(
        (o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame' && (!ignoreText || o.group !== 'text'),
      );
      const startH = e.box.h;
      const startW = e.box.w;
      let h = e.box.h;
      let w = e.box.w;
      const cx = e.box.x + e.box.w / 2;
      const cy = e.box.y + e.box.h / 2;
      for (let step = 0; step < 24 && h < targetH; step++) {
        const nh = Math.min(targetH, h + Math.round(targetH / 12));
        const nw = Math.round((w * nh) / Math.max(1, h));
        const cand: PlanBox = { x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh };
        const clamped = clampInto(cand, BB);
        // Aspect-locked growth: the compositor pastes the cut at e.scale,
        // which follows the WIDTH — when the width is squeezed by the canvas
        // bounds, the visual cannot grow, so the box must stop too. Growing
        // height alone inflates empty collision area that squeezes text into
        // unresolvable overlaps (seen live: ZAZO story subtext/panel).
        if (clamped.w < nw) break;
        if (others.some((o) => overlaps(clamped, o.box) && !nestedIn(clamped, o.box) && !nestedIn(o.box, clamped))) break;
        w = clamped.w;
        h = clamped.h;
        e.box = clamped;
      }
      if (e.box.h !== startH) {
        // The compositor pastes cut pixels at e.scale — a grown box with a
        // stale scale renders small and centered (the "shrunk products" bug).
        if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, startW);
        corrections.push(`${e.id}: grew toward ${tall ? '45% safe-height' : '70% canvas-height'} floor (${e.box.w}x${e.box.h})${pass}`);
        e.source = 'corrected';
      } else if (!ignoreText) {
        corrections.push(`${e.id}: below size floor but blocked from growing — needs review`);
      }
    }
  };
  growProductsTowardFloor(tall, '');

  // 2b. Shared surface line: every product stands on the same base — align
  // product bottoms to the group's lowest bottom (never into the panel).
  {
    const prods = m.elements.filter((e) => e.kind === 'product');
    if (prods.length > 1) {
      const targetBottom = Math.max(...prods.map((p) => p.box.y + p.box.h));
      const panel = m.elements.find((e) => e.kind === 'panel');
      let aligned = 0;
      for (const p of prods) {
        const dy = targetBottom - (p.box.y + p.box.h);
        if (dy === 0) continue;
        const cand = clampInto({ ...p.box, y: p.box.y + dy }, BB);
        if (cand.y + cand.h !== targetBottom) continue;
        if (panel && overlaps(cand, panel.box)) continue;
        p.box = cand;
        p.source = 'corrected';
        aligned++;
      }
      if (aligned > 0) corrections.push(`products: ${aligned} aligned to the shared surface line y=${targetBottom}`);
    }
  }

  // 2c. Multi-product group arrangement: products that did not overlap in
  // the source must not overlap here (NORTHBEAN fb-link: two cans placed
  // on the exact same box, reading as one blob). Re-lay the group inside
  // its current union box with the source's relative offsets, scaled as
  // one group.
  {
    const prods = m.elements.filter((e) => e.kind === 'product');
    const srcBoxes = input.productSrcBoxes ?? [];
    if (prods.length > 1 && prods.every((e) => srcBoxes[Number(e.id.split('-')[1])])) {
      // Overlap is judged against the SOURCE pair: loose Spark boxes of
      // neighbouring products overlap slightly by design, so only overlap
      // well beyond the source pair's fraction counts as a new blob.
      const pairFrac = (a: PlanBox, b: PlanBox): number =>
        intersectArea(a, b) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
      const srcFrac = (i: number, j: number): number => pairFrac(
        srcBoxes[Number(prods[i]!.id.split('-')[1])] as PlanBox,
        srcBoxes[Number(prods[j]!.id.split('-')[1])] as PlanBox,
      );
      const pairOverlap = prods.some((a, i) => prods.some((b, j) => j > i
        && pairFrac(a.box, b.box) > srcFrac(i, j) + 0.05));
      if (pairOverlap) {
        const srcs = prods.map((e) => srcBoxes[Number(e.id.split('-')[1])] as PlanBox);
        const srcU = {
          x: Math.min(...srcs.map((b) => b.x)),
          y: Math.min(...srcs.map((b) => b.y)),
          w: Math.max(...srcs.map((b) => b.x + b.w)) - Math.min(...srcs.map((b) => b.x)),
          h: Math.max(...srcs.map((b) => b.y + b.h)) - Math.min(...srcs.map((b) => b.y)),
        };
        const dstU = {
          x: Math.min(...prods.map((e) => e.box.x)),
          y: Math.min(...prods.map((e) => e.box.y)),
          w: Math.max(...prods.map((e) => e.box.x + e.box.w)) - Math.min(...prods.map((e) => e.box.x)),
          h: Math.max(...prods.map((e) => e.box.y + e.box.h)) - Math.min(...prods.map((e) => e.box.y)),
        };
        const scale = Math.min(dstU.w / Math.max(1, srcU.w), dstU.h / Math.max(1, srcU.h));
        const placed = prods.map((e, i) => {
          const s = srcs[i] as PlanBox;
          return clampInto({
            x: Math.round(dstU.x + (s.x - srcU.x) * scale),
            y: Math.round(dstU.y + (s.y - srcU.y) * scale),
            w: Math.max(8, Math.round(s.w * scale)),
            h: Math.max(8, Math.round(s.h * scale)),
          }, BB);
        });
        const stillOverlaps = placed.some((a, i) => placed.some((b, j) => j > i
          && pairFrac(a, b) > srcFrac(i, j) + 0.05));
        if (!stillOverlaps) {
          prods.forEach((e, i) => {
            const prevW = e.box.w;
            e.box = placed[i] as PlanBox;
            if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
            e.source = 'corrected';
          });
          corrections.push('products: group re-laid in source arrangement (overlapping products separated)');
        } else {
          corrections.push('products: overlap persists after group relayout — needs review');
        }
      }
    }
  }

  // 3. Text group: one shared alignment edge (right for RTL, left for LTR).
  const wantAlign = input.direction === 'rtl' ? 'right' : 'left';
  for (const e of m.elements) {
    if (e.group !== 'text' && e.kind !== 'panel') continue;
    if (e.align !== wantAlign) {
      e.align = wantAlign;
      corrections.push(`${e.id}: alignment edge → ${wantAlign} (${input.direction})`);
    }
  }
  // Text minimums: every free-text box must fit one line at the legible
  // floor (else Chromium throws RenderBlocker and the whole size fails —
  // seen live with a 222x24 Wonder box). Grown from center, clamped safe.
  const floor = minLegiblePx(Math.min(W, H));
  const minTextH = Math.ceil(floor * 1.7);
  const minTextW = floor * 4;
  for (const e of m.elements) {
    if (e.group !== 'text') continue;
    if (e.box.w >= minTextW && e.box.h >= minTextH) continue;
    const nw = Math.max(e.box.w, minTextW);
    const nh = Math.max(e.box.h, minTextH);
    const cx = e.box.x + e.box.w / 2;
    const cy = e.box.y + e.box.h / 2;
    e.box = clampInto({ x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
    e.source = 'corrected';
    corrections.push(`${e.id}: grew to the text minimum (${e.box.w}x${e.box.h})`);
  }
  // Consistent gaps: text boxes stacked vertically share the same edge x.
  const texts = m.elements.filter((e) => e.group === 'text').sort((a, b) => a.box.y - b.box.y);
  if (texts.length >= 2) {
    let edgeX = wantAlign === 'right' ? Math.max(...texts.map((t) => t.box.x + t.box.w)) : Math.min(...texts.map((t) => t.box.x));
    // Snap the column to the logo's edge when the logo sits above the
    // texts near that edge: logo/headline/subtext then share one edge
    // instead of near-miss edges a few dozen px apart.
    const logoEl = m.elements.find((e) => e.kind === 'logo');
    if (logoEl && logoEl.box.y + logoEl.box.h <= Math.min(...texts.map((t) => t.box.y)) + 4) {
      const logoEdge = wantAlign === 'right' ? logoEl.box.x + logoEl.box.w : logoEl.box.x;
      if (Math.abs(logoEdge - edgeX) > 0 && Math.abs(logoEdge - edgeX) < W * 0.25) {
        edgeX = logoEdge;
        corrections.push(`text group: column snapped to the logo ${wantAlign} edge`);
      }
    }
    for (const t of texts) {
      // Same-row texts (price + shipping on one line) are side-by-side by
      // design: aligning their x would stack them onto each other.
      const sameRow = texts.some((o) => o !== t && o.box.y < t.box.y + t.box.h && t.box.y < o.box.y + o.box.h);
      if (sameRow) continue;
      const nx = wantAlign === 'right' ? edgeX - t.box.w : edgeX;
      // A box wider than the space from the shared edge to the bound must
      // shrink to fit there, or clamping silently moves it off the edge
      // (the 12px-off headline that read as a ragged column).
      const fitW = wantAlign === 'right' ? Math.min(t.box.w, edgeX - BB.x) : Math.min(t.box.w, BB.x + BB.w - nx);
      const clamped = clampInto({ ...t.box, x: nx, w: Math.max(8, fitW) }, BB);
      if (clamped.x !== t.box.x) {
        t.box = clamped;
        t.source = 'corrected';
      }
    }
    corrections.push(`text group: ${texts.length} boxes share the ${wantAlign} edge`);
    // The CTA panel belongs to the same text column: snap its alignment
    // edge to the column too (NORTHBEAN's "Order now" sat right of the
    // logo/headline/price column in every size).
    const panelCol = m.elements.find((e) => e.kind === 'panel');
    if (panelCol) {
      const sameRow = texts.some((t) => t.box.y < panelCol.box.y + panelCol.box.h && panelCol.box.y < t.box.y + t.box.h);
      if (!sameRow) {
        const nx = wantAlign === 'right' ? edgeX - panelCol.box.w : edgeX;
        const fitW = wantAlign === 'right' ? Math.min(panelCol.box.w, edgeX - BB.x) : Math.min(panelCol.box.w, BB.x + BB.w - nx);
        const clamped = clampInto({ ...panelCol.box, x: nx, w: Math.max(8, fitW) }, BB);
        if (clamped.x !== panelCol.box.x) {
          panelCol.box = clamped;
          panelCol.source = 'corrected';
          corrections.push(`panel: snapped to the text column ${wantAlign} edge`);
        }
      }
    }
  }

  // Headline dominance (tall/square): the source headline is the hero — a
  // Wonder box shrunk to a side note (seen on NOA) is grown back toward a
  // full-width line taller than the subtext. The overlap push below re-settles
  // it when the grown box collides.
  const headlineEl = m.elements.find((e) => e.id === 'headline') ?? null;
  const subtextEl = m.elements.find((e) => e.id === 'subtext') ?? null;
  if (headlineEl && (tall || !wide)) {
    const targetW = Math.round(safe.w * 0.55);
    if (headlineEl.box.w < targetW) {
      const grown: PlanBox = wantAlign === 'right'
        ? { x: headlineEl.box.x + headlineEl.box.w - targetW, y: headlineEl.box.y, w: targetW, h: headlineEl.box.h }
        : { x: headlineEl.box.x, y: headlineEl.box.y, w: targetW, h: headlineEl.box.h };
      const clamped = clampInto(grown, BB);
      if (clamped.w > headlineEl.box.w) {
        headlineEl.box = clamped;
        headlineEl.source = 'corrected';
        corrections.push(`headline: grew toward full-width dominance (${headlineEl.box.w}x${headlineEl.box.h})`);
      }
    }
    if (subtextEl) {
      const targetH = Math.ceil(subtextEl.box.h * 1.25);
      if (headlineEl.box.h < targetH) {
        const grown = clampInto({ ...headlineEl.box, h: targetH }, BB);
        if (grown.h > headlineEl.box.h) {
          headlineEl.box = grown;
          headlineEl.source = 'corrected';
          corrections.push(`headline: grew taller than the subtext (${headlineEl.box.w}x${headlineEl.box.h})`);
        }
      }
    }
  }

  // Landscape text cohesion: headline/subtext/others form one tight vertical
  // stack with a uniform gap, anchored at the topmost text box (a subline
  // stranded far below the headline reads detached). All or nothing: when any
  // stacked box would collide with a non-text element or leave the bound, the
  // whole stack is skipped and the boxes keep their positions.
  if (wide) {
    const stack = m.elements.filter((e) => e.group === 'text').sort((a, b) => a.box.y - b.box.y);
    if (stack.length >= 2) {
      const gap = Math.min(24, Math.max(minGap, Math.round(H * 0.02)));
      const solids = m.elements.filter((e) => e.group !== 'text' && e.kind !== 'shadow' && e.kind !== 'frame');
      const gapBetween = (a: PlanBox, b: PlanBox): number => {
        const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
        const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
        return Math.hypot(dx, dy);
      };
      const desired = new Map<string, PlanBox>();
      let cursor = (stack[0] as ManifestElement).box.y;
      let ok = true;
      for (const t of stack) {
        const cand = clampInto({ ...t.box, y: cursor }, BB);
        if (cand.y !== cursor || solids.some((o) => gapBetween(cand, o.box) < minGap)) {
          ok = false;
          break;
        }
        desired.set(t.id, cand);
        cursor = cand.y + cand.h + gap;
      }
      if (ok) {
        for (const t of stack) {
          const next = desired.get(t.id);
          if (next && (next.y !== t.box.y)) {
            t.box = next;
            t.source = 'corrected';
          }
        }
        corrections.push(`text group: tight stack with ${gap}px gaps`);
      } else {
        // Fallback: stack the offer group WITH the panel in reading order,
        // so a free price stays next to the headline/CTA instead of being
        // stranded alone below the panel (seen live: LUMA "$42" bottom-left).
        const panel = m.elements.find((e) => e.kind === 'panel');
        if (panel) {
          const seq = [...stack, panel].sort((a, b) => a.box.y - b.box.y);
          const solids2 = m.elements.filter((e) => e !== panel && e.group !== 'text' && e.kind !== 'shadow' && e.kind !== 'frame');
          const desired2 = new Map<string, PlanBox>();
          let cursor2 = (seq[0] as ManifestElement).box.y;
          let ok2 = true;
          for (const t of seq) {
            const cand = clampInto({ ...t.box, y: cursor2 }, BB);
            if (cand.y !== cursor2 || solids2.some((o) => gapBetween(cand, o.box) < minGap)) { ok2 = false; break; }
            desired2.set(t.id, cand);
            cursor2 = cand.y + cand.h + gap;
          }
          if (ok2) {
            for (const t of seq) {
              const next = desired2.get(t.id);
              if (next && next.y !== t.box.y) { t.box = next; t.source = 'corrected'; }
            }
            corrections.push(`text group: tight stack with panel with ${gap}px gaps (offer group kept together)`);
          }
        }
      }
    }
  }

  // 4. Logo legibility floor: a lockup below this is unreadable (seen live:
  // a 23x8 logo shrunk to nothing). Grown from center, aspect kept.
  const minLogoH = Math.max(28, Math.round(Math.min(W, H) * 0.035));
  const minProductH = Math.max(48, Math.round(H * 0.08));
  for (const e of m.elements) {
    if (e.kind !== 'logo' || e.box.h >= minLogoH) continue;
    const aspect = e.box.w / Math.max(1, e.box.h);
    const nh = minLogoH;
    const nw = Math.max(8, Math.round(nh * aspect));
    const cy = e.box.y + e.box.h / 2;
    const prevW = e.box.w;
    // Grow from the alignment edge, not the center: center growth shifts
    // the logo's edge off the text column it was just snapped to.
    const anchoredX = wantAlign === 'right' ? e.box.x + e.box.w - nw : e.box.x;
    e.box = clampInto({ x: Math.round(anchoredX), y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
    if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
    e.source = 'corrected';
    corrections.push(`${e.id}: grew to the logo minimum (${e.box.w}x${e.box.h})`);
  }

  // 5. Overlaps involving text or the logo: move the text/logo box clear in
  // reading order (text never shrinks; products and panels never move here).
  // No panel-nesting exemption: a free-text box inside the panel box always
  // collides with the panel's own text. Bounded + recorded; whatever persists
  // fails honestly downstream.
  const movable = (e: ManifestElement): boolean => e.group === 'text' || e.kind === 'logo';
  for (let iter = 0; iter < 8; iter++) {
    const movers = m.elements.filter(movable).sort((a, b) => a.box.y - b.box.y);
    let pushed = false;
    for (const e of movers) {
      const hit = m.elements.find((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame' && overlaps(e.box, o.box));
      if (!hit) continue;
      // Reading order: the lower top-edge moves (ties: the smaller box moves).
      // Text/logo always yields to a product or panel — those never move here.
      let lower: ManifestElement;
      let upper: ManifestElement;
      if (hit.group === 'text' || hit.kind === 'logo') {
        lower = e.box.y !== hit.box.y ? (e.box.y > hit.box.y ? e : hit) : e.box.h <= hit.box.h ? e : hit;
        upper = lower === e ? hit : e;
      } else {
        lower = e;
        upper = hit;
      }
      const ny = upper.box.y + upper.box.h + minGap;
      const cand = clampInto({ ...lower.box, y: ny }, BB);
      if (cand.y === lower.box.y || overlaps(cand, upper.box)) {
        // No room below: try above the upper box.
        const above = clampInto({ ...lower.box, y: upper.box.y - lower.box.h - minGap }, BB);
        if (above.y === lower.box.y || overlaps(above, upper.box)) continue;
        lower.box = above;
      } else {
        lower.box = cand;
      }
      lower.source = 'corrected';
      corrections.push(`${lower.id}: pushed clear of ${upper.id}`);
      pushed = true;
      break;
    }
    if (!pushed) break;
    if (iter === 7) corrections.push('text overlaps persist after pushing — needs review');
  }

  // 5b. Second growth pass: text blocked the first pass on wide/square
  // canvases (and crowded tall ones) — now that text has settled, products
  // grow into the freed space. Then the single-product fill: one product on a
  // tall canvas grows past the floor toward 60% of the safe height while free
  // space allows (capped at 1.5x source scale so raster cuts stay sharp),
  // filling the middle band instead of stranding a thumbnail up top.
  growProductsTowardFloor(false, ' (second pass)');
  if (tall) {
    const singles = m.elements.filter((e) => e.kind === 'product');
    if (singles.length === 1) {
      const e = singles[0] as ManifestElement;
      const targetH = Math.round(safe.h * 0.6);
      if (e.box.h < targetH) {
        const others = m.elements.filter((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame');
        const startW = e.box.w;
        const startScale = e.scale ?? 1;
        let h = e.box.h;
        let w = e.box.w;
        const cx = e.box.x + e.box.w / 2;
        const cy = e.box.y + e.box.h / 2;
        for (let step = 0; step < 24 && h < targetH; step++) {
          const nh = Math.min(targetH, h + Math.round(targetH / 12));
          const nw = Math.round((w * nh) / Math.max(1, h));
          if (startScale * (nw / Math.max(1, startW)) > 1.5) break;
          const cand: PlanBox = { x: Math.round(cx - nw / 2), y: Math.round(cy - nh / 2), w: nw, h: nh };
          const clamped = clampInto(cand, BB);
          // Aspect-locked like the floor growth above: a width squeezed by
          // the bounds means the visual cannot grow — stop, don't inflate.
          if (clamped.w < nw) break;
          if (others.some((o) => overlaps(clamped, o.box) && !nestedIn(clamped, o.box) && !nestedIn(o.box, clamped))) break;
          w = clamped.w;
          h = clamped.h;
          e.box = clamped;
        }
        if (e.box.h > Math.round(safe.h * 0.45) && e.box.w !== startW) {
          if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, startW);
          e.source = 'corrected';
          corrections.push(`${e.id}: filled toward 60% safe-height (${e.box.w}x${e.box.h})`);
        }
      }
    }
  }

  // 6. Remaining overlaps: shrink the product/logo until clear, never below
  // the legibility floors (text never shrinks). When shrinking cannot clear
  // the overlap, the pre-shrink size is restored and the overlap is flagged:
  // a full-size element with an honest flag beats a shrunk-to-a-sliver one
  // with the same flag (seen live: VELA's bottle at 23px wide on fb-link).
  for (const e of m.elements) {
    if (e.kind !== 'product' && e.kind !== 'logo') continue;
    const startBox = { ...e.box };
    const startScale = e.scale;
    const floorH = e.kind === 'logo' ? minLogoH : minProductH;
    let cleared = true;
    for (let iter = 0; iter < 12; iter++) {
      const hit = m.elements.find((o) => o !== e && o.kind !== 'shadow' && o.kind !== 'frame' && overlaps(e.box, o.box));
      if (!hit) {
        cleared = true;
        break;
      }
      cleared = false;
      const nw = Math.round(e.box.w * 0.92);
      const nh = Math.round(e.box.h * 0.92);
      if (nh < floorH || nw < 8) {
        corrections.push(`${e.id}: still overlaps ${hit.id} after shrinking — needs review`);
        break;
      }
      const cx = e.box.x + e.box.w / 2;
      const cy = e.box.y + e.box.h / 2;
      const prevW = e.box.w;
      // Logos shrink from their alignment edge (see the logo floor above):
      // center shrinking walks the logo off the text column.
      const sx = e.kind === 'logo' ? (wantAlign === 'right' ? e.box.x + e.box.w - nw : e.box.x) : Math.round(cx - nw / 2);
      e.box = clampInto({ x: sx, y: Math.round(cy - nh / 2), w: nw, h: nh }, BB);
      if (e.scale !== null) e.scale = (e.scale * e.box.w) / Math.max(1, prevW);
      e.source = 'corrected';
      if (iter === 11) corrections.push(`${e.id}: still overlaps ${hit.id} after shrinking — needs review`);
    }
    if (!cleared && e.box.w !== startBox.w) {
      e.box = startBox;
      e.scale = startScale;
    }
    if (e.box.w !== startBox.w && !corrections.some((c) => c.startsWith(`${e.id}: still overlaps`))) {
      corrections.push(`${e.id}: shrunk to clear overlap`);
    }
  }

  // 6b. Final text restack: the push loop gives up when clamping leaves no
  // room, which shipped overlapping headline/subtext near story bottoms.
  // Deterministically stack the text group: forward pass pushes each box
  // below the previous, backward pass pulls the stack up if it overflows.
  {
    const stack = m.elements.filter((e) => e.group === 'text').sort((a, b) => a.box.y - b.box.y);
    if (stack.length >= 2 && stack.some((t, i) => i > 0 && overlaps(t.box, (stack[i - 1] as ManifestElement).box))) {
      for (let i = 1; i < stack.length; i++) {
        const prev = stack[i - 1] as ManifestElement;
        const cur = stack[i] as ManifestElement;
        if (cur.box.y < prev.box.y + prev.box.h + minGap) {
          cur.box = { ...cur.box, y: prev.box.y + prev.box.h + minGap };
          cur.source = 'corrected';
        }
      }
      const last = stack[stack.length - 1] as ManifestElement;
      const overflow = last.box.y + last.box.h - (BB.y + BB.h);
      if (overflow > 0) {
        for (let i = stack.length - 1; i >= 0; i--) {
          const cur = stack[i] as ManifestElement;
          cur.box = { ...cur.box, y: cur.box.y - overflow };
          if (i > 0) {
            const above = stack[i - 1] as ManifestElement;
            const maxY = cur.box.y - minGap - above.box.h;
            if (above.box.y > maxY) above.box = { ...above.box, y: maxY };
          }
        }
      }
      for (const t of stack) t.box = clampInto(t.box, BB);
      corrections.push('text group: final restack separated overlapping text');
    }
  }

  // 6c. Offer cohesion + reading order (every family, not only landscape):
  // an isolated other-text (the price) stranded far from the
  // headline/subtext/panel cluster is pulled next to the panel; then
  // headline → subtext → panel are restacked in role order when a planner
  // reversed them. Grouped others (Hebrew badge lines) never move here.
  {
    const panelEl = m.elements.find((e) => e.id === 'panel') ?? null;
    const headEl = m.elements.find((e) => e.id === 'headline') ?? null;
    const subEl = m.elements.find((e) => e.id === 'subtext') ?? null;
    const cluster = [headEl, subEl, panelEl].filter((e): e is ManifestElement => !!e);
    const others = m.elements.filter((e) => e.kind === 'other_text');
    const vGap = (a: PlanBox, b: PlanBox): number => Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
    for (const o of others) {
      if (cluster.length === 0) break;
      const grouped = others.some((q) => q !== o && vGap(o.box, q.box) < 100);
      if (grouped) continue;
      const dist = Math.min(...cluster.map((c) => vGap(o.box, c.box)));
      if (dist <= Math.max(60, Math.round(H * 0.06))) continue;
      const targetY = panelEl ? panelEl.box.y - o.box.h - minGap : (subEl ?? headEl)!.box.y + (subEl ?? headEl)!.box.h + minGap;
      const cand = clampInto({ ...o.box, y: targetY }, BB);
      const solids = m.elements.filter((e) => e !== o && e.group !== 'text' && e.kind !== 'shadow' && e.kind !== 'frame');
      if (solids.some((s) => overlaps(cand, s.box))) continue;
      o.box = cand;
      o.source = 'corrected';
      corrections.push(`${o.id}: pulled next to the offer group (was orphaned ${dist}px away)`);
    }
    const seq = [headEl, subEl, panelEl].filter((e): e is ManifestElement => !!e);
    if (seq.length >= 2) {
      const centers = seq.map((e) => e.box.y + e.box.h / 2);
      const ordered = centers.every((c, i) => i === 0 || c > centers[i - 1]!);
      if (!ordered) {
        let cursor = Math.min(...seq.map((e) => e.box.y));
        const desired = new Map<string, PlanBox>();
        for (const e of seq) {
          desired.set(e.id, { ...e.box, y: Math.round(cursor) });
          cursor += e.box.h + minGap;
        }
        const solids = m.elements.filter((e) => !seq.includes(e) && e.kind !== 'shadow' && e.kind !== 'frame');
        const blocked = seq.some((e) => solids.some((s) => overlaps(desired.get(e.id)!, s.box)));
        if (!blocked) {
          for (const e of seq) {
            const next = desired.get(e.id)!;
            const clamped = clampInto(next, BB);
            if (clamped.y !== e.box.y) {
              e.box = clamped;
              e.source = 'corrected';
            }
          }
          corrections.push('text group: restacked in reading order (headline → subtext → panel)');
        }
      }
    }
  }

  // 6d. Source-order restack (runs last, after every planner/patch move):
  // the text group — logo, headline, subtext, price/other texts, panel —
  // keeps the SOURCE vertical order with consistent gaps, so no Wonder
  // plan or patch can reorder or overlap it (LUMA story: logo under the
  // headline). Members keep their current y-slots (permuted into source
  // order), then a separation pass settles gaps; the logo only joins when
  // it sits near the group, and any result colliding with a product is
  // reverted (the reading_order/overlap checks then fail honestly).
  {
    const order = input.sourceOrder ?? [];
    if (order.length >= 2) {
      const byId = new Map(m.elements.map((e) => [e.id, e]));
      const members = order
        .filter((o) => byId.has(o.id))
        .map((o) => ({ el: byId.get(o.id) as ManifestElement, srcY: o.srcY }));
      const nonLogo = members.filter((mm) => mm.el.kind !== 'logo');
      if (nonLogo.length >= 1) {
        const spanTop = Math.min(...nonLogo.map((mm) => mm.el.box.y));
        const spanBot = Math.max(...nonLogo.map((mm) => mm.el.box.y + mm.el.box.h));
        const group = members.filter((mm) => mm.el.kind !== 'logo'
          || (mm.el.box.y + mm.el.box.h >= spanTop - H * 0.2 && mm.el.box.y <= spanBot + H * 0.2));
        if (group.length >= 2) {
          const center = (e: ManifestElement): number => e.box.y + e.box.h / 2;
          const actualOrder = [...group].sort((a, b) => center(a.el) - center(b.el)).map((mm) => mm.el.id);
          const sourceOrderIds = [...group].sort((a, b) => a.srcY - b.srcY).map((mm) => mm.el.id);
          const memberOverlap = group.some((a, i) => group.some((b, j) => j > i && overlaps(a.el.box, b.el.box)));
          if (actualOrder.join(',') !== sourceOrderIds.join(',') || memberOverlap) {
            const slots = [...group].sort((a, b) => a.el.box.y - b.el.box.y).map((mm) => mm.el.box.y);
            const sorted = [...group].sort((a, b) => a.srcY - b.srcY);
            const desired = new Map<string, PlanBox>();
            sorted.forEach((mm, i) => desired.set(mm.el.id, { ...mm.el.box, y: slots[i] as number }));
            // Separation pass in source order, then pull up on overflow.
            for (let i = 1; i < sorted.length; i++) {
              const prev = desired.get((sorted[i - 1] as (typeof sorted)[number]).el.id) as PlanBox;
              const cur = desired.get((sorted[i] as (typeof sorted)[number]).el.id) as PlanBox;
              if (cur.y < prev.y + prev.h + minGap) cur.y = prev.y + prev.h + minGap;
            }
            const lastEl = desired.get((sorted[sorted.length - 1] as (typeof sorted)[number]).el.id) as PlanBox;
            const overflow = lastEl.y + lastEl.h - (BB.y + BB.h);
            if (overflow > 0) {
              for (const mm of sorted) {
                const d = desired.get(mm.el.id) as PlanBox;
                d.y -= overflow;
              }
            }
            const solids = m.elements.filter((e) => !group.some((mm) => mm.el === e) && e.kind !== 'shadow' && e.kind !== 'frame');
            const blocked = sorted.some((mm) => {
              const d = desired.get(mm.el.id) as PlanBox;
              const clamped = clampInto(d, BB);
              return clamped.y !== d.y || clamped.x !== d.x || solids.some((s) => overlaps(clamped, s.box));
            });
            const stillOverlap = sorted.some((a, i) => sorted.some((b, j) => j > i
              && overlaps(desired.get(a.el.id) as PlanBox, desired.get(b.el.id) as PlanBox)));
            if (!blocked && !stillOverlap) {
              for (const mm of sorted) {
                const d = desired.get(mm.el.id) as PlanBox;
                if (d.y !== mm.el.box.y) {
                  mm.el.box = { ...mm.el.box, y: d.y };
                  mm.el.source = 'corrected';
                }
              }
              corrections.push('text group: restacked in source order after planning (logo → headline → subtext → price → panel → other)');
            } else {
              corrections.push('text group: source-order restack blocked by a product — needs review');
            }
          }
        }
      }
    }
  }

  // 5. Empty-band check: no horizontal band >25% of H without any element.
  const rows = 40;
  const rowH = H / rows;
  const covered = new Array(rows).fill(false);
  m.elements.forEach((e) => {
    if (e.kind === 'frame' || e.kind === 'shadow') return;
    const r1 = Math.max(0, Math.floor(e.box.y / rowH));
    const r2 = Math.min(rows - 1, Math.floor((e.box.y + e.box.h) / rowH));
    for (let r = r1; r <= r2; r++) covered[r] = true;
  });
  let gapStart = -1;
  for (let r = 0; r <= rows; r++) {
    const isGap = r < rows && !covered[r];
    if (isGap && gapStart < 0) gapStart = r;
    if (!isGap && gapStart >= 0) {
      const gapH = (r - gapStart) * rowH;
      if (gapH > H * 0.25) corrections.push(`empty band ${(gapStart * rowH / H * 100).toFixed(0)}-${(r * rowH / H * 100).toFixed(0)}% of canvas height — needs review`);
      gapStart = -1;
    }
  }

  m.corrections = corrections;
  return m;
}

/** Look up one element by id (compositor/proof/review helper). */
export function manifestElement(m: ResolvedLayoutManifest, id: string): ManifestElement | null {
  return m.elements.find((e) => e.id === id) ?? null;
}

/** Elements in paint order (z ascending). */
export function paintOrder(m: ResolvedLayoutManifest): ManifestElement[] {
  return [...m.elements].sort((a, b) => a.z - b.z);
}
