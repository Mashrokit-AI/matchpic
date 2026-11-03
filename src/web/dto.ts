export interface PresetDto {
  id: string;
  label: string;
  width: number;
  height: number;
  safe: { top: number; bottom: number; left: number; right: number };
  meta: boolean;
}

export interface TemplateDto {
  id: string;
  preset: string | null;
  image: string;
  thumb: string;
  status: string;
  error: string | null;
  spec: TemplateSpecDto | null;
  frame: string | null;
}

export interface NormBoxDto {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TemplateSpecDto {
  logo: { box: NormBoxDto; corner: string } | null;
  headline_zone: NormBoxDto | null;
  subtext_zone: NormBoxDto | null;
  panel_zone: { box: NormBoxDto; color: string; shape: string } | null;
  product_zone: NormBoxDto | null;
  frames: Array<{ box: NormBoxDto; color: string; edge: string; kind: string }>;
  background_style: string;
  text_align: string;
  direction: string;
}

export interface BrandColorDto {
  hex: string;
  role: string;
}

export interface BrandExampleDto {
  id: string;
  scope: string;
  image: string;
  thumb: string;
  status: string;
}

export interface BrandPromptDto {
  version: number;
  generatedBy: string;
  generatedAt: string;
  editedByUser: boolean;
  general: string[];
  perPreset: Record<string, string[]>;
  never: string[];
  proportions: Array<{ element: string; dimension: string; pct: number }>;
  text: string[];
  colors: string[];
  fonts: string[];
  /** Readable text (the user's edit when editedByUser). */
  readable: string;
}

export interface BrandDto {
  id: string;
  name: string;
  colors: BrandColorDto[];
  fonts: string[];
  logo: string | null;
  demo: boolean;
  templates: TemplateDto[];
  examples: BrandExampleDto[];
  prompt: BrandPromptDto | null;
}

export interface CardChecksDto {
  protected: 'pending' | 'passed' | 'fixed' | 'needs_review';
  text: 'pending' | 'passed' | 'fixed' | 'needs_review';
  layout: 'pending' | 'passed' | 'fixed' | 'needs_review';
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
  thumb: string;
  qaPass: boolean | null;
  retries: number;
  proofDiff: number | null;
  checks: CardChecksDto;
  models: string[];
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
  firstPreviewMs: number | null;
  totalMs: number | null;
  models: string[];
  outputs: OutputCardDto[];
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
  sourceThumb: string;
  sourceWidth: number;
  sourceHeight: number;
  outputCount: number;
  finishedAt: string | null;
}

export interface DetectedTextsDto {
  width: number;
  height: number;
  language: string;
  texts: {
    headline: string | null;
    subtext: string | null;
    panel: string[];
    others: string[];
  };
}

/** One streamed SSE row (mirrors the server JobRow). */
export interface JobRow {
  outputId: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  status: 'pass' | 'needs_review' | 'failed';
  retries: number;
  models: string[];
  traceMs: number;
  pending?: boolean;
  error?: string;
  checks?: CardChecksDto | null;
}

export interface TraceEventDto {
  seq: number;
  step: string;
  tool_or_model: string;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
  evidence_ids: string[];
  next_state: string;
  cached: boolean;
}

export interface ManifestElementDto {
  id: string;
  kind: string;
  box: { x: number; y: number; w: number; h: number };
  group: string | null;
  z: number;
  align: string | null;
  scale: number | null;
  source: string;
  srcBox?: { x: number; y: number; w: number; h: number } | null;
}

export interface ManifestDto {
  preset: string;
  width: number;
  height: number;
  family: string;
  planner: string;
  safe: { x: number; y: number; w: number; h: number };
  elements: ManifestElementDto[];
  templateZones: Record<string, { x: number; y: number; w: number; h: number }> | null;
  corrections: string[];
  rationale: string | null;
}

export interface CheckEntryDto {
  status: 'pending' | 'passed' | 'fixed' | 'needs_review';
  detail: string;
}

export interface ChecksDto {
  protected_pixels: CheckEntryDto;
  text: CheckEntryDto;
  layout_review: CheckEntryDto;
  repaired: { before: string; patches: string[] } | null;
}

export interface OutputDetailDto extends Omit<OutputCardDto, 'checks'> {
  jobId: string;
  plan: {
    preset: string;
    width: number;
    height: number;
    from_template: boolean;
    template_id: string | null;
    safe: { x: number; y: number; w: number; h: number };
    logo: { x: number; y: number; w: number; h: number } | null;
    products: Array<{ x: number; y: number; w: number; h: number }>;
    headline: { x: number; y: number; w: number; h: number } | null;
    subtext: { x: number; y: number; w: number; h: number } | null;
    panel: { x: number; y: number; w: number; h: number } | null;
    other_texts: Array<{ x: number; y: number; w: number; h: number }>;
    product_scales: number[];
    logo_scale: number | null;
    notes: string[];
  } | null;
  manifest: ManifestDto | null;
  checks: ChecksDto | null;
  beforeImage: string | null;
  proof: Record<string, { scale: number; core_differ: number; core_total: number; feather_total: number; coverage?: number; pass: boolean }> | null;
  qa: {
    pass: boolean;
    reasons: string[];
    texts_read: Array<{ expected: string; found: string; exact: boolean }>;
    logo_ok: boolean;
    product_ok: boolean;
    safe_area_ok: boolean;
    invented_text: string[];
  } | null;
  trace: TraceEventDto[];
  error: string | null;
  latencyMs: number;
  sourceImage: string;
  sourceThumb: string;
  sourceWidth: number;
  sourceHeight: number;
  templateImage: string | null;
  masks: string[];
}
