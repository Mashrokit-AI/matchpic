import { GENERAL_SCOPE, parseBrandColors, renderBrandPromptText, storedBrandPromptSchema, type BrandColor, type StoredBrandPrompt } from '../../shared/brand-prompt.js';
import { PRESETS } from '../../shared/presets.js';
import { Store, type BrandRow, type JobRow, type OutputRow, type TemplateRow } from '../store/db.js';

export interface TemplateDto {
  id: string;
  preset: string | null;
  image: string;
  /** Sized WebP derivative for grids (the full image stays internal). */
  thumb: string;
  status: string;
  error: string | null;
  spec: unknown;
  frame: string | null;
}

export interface BrandExampleDto {
  id: string;
  /** `general` or a preset id. */
  scope: string;
  image: string;
  thumb: string;
  status: string;
}

export interface BrandPromptDto extends StoredBrandPrompt {
  /** Readable text (generated render, or the user's edit when editedByUser). */
  readable: string;
}

export interface BrandDto {
  id: string;
  name: string;
  colors: BrandColor[];
  fonts: string[];
  logo: string | null;
  demo: boolean;
  templates: TemplateDto[];
  /** Style examples (same rows as templates, clean view: no zone specs). */
  examples: BrandExampleDto[];
  prompt: BrandPromptDto | null;
}

function templateDto(t: TemplateRow): TemplateDto {
  let spec: unknown = null;
  try {
    spec = t.spec_json ? JSON.parse(t.spec_json) : null;
  } catch {
    spec = null;
  }
  return {
    id: t.id,
    preset: t.preset,
    image: `media/template/${t.id}`,
    thumb: `media/examplethumb/${t.id}`,
    status: t.status,
    error: t.error,
    spec,
    frame: t.frame_path ? `media/frame/${t.id}` : null,
  };
}

function brandDto(b: BrandRow, templates: TemplateRow[]): BrandDto {
  let colors: BrandColor[] = [];
  let fonts: string[] = [];
  try {
    colors = parseBrandColors(JSON.parse(b.colors_json) as unknown);
    fonts = JSON.parse(b.fonts_json) as string[];
  } catch {
    // Corrupt rows render with empty lists, never crash the API.
  }
  let prompt: BrandPromptDto | null = null;
  if (b.prompt_json) {
    try {
      const parsed = storedBrandPromptSchema.parse(JSON.parse(b.prompt_json));
      prompt = { ...parsed, readable: b.prompt_text ?? renderBrandPromptText(parsed) };
    } catch {
      prompt = null;
    }
  }
  return {
    id: b.id,
    name: b.name,
    colors,
    fonts,
    logo: b.logo_path ? `media/logo/${b.id}` : null,
    demo: b.is_demo === 1,
    templates: templates.map(templateDto),
    examples: templates.map((t) => ({
      id: t.id,
      scope: t.preset ?? GENERAL_SCOPE,
      image: `media/template/${t.id}`,
      thumb: `media/examplethumb/${t.id}`,
      status: t.status,
    })),
    prompt,
  };
}

export function buildBrands(s: Store): { presets: typeof PRESETS; brands: BrandDto[] } {
  const brands = s.allBrands().map((b) => brandDto(b, s.templatesForBrand(b.id)));
  return { presets: PRESETS, brands };
}

export function buildBrand(s: Store, id: string): BrandDto | null {
  const b = s.getBrand(id);
  if (!b) return null;
  return brandDto(b, s.templatesForBrand(id));
}

export interface CardChecksDto {
  protected: 'pending' | 'passed' | 'fixed' | 'needs_review';
  text: 'pending' | 'passed' | 'fixed' | 'needs_review';
  layout: 'pending' | 'passed' | 'fixed' | 'needs_review';
  /** True when the review repaired this size ("Fixed by Wonder"). */
  repaired: boolean;
}

export interface OutputCardDto {
  id: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  mode: string;
  status: string;
  image: string;
  /** Sized WebP derivative for tiles, cards and the showcase. */
  thumb: string;
  qaPass: boolean | null;
  retries: number;
  proofDiff: number | null;
  /** The three status chips (legacy rows without checks_json get an honest mapping). */
  checks: CardChecksDto;
  /** Distinct model ids from the trace, in first-appearance order (no `model:` prefix). */
  models: string[];
  /** Sum of trace step durations in ms (the honest per-output cost). */
  traceMs: number;
}

export interface JobDto {
  id: string;
  brandId: string | null;
  mode: string;
  sizes: string[];
  sources: string[];
  status: string;
  error: string | null;
  modelCalls: number;
  imageCalls: number;
  createdAt: string;
  finishedAt: string | null;
  /** First streamed preview (ms after job creation; null while nothing landed). */
  firstPreviewMs: number | null;
  /** Whole run (ms, creation → finish; null while running). */
  totalMs: number | null;
  /** Distinct model ids across all output traces, first-appearance order. */
  models: string[];
  outputs: OutputCardDto[];
}

