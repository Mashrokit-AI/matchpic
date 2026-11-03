import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type OpenAI from 'openai';
import sharp from 'sharp';
import { z } from 'zod';
import { BRAND_SLUG } from '../../shared/brand.js';
import {
  GENERAL_SCOPE, brandPromptUseForSize, guessScopeFromAspect, isGeneralScope, parseBrandColors,
  parseStoredBrandPrompt, renderBrandPromptText, storedBrandPromptSchema, validateBrandPromptContent,
} from '../../shared/brand-prompt.js';
import { loadModelConfig } from '../../shared/config.js';
import { PRESETS, presetById } from '../../shared/presets.js';
import { templateSpecSchema } from '../../shared/schemas.js';
import { DEMO_JOB_ID, DEMO_JOB_ORDER } from '../adfit/seed.js';
import { prepareSource, runAnalysisStage, runOutput, runPool, type FitMode, type OutputTemplate, type PreparedSource } from '../adfit/pipeline.js';
import { rowStatusFromChecks, runBatchSource, type TextOverrides } from '../adfit/batch.js';
import { CostLedger } from '../models/costs.js';
import { matchBrand } from '../models/brand-match.js';
import { generateBrandPrompt, type BrandPromptExample } from '../models/brand-prompt.js';
import { createModelClient } from '../models/client.js';
import { readTemplate, specBoxesNormalized } from '../models/template-read.js';
import type { ImageGenConfig } from '../models/muse-image.js';
import { segmentTargets } from '../repair/masks.js';
import { Store } from '../store/db.js';
import { TraceCollector } from '../workflow/trace.js';
import { loadHttpConfig, type HttpConfig } from './config.js';
import { buildBrand, buildBrands, buildExamples, buildJob, buildOutput, traceSummaryOf } from './dto.js';
import { JobManager, RateLimiter, sseResponse, type JobRow } from './jobs.js';
import { MEDIA_KINDS, invalidateThumb, readContainedFile, resolveMask, resolveMedia, type MediaKind } from './media.js';
import { UploadError, validateAndStoreUpload, validateImageBytes } from './uploads.js';
import { buildZip, sha256Hex } from './zip.js';

/**
 * Public read-only web app + bounded live jobs. MatchPic never publishes
 * anything: there is no write path to any external ad platform in this
 * module or its imports.
 */

export interface AppDeps {
  repoRoot: string;
  dbPath?: string;
  webRoot?: string;
  http?: Partial<HttpConfig>;
  makeClient?: () => OpenAI;
  makeImageConfig?: () => ImageGenConfig;
  extractModel?: string;
  samModel?: string;
  wonderModel?: string;
}

const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

function securityHeaders(c: Context): void {
  c.header('content-security-policy', CSP);
  c.header('x-content-type-options', 'nosniff');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-frame-options', 'DENY');
}

function err(c: Context, status: 400 | 404 | 413 | 429 | 503 | 500, key: string) {
  return c.json({ error: key }, status);
}

function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) return xff.split(',')[0]?.trim().slice(0, 100) || 'unknown';
  }
  const incoming = (c.env as Record<string, unknown> | undefined)?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  return incoming?.socket?.remoteAddress ?? 'unknown';
}

function utcMidnightIso(now: Date = new Date()): string {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

async function sendFile(c: Context, abs: string, contentType: string, cache: string) {
  try {
    const bytes = await readFile(abs);
    c.header('content-type', contentType);
    c.header('content-length', String(bytes.length));
    c.header('cache-control', cache);
    return c.body(bytes);
  } catch {
    return err(c, 404, 'err_not_found');
  }
}

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const brandColorInput = z.union([hexColor, z.object({ hex: hexColor, role: z.enum(['primary', 'secondary', 'accent', 'text', 'background']) }).strict()]);

const brandBodySchema = z.object({ name: z.string().trim().min(1).max(60), colors: z.array(brandColorInput).max(8).default([]), fonts: z.array(z.string().trim().min(1).max(60)).max(8).default([]) }).strict();

const templatePatchSchema = z.object({ preset: z.string().max(40).nullable().optional(), spec: z.unknown().optional() }).strict();

const DEMO_SOURCES: Record<string, string> = {
  'gali-he': 'fixtures/brands/gali/source-he.png',
  'gali-en': 'fixtures/brands/gali/source-en.png',
  noa: 'fixtures/brands/noa/source.png',
};

const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const dayFromNow = (): string => new Date(Date.now() + 24 * 3600 * 1000).toISOString();

interface UploadedFile {
  arrayBuffer: () => Promise<ArrayBuffer>;
  size?: number;
}

function isFile(v: unknown): v is UploadedFile {
  return !!v && typeof (v as UploadedFile).arrayBuffer === 'function';
}

function collectFiles(body: Record<string, unknown>): UploadedFile[] {
  const out: UploadedFile[] = [];
  for (const v of Object.values(body)) {
    if (isFile(v)) out.push(v);
    else if (Array.isArray(v)) for (const e of v) if (isFile(e)) out.push(e);
  }
  return out;
}

/**
 * Parse the setup flow's confirmed-text field: per-source-index overrides
 * (`{"0": {"headline": "...", ...}}`) or one object for the first source.
 * Strings only (≤300 chars); anything else is dropped, never trusted.
 */
function parseTextsField(raw: unknown): Record<number, TextOverrides> {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 20000) return {};
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {};
  }
  const one = (v: unknown): TextOverrides | null => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const out: TextOverrides = {};
    const str = (x: unknown): string | null => (typeof x === 'string' && x.trim().length > 0 ? x.slice(0, 300) : null);
    const arr = (x: unknown): string[] | null =>
      Array.isArray(x) ? x.filter((e): e is string => typeof e === 'string').map((e) => e.slice(0, 300)).slice(0, 8) : null;
    const h = str(o['headline']);
    const s = str(o['subtext']);
    const p = arr(o['panel']);
    const t = arr(o['others']);
    if (h) out.headline = h;
    if (s) out.subtext = s;
    if (p && p.length > 0) out.panel = p;
    if (t && t.length > 0) out.others = t;
    return Object.keys(out).length > 0 ? out : null;
  };
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    const keys = Object.keys(json);
    if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
      const out: Record<number, TextOverrides> = {};
      for (const k of keys) {
        const parsed = one((json as Record<string, unknown>)[k]);
        if (parsed) out[Number(k)] = parsed;
      }
      return out;
    }
    const single = one(json);
    return single ? { 0: single } : {};
  }
  return {};
}

