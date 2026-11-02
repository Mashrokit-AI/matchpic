import { z } from 'zod';
import { PRESETS, presetById } from './presets.js';

/**
 * Style examples + the automatic brand prompt.
 *
 * A style example is one finished ad uploaded for a brand, with a scope:
 * `general` (rules for every size) or one placement preset id (rules for
 * that size only). In the store, examples reuse the template rows: scope
 * `general` is preset NULL, a per-size scope is that preset. Zone specs may
 * still be derived for per-size examples (the engine binds to them), but the
 * UI never draws boxes — it shows clean thumbnails with a scope chip.
 *
 * The brand prompt is structured JSON plus its readable text: `general`
 * rules for every size, `perPreset` rules for one size, a `never` never-add
 * list, fixed-size proportions, and text conventions. The engine sends
 * `general` + `never` to every size's call and `perPreset[size]` only to
 * that size's call. A user edit of the readable text wins over the
 * generated JSON until the next regenerate.
 */

export const GENERAL_SCOPE = 'general';

/** True for the `general` scope (rules for every size). */
export function isGeneralScope(scope: string): boolean {
  return scope === GENERAL_SCOPE;
}

/** Preset id for a per-size scope, or null for `general`/unknown. */
export function scopePreset(scope: string): string | null {
  if (isGeneralScope(scope)) return null;
  return presetById(scope)?.id ?? null;
}

/**
 * Guess an example's scope from its aspect ratio: the nearest preset within
 * 3% relative aspect distance, else `general` (the user can change it).
 */
export function guessScopeFromAspect(width: number, height: number): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return GENERAL_SCOPE;
  const aspect = width / height;
  let best: string | null = null;
  let bestDist = 0.03;
  for (const p of PRESETS) {
    const dist = Math.abs(p.width / p.height - aspect) / aspect;
    if (dist < bestDist) {
      bestDist = dist;
      best = p.id;
    }
  }
  return best ?? GENERAL_SCOPE;
}

// --- structured brand colours ---

export const BRAND_COLOR_ROLES = ['primary', 'secondary', 'accent', 'text', 'background'] as const;
export type BrandColorRole = (typeof BRAND_COLOR_ROLES)[number];

export const brandColorSchema = z.object({
  hex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  role: z.enum(BRAND_COLOR_ROLES),
});
export type BrandColor = z.infer<typeof brandColorSchema>;

/** Positional roles for legacy plain-hex colour lists. */
const LEGACY_ROLE_ORDER: BrandColorRole[] = ['primary', 'secondary', 'accent', 'background', 'text'];

/**
 * Parse stored brand colours, tolerating the legacy `string[]` shape
 * (positional roles) and dropping anything that is not a valid hex.
 */
export function parseBrandColors(value: unknown): BrandColor[] {
  if (!Array.isArray(value)) return [];
  const out: BrandColor[] = [];
  value.forEach((entry, i) => {
    if (typeof entry === 'string' && /^#[0-9a-fA-F]{6}$/.test(entry)) {
      out.push({ hex: entry, role: LEGACY_ROLE_ORDER[Math.min(i, LEGACY_ROLE_ORDER.length - 1)] as BrandColorRole });
      return;
    }
    const parsed = brandColorSchema.safeParse(entry);
    if (parsed.success) out.push(parsed.data);
  });
  return out.slice(0, 8);
}

// --- brand prompt (structured JSON + readable text) ---

const bullet = z.string().trim().min(1).max(500);

/** A bullet list that also accepts one bare string (models flub this). */
const bulletList = (min: number, max: number): z.ZodType<string[]> =>
  z.preprocess((v) => (typeof v === 'string' ? [v] : v), z.array(bullet).min(min).max(max)) as unknown as z.ZodType<string[]>;