/** Distinct `model:*` ids + summed durations from decoded trace events. */
export function traceSummaryOf(events: Array<{ tool_or_model?: unknown; duration_ms?: unknown }>): { models: string[]; traceMs: number } {
  const models: string[] = [];
  let traceMs = 0;
  for (const e of events) {
    if (typeof e.duration_ms === 'number' && Number.isFinite(e.duration_ms)) traceMs += Math.max(0, e.duration_ms);
    if (typeof e.tool_or_model === 'string' && e.tool_or_model.startsWith('model:')) {
      const id = e.tool_or_model.slice('model:'.length);
      if (id && !models.includes(id)) models.push(id);
    }
  }
  return { models, traceMs: Math.round(traceMs) };
}

/** Distinct `model:*` ids + summed durations from a stored trace (never throws). */
export function traceSummary(traceJson: string | null): { models: string[]; traceMs: number } {
  if (!traceJson) return { models: [], traceMs: 0 };
  try {
    const events = JSON.parse(traceJson) as Array<{ tool_or_model?: unknown; duration_ms?: unknown }>;
    if (!Array.isArray(events)) return { models: [], traceMs: 0 };
    return traceSummaryOf(events);
  } catch {
    return { models: [], traceMs: 0 };
  }
}

function outputCard(o: OutputRow, sources: string[]): OutputCardDto {
  let qaPass: boolean | null = null;
  try {
    const qa = o.qa_json ? (JSON.parse(o.qa_json) as { pass?: boolean }) : null;
    qaPass = typeof qa?.pass === 'boolean' ? qa.pass : null;
  } catch {
    qaPass = null;
  }
  let proofDiff: number | null = null;
  try {
    const proof = o.proof_json ? (JSON.parse(o.proof_json) as Record<string, { core_differ?: number }>) : null;
    proofDiff = proof ? Object.values(proof).reduce((s, p) => s + (p.core_differ ?? 0), 0) : null;
  } catch {
    proofDiff = null;
  }
  const checks = cardChecks(o, qaPass);
  const { models, traceMs } = traceSummary(o.trace_json);
  return {
    id: o.id,
    sourceId: o.source_id,
    sourceIndex: Math.max(0, sources.indexOf(o.source_id)),
    preset: o.preset,
    mode: o.mode,
    status: o.status,
    image: `media/output/${o.id}`,
    thumb: `media/thumb/${o.id}`,
    qaPass,
    retries: o.retries,
    proofDiff,
    checks,
    models,
    traceMs,
  };
}

type CardStatus = CardChecksDto['protected'];

function asCardStatus(v: unknown, fallback: CardStatus): CardStatus {
  return v === 'passed' || v === 'fixed' || v === 'needs_review' || v === 'pending' ? v : fallback;
}

/** Card chips from checks_json, with an honest mapping for legacy rows. */
function cardChecks(o: OutputRow, qaPass: boolean | null): CardChecksDto {
  try {
    const c = o.checks_json ? (JSON.parse(o.checks_json) as { protected_pixels?: { status?: unknown }; text?: { status?: unknown }; layout_review?: { status?: unknown }; repaired?: unknown }) : null;
    if (c && (c.protected_pixels || c.text || c.layout_review)) {
      return {
        protected: asCardStatus(c.protected_pixels?.status, 'pending'),
        text: asCardStatus(c.text?.status, 'pending'),
        layout: asCardStatus(c.layout_review?.status, 'pending'),
        repaired: c.repaired !== null && c.repaired !== undefined,
      };
    }
  } catch {
    // Fall through to the legacy mapping.
  }
  const ok = qaPass === true;
  const pass: CardStatus = o.status === 'failed' ? 'needs_review' : ok ? 'passed' : 'needs_review';
  return {
    protected: o.mode === 'fast' ? 'pending' : pass,
    text: pass,
    layout: pass,
    repaired: o.retries > 0 && ok,
  };
}

function jobDto(j: JobRow, outputs: OutputRow[]): JobDto {
  let sizes: string[] = [];
  let sources: string[] = [];
  try {
    sizes = JSON.parse(j.sizes_json) as string[];
    sources = JSON.parse(j.sources_json) as string[];
  } catch {
    // Corrupt rows render with empty lists, never crash the API.
  }
  const cards = outputs.map((o) => outputCard(o, sources));
  const created = Date.parse(j.created_at);
  const landed = outputs.map((o) => Date.parse(o.created_at)).filter((t) => Number.isFinite(t));
  const finished = j.finished_at ? Date.parse(j.finished_at) : NaN;
  const models: string[] = [];
  for (const c of cards) {
    for (const m of c.models) {
      if (!models.includes(m)) models.push(m);
    }
  }
  return {
    id: j.id,
    brandId: j.brand_id,
    mode: j.mode,
    sizes,
    sources,
    status: j.status,
    error: j.error,
    modelCalls: j.model_calls,
    imageCalls: j.image_calls,
    createdAt: j.created_at,
    finishedAt: j.finished_at,
    firstPreviewMs: Number.isFinite(created) && landed.length > 0 ? Math.max(0, Math.min(...landed) - created) : null,
    totalMs: Number.isFinite(created) && Number.isFinite(finished) ? Math.max(0, finished - created) : null,
    models,
    outputs: cards,
  };
}