export function createApp(deps: AppDeps): Hono {
  const repoRoot = deps.repoRoot;
  const cfg: HttpConfig = { ...loadHttpConfig(process.env), ...deps.http };
  const dbPath = deps.dbPath ?? join(repoRoot, 'data', 'adfit.db');
  const webRoot = deps.webRoot ?? join(repoRoot, 'dist', 'web');
  const makeClient = deps.makeClient ?? (() => createModelClient(loadModelConfig(process.env)));
  const makeImageConfig =
    deps.makeImageConfig ??
    (() => {
      const m = loadModelConfig(process.env);
      return { baseUrl: m.MODEL_API_BASE, apiKey: m.MODEL_API_KEY, model: m.MODEL_IMAGE };
    });
  const extractModel = deps.extractModel ?? 'muse-spark-1.3';
  const samModel = deps.samModel ?? 'sam-3.1';
  const wonderModel = deps.wonderModel ?? 'muse-wonder-1.0';

  const jobs = new JobManager({ queueMax: cfg.queueMax, jobTimeoutMs: cfg.jobTimeoutMs });
  const limiter = new RateLimiter(cfg.ratePerHour);
  // Bug 2: a previous process may have died mid-run. Those DB rows can never
  // resume (the in-memory task is gone), so fail them instead of hanging.
  try {
    const store = Store.open(dbPath);
    try { store.failStaleRunningJobs('err_job_interrupted'); } finally { store.close(); }
  } catch { /* DB not ready yet; routes surface the error */ }

  // One shared connection per app: opening + schema + migrations on every
  // call made 2s polling needlessly expensive. better-sqlite3 is synchronous
  // and this process is single-threaded, so sharing is safe.
  let sharedStore: Store | null = null;
  const withStore = <T>(fn: (s: Store) => T): T => {
    sharedStore ??= Store.open(dbPath);
    return fn(sharedStore);
  };

  const cardChecks = (checks: { protected_pixels: { status: string }; text: { status: string }; layout_review: { status: string }; repaired: unknown }): JobRow['checks'] => ({
    protected: checks.protected_pixels.status, text: checks.text.status, layout: checks.layout_review.status,
    repaired: checks.repaired !== null && checks.repaired !== undefined,
  });

  const capped = (kind: 'model' | 'image'): boolean => {
    const limit = kind === 'model' ? cfg.dailyModelCalls : cfg.dailyImages;
    return withStore((s) => s.countUsageSince(utcMidnightIso(), kind)) >= limit;
  };

  /** Spend caps from the USD ledger. Total over cap blocks new live jobs (busy); Wonder over cap only disables Wonder. */
  const spendCaps = (): { wonderOver: boolean; allOver: boolean } => {
    const spend = withStore((s) => s.spendSince(utcMidnightIso()));
    return { wonderOver: spend.wonderUsd >= cfg.wonderDailyUsd, allOver: spend.totalUsd >= cfg.dailyUsd };
  };

  /** Best-effort unlink of repo-local data files (never fixtures). */
  const unlinkData = async (rels: Array<string | null>): Promise<void> => {
    for (const rel of rels) {
      if (!rel || (!rel.startsWith('data/') && !rel.startsWith('artifacts/'))) continue;
      await rm(join(repoRoot, rel), { force: true, recursive: true }).catch(() => undefined);
    }
  };

  // Background template parse: Spark layout spec + SAM logo mask (by convention
  // data/.../mask-logo.png next to the template image). Never throws.
  const parseTemplate = (templateId: string): void => {
    void (async () => {
      try {
        const row = withStore((s) => s.getTemplate(templateId));
        if (!row) return;
        const bytes = await readContainedFile(repoRoot, row.image_path);
        if (!bytes) {
          withStore((s) => s.setTemplateFailed(templateId, 'template image missing'));
          return;
        }
        const meta = await sharp(bytes).metadata();
        const client = makeClient();
        const res = await readTemplate(client, {
          imageBytes: bytes,
          mimeType: 'image/png',
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          model: extractModel,
        });
        withStore((s) => {
          s.setTemplateReady(templateId, JSON.stringify(res.spec));
          s.recordUsage('model', res.attempts.length);
        });
        if (res.spec.logo) {
          const seg = await segmentTargets(client, {
            imageBytes: bytes,
            mimeType: 'image/png',
            width: meta.width ?? 0,
            height: meta.height ?? 0,
            model: samModel,
            targets: [{ id: 'logo', phrase: 'logo', box: null }],
          });
          withStore((s) => s.recordUsage('model', seg.calls));
          const mask = seg.masks.get('logo');
          if (mask && row.image_path.startsWith('data/')) {
            const px = Buffer.alloc(mask.length);
            for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
            const dir = join(repoRoot, dirname(row.image_path));
            await mkdir(dir, { recursive: true });
            await sharp(px, { raw: { width: meta.width ?? 0, height: meta.height ?? 0, channels: 1 } })
              .png()
              .toFile(join(dir, 'mask-logo.png'));
          }
        }
      } catch (e) {
        withStore((s) => s.setTemplateFailed(templateId, `parse failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300)));
      }
    })();
  };

  // Brand-prompt generations in flight (the ready state lives in the DB row).
  const promptRuns = new Map<string, { status: 'generating' | 'failed' | 'capped'; error: string | null; at: string }>();

  /** Background Wonder call: examples + logo + colours in, rules out. Never throws. */
  const runBrandPromptGeneration = (brandId: string): void => {
    promptRuns.set(brandId, { status: 'generating', error: null, at: new Date().toISOString() });
    void (async () => {
      const fail = (error: string, status: 'failed' | 'capped' = 'failed'): void => {
        promptRuns.set(brandId, { status, error: error.slice(0, 300), at: new Date().toISOString() });
      };
      try {
        const brand = withStore((s) => s.getBrand(brandId));
        if (!brand || brand.is_demo === 1) {
          fail('brand not found');
          return;
        }
        const rows = withStore((s) => s.templatesForBrand(brandId));
        if (rows.length === 0) {
          fail('no style examples');
          return;
        }
        const examples: BrandPromptExample[] = [];
        for (const row of rows) {
          const bytes = await readContainedFile(repoRoot, row.image_path);
          if (!bytes) continue;
          let width = 0;
          let height = 0;
          try {
            const meta = await sharp(bytes).metadata();
            width = meta.width ?? 0;
            height = meta.height ?? 0;
          } catch {
            continue;
          }
          examples.push({ imageBytes: bytes, mimeType: 'image/png', scope: row.preset ?? GENERAL_SCOPE, width, height });
        }
        if (examples.length === 0) {
          fail('style example images are missing');
          return;
        }
        let colors: string[] = [];
        let fonts: string[] = [];
        try {
          colors = parseBrandColors(JSON.parse(brand.colors_json) as unknown).map((c) => c.hex);
          fonts = JSON.parse(brand.fonts_json) as string[];
        } catch {
          // Brand basics stay best-effort context, never a failure.
        }
        const logoBytes = brand.logo_path ? await readContainedFile(repoRoot, brand.logo_path) : null;
        const ledger = new CostLedger(Number.POSITIVE_INFINITY);
        const res = await generateBrandPrompt(makeClient(), {
          model: wonderModel,
          brandName: brand.name,
          colors,
          fonts,
          logo: logoBytes ? { imageBytes: logoBytes, mimeType: 'image/png' } : null,
          examples,
          ledger,
        });
        withStore((s) => s.recordUsage('model', res.attempts.length));
        for (const entry of ledger.all()) {
          withStore((st) => st.recordSpend({ model: entry.model, modelId: entry.modelId, costUsd: entry.costUsd, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, images: entry.images }));
        }
        if (!res.ok || !res.content) {
          fail(res.reason);
          return;
        }
        const withExamples = new Set(examples.map((e) => e.scope).filter((s) => s !== GENERAL_SCOPE));
        const errors = validateBrandPromptContent(res.content, withExamples);
        if (errors.length > 0) {
          fail(`invalid brand prompt: ${errors.join('; ')}`);
          return;
        }
        let version = 1;
        try {
          const prev = brand.prompt_json ? storedBrandPromptSchema.parse(JSON.parse(brand.prompt_json)) : null;
          if (prev) version = prev.version + 1;
        } catch {
          version = 1;
        }
        const stored = {
          ...res.content,
          version,
          generatedBy: wonderModel,
          generatedAt: new Date().toISOString(),
          editedByUser: false,
          colors,
          fonts,
        };
        withStore((s) => s.setBrandPrompt(brandId, JSON.stringify(stored), renderBrandPromptText(stored)));
        promptRuns.delete(brandId);
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    })();
  };

  interface CellDef {
    source: PreparedSource;
    sourceIndex: number;
    presetId: string;
  }

  /** Resolve template + frame per size once (shared by fast and protected paths). */
  const resolvePerSize = async (
    brandId: string | null,
    presetIds: string[],
  ): Promise<Map<string, { template: OutputTemplate | null; framePng: Buffer | null }>> => {
    const perSize = new Map<string, { template: OutputTemplate | null; framePng: Buffer | null }>();
    for (const presetId of presetIds) {
      if (perSize.has(presetId)) continue;
      let template: OutputTemplate | null = null;
      let framePng: Buffer | null = null;
      if (brandId) {
        const row = withStore((s) => s.templateForSize(brandId, presetId));
        if (row?.spec_json) {
          try {
            const spec = templateSpecSchema.parse(JSON.parse(row.spec_json));
            const bytes = await readContainedFile(repoRoot, row.image_path);
            if (bytes) template = { id: row.id, spec, imageBytes: bytes, mimeType: 'image/png' };
            if (row.frame_path) framePng = await readContainedFile(repoRoot, row.frame_path);
          } catch {
            // A corrupt template row never fails the job; the plan falls back to defaults.
          }
        }
      }
      perSize.set(presetId, { template, framePng });
    }
    return perSize;
  };

  /** Persist full-frame masks for the overlay UI + source analysis row. */
  const persistSourceLayers = async (rawId: string, p: PreparedSource): Promise<void> => {
    const maskMap: Record<string, string> = {};
    if (p.masks.size > 0) {
      const dir = join(repoRoot, 'data', 'masks', rawId);
      await mkdir(dir, { recursive: true });
      for (const [mid, mask] of p.masks) {
        const px = Buffer.alloc(mask.length);
        for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
        await sharp(px, { raw: { width: p.width, height: p.height, channels: 1 } }).png().toFile(join(dir, `${mid}.png`));
        maskMap[mid] = `data/masks/${rawId}/${mid}.png`;
      }
    }
    withStore((s) => {
      s.setSourceAnalysis(rawId, JSON.stringify(p.analysis), JSON.stringify(maskMap), null);
      s.recordUsage('model', p.modelCalls);
    });
  };

  /** The brand's automatic prompt for this job (null when the brand has none). */
  const loadBrandPrompt = (brandId: string | null): { prompt: import('../../shared/brand-prompt.js').StoredBrandPrompt; text: string } | null => {
    if (!brandId) return null;
    const row = withStore((s) => s.getBrand(brandId));
    if (!row) return null;
    return parseStoredBrandPrompt(row.prompt_json, row.prompt_text);
  };

  /** Execute one fast job: prepared sources, cells in a worker pool. */
  const executeJob = async (
    storeJobId: string,
    cells: CellDef[],
    mode: FitMode,
    brandId: string | null,
    brandName: string | null,
    prepareTraces: Map<string, TraceCollector>,
    onRow: (row: JobRow) => void,
  ): Promise<{ jobId: string }> => {
    const perSize = await resolvePerSize(brandId, cells.map((c) => c.presetId));
    const brandPrompt = loadBrandPrompt(brandId);
    const models = { client: makeClient(), extractModel, samModel, wonderModel, image: makeImageConfig() };
    let jobModels = 0;
    let jobImages = 0;
    const runCell = async (cell: CellDef): Promise<void> => {
      const preset = presetById(cell.presetId);
      if (!preset) return;
      const trace = new TraceCollector();
      for (const e of prepareTraces.get(cell.source.id)?.all() ?? []) {
        const { seq: _s, ...rest } = e;
        trace.emit(rest);
      }
      const outDir = join(repoRoot, 'data', 'outputs', storeJobId);
      const start = Date.now();
      try {
        const { template, framePng } = perSize.get(cell.presetId) ?? { template: null, framePng: null };
        const outcome = await runOutput(models, { source: cell.source, preset, mode, template, framePng, brandName, brandPrompt: brandPrompt ? brandPromptUseForSize(brandPrompt, preset.id) : null }, `${storeJobId}/${cell.sourceIndex}/${preset.id}`, trace);
        await mkdir(outDir, { recursive: true });
        const fileName = `${cell.sourceIndex}-${preset.id}.png`;
        await writeFile(join(outDir, fileName), outcome.png);
        jobModels += outcome.modelCalls;
        jobImages += outcome.imageCalls;
        const status = outcome.qa.pass ? 'pass' : 'needs_review';
        const checks = {
          protected_pixels: { status: 'pending', detail: 'fast mode redraws pixels (nothing protected)' },
          text: outcome.qa.texts_read.every((t) => t.exact)
            ? { status: 'passed', detail: 're-rendered text verified exact' }
            : { status: 'needs_review', detail: 'text mismatch in QA read' },
          layout_review: outcome.qa.pass
            ? { status: 'passed', detail: 'Spark QA passed' }
            : { status: 'needs_review', detail: outcome.qa.reasons[0]?.slice(0, 200) ?? 'QA failed' },
          repaired: null,
        };
        const outputId = withStore((s) => {
          const id = s.insertOutput({
            jobId: storeJobId, sourceId: cell.source.id, preset: preset.id, mode, status,
            imagePath: `data/outputs/${storeJobId}/${fileName}`,
            planJson: JSON.stringify({ ...outcome.plan, manifest: outcome.manifest }),
            proofJson: outcome.proofs ? JSON.stringify(outcome.proofs) : null,
            qaJson: JSON.stringify(outcome.qa),
            retries: outcome.retries,
            modelCalls: outcome.modelCalls, imageCalls: outcome.imageCalls,
            latencyMs: Date.now() - start, traceJson: JSON.stringify(trace.all()), error: null,
            checksJson: JSON.stringify(checks),
          });
          s.recordUsage('model', outcome.modelCalls);
          s.recordUsage('image', outcome.imageCalls);
          return id;
        });
        onRow({ outputId, sourceId: cell.source.id, sourceIndex: cell.sourceIndex, preset: preset.id, status, retries: outcome.retries, checks: cardChecks(checks), ...traceSummaryOf(trace.all()) });
      } catch (e) {
        const message = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        const outputId = withStore((s) =>
          s.insertOutput({
            jobId: storeJobId, sourceId: cell.source.id, preset: preset.id, mode, status: 'failed',
            imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
            modelCalls: 0, imageCalls: 0, latencyMs: Date.now() - start,
            traceJson: JSON.stringify(trace.all()), error: message,
          }),
        );
        onRow({ outputId, sourceId: cell.source.id, sourceIndex: cell.sourceIndex, preset: preset.id, status: 'failed', retries: 0, ...traceSummaryOf(trace.all()), error: message });
      }
    };
    await runPool(cells, cfg.sizeConcurrency, runCell);
    const failed = withStore((s) => s.outputsForJob(storeJobId).filter((o) => o.status === 'failed').length);
    const total = withStore((s) => s.outputsForJob(storeJobId).length);
    withStore((s) => s.finishJob(storeJobId, failed === total && total > 0 ? 'failed' : 'done', null, jobModels, jobImages));
    return { jobId: storeJobId };
  };

  /**
   * Execute one protected job through the batch engine: per source,
   * analyze → SAM ∥ Wonder plan → plates → streamed previews (review
   * pending) → batch review → repair → final rows via onUpdate.
   */
  const executeProtected = async (
    storeJobId: string,
    raws: Array<{ id: string; bytes: Buffer; width: number; height: number }>,
    sizes: string[],
    brandId: string | null,
    brandName: string | null,
    onRow: (row: JobRow) => void,
    onUpdate: (row: JobRow) => void,
    onPrep: (step: 'analyze' | 'masks' | 'plan', state: 'start' | 'done', ms?: number, detail?: string) => void = () => undefined,
    textsBySource: Record<number, TextOverrides> = {},
  ): Promise<{ jobId: string }> => {
    const perSize = await resolvePerSize(brandId, sizes);
    const models = { client: makeClient(), extractModel, samModel, wonderModel, image: makeImageConfig() };
    const brandPrompt = loadBrandPrompt(brandId);
    const ledger = new CostLedger(Number.POSITIVE_INFINITY);
    const wonderAllowed = !spendCaps().wonderOver;
    let jobModels = 0;
    let jobImages = 0;
    for (const raw of raws) {
      const sourceIndex = raws.findIndex((r) => r.id === raw.id);
      const batchSizes = sizes
        .map((presetId) => ({ preset: presetById(presetId), ...(perSize.get(presetId) ?? { template: null, framePng: null }), sourceIndex }))
        .filter((s): s is { preset: NonNullable<ReturnType<typeof presetById>>; template: OutputTemplate | null; framePng: Buffer | null; sourceIndex: number } => s.preset !== null);
      const outDir = join(repoRoot, 'data', 'outputs', storeJobId);
      await mkdir(outDir, { recursive: true });
      // Preview rows first (review pending), then finals via onUpdate.
      const previewIds = new Map<string, number>();
      let batch: Awaited<ReturnType<typeof runBatchSource>> | null = null;
      try {
        batch = await runBatchSource({
          models,
          input: { id: raw.id, bytes: raw.bytes, mimeType: 'image/png', width: raw.width, height: raw.height },
          sizes: batchSizes,
          brandName,
          brandPrompt,
          jobTag: storeJobId,
          repoRoot,
          ledger,
          wonderAllowed,
          concurrency: cfg.sizeConcurrency,
          onStage: onPrep,
          textOverrides: textsBySource[sourceIndex] ?? null,
          onPreview: async (o) => {
            if (!o.png || !o.plan || !o.manifest) return;
            const fileName = `${sourceIndex}-${o.preset.id}.png`;
            await writeFile(join(outDir, fileName), o.png);
            const outputId = withStore((s) =>
              s.insertOutput({
                jobId: storeJobId, sourceId: raw.id, preset: o.preset.id, mode: 'protected', status: 'needs_review',
                imagePath: `data/outputs/${storeJobId}/${fileName}`,
                planJson: JSON.stringify({ ...o.plan, manifest: o.manifest }),
                proofJson: o.proofs ? JSON.stringify(o.proofs) : null,
                qaJson: null, retries: 0, modelCalls: 0, imageCalls: o.imageCalls,
                latencyMs: o.latencyMs, traceJson: JSON.stringify(o.trace.all()), error: null,
                checksJson: JSON.stringify(o.checks),
              }),
            );
            previewIds.set(o.preset.id, outputId);
            onRow({ outputId, sourceId: raw.id, sourceIndex, preset: o.preset.id, status: 'needs_review', retries: 0, pending: true, checks: cardChecks(o.checks), ...traceSummaryOf(o.trace.all()) });
          },
        });
      } catch (e) {
        const message = `${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        for (const presetId of sizes) {
          if (previewIds.has(presetId)) continue;
          const outputId = withStore((s) =>
            s.insertOutput({
              jobId: storeJobId, sourceId: raw.id, preset: presetId, mode: 'protected', status: 'failed',
              imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
              modelCalls: 0, imageCalls: 0, latencyMs: 0, traceJson: '[]', error: message,
            }),
          );
          onRow({ outputId, sourceId: raw.id, sourceIndex, preset: presetId, status: 'failed', retries: 0, ...traceSummaryOf([]), error: message });
        }
        continue;
      }
      await persistSourceLayers(raw.id, batch.source);
      jobModels += batch.source.modelCalls + batch.modelCalls;
      for (const o of batch.outcomes) {
        jobImages += o.imageCalls;
        const outputId = previewIds.get(o.preset.id);
        if (o.error || !o.png || !o.plan || !o.manifest || outputId === undefined) {
          if (outputId === undefined) {
            const oid = withStore((s) =>
              s.insertOutput({
                jobId: storeJobId, sourceId: raw.id, preset: o.preset.id, mode: 'protected', status: 'failed',
                imagePath: '', planJson: o.plan ? JSON.stringify({ ...o.plan, manifest: o.manifest }) : '{}',
                proofJson: null, qaJson: null, retries: 0, modelCalls: 0, imageCalls: o.imageCalls,
                latencyMs: o.latencyMs, traceJson: JSON.stringify(o.trace.all()), error: o.error ?? 'compose failed',
              }),
            );
            onRow({ outputId: oid, sourceId: raw.id, sourceIndex, preset: o.preset.id, status: 'failed', retries: 0, ...traceSummaryOf(o.trace.all()), error: o.error ?? undefined });
          }
          continue;
        }
        const fileName = `${sourceIndex}-${o.preset.id}.png`;
        await writeFile(join(outDir, fileName), o.png);
        // Finals overwrite the preview bytes in place: drop the cached thumb.
        await invalidateThumb(repoRoot, `o${outputId}`);
        if (o.repaired) {
          await writeFile(join(outDir, `before-${sourceIndex}-${o.preset.id}.png`), o.repaired.beforePng);
          if (o.checks.repaired) o.checks.repaired.before = `data/outputs/${storeJobId}/before-${sourceIndex}-${o.preset.id}.png`;
        }
        const status = rowStatusFromChecks(o.checks);
        withStore((s) => {
          s.updateOutput(outputId, {
            status,
            planJson: JSON.stringify({ ...o.plan, manifest: o.manifest }),
            proofJson: o.proofs ? JSON.stringify(o.proofs) : null,
            imageCalls: o.imageCalls,
            latencyMs: o.latencyMs,
            traceJson: JSON.stringify(o.trace.all()),
            checksJson: JSON.stringify(o.checks),
          });
          s.recordUsage('image', o.imageCalls);
        });
        onUpdate({ outputId, sourceId: raw.id, sourceIndex, preset: o.preset.id, status, retries: o.repaired ? 1 : 0, pending: false, checks: cardChecks(o.checks), ...traceSummaryOf(o.trace.all()) });
      }
      withStore((s) => s.recordUsage('model', batch.source.modelCalls + batch.modelCalls));
    }
    for (const entry of ledger.all()) {
      withStore((s) => s.recordSpend({ model: entry.model, modelId: entry.modelId, costUsd: entry.costUsd, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, images: entry.images }));
    }
    const failed = withStore((s) => s.outputsForJob(storeJobId).filter((o) => o.status === 'failed').length);
    const total = withStore((s) => s.outputsForJob(storeJobId).length);
    withStore((s) => s.finishJob(storeJobId, failed === total && total > 0 ? 'failed' : 'done', null, jobModels, jobImages));
    return { jobId: storeJobId };
  };

  /** Prepare sources (analyze + masks + persist mask PNGs). Throws nothing per-source: failures are returned. */
  const prepareAll = async (
    raws: Array<{ id: string; bytes: Buffer; width: number; height: number }>,
  ): Promise<{ prepared: PreparedSource[]; traces: Map<string, TraceCollector>; failed: Map<string, string> }> => {
    const models = { client: makeClient(), extractModel, samModel, wonderModel, image: makeImageConfig() };
    const prepared: PreparedSource[] = [];
    const traces = new Map<string, TraceCollector>();
    const failed = new Map<string, string>();
    for (const raw of raws) {
      const trace = new TraceCollector();
      traces.set(raw.id, trace);
      try {
        const p = await prepareSource(models, { id: raw.id, bytes: raw.bytes, mimeType: 'image/png', width: raw.width, height: raw.height }, trace);
        // Persist full-frame masks for the overlay UI.
        const maskMap: Record<string, string> = {};
        if (p.masks.size > 0) {
          const dir = join(repoRoot, 'data', 'masks', raw.id);
          await mkdir(dir, { recursive: true });
          for (const [mid, mask] of p.masks) {
            const px = Buffer.alloc(mask.length);
            for (let i = 0; i < px.length; i++) px[i] = mask[i] ? 255 : 0;
            await sharp(px, { raw: { width: p.width, height: p.height, channels: 1 } }).png().toFile(join(dir, `${mid}.png`));
            maskMap[mid] = `data/masks/${raw.id}/${mid}.png`;
          }
        }
        withStore((s) => {
          s.setSourceAnalysis(raw.id, JSON.stringify(p.analysis), JSON.stringify(maskMap), null);
          s.recordUsage('model', p.modelCalls);
        });
        prepared.push(p);
      } catch (e) {
        failed.set(raw.id, `${e instanceof Error ? e.message : String(e)}`.slice(0, 300));
      }
    }
    return { prepared, traces, failed };
  };

  const inner = new Hono();
  inner.use('*', async (c, next) => {
    securityHeaders(c);
    await next();
  });
  inner.notFound((c) => err(c, 404, 'err_not_found'));
  inner.onError((e, c) => {
    console.error(`web error: ${e instanceof Error ? e.message : String(e)}`);
    return err(c, 500, 'err_unknown');
  });

  // --- static shell ---
  inner.get('/', (c) => sendFile(c, join(webRoot, 'index.html'), 'text/html; charset=utf-8', 'no-cache'));
  inner.get('/app.js', (c) => sendFile(c, join(webRoot, 'app.js'), 'text/javascript; charset=utf-8', 'no-cache'));
  inner.get('/styles.css', (c) => sendFile(c, join(webRoot, 'styles.css'), 'text/css; charset=utf-8', 'no-cache'));
  inner.get('/favicon.svg', (c) => sendFile(c, join(webRoot, 'favicon.svg'), 'image/svg+xml', 'public, max-age=3600'));
  inner.get('/fonts/:file', (c) => {
    const f = c.req.param('file');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.woff2$/.test(f)) return err(c, 404, 'err_not_found');
    return sendFile(c, join(webRoot, 'fonts', f), 'font/woff2', 'public, max-age=86400');
  });

  // --- read API ---
  inner.get('/api/presets', (c) => c.json({ presets: PRESETS }));
  inner.get('/api/brands', (c) => c.json(withStore((s) => buildBrands(s))));
  inner.get('/api/brands/:id', (c) => {
    const dto = withStore((s) => buildBrand(s, c.req.param('id')));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/runs/:id', (c) => {
    const dto = withStore((s) => buildJob(s, c.req.param('id')));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/outputs/:id', (c) => {
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const dto = withStore((s) => buildOutput(s, Number(c.req.param('id'))));
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  inner.get('/api/demo', (c) => {
    const dto = withStore((s) => {
      const demos = s.demoJobs();
      const first = [...demos].sort((a, b) => {
        const ia = DEMO_JOB_ORDER.indexOf(a.id);
        const ib = DEMO_JOB_ORDER.indexOf(b.id);
        return (ia < 0 ? DEMO_JOB_ORDER.length : ia) - (ib < 0 ? DEMO_JOB_ORDER.length : ib);
      })[0];
      return buildJob(s, first?.id ?? DEMO_JOB_ID);
    });
    if (!dto) return err(c, 404, 'err_not_found');
    return c.json(dto);
  });
  // Saved demo examples (up to 5, each a finished demo job). Details come
  // from GET /api/runs/:id — same JobDto shape, no new client model.
  inner.get('/api/examples', (c) => {
    const list = withStore((s) => buildExamples(s));
    return c.json({ examples: list });
  });

  // --- media by record id ---
  inner.get('/media/:kind/:id', async (c) => {
    const kind = c.req.param('kind') as MediaKind;
    if (!MEDIA_KINDS.includes(kind)) return err(c, 404, 'err_not_found');
    const m = await resolveMedia({ repoRoot, dbPath }, kind, c.req.param('id'));
    if (!m) return err(c, 404, 'err_not_found');
    return sendFile(c, m.file, m.contentType, 'public, max-age=3600');
  });
  inner.get('/media/mask/:source/:mask', async (c) => {
    const m = await resolveMask({ repoRoot, dbPath }, c.req.param('source'), c.req.param('mask'));
    if (!m) return err(c, 404, 'err_not_found');
    return sendFile(c, m.file, m.contentType, 'public, max-age=3600');
  });
  inner.get('/media/templatemask/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const rel = `${dirname(row.image_path)}/mask-logo.png`;
    const bytes = await readContainedFile(repoRoot, rel);
    if (!bytes) return err(c, 404, 'err_not_found');
    return new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' },
    });
  });

  // --- brands ---
  inner.post('/api/brands', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = brandBodySchema.safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    const id = newId('brand');
    withStore((s) => s.insertBrand({ id, name: parsed.data.name, colors: parseBrandColors(parsed.data.colors), fonts: parsed.data.fonts, logoPath: null, isDemo: false, expiresAt: dayFromNow() }));
    return c.json({ id }, 201);
  });
  inner.delete('/api/brands/:id', async (c) => {
    const id = c.req.param('id');
    const row = withStore((s) => s.getBrand(id));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const templates = withStore((s) => s.templatesForBrand(id));
    await unlinkData([row.logo_path, ...templates.flatMap((t) => [t.image_path, t.frame_path])]);
    for (const t of templates) await invalidateThumb(repoRoot, `e${t.id}`);
    withStore((s) => s.deleteBrand(id));
    return c.json({ ok: true });
  });
  inner.post('/api/brands/:id/logo', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const raw = Buffer.from(await (files[0] as UploadedFile).arrayBuffer());
    try {
      const stored = await validateAndStoreUpload(repoRoot, raw, cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'logos', 'logo.png');
      await unlinkData([row.logo_path]);
      withStore((s) => s.setBrandLogo(row.id, stored.relPath));
      return c.json({ logo: `media/logo/${row.id}` });
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
  });
  inner.post('/api/brands/:id/templates', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const len = c.req.header('content-length');
    if (len && Number(len) > (cfg.uploadMaxBytes + 65536) * 2) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const presetRaw = typeof parsed.preset === 'string' && parsed.preset !== '' ? parsed.preset : null;
    if (presetRaw !== null && !presetById(presetRaw)) return err(c, 400, 'err_bad_request');
    const imageFile = parsed.image;
    const frameFile = parsed.frame;
    if (!isFile(imageFile) || (frameFile !== undefined && !isFile(frameFile))) return err(c, 400, 'err_bad_request');
    try {
      const stored = await validateAndStoreUpload(repoRoot, Buffer.from(await imageFile.arrayBuffer()), cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'templates', 'template.png');
      let framePath: string | null = null;
      if (isFile(frameFile)) {
        const frame = await validateAndStoreUpload(repoRoot, Buffer.from(await frameFile.arrayBuffer()), cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'templates', 'frame.png');
        framePath = frame.relPath;
      }
      const id = newId('tpl');
      withStore((s) => s.insertTemplate({ id, brandId: row.id, preset: presetRaw, imagePath: stored.relPath, framePath, expiresAt: dayFromNow() }));
      parseTemplate(id);
      return c.json({ id, status: 'pending' }, 202);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
  });
  inner.patch('/api/templates/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const owner = withStore((s) => s.getBrand(row.brand_id));
    if (owner?.is_demo === 1) return err(c, 400, 'err_bad_request');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = templatePatchSchema.safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    if (parsed.data.preset !== undefined) {
      if (parsed.data.preset !== null && !presetById(parsed.data.preset)) return err(c, 400, 'err_bad_request');
      withStore((s) => s.setTemplatePreset(row.id, parsed.data.preset ?? null));
    }
    if (parsed.data.spec !== undefined) {
      const spec = templateSpecSchema.safeParse(parsed.data.spec);
      if (!spec.success || !specBoxesNormalized(spec.data)) return err(c, 400, 'err_bad_request');
      withStore((s) => s.updateTemplateSpec(row.id, JSON.stringify(spec.data)));
    }
    return c.json({ ok: true });
  });
  inner.delete('/api/templates/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const brand = withStore((s) => s.getBrand(row.brand_id));
    if (brand?.is_demo === 1) return err(c, 400, 'err_bad_request');
    await unlinkData([row.image_path, row.frame_path]);
    await invalidateThumb(repoRoot, `e${row.id}`);
    withStore((s) => s.deleteTemplate(row.id));
    return c.json({ ok: true });
  });

  // --- style examples (finished ads with a scope; same rows as templates) ---
  inner.post('/api/brands/:id/examples', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const scopeRaw = typeof parsed.scope === 'string' ? parsed.scope : '';
    try {
      const stored = await validateAndStoreUpload(repoRoot, Buffer.from(await (files[0] as UploadedFile).arrayBuffer()), cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'templates', 'example.png');
      const scope = scopeRaw === GENERAL_SCOPE || scopeRaw === ''
        ? (scopeRaw === '' ? guessScopeFromAspect(stored.width, stored.height) : GENERAL_SCOPE)
        : scopeRaw;
      if (!isGeneralScope(scope) && !presetById(scope)) return err(c, 400, 'err_bad_request');
      if (!isGeneralScope(scope) && !cfg.live) return err(c, 503, 'err_live_off');
      const id = newId('tpl');
      withStore((s) => s.insertTemplate({ id, brandId: row.id, preset: isGeneralScope(scope) ? null : scope, imagePath: stored.relPath, framePath: null, expiresAt: dayFromNow() }));
      if (isGeneralScope(scope)) {
        withStore((s) => s.setTemplateReadyWithoutSpec(id));
      } else {
        parseTemplate(id);
      }
      return c.json({ id, scope, status: isGeneralScope(scope) ? 'ready' : 'pending' }, 202);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
  });
  inner.patch('/api/examples/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const owner = withStore((s) => s.getBrand(row.brand_id));
    if (owner?.is_demo === 1) return err(c, 400, 'err_bad_request');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = z.object({ scope: z.string().min(1).max(40) }).strict().safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    const scope = parsed.data.scope;
    if (!isGeneralScope(scope) && !presetById(scope)) return err(c, 400, 'err_bad_request');
    withStore((s) => s.setTemplatePreset(row.id, isGeneralScope(scope) ? null : scope));
    if (!isGeneralScope(scope) && !row.spec_json) {
      if (!cfg.live) return err(c, 503, 'err_live_off');
      withStore((s) => s.resetTemplateParse(row.id));
      parseTemplate(row.id);
    }
    return c.json({ ok: true, scope });
  });
  inner.delete('/api/examples/:id', async (c) => {
    const row = withStore((s) => s.getTemplate(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const brand = withStore((s) => s.getBrand(row.brand_id));
    if (brand?.is_demo === 1) return err(c, 400, 'err_bad_request');
    await unlinkData([row.image_path, row.frame_path]);
    await invalidateThumb(repoRoot, `e${row.id}`);
    withStore((s) => s.deleteTemplate(row.id));
    return c.json({ ok: true });
  });

  // --- the automatic brand prompt (one Wonder call per generate) ---
  inner.get('/api/brands/:id/prompt', (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    const run = promptRuns.get(row.id);
    if (run?.status === 'generating') return c.json({ status: 'generating' });
    if (row.prompt_json) {
      try {
        const parsed = storedBrandPromptSchema.parse(JSON.parse(row.prompt_json));
        return c.json({ status: 'ready', prompt: { ...parsed, readable: row.prompt_text ?? renderBrandPromptText(parsed) } });
      } catch {
        // A corrupt prompt row reads as missing, never crashes the API.
      }
    }
    if (run) return c.json({ status: run.status, error: run.error });
    return c.json({ status: 'none' });
  });
  inner.post('/api/brands/:id/prompt/generate', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    if (promptRuns.get(row.id)?.status === 'generating') return c.json({ status: 'generating' }, 202);
    const examples = withStore((s) => s.templatesForBrand(row.id));
    if (examples.length === 0) return err(c, 400, 'err_no_examples');
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (spendCaps().wonderOver) {
      promptRuns.set(row.id, { status: 'capped', error: 'daily Wonder budget spent', at: new Date().toISOString() });
      return err(c, 429, 'err_spendcap');
    }
    runBrandPromptGeneration(row.id);
    return c.json({ status: 'generating' }, 202);
  });
  inner.patch('/api/brands/:id/prompt', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo === 1) return err(c, 400, 'err_bad_request');
    if (!row.prompt_json) return err(c, 400, 'err_bad_request');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const parsed = z.object({ text: z.string().trim().min(1).max(20000) }).strict().safeParse(body);
    if (!parsed.success) return err(c, 400, 'err_bad_request');
    try {
      const prev = storedBrandPromptSchema.parse(JSON.parse(row.prompt_json));
      withStore((s) => s.setBrandPromptText(row.id, JSON.stringify({ ...prev, editedByUser: true }), parsed.data.text));
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    return c.json({ ok: true });
  });

  // --- brand auto-match (one light Spark call; gated on live + daily cap) ---
  inner.post('/api/match', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (capped('model')) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const raw = Buffer.from(await (files[0] as UploadedFile).arrayBuffer());
    let checked: { bytes: Buffer; width: number; height: number };
    try {
      checked = await validateImageBytes(raw, cfg.uploadMaxBytes, cfg.uploadMaxPixels);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
    const brands = withStore((s) => s.allBrands());
    const candidates = [];
    for (const b of brands) {
      let colors: string[] = [];
      try {
        colors = parseBrandColors(JSON.parse(b.colors_json) as unknown).map((e) => e.hex);
      } catch {
        colors = [];
      }
      const logoBytes = b.logo_path ? await readContainedFile(repoRoot, b.logo_path) : null;
      candidates.push({ name: b.name, colors, logoBytes, logoMime: 'image/png' });
    }
    try {
      const match = await matchBrand(makeClient(), { imageBytes: checked.bytes, mimeType: 'image/png', model: extractModel, candidates });
      withStore((s) => s.recordUsage('model', 1));
      const brandId = match.brand_index !== null ? (brands[match.brand_index]?.id ?? null) : null;
      return c.json({ brandId, reason: match.reason });
    } catch {
      return err(c, 500, 'err_unknown');
    }
  });

  // --- setup flow: read the detected text before generating (one Spark call) ---
  inner.post('/api/analyze', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (capped('model')) return err(c, 503, 'err_live_off');
    if (spendCaps().allOver) return err(c, 429, 'err_busy');
    const len = c.req.header('content-length');
    if (len && Number(len) > cfg.uploadMaxBytes + 65536) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const files = collectFiles(parsed);
    if (files.length !== 1) return err(c, 400, 'err_bad_request');
    const raw = Buffer.from(await (files[0] as UploadedFile).arrayBuffer());
    let checked: { bytes: Buffer; width: number; height: number };
    try {
      checked = await validateImageBytes(raw, cfg.uploadMaxBytes, cfg.uploadMaxPixels);
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : 400, e.key);
      throw e;
    }
    try {
      const models = { client: makeClient(), extractModel, samModel, wonderModel, image: makeImageConfig() };
      const ledger = new CostLedger(Number.POSITIVE_INFINITY);
      const staged = await runAnalysisStage(models, { id: 'analyze', bytes: checked.bytes, mimeType: 'image/png', width: checked.width, height: checked.height }, new TraceCollector(), { repoRoot, ledger });
      withStore((s) => s.recordUsage('model', staged.attempts));
      for (const entry of ledger.all()) {
        withStore((st) => st.recordSpend({ model: entry.model, modelId: entry.modelId, costUsd: entry.costUsd, inputTokens: entry.inputTokens, outputTokens: entry.outputTokens, images: entry.images }));
      }
      const a = staged.analysis;
      return c.json({
        width: checked.width,
        height: checked.height,
        language: a.language,
        texts: {
          headline: a.headline?.text ?? null,
          subtext: a.subtext?.text ?? null,
          panel: a.panel?.texts ?? [],
          others: a.other_texts.map((t) => t.text),
        },
      });
    } catch {
      return err(c, 500, 'err_unknown');
    }
  });

  inner.patch('/api/brands/:id', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    if (row.is_demo) return err(c, 400, 'err_demo_readonly');
    let body: { name?: unknown; colors?: unknown; fonts?: unknown };
    try {
      body = (await c.req.json()) as { name?: unknown; colors?: unknown; fonts?: unknown };
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const patch: { name?: string; colors?: Array<string | { hex: string; role: 'primary' | 'secondary' | 'accent' | 'text' | 'background' }>; fonts?: string[] } = {};
    if (typeof body.name === 'string' && body.name.trim().length > 0) patch.name = body.name.trim().slice(0, 60);
    if (Array.isArray(body.colors)) {
      const colors = parseBrandColors(body.colors);
      if (colors.length > 0) patch.colors = colors;
    }
    if (Array.isArray(body.fonts)) {
      const fonts = body.fonts.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 80).slice(0, 4);
      if (fonts.length > 0) patch.fonts = fonts;
    }
    if (Object.keys(patch).length === 0) return err(c, 400, 'err_bad_request');
    withStore((s) => s.updateBrand(row.id, patch));
    return c.json({ ok: true });
  });

  // --- duplicate a brand (demo brands are read-only: duplicate to edit) ---
  inner.post('/api/brands/:id/duplicate', async (c) => {
    const row = withStore((s) => s.getBrand(c.req.param('id')));
    if (!row) return err(c, 404, 'err_not_found');
    let name = `${row.name} 2`;
    try {
      const body = (await c.req.json()) as { name?: unknown };
      if (typeof body?.name === 'string' && body.name.trim().length > 0) name = body.name.trim().slice(0, 60);
    } catch {
      // No JSON body: default copy name.
    }
    const id = newId('brand');
    const templates = withStore((s) => s.templatesForBrand(row.id));
    withStore((s) => {
      s.insertBrand({ id, name, colors: parseBrandColors(JSON.parse(row.colors_json) as unknown), fonts: JSON.parse(row.fonts_json) as string[], logoPath: row.logo_path, isDemo: false, expiresAt: dayFromNow() });
      for (const t of templates) {
        const tid = newId('tpl');
        s.insertTemplate({ id: tid, brandId: id, preset: t.preset, imagePath: t.image_path, framePath: t.frame_path, expiresAt: dayFromNow() });
        if (t.spec_json) s.setTemplateReady(tid, t.spec_json);
        else if (t.status === 'ready') s.setTemplateReadyWithoutSpec(tid);
      }
      // The duplicate keeps the generated prompt (editable copy, same version).
      if (row.prompt_json && row.prompt_text) s.setBrandPrompt(id, row.prompt_json, row.prompt_text);
    });
    return c.json({ id }, 201);
  });

  // --- live generation jobs ---
  inner.post('/api/jobs', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    const len = c.req.header('content-length');
    if (len && Number(len) > (cfg.uploadMaxBytes + 65536) * 3) return err(c, 413, 'err_too_large');
    let parsed: Record<string, unknown>;
    try {
      parsed = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return err(c, 400, 'err_bad_request');
    }
    const mode = parsed.mode === 'fast' ? 'fast' : parsed.mode === undefined || parsed.mode === 'protected' ? 'protected' : null;
    if (!mode) return err(c, 400, 'err_bad_request');
    const sizes = typeof parsed.sizes === 'string' ? [...new Set(parsed.sizes.split(',').map((s) => s.trim()).filter(Boolean))] : [];
    if (sizes.length === 0 || sizes.length > 8 || !sizes.every((s) => presetById(s))) return err(c, 400, 'err_bad_request');
    const brandId = typeof parsed.brandId === 'string' && parsed.brandId !== '' ? parsed.brandId : null;
    const brand = brandId ? withStore((s) => s.getBrand(brandId)) : null;
    if (brandId && !brand) return err(c, 400, 'err_bad_request');

    // Sources: uploaded files, or one fixture source for "Run it live".
    const raws: Array<{ id: string; bytes: Buffer; width: number; height: number; relPath: string; fixture: boolean }> = [];
    const demoSource = typeof parsed.demoSource === 'string' ? parsed.demoSource : null;
    try {
      if (demoSource) {
        const rel = DEMO_SOURCES[demoSource];
        if (!rel) return err(c, 400, 'err_bad_request');
        const bytes = await readContainedFile(repoRoot, rel);
        if (!bytes) return err(c, 500, 'err_unknown');
        const meta = await sharp(bytes).metadata();
        raws.push({ id: newId('src'), bytes, width: meta.width ?? 0, height: meta.height ?? 0, relPath: rel, fixture: true });
      } else {
        const files = collectFiles(parsed);
        if (files.length === 0 || files.length > 3) return err(c, 400, 'err_too_many');
        for (const f of files) {
          const buf = Buffer.from(await f.arrayBuffer());
          const stored = await validateAndStoreUpload(repoRoot, buf, cfg.uploadMaxBytes, cfg.uploadMaxPixels, 'uploads', 'source.png');
          const bytes = await readFile(join(repoRoot, stored.relPath));
          raws.push({ id: newId('src'), bytes, width: stored.width, height: stored.height, relPath: stored.relPath, fixture: false });
        }
      }
    } catch (e) {
      if (e instanceof UploadError) return err(c, e.key === 'err_too_large' ? 413 : e.key === 'err_too_many_pixels' ? 400 : 400, e.key);
      throw e;
    }

    if (!limiter.check(clientIp(c, cfg.trustProxy))) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 429, 'err_rate');
    }
    if (capped('model') || capped('image')) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 503, 'err_live_off');
    }
    if (spendCaps().allOver) {
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 429, 'err_busy');
    }

    for (const r of raws) {
      withStore((s) => s.insertSource({ id: r.id, imagePath: r.relPath, width: r.width, height: r.height, expiresAt: dayFromNow() }));
    }
    const storeJobId = newId('job');
    withStore((s) => s.insertJob({ id: storeJobId, brandId, mode, sizes, sources: raws.map((r) => r.id), status: jobs.isBusy() ? 'queued' : 'running' }));

    const total = raws.length * sizes.length;
    const textsBySource = parseTextsField(parsed.texts);
    const job = jobs.submit('generate', total, async (onRow, onUpdate, onPrep) => {
      withStore((s) => s.setJobStatus(storeJobId, 'running'));
      if (mode === 'protected') {
        return executeProtected(storeJobId, raws, sizes, brandId, brand?.name ?? null, onRow, onUpdate, onPrep, textsBySource);
      }
      const { prepared, traces, failed } = await prepareAll(raws);
      if (failed.size > 0) {
        withStore((s) => s.recordUsage('model', 0));
        for (const [sid, message] of failed) {
          const idx = raws.findIndex((r) => r.id === sid);
          for (const presetId of sizes) {
            const outputId = withStore((s) =>
              s.insertOutput({
                jobId: storeJobId, sourceId: sid, preset: presetId, mode, status: 'failed',
                imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
                modelCalls: 0, imageCalls: 0, latencyMs: 0,
                traceJson: JSON.stringify(traces.get(sid)?.all() ?? []), error: message,
              }),
            );
            onRow({ outputId, sourceId: sid, sourceIndex: idx, preset: presetId, status: 'failed', retries: 0, ...traceSummaryOf(traces.get(sid)?.all() ?? []), error: message });
          }
        }
      }
      const cells = prepared.flatMap((p) => sizes.map((presetId) => ({ source: p, sourceIndex: raws.findIndex((r) => r.id === p.id), presetId })));
      if (cells.length === 0) {
        withStore((s) => s.finishJob(storeJobId, 'failed', 'all sources failed to analyze', 0, 0));
        return { jobId: storeJobId };
      }
      return executeJob(storeJobId, cells, mode, brandId, brand?.name ?? null, traces, onRow);
    });
    if (!job) {
      withStore((s) => s.finishJob(storeJobId, 'failed', 'err_busy', 0, 0));
      await unlinkData(raws.filter((r) => !r.fixture).map((r) => r.relPath));
      return err(c, 429, 'err_busy');
    }
    return c.json({ key: job.id, status: job.status, queueAhead: jobs.queueAheadOf(job), jobId: storeJobId }, 202);
  });

  inner.post('/api/outputs/:id/regenerate', async (c) => {
    if (!cfg.live) return err(c, 503, 'err_live_off');
    if (!/^\d+$/.test(c.req.param('id'))) return err(c, 404, 'err_not_found');
    const prev = withStore((s) => s.getOutput(Number(c.req.param('id'))));
    if (!prev) return err(c, 404, 'err_not_found');
    const prevJob = withStore((s) => s.getJob(prev.job_id));
    if (!prevJob) return err(c, 404, 'err_not_found');
    const source = withStore((s) => s.getSource(prev.source_id));
    if (!source) return err(c, 404, 'err_not_found');
    if (!limiter.check(clientIp(c, cfg.trustProxy))) return err(c, 429, 'err_rate');
    if (capped('model') || capped('image')) return err(c, 503, 'err_live_off');
    if (spendCaps().allOver) return err(c, 429, 'err_busy');

    const bytes = await readContainedFile(repoRoot, source.image_path);
    if (!bytes) return err(c, 404, 'err_not_found');
    const storeJobId = newId('job');
    const mode = (prev.mode === 'fast' ? 'fast' : 'protected') as FitMode;
    withStore((s) => s.insertJob({ id: storeJobId, brandId: prevJob.brand_id, mode, sizes: [prev.preset], sources: [source.id], status: jobs.isBusy() ? 'queued' : 'running' }));
    const brand = prevJob.brand_id ? withStore((s) => s.getBrand(prevJob.brand_id as string)) : null;
    const job = jobs.submit('regenerate', 1, async (onRow, onUpdate, onPrep) => {
      withStore((s) => s.setJobStatus(storeJobId, 'running'));
      if (mode === 'protected') {
        return executeProtected(storeJobId, [{ id: source.id, bytes, width: source.width, height: source.height }], [prev.preset], prevJob.brand_id, brand?.name ?? null, onRow, onUpdate, onPrep);
      }
      const { prepared, traces, failed } = await prepareAll([{ id: source.id, bytes, width: source.width, height: source.height }]);
      if (failed.size > 0 || prepared.length === 0) {
        const message = failed.get(source.id) ?? 'source analysis failed';
        const outputId = withStore((s) =>
          s.insertOutput({
            jobId: storeJobId, sourceId: source.id, preset: prev.preset, mode, status: 'failed',
            imagePath: '', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
            modelCalls: 0, imageCalls: 0, latencyMs: 0, traceJson: '[]', error: message,
          }),
        );
        onRow({ outputId, sourceId: source.id, sourceIndex: 0, preset: prev.preset, status: 'failed', retries: 0, ...traceSummaryOf(traces.get(source.id)?.all() ?? []), error: message });
        withStore((s) => s.finishJob(storeJobId, 'failed', message, 0, 0));
        return { jobId: storeJobId };
      }
      return executeJob(
        storeJobId,
        [{ source: prepared[0] as PreparedSource, sourceIndex: 0, presetId: prev.preset }],
        mode,
        prevJob.brand_id,
        brand?.name ?? null,
        traces,
        onRow,
      );
    });
    if (!job) {
      withStore((s) => s.finishJob(storeJobId, 'failed', 'err_busy', 0, 0));
      return err(c, 429, 'err_busy');
    }
    return c.json({ key: job.id, status: job.status, queueAhead: jobs.queueAheadOf(job), jobId: storeJobId }, 202);
  });

  inner.get('/api/live/:key', (c) => {
    const job = jobs.get(c.req.param('key'));
    if (!job) return err(c, 404, 'err_not_found');
    return c.json({ job: jobs.summary(job) });
  });

  inner.get('/api/live/:key/events', (c) => {
    const job = jobs.get(c.req.param('key'));
    if (!job) return err(c, 404, 'err_not_found');
    return sseResponse(job);
  });

  // --- download all (ZIP with manifest) ---
  inner.get('/api/runs/:id/zip', async (c) => {
    const job = withStore((s) => s.getJob(c.req.param('id')));
    if (!job) return err(c, 404, 'err_not_found');
    const outputs = withStore((s) => s.outputsForJob(job.id)).filter((o) => o.status !== 'failed' && o.image_path);
    if (outputs.length === 0) return err(c, 404, 'err_not_found');
    const entries = [];
    const manifest = [];
    for (const o of outputs) {
      const bytes = await readContainedFile(repoRoot, o.image_path);
      if (!bytes) continue;
      const name = `${BRAND_SLUG}-${o.preset}-${o.id}.png`;
      entries.push({ name, data: bytes });
      manifest.push({ file: name, preset: o.preset, source: o.source_id, mode: o.mode, status: o.status, qa: o.qa_json ? JSON.parse(o.qa_json) : null, sha256: sha256Hex(bytes) });
    }
    if (entries.length === 0) return err(c, 404, 'err_not_found');
    entries.push({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ job: job.id, brand: job.brand_id, mode: job.mode, generatedAt: job.finished_at ?? job.created_at, outputs: manifest }, null, 2)) });
    const zip = buildZip(entries);
    return new Response(zip as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${BRAND_SLUG}-${job.id}.zip"`,
        'content-length': String(zip.length),
      },
    });
  });

  if (cfg.basePath === '/') return inner;
  const mount = cfg.basePath.replace(/\/+$/, '');
  const outer = new Hono();
  outer.use('*', async (c, next) => {
    securityHeaders(c);
    await next();
  });
  outer.get(`${mount}/`, (c) => sendFile(c, join(webRoot, 'index.html'), 'text/html; charset=utf-8', 'no-cache'));
  outer.notFound((c) => err(c, 404, 'err_not_found'));
  outer.onError((e, c) => {
    console.error(`web error: ${e instanceof Error ? e.message : String(e)}`);
    return err(c, 500, 'err_unknown');
  });
  outer.route(mount, inner);
  return outer;
}
