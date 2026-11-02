import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../store/db.js';

interface FixtureTemplate {
  id: string;
  preset: string | null;
  image: string;
  spec: string | null;
  frame?: string;
}

interface FixtureBrand {
  id: string;
  name: string;
  colors: string[];
  fonts: string[];
  logo: string | null;
  templates: FixtureTemplate[];
}

interface DemoOutput {
  source: string;
  sourceLabel: string;
  preset: string;
  mode: string;
  status: string;
  image: string;
  before: string | null;
  plan: unknown;
  proof: unknown;
  qa: unknown;
  retries: number;
  modelCalls: number;
  imageCalls: number;
  latencyMs: number;
  trace: unknown[];
  error: string | null;
  checks: unknown;
}

interface DemoJob {
  brand: string;
  mode: string;
  finishedAt: string;
  modelCalls: number;
  imageCalls: number;
  firstPreviewMs: number | null;
  totalMs: number;
  outputs: DemoOutput[];
}

interface DemoDef {
  jobId: string;
  brand: string;
  lang: string;
  nativePreset: string;
}

/** Saved demo examples (session 11): one native size each, distinct brands. */
const DEMO_JOBS: DemoDef[] = [
  { jobId: 'demo-luma', brand: 'luma', lang: 'en', nativePreset: 'ig-feed-11' },
  { jobId: 'demo-stride', brand: 'stride', lang: 'en', nativePreset: 'ig-story-916' },
  { jobId: 'demo-northbean', brand: 'northbean', lang: 'en', nativePreset: 'fb-link' },
  { jobId: 'demo-sheket', brand: 'sheket', lang: 'he', nativePreset: 'yt-thumb' },
];

/** Fallback demo id when the DB has no seeded demos (tests + /api/demo). */
export const DEMO_JOB_ID = 'demo-luma';

/** PNG dimensions from the IHDR chunk (all fixture sources are PNG). */
function pngSize(path: string): { width: number; height: number } {
  const bytes = readFileSync(path);
  if (bytes.length > 24 && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  return { width: 1080, height: 1080 };
}

/**
 * Seed fixture brands and the saved demo jobs into the store.
 * Idempotent: existing rows are left untouched. Demo rows never expire.
 */
export function ensureSeeded(repoRoot: string, dbPath: string): void {
  const store = Store.open(dbPath);
  try {
    const brandsDir = join(repoRoot, 'fixtures', 'brands');
    if (!existsSync(brandsDir)) return;
    const dirs = readdirSync(brandsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const dir of dirs) {
      const manifestPath = join(brandsDir, dir, 'brand.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as FixtureBrand;
      if (!store.getBrand(manifest.id)) {
        store.insertBrand({
          id: manifest.id,
          name: manifest.name,
          colors: manifest.colors,
          fonts: manifest.fonts ?? [],
          logoPath: manifest.logo ? `fixtures/brands/${dir}/${manifest.logo}` : null,
          isDemo: true,
          expiresAt: null,
        });
      }
      for (const t of manifest.templates) {
        if (store.getTemplate(t.id)) continue;
        let specJson: string | null = null;
        if (t.spec) {
          const specPath = join(brandsDir, dir, t.spec);
          if (existsSync(specPath)) specJson = readFileSync(specPath, 'utf8');
        }
        store.insertTemplate({
          id: t.id,
          brandId: manifest.id,
          preset: t.preset,
          imagePath: `fixtures/brands/${dir}/${t.image}`,
          framePath: t.frame ? `fixtures/brands/${dir}/${t.frame}` : null,
          expiresAt: null,
        });
        if (specJson) store.setTemplateReady(t.id, specJson);
        else store.setTemplateFailed(t.id, 'fixture spec missing');
      }
    }

    // Saved demo jobs (finished runs, committed under fixtures/.../demo).
    // Timing is replayed from the real run so the run line shows real numbers.
    for (const def of DEMO_JOBS) {
      const demoPath = join(brandsDir, def.brand, 'demo', 'demo.json');
      if (!existsSync(demoPath)) continue;
      if (store.getJob(def.jobId)) continue;
      const demo = JSON.parse(readFileSync(demoPath, 'utf8')) as DemoJob;
      const finished = Date.parse(demo.finishedAt);
      const jobCreated = Number.isFinite(finished) ? finished - (demo.totalMs ?? 0) : Date.now();
      const sourceIds = [...new Set(demo.outputs.map((o) => o.source))];
      for (const sid of sourceIds) {
        if (store.getSource(sid)) continue;
        const first = demo.outputs.find((o) => o.source === sid);
        const rel = `fixtures/brands/${def.brand}/${first?.sourceLabel ?? 'source.png'}`;
        const { width, height } = existsSync(join(repoRoot, rel)) ? pngSize(join(repoRoot, rel)) : { width: 1080, height: 1080 };
        store.insertSource({ id: sid, imagePath: rel, width, height, expiresAt: null });
      }
      store.insertJob({
        id: def.jobId, brandId: demo.brand, mode: demo.mode,
        sizes: demo.outputs.map((o) => o.preset), sources: sourceIds,
        lang: def.lang, nativePreset: def.nativePreset,
        createdAt: new Date(jobCreated).toISOString(),
      });
      for (const o of demo.outputs) {
        const landed = jobCreated + Math.min(Math.max(o.latencyMs, 0), demo.totalMs ?? o.latencyMs);
        store.insertOutput({
          jobId: def.jobId,
          sourceId: o.source,
          preset: o.preset,
          mode: o.mode,
          status: o.status,
          imagePath: `fixtures/brands/${def.brand}/demo/${o.image}`,
          planJson: JSON.stringify(o.plan),
          proofJson: o.proof ? JSON.stringify(o.proof) : null,
          qaJson: o.qa ? JSON.stringify(o.qa) : null,
          retries: o.retries,
          modelCalls: o.modelCalls,
          imageCalls: o.imageCalls,
          latencyMs: o.latencyMs,
          traceJson: JSON.stringify(o.trace),
          error: o.error,
          checksJson: o.checks ? JSON.stringify(o.checks) : null,
          createdAt: new Date(landed).toISOString(),
        });
      }
      store.finishJob(def.jobId, 'done', null, demo.modelCalls, demo.imageCalls, demo.finishedAt);
    }
  } finally {
    store.close();
  }
}