/** Parse the "logo ≈ 18% of the canvas width" string form into a proportion (null when unparseable). */
function parseProportionString(v: string): { element: string; dimension: 'width' | 'height'; pct: number } | null {
  const m = v.match(/(.+?)\s*[≈~]\s*(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+canvas\s+)?)?(width|height)/i);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  const dimension = m[3].toLowerCase() === 'height' ? 'height' : 'width';
  return { element: m[1].trim().slice(0, 60), dimension, pct: Number(m[2]) };
}

export const brandProportionSchema = z.object({
  /** Fixed-size element, e.g. "logo", "bottom band". */
  element: z.string().trim().min(1).max(60),
  /** Which canvas dimension the percent refers to. */
  dimension: z.enum(['width', 'height']),
  /** Percent of the canvas dimension (1–95). */
  pct: z.number().min(1).max(95),
});
export type BrandProportion = z.infer<typeof brandProportionSchema>;

/** What the model returns (code adds version/attribution/echoed fields). */
export const brandPromptContentSchema = z.object({
  /** Rules for every size (conditional on what's visible in the source). */
  general: bulletList(1, 12),
  /** Rules for one size only: preset id → LIST of rules. */
  perPreset: z.record(z.string(), bulletList(1, 8)),
  /** Never-add list: things the model must not invent. */
  never: bulletList(1, 12),
  /** Fixed-size elements as % of the canvas (logo, bands, tabs). */
  proportions: z.preprocess((v) => {
    const arr = v === undefined || v === null ? [] : v;
    if (!Array.isArray(arr)) return arr;
    return arr
      .map((item) => (typeof item === 'string' ? parseProportionString(item) : item))
      .filter((x) => x !== null && x !== undefined);
  }, z.array(brandProportionSchema).max(12)),
  /** Hebrew/English text conventions when visible in the examples. */
  text: z.preprocess((v) => (typeof v === 'string' ? [v] : (v ?? [])), z.array(bullet).max(6)),
});
export type BrandPromptContent = z.infer<typeof brandPromptContentSchema>;

export const storedBrandPromptSchema = brandPromptContentSchema.extend({
  version: z.number().int().min(1),
  /** Model id that generated this version, e.g. "muse-wonder-1.0". */
  generatedBy: z.string().min(1),
  generatedAt: z.string().min(1),
  /** True once the user edited the readable text (their text wins). */
  editedByUser: z.boolean(),
  /** Brand colours echoed at generation time. */
  colors: z.array(z.string()).default([]),
  fonts: z.array(z.string()).default([]),
});
export type StoredBrandPrompt = z.infer<typeof storedBrandPromptSchema>;

/**
 * Validate generated content beyond the schema: per-preset keys must be
 * real presets that have examples, proportions must be sane percents.
 * Returns error strings (empty = valid).
 */
export function validateBrandPromptContent(content: BrandPromptContent, presetsWithExamples: Set<string>): string[] {
  const errors: string[] = [];
  if (content.general.length === 0) errors.push('general rules are empty');
  if (content.never.length === 0) errors.push('never-add list is empty');
  for (const key of Object.keys(content.perPreset)) {
    if (!presetById(key)) errors.push(`unknown preset in perPreset: ${key}`);
    else if (!presetsWithExamples.has(key)) errors.push(`perPreset rule for a size with no examples: ${key}`);
  }
  for (const p of content.proportions) {
    if (!Number.isFinite(p.pct) || p.pct < 1 || p.pct > 95) errors.push(`proportion out of range: ${p.element} ${p.pct}%`);
  }
  return errors;
}