export interface ExampleDto {
  jobId: string;
  brandId: string | null;
  brandName: string | null;
  mode: string;
  lang: 'he' | 'en';
  nativePreset: string | null;
  sourceId: string;
  sourceImage: string;
  /** Sized WebP derivative for the strip and the showcase source tile. */
  sourceThumb: string;
  sourceWidth: number;
  sourceHeight: number;
  outputCount: number;
  finishedAt: string | null;
}

/** Saved-example strip: one row per demo job (no output pixels here). */
export function buildExamples(s: Store): ExampleDto[] {
  const out: ExampleDto[] = [];
  for (const j of s.demoJobs()) {
    let sources: string[] = [];
    try {
      sources = JSON.parse(j.sources_json) as string[];
    } catch {
      sources = [];
    }
    const sourceId = sources[0];
    if (!sourceId) continue;
    const source = s.getSource(sourceId);
    if (!source) continue;
    const brand = j.brand_id ? s.getBrand(j.brand_id) : null;
    out.push({
      jobId: j.id,
      brandId: j.brand_id,
      brandName: brand?.name ?? null,
      mode: j.mode,
      lang: j.lang === 'he' ? 'he' : 'en',
      nativePreset: j.native_preset,
      sourceId,
      sourceImage: `media/source/${sourceId}`,
      sourceThumb: `media/sourcethumb/${sourceId}`,
      sourceWidth: source.width,
      sourceHeight: source.height,
      outputCount: s.outputsForJob(j.id).length,
      finishedAt: j.finished_at,
    });
  }
  return out;
}

export function buildJob(s: Store, id: string): JobDto | null {
  const j = s.getJob(id);
  if (!j) return null;
  return jobDto(j, s.outputsForJob(id));
}

export interface OutputDetailDto extends Omit<OutputCardDto, 'checks'> {
  jobId: string;
  plan: unknown;
  manifest: unknown;
  proof: unknown;
  qa: unknown;
  /** Three independent statuses (protected pixels / text / layout review). */
  checks: unknown;
  /** Before-repair image (repaired sizes only). */
  beforeImage: string | null;
  trace: unknown[];
  error: string | null;
  latencyMs: number;
  sourceImage: string;
  /** Sized WebP derivative for the rail mini (crops keep the full source). */
  sourceThumb: string;
  sourceWidth: number;
  sourceHeight: number;
  templateImage: string | null;
  masks: string[];
}

export function buildOutput(s: Store, id: number): OutputDetailDto | null {
  const o = s.getOutput(id);
  if (!o) return null;
  const job = s.getJob(o.job_id);
  let sources: string[] = [];
  try {
    sources = job ? (JSON.parse(job.sources_json) as string[]) : [];
  } catch {
    sources = [];
  }
  const parse = (v: string | null): unknown => {
    if (!v) return null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  const plan = parse(o.plan_json) as { template_id?: string; manifest?: unknown } | null;
  const checks = parse(o.checks_json) as { repaired?: { before?: string } | null } | null;
  const source = s.getSource(o.source_id);
  let masks: string[] = [];
  try {
    const map = source?.masks_json ? (JSON.parse(source.masks_json) as Record<string, string>) : {};
    masks = Object.keys(map);
  } catch {
    masks = [];
  }
  const templateImage = plan?.template_id ? `media/template/${plan.template_id}` : null;
  const beforeImage = typeof checks?.repaired?.before === 'string' && checks.repaired.before.length > 0
    ? `media/before/${o.id}`
    : null;
  return {
    ...outputCard(o, sources),
    jobId: o.job_id,
    plan,
    manifest: plan?.manifest ?? null,
    proof: parse(o.proof_json),
    qa: parse(o.qa_json),
    checks,
    beforeImage,
    trace: (parse(o.trace_json) as unknown[]) ?? [],
    error: o.error,
    latencyMs: o.latency_ms,
    sourceImage: `media/source/${o.source_id}`,
    sourceThumb: `media/sourcethumb/${o.source_id}`,
    sourceWidth: source?.width ?? 0,
    sourceHeight: source?.height ?? 0,
    templateImage,
    masks,
  };
}
