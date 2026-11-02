#!/usr/bin/env tsx
/**
 * Demo assembler (session 11): compose fixtures demo dirs from engine-run
 * outDirs (which must already contain per-size .export.json files).
 * Sizes that failed or produced nothing are LEFT OUT (curate, don't fake).
 *
 *   npx tsx scripts/assemble-demo.ts
 */
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findRepoRoot } from '../src/shared/env.js';
import { rowStatusFromChecks } from '../src/server/adfit/batch.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

interface DemoDef {
  key: string;
  brand: string;
  outDir: string;
  sourceFile: string;
  sizes: string[];
  /** Per-size override outDir (re-runs kept for single sizes). */
  sizeSrc?: Record<string, string>;
  /** Extra run dirs whose model/image call counts merge into the job totals. */
  extraReports?: string[];
}

const DEMOS: DemoDef[] = [
  { key: 'luma', brand: 'luma', outDir: 'artifacts/demo-v3/luma', sourceFile: 'source-en.png', sizes: ['ig-feed-45', 'ig-story-916', 'fb-link'] },
  { key: 'stride', brand: 'stride', outDir: 'artifacts/demo-nb/stride', sourceFile: 'source-en.png', sizes: ['ig-feed-11', 'ig-feed-45', 'fb-link'] },
  { key: 'northbean', brand: 'northbean', outDir: 'artifacts/demo-v3/northbean', sourceFile: 'source-en.png', sizes: ['ig-feed-11', 'ig-feed-45', 'ig-story-916'] },
  { key: 'teva', brand: 'teva', outDir: 'artifacts/demo-v3/teva', sourceFile: 'source-he.png', sizes: ['ig-feed-11', 'ig-feed-45'] },
  { key: 'sheket', brand: 'sheket', outDir: 'artifacts/demo-v3/sheket2', sourceFile: 'source-he.png', sizes: ['ig-feed-11', 'ig-feed-45'] },
];

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  for (const d of DEMOS) {
    const src = join(REPO_ROOT, d.outDir);
    const files = await readdir(src).catch(() => null);
    if (!files) {
      console.log(`${d.key}: no outDir ${d.outDir} — run engine first`);
      continue;
    }
    const report = JSON.parse(await readFile(join(src, 'report.json'), 'utf8')) as {
      firstPreviewMs: number | null; totalMs: number; jobModelCalls: number; jobImageCalls: number;
    };
    let modelCalls = report.jobModelCalls;
    let imageCalls = report.jobImageCalls;
    for (const extra of d.extraReports ?? []) {
      try {
        const r = JSON.parse(await readFile(join(REPO_ROOT, extra, 'report.json'), 'utf8')) as {
          jobModelCalls: number; jobImageCalls: number;
        };
        modelCalls += r.jobModelCalls;
        imageCalls += r.jobImageCalls;
      } catch {
        console.log(`${d.key}: extra report ${extra} missing — counts partial`);
      }
    }
    const demoDir = join(REPO_ROOT, 'fixtures', 'brands', d.brand, 'demo');
    await rm(demoDir, { recursive: true, force: true });
    await mkdir(demoDir, { recursive: true });
    const outputs: Array<Record<string, unknown>> = [];
    for (const preset of d.sizes) {
      const sizeDir = join(REPO_ROOT, d.sizeSrc?.[preset] ?? d.outDir);
      const expPath = join(sizeDir, `${preset}.export.json`);
      const pngPath = join(sizeDir, `${preset}.png`);
      if (!(await exists(expPath)) || !(await exists(pngPath))) {
        console.log(`${d.key}/${preset}: SKIP (missing export or png)`);
        continue;
      }
      const exp = JSON.parse(await readFile(expPath, 'utf8')) as {
        plan: Record<string, unknown> | null; manifest: unknown; proofs: unknown; checks: Record<string, unknown> & { repaired: { patches: string[]; before: string | null } | null };
        imageCalls: number; latencyMs: number; trace: unknown; error: string | null; repairedPatches: string[] | null;
      };
      if (exp.error || !exp.plan || !exp.manifest) {
        console.log(`${d.key}/${preset}: SKIP (${exp.error ?? 'no plan/manifest'})`);
        continue;
      }
      await copyFile(pngPath, join(demoDir, `${preset}.png`));
      const beforeSrc = join(sizeDir, `before-${preset}.png`);
      let before: string | null = null;
      if (exp.repairedPatches && (await exists(beforeSrc))) {
        await copyFile(beforeSrc, join(demoDir, `before-${preset}.png`));
        before = `before-${preset}.png`;
        if (exp.checks.repaired) exp.checks.repaired.before = `fixtures/brands/${d.brand}/demo/before-${preset}.png`;
      }
      const status = rowStatusFromChecks(exp.checks as Parameters<typeof rowStatusFromChecks>[0]);
      outputs.push({
        source: `demo-src-${d.key}`, sourceLabel: d.sourceFile, preset, mode: 'protected', status,
        image: `${preset}.png`, before,
        plan: { ...exp.plan, manifest: exp.manifest },
        proof: exp.proofs, qa: null, retries: 0, modelCalls: 0,
        imageCalls: exp.imageCalls, latencyMs: exp.latencyMs, trace: exp.trace, error: null,
        checks: exp.checks,
      });
      console.log(`${d.key}/${preset}: ${status}${before ? ' (repaired, before kept)' : ''}`);
    }
    await writeFile(join(demoDir, 'demo.json'), `${JSON.stringify({
      brand: d.brand, mode: 'protected', finishedAt: new Date().toISOString(),
      modelCalls, imageCalls,
      firstPreviewMs: report.firstPreviewMs, totalMs: report.totalMs,
      outputs,
    }, null, 2)}\n`);
    console.log(`${d.key}: demo.json with ${outputs.length}/${d.sizes.length} sizes`);
  }
}

await main();
