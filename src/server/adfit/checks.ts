import type { ResolvedLayoutManifest } from './manifest.js';
import { minLegiblePx } from '../repair/render.js';
import { freeOtherTexts, isPriceText } from './planner.js';
import type { SourceAnalysis } from '../../shared/schemas.js';

/**
 * Deterministic geometry/text checks. They run FIRST on every composed
 * output, their results go into the Wonder review prompt, and anything still
 * failing after the single repair pass marks the output "Needs review".
 */

export type CheckSeverity = 'fail' | 'warn';

export interface GeometryFinding {
  code: string;
  severity: CheckSeverity;
  element: string | null;
  detail: string;
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function intersectArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return w * h;
}

/**
 * Check one resolved manifest against the hard layout contract. Pure and
 * fast — no models. `renderedSizes` maps text element ids to the actual
 * rendered font px (from Chromium) for the legibility check.
 */
export function checkManifestGeometry(
  manifest: ResolvedLayoutManifest,
  analysis: SourceAnalysis,
  renderedSizes: Record<string, number[]> = {},
): GeometryFinding[] {
  const out: GeometryFinding[] = [];
  const W = manifest.width;
  const H = manifest.height;
  const safe = manifest.safe;
  const margin = Math.round(Math.min(W, H) * 0.06);
  const tall = H / W >= 1.5;
  const wide = W / H > 1.3;
  const inSafe = (b: { x: number; y: number; w: number; h: number }): boolean =>
    b.x >= safe.x && b.y >= safe.y && b.x + b.w <= safe.x + safe.w && b.y + b.h <= safe.y + safe.h;

  for (const e of manifest.elements) {
    if (e.kind === 'frame' || e.kind === 'shadow') continue;
    // Safe area.
    if (!inSafe(e.box)) {
      out.push({ code: 'safe_area', severity: 'fail', element: e.id, detail: `${e.id} leaves the safe area` });
    }
    // 6% margin.
    if (e.box.x < margin || e.box.y < margin || e.box.x + e.box.w > W - margin || e.box.y + e.box.h > H - margin) {
      out.push({ code: 'margin', severity: 'fail', element: e.id, detail: `${e.id} closer than 6% of the short side to the canvas edge` });
    }
  }

  // Overlaps: ANY box collision fails, including text nested in the panel
  // (panel-carried strings have no element, so a free-text box inside the
  // panel box always renders over the panel's own text — seen live as a
  // subtext stamped across "$39"). No nesting exemption at this level.
  const els = manifest.elements.filter((e) => e.kind !== 'frame' && e.kind !== 'shadow');
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i]!;
      const b = els[j]!;
      if (!overlaps(a.box, b.box)) continue;
      // Products that overlap in the source keep that overlap by design.
      if (a.kind === 'product' && b.kind === 'product') {
        const sa = analysis.products[Number(a.id.split('-')[1])]?.bbox;
        const sb = analysis.products[Number(b.id.split('-')[1])]?.bbox;
        if (sa && sb && overlaps(sa, sb)) continue;
      }
      out.push({ code: 'overlap', severity: 'fail', element: a.id, detail: `${a.id} overlaps ${b.id}` });
    }
  }

  // Product size floors: the hero (tallest) product carries the size bar —
  // secondary products stay proportionate to it, so a small jar beside a big
  // bottle is composition, not a defect (per-product floors spammed the review
  // with unfixable scale patches).
  const products = manifest.elements.filter((e) => e.kind === 'product');
  if (products.length > 0) {
    const hero = products.reduce((a, b) => (b.box.h > a.box.h ? b : a));
    if (tall && hero.box.h < Math.round(safe.h * 0.45)) {
      out.push({ code: 'product_size', severity: 'warn', element: hero.id, detail: `${hero.id} below 45% of safe height on 9:16` });
    }
    if (wide && hero.box.h < Math.round(H * 0.7)) {
      out.push({ code: 'product_size', severity: 'warn', element: hero.id, detail: `${hero.id} below 70% of canvas height on landscape` });
    }
    if (!tall && !wide && hero.box.h < Math.round(safe.h * 0.4)) {
      out.push({ code: 'product_size', severity: 'warn', element: hero.id, detail: `${hero.id} below 40% of safe height on square/portrait` });
    }
  }

  // Text group: one shared alignment edge.
  const texts = manifest.elements.filter((e) => e.group === 'text');
  const edges = new Set(texts.map((t) => t.align));
  if (edges.size > 1) {
    out.push({ code: 'text_align', severity: 'warn', element: null, detail: `text group mixes alignment edges (${[...edges].join(',')})` });
  }
  // Ragged column: non-same-row text boxes must share the alignment edge
  // in pixels (a shared `align` label with different box edges renders as
  // a ragged column — the defect Wonder kept "fixing" with ±162px moves).
  // The CTA panel belongs to the text column too (its box edge counts).
  {
    const panelEl = manifest.elements.find((e) => e.kind === 'panel');
    const columnTexts = panelEl && !texts.some((t) => t.id === panelEl.id)
      ? [...texts, { ...panelEl, group: 'text' }]
      : texts;
    const stacked = columnTexts.filter(
      (t) => !columnTexts.some((o) => o !== t && o.box.y < t.box.y + t.box.h && t.box.y < o.box.y + o.box.h),
    );
    if (stacked.length >= 2) {
      const align = stacked[0]!.align ?? 'left';
      const edgeOf = (b: { x: number; w: number }): number => (align === 'right' ? b.x + b.w : align === 'center' ? b.x + b.w / 2 : b.x);
      const edge0 = edgeOf(stacked[0]!.box);
      for (const t of stacked.slice(1)) {
        if (Math.abs(edgeOf(t.box) - edge0) > 4) {
          out.push({ code: 'text_column', severity: 'fail', element: t.id, detail: `${t.id} alignment edge off by ${Math.round(edgeOf(t.box) - edge0)}px from the text column` });
        }
      }
      // The logo shares the column edge when it sits above the texts on
      // the same side (near-miss edges read as a ragged lockup column).
      const logo = manifest.elements.find((e) => e.kind === 'logo');
      const firstTextY = Math.min(...stacked.map((t) => t.box.y));
      if (logo && logo.box.y + logo.box.h <= firstTextY + 4) {
        // Near-miss only: a logo far from the column edge is a centered
        // lockup by design, not a ragged column.
        if (Math.abs(edgeOf(logo.box) - edge0) > 8 && Math.abs(edgeOf(logo.box) - edge0) < W * 0.25) {
          out.push({ code: 'text_column', severity: 'fail', element: 'logo', detail: `logo alignment edge off by ${Math.round(edgeOf(logo.box) - edge0)}px from the text column` });
        }
      }
    }
  }
  // Grouped source lines split apart: other-texts stacked tightly in the
  // source must stay a tight stack in the output.
  {
    const free = freeOtherTexts(analysis);
    const byId = new Map(manifest.elements.map((e) => [e.id, e]));
    const sorted = free
      .map((t, i) => ({ t, el: byId.get(`other-${i}`) }))
      .filter((r): r is { t: (typeof free)[number]; el: NonNullable<ReturnType<typeof byId.get>> } => !!r.el)
      .sort((a, b) => a.t.bbox.y - b.t.bbox.y);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      const srcGap = cur.t.bbox.y - (prev.t.bbox.y + prev.t.bbox.h);
      const xOverlap = Math.max(0, Math.min(prev.t.bbox.x + prev.t.bbox.w, cur.t.bbox.x + cur.t.bbox.w) - Math.max(prev.t.bbox.x, cur.t.bbox.x));
      const grouped = srcGap < Math.max(prev.t.bbox.h, cur.t.bbox.h) * 0.6 && xOverlap > Math.min(prev.t.bbox.w, cur.t.bbox.w) * 0.3;
      if (!grouped) continue;
      const outGap = cur.el.box.y - (prev.el.box.y + prev.el.box.h);
      const limit = Math.max(48, Math.round(Math.max(prev.el.box.h, cur.el.box.h) * 1.5));
      if (outGap > limit) {
        out.push({ code: 'text_group_split', severity: 'fail', element: cur.el.id, detail: `${prev.el.id}→${cur.el.id} were one group in the source but are split by ${outGap}px in the output` });
      }
    }
  }

  // Reading order: headline / subtext / price / panel must keep the
  // source's vertical order (the s18 square/story outputs read
  // subtext → headline, with the price stranded above both).
  {
    const byId = new Map(manifest.elements.map((e) => [e.id, e]));
    const seq: Array<{ id: string; srcY: number }> = [];
    if (analysis.headline && byId.has('headline')) seq.push({ id: 'headline', srcY: analysis.headline.bbox.y });
    if (analysis.subtext && byId.has('subtext')) seq.push({ id: 'subtext', srcY: analysis.subtext.bbox.y });
    freeOtherTexts(analysis).forEach((t, i) => {
      if (isPriceText(t.text) && byId.has(`other-${i}`)) seq.push({ id: `other-${i}`, srcY: t.bbox.y });
    });
    if (analysis.panel && byId.has('panel')) seq.push({ id: 'panel', srcY: analysis.panel.bbox.y });
    if (seq.length >= 2) {
      const expected = [...seq].sort((a, b) => a.srcY - b.srcY).map((s) => s.id);
      const actual = [...seq]
        .sort((a, b) => (byId.get(a.id)!.box.y + byId.get(a.id)!.box.h / 2) - (byId.get(b.id)!.box.y + byId.get(b.id)!.box.h / 2))
        .map((s) => s.id);
      if (expected.join(',') !== actual.join(',')) {
        out.push({
          code: 'reading_order', severity: 'fail', element: null,
          detail: `output order ${actual.join(' → ')} differs from source order ${expected.join(' → ')}`,
        });
      }
    }
  }

  // Hero size on tall canvases: a product photo under ~35% of the canvas
  // height reads as a thumbnail in empty space (every s18 story). Measure
  // the product GROUP's union box — a pair of cans side by side fills the
  // frame even when neither can alone clears the bar.
  if (tall && products.length > 0) {
    const hero = products.reduce((a, b) => (b.box.h > a.box.h ? b : a));
    const unionTop = Math.min(...products.map((p) => p.box.y));
    const unionBottom = Math.max(...products.map((p) => p.box.y + p.box.h));
    const groupH = unionBottom - unionTop;
    if (groupH < Math.round(H * 0.35)) {
      out.push({ code: 'hero_too_small', severity: 'fail', element: hero.id, detail: `product group is ${groupH}px tall (union), below 35% of the ${H}px canvas height on 9:16` });
    }
    const headlineEl = manifest.elements.find((e) => e.id === 'headline');
    if (headlineEl && headlineEl.box.h < Math.round(H * 0.04)) {
      out.push({ code: 'hero_too_small', severity: 'fail', element: 'headline', detail: `headline box ${headlineEl.box.h}px tall, below 4% of the ${H}px canvas height on 9:16` });
    }
  }

  // Legibility: rendered text must clear the floor for this canvas.
  const floor = minLegiblePx(Math.min(W, H));
  for (const [id, sizes] of Object.entries(renderedSizes)) {
    for (const s of sizes) {
      if (s < floor) {
        out.push({ code: 'text_size', severity: 'fail', element: id, detail: `${id} rendered at ${s}px, below the ${floor}px legible floor` });
      }
    }
  }

  // Empty band INSIDE the safe area: the platform safe zones (story top
  // 14% / bottom 20%) are empty by design and never counted. Any other
  // empty band over 20% of the canvas height means the ad shrank into
  // part of the canvas (every s18 story) — a fail, not a warning.
  {
    const rows = 80;
    const rowH = H / rows;
    const safeTopRow = Math.max(0, Math.floor(safe.y / rowH));
    const safeBotRow = Math.min(rows - 1, Math.floor((safe.y + safe.h) / rowH));
    const covered = new Array(rows).fill(false);
    for (const e of manifest.elements) {
      if (e.kind === 'frame' || e.kind === 'shadow') continue;
      const r1 = Math.max(0, Math.floor(e.box.y / rowH));
      const r2 = Math.min(rows - 1, Math.floor((e.box.y + e.box.h) / rowH));
      for (let r = r1; r <= r2; r++) covered[r] = true;
    }
    let gapStart = -1;
    for (let r = safeTopRow; r <= safeBotRow + 1; r++) {
      const isGap = r <= safeBotRow && !covered[r];
      if (isGap && gapStart < 0) gapStart = r;
      if (!isGap && gapStart >= 0) {
        const gapH = (r - gapStart) * rowH;
        // Tall canvases fail above 20% (a cramped story must not pass);
        // other families keep the older 25% warn / 35% fail bar.
        const failAt = tall ? H * 0.2 : H * 0.35;
        const warnAt = tall ? H * 0.2 : H * 0.25;
        if (gapH > warnAt) {
          out.push({ code: 'empty_band', severity: gapH > failAt ? 'fail' : 'warn', element: null, detail: `empty band ${Math.round((gapH / H) * 100)}% of canvas height inside the safe area (rows ${gapStart}-${r})` });
        }
        gapStart = -1;
      }
    }
  }

  // Coverage: every analyzed element must be placed (nothing vanishes silently).
  const ids = new Set(manifest.elements.map((e) => e.id));
  analysis.products.forEach((_, i) => {
    if (!ids.has(`product-${i}`)) out.push({ code: 'missing_element', severity: 'fail', element: `product-${i}`, detail: `product-${i} not placed` });
  });
  if (analysis.logo_bbox && !ids.has('logo')) {
    out.push({ code: 'missing_element', severity: 'fail', element: 'logo', detail: 'logo not placed' });
  }
  // The panel/CTA carries the offer: dropping it silently (a transparent
  // CTA with no pastable pixels, NORTHBEAN's vanished "Order now") must
  // fail the layout check, never ship as a clean-looking ad without it.
  if (analysis.panel && !ids.has('panel')) {
    out.push({ code: 'missing_element', severity: 'fail', element: 'panel', detail: 'panel (CTA) not placed' });
  }
  // Headline/subtext travel with pasted panel pixels when a panel exists, so
  // they are not required to have their own manifest elements.
  return out;
}

/** True when no failing (vs warning) findings remain. */
export function checksPass(findings: GeometryFinding[]): boolean {
  return !findings.some((f) => f.severity === 'fail');
}