/** Readable text for the UI: short bullets grouped General / per size / Never. */
export function renderBrandPromptText(p: StoredBrandPrompt | BrandPromptContent): string {
  const lines: string[] = ['General:'];
  for (const b of p.general) lines.push(`- ${b}`);
  if (p.proportions.length > 0) {
    lines.push('Fixed sizes:');
    for (const pr of p.proportions) lines.push(`- ${pr.element} ≈ ${pr.pct}% of the canvas ${pr.dimension}`);
  }
  const keys = Object.keys(p.perPreset).sort();
  for (const key of keys) {
    const label = presetById(key)?.label ?? key;
    lines.push(`${label}:`);
    for (const b of p.perPreset[key] ?? []) lines.push(`- ${b}`);
  }
  if (p.text.length > 0) {
    lines.push('Text:');
    for (const b of p.text) lines.push(`- ${b}`);
  }
  lines.push('Never:');
  for (const b of p.never) lines.push(`- ${b}`);
  return lines.join('\n');
}

/** Parse a stored brand prompt row (null when missing/corrupt — never throws). */
export function parseStoredBrandPrompt(promptJson: string | null, promptText: string | null): { prompt: StoredBrandPrompt; text: string } | null {
  if (!promptJson) return null;
  try {
    const prompt = storedBrandPromptSchema.parse(JSON.parse(promptJson));
    return { prompt, text: promptText ?? renderBrandPromptText(prompt) };
  } catch {
    return null;
  }
}

/** What the engine sends for one size (a user edit wins over generated JSON). */
export interface BrandPromptUse {
  version: number;
  block: string;
}

/** Resolve the engine block for ONE size from a stored prompt. */
export function brandPromptUseForSize(stored: { prompt: StoredBrandPrompt; text: string }, presetId: string): BrandPromptUse {
  if (stored.prompt.editedByUser) return { version: stored.prompt.version, block: stored.text };
  return { version: stored.prompt.version, block: brandPromptBlockForSize(stored.prompt, presetId) };
}

/**
 * Plan-call lines for the Wonder art director: the general rules once, then
 * each size's own extra rules (a brand with no per-size example for a size
 * runs that size from the general rules). A user edit goes out verbatim.
 */
export function formatBrandPromptForPlan(stored: { prompt: StoredBrandPrompt; text: string }, presetIds: string[]): string[] {
  const p = stored.prompt;
  if (p.editedByUser) {
    return [`BRAND STYLE RULES (v${p.version}, written by the user — binding for every size below):`, stored.text];
  }
  const lines = [
    `BRAND STYLE RULES (v${p.version}, binding — conditional on what is visible in the source):`,
    ...p.general.map((b) => `- ${b}`),
    ...p.proportions.map((pr) => `- ${pr.element} ≈ ${pr.pct}% of the canvas ${pr.dimension} (fixed — give extra room to the photo/background)`),
    ...p.text.map((b) => `- ${b}`),
    'Never add:',
    ...p.never.map((b) => `- ${b}`),
  ];
  for (const id of presetIds) {
    const extra = p.perPreset[id] ?? [];
    lines.push(extra.length > 0
      ? `BRAND RULES FOR ${id} (this size only): ${extra.map((b) => `- ${b}`).join(' ')}`
      : `BRAND RULES FOR ${id}: none for this size — follow the general rules.`);
  }
  return lines;
}

/** Trace tag recording which brand-prompt version a size used. */
export function brandPromptTraceTag(use: BrandPromptUse | null | undefined): string {
  return use ? ` brand-prompt=v${use.version}` : '';
}

/** Engine block for ONE size: general + fixed sizes + perPreset[size] + text + never. */
export function brandPromptBlockForSize(p: StoredBrandPrompt | BrandPromptContent, presetId: string): string {
  const lines: string[] = [];
  for (const b of p.general) lines.push(`- ${b}`);
  for (const pr of p.proportions) lines.push(`- ${pr.element} ≈ ${pr.pct}% of the canvas ${pr.dimension} (fixed — give extra room to the photo/background)`);
  for (const b of p.perPreset[presetId] ?? []) lines.push(`- ${b}`);
  for (const b of p.text) lines.push(`- ${b}`);
  lines.push('Never add:');
  for (const b of p.never) lines.push(`- ${b}`);
  return lines.join('\n');
}
