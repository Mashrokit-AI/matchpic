#!/usr/bin/env tsx
/**
 * MatchPic UI screenshot matrix + failure gate. Seeds the store, serves the real
 * app on 127.0.0.1 and drives it with Playwright:
 *
 *   npm run ui-shots [-- --live] [--port 3023]
 *
 * Shots: home (empty form + saved demo), output detail (overlays on), brands
 * (parsed template overlay) — each in EN+HE at 1440x900 and 390x844 →
 * artifacts/ui/. Exits nonzero on ANY console error, page error, failed
 * request, HTTP >= 400 or non-localhost request. --live additionally runs one
 * single-size demo-source job through the API (live model calls) and fails
 * when the job fails.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { chromium, type Browser, type Page } from 'playwright';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import { ensureSeeded } from '../src/server/adfit/seed.js';
import { Store } from '../src/server/store/db.js';
import { createApp } from '../src/server/http/app.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 3023;

const SHOTS_DIR = join(REPO_ROOT, 'artifacts', 'ui');
const VIEWPORTS = [
  { name: '1440', width: 1440, height: 900 },
  { name: '390', width: 390, height: 844 },
] as const;
const LANGS = ['en', 'he'] as const;

interface Problem {
  shot: string;
  kind: string;
  detail: string;
}

const problems: Problem[] = [];

function watch(page: Page, shot: string): void {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push({ shot, kind: 'console', detail: m.text().slice(0, 300) });
  });
  page.on('pageerror', (e) => problems.push({ shot, kind: 'pageerror', detail: String(e).slice(0, 300) }));
  page.on('requestfailed', (r) => problems.push({ shot, kind: 'requestfailed', detail: `${r.url()} ${r.failure()?.errorText ?? ''}`.slice(0, 300) }));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push({ shot, kind: `http-${r.status()}`, detail: r.url().slice(0, 300) });
  });
  page.on('request', (r) => {
    try {
      const host = new URL(r.url()).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost') {
        problems.push({ shot, kind: 'external-request', detail: r.url().slice(0, 300) });
      }
    } catch {
      // Non-URL requests (data:) are fine.
    }
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

async function main(): Promise<void> {
  mkdirSync(SHOTS_DIR, { recursive: true });
  // Fresh throwaway store every run: the seed is idempotent, so reusing the
  // dev DB would screenshot a stale demo after fixture re-exports.
  const dbPath = join(SHOTS_DIR, '.shots.db');
  rmSync(dbPath, { force: true });
  ensureSeeded(REPO_ROOT, dbPath);
  // A fake mid-run job (no live credits): exercises the skeleton tiles +
  // prep line via the run-page polling fallback.
  {
    const store = Store.open(dbPath);
    try {
      store.insertJob({
        id: 'shot-running', brandId: null, mode: 'protected',
        sizes: ['ig-feed-11', 'ig-feed-45', 'ig-story-916', 'fb-feed', 'fb-link', 'li-post', 'yt-thumb', 'tiktok-916'],
        sources: [],
      });
    } finally {
      store.close();
    }
  }
  const app = createApp({ repoRoot: REPO_ROOT, dbPath });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 500));
  const base = `http://127.0.0.1:${PORT}`;
  console.log(`ui-shots: serving ${base}`);

  const demo = (await (await fetch(`${base}/api/demo`)).json()) as {
    outputs: Array<{ id: number; preset: string; mode: string }>;
  };
  const firstOutput = demo.outputs[0];
  if (!firstOutput) throw new Error('demo job has no outputs — run the live batch first');
  console.log(`ui-shots: demo output #${firstOutput.id} (${firstOutput.preset}, ${firstOutput.mode})`);
  const examples = (await (await fetch(`${base}/api/examples`)).json()) as {
    examples: Array<{ jobId: string; brandName: string | null }>;
  };
  console.log(`ui-shots: ${examples.examples.length} examples`);
  // A throwaway user brand for the new-brand empty state + delete confirm.
  const shotBrand = (await (
    await fetch(`${base}/api/brands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shot Brand', colors: ['#0e6b45', '#e8a13d'] }),
    })
  ).json()) as { id: string };
  console.log(`ui-shots: shot brand ${shotBrand.id}`);

  // Plain Playwright Chromium only: never system Chrome, never --single-process.
  const launchBrowser = (): Promise<Browser> => chromium.launch();
  let browser: Browser = await launchBrowser();
  try {
    for (const lang of LANGS) {
      for (const vp of VIEWPORTS) {
        const shots: Array<{ name: string; hash: string; desktopOnly?: boolean; full?: boolean; setup?: (p: Page) => Promise<void> }> = [
          {
            name: 'home',
            hash: '#/',
            setup: async (p) => {
              await p.locator('.strip-item').first().waitFor({ timeout: 15000 });
              await p.locator('.showcase-src').waitFor({ timeout: 15000 });
            },
          },
          {
            name: 'detail',
            hash: `#/output/${firstOutput.id}`,
            setup: async (p) => {
              await p.locator('.stage img').first().waitFor({ timeout: 15000 });
            },
          },
          {
            name: 'xray',
            hash: `#/output/${firstOutput.id}`,
            setup: async (p) => {
              await p.locator('.stage img').first().waitFor({ timeout: 15000 });
              const xray = p.getByRole('button', { name: /x-ray|רנטגן/i });
              if ((await xray.count()) > 0 && xray.first() && (await xray.first().isEnabled())) {
                await xray.first().click();
              }
              const safe = p.getByRole('button', { name: /safe area|אזור בטוח/i });
              if ((await safe.count()) > 0 && safe.first() && (await safe.first().isEnabled())) {
                await safe.first().click();
              }
              await p.waitForTimeout(600);
            },
          },
          {
            name: 'verify',
            hash: `#/output/${firstOutput.id}`,
            setup: async (p) => {
              await p.locator('.stage img').first().waitFor({ timeout: 15000 });
              if ((await p.locator('details.verify[open]').count()) === 0) {
                await p.locator('details.verify summary').click();
              }
              await p.waitForTimeout(400);
              await p.locator('details.verify').scrollIntoViewIfNeeded();
            },
          },
          { name: 'brands', hash: '#/brands' },
          {
            name: 'brand-open',
            hash: '#/brands/vela',
            full: true,
            setup: async (p) => {
              await p.locator('.ex-cell img').first().waitFor({ timeout: 15000 });
              await p.locator('.prompt-list').first().waitFor({ timeout: 15000 });
              await p.waitForTimeout(800);
            },
          },
          {
            name: 'brand-new',
            hash: `#/brands/${shotBrand.id}?new=1`,
            full: true,
            setup: async (p) => {
              await p.locator('.steps .step').first().waitFor({ timeout: 15000 });
              await p.waitForTimeout(500);
            },
          },
          {
            name: 'brand-delete',
            hash: `#/brands/${shotBrand.id}`,
            setup: async (p) => {
              const del = p.getByRole('button', { name: /Delete brand|מחיקת מותג/ });
              await del.waitFor({ timeout: 15000 });
              await del.click();
              const row = p.locator('.confirm-row').last();
              await row.waitFor({ timeout: 15000 });
              await row.scrollIntoViewIfNeeded();
              await p.waitForTimeout(400);
            },
          },
          { name: 'about', hash: '#/about' },
          {
            name: 'home-full',
            hash: '#/',
            full: true,
            setup: async (p) => {
              await p.locator('.strip-item').first().waitFor({ timeout: 15000 });
              await p.locator('.showcase-src').waitFor({ timeout: 15000 });
              await p.waitForTimeout(800);
            },
          },
          {
            name: 'run',
            hash: '#/run/shot-running',
            desktopOnly: true,
            setup: async (p) => {
              await p.locator('.tile .skel').first().waitFor({ timeout: 15000 });
              await p.locator('.prep-line').first().scrollIntoViewIfNeeded();
            },
          },
        ];
        for (let i = 0; i < examples.examples.length; i++) {
          const ex = examples.examples[i]!;
          shots.push({
            name: `example-${i}`,
            hash: '#/',
            desktopOnly: true,
            setup: async (p) => {
              await p.locator('.strip-item').first().waitFor({ timeout: 15000 });
              await p.locator(`.strip-item[data-job="${ex.jobId}"]`).click();
              await p.locator('.strip-item[aria-pressed="true"] .lab').first().waitFor({ timeout: 15000 });
              await p.locator('.showcase-cell img').first().waitFor({ timeout: 15000 });
              await p.waitForTimeout(800);
            },
          });
        }
        for (const s of shots) {
          if (s.desktopOnly && vp.name !== '1440') continue;
          const shotName = `${s.name}-${lang}-${vp.name}`;
          let page;
          try {
            page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
          } catch {
            // Single-process mode can drop the browser between shots; relaunch.
            browser = await launchBrowser();
            page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
          }
          watch(page, shotName);
          await page.goto(`${base}/?lang=${lang}${s.hash}`, { waitUntil: 'domcontentloaded' });
          await settle(page);
          if (s.setup) await s.setup(page);
          await page.screenshot({ path: join(SHOTS_DIR, `${shotName}.png`), fullPage: s.full ?? false });
          console.log(`shot: ${shotName}.png`);
          const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          if (pageOverflow > 1) problems.push({ shot: shotName, kind: 'page-overflow-x', detail: `${pageOverflow}px wider than the viewport` });
          if (s.full) {
            const pageH = await page.evaluate(() => document.documentElement.scrollHeight);
            console.log(`  full page height: ${pageH}px`);
          }
          await page.close();
        }
      }
    }

    if (LIVE) {
      // One single-size live job through the API (protected, demo source).
      const fd = new FormData();
      fd.append('demoSource', 'gali-he');
      fd.append('sizes', 'ig-feed-11');
      fd.append('mode', 'protected');
      fd.append('brandId', 'gali');
      const sub = await fetch(`${base}/api/jobs`, { method: 'POST', body: fd });
      if (sub.status !== 202) throw new Error(`live job submit → HTTP ${sub.status}: ${(await sub.text()).slice(0, 200)}`);
      const { key, jobId } = (await sub.json()) as { key: string; jobId: string };
      console.log(`live: job ${jobId} submitted, following SSE...`);
      const deadline = Date.now() + 600_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 5000));
        const poll = (await (await fetch(`${base}/api/live/${key}`)).json()) as { job: { status: string; rows: Array<{ status: string }> } };
        if (poll.job.status === 'done') {
          console.log(`live: job done, rows: ${poll.job.rows.map((r) => r.status).join(',')}`);
          if (poll.job.rows.some((r) => r.status === 'failed')) throw new Error('live job produced a failed output');
          break;
        }
        if (poll.job.status === 'failed') throw new Error('live job failed');
        if (Date.now() > deadline) throw new Error('live job timed out');
      }
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }

  if (problems.length > 0) {
    console.log(`\nui-shots: ${problems.length} problem(s):`);
    for (const p of problems) console.log(`- [${p.shot}] ${p.kind}: ${p.detail}`);
    process.exit(1);
  }
  console.log('\nui-shots: clean — no console errors, failed or external requests.');
}

void main();
