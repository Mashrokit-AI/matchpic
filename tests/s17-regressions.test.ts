import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager } from '../src/server/http/jobs.js';
import { buildJob } from '../src/server/http/dto.js';
import { createApp } from '../src/server/http/app.js';
import { Store } from '../src/server/store/db.js';
import { isSafeHref } from '../src/web/lib.js';
import { presetById } from '../src/shared/presets.js';
import { planLayout, freeHeadlineSubtext } from '../src/server/adfit/planner.js';
import { manifestFromPlan, enforceManifest } from '../src/server/adfit/manifest.js';
import type { SourceAnalysis } from '../src/shared/schemas.js';

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } dirs = []; });
function tmp(): string { const d = mkdtempSync(join(tmpdir(), 's17-')); dirs.push(d); return d; }
const wait = async (fn: () => boolean) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 10)); };

describe('bug1: queued jobs actually run', () => {
  it('starts the queued job after the running one, in order, with queue position', async () => {
    const mgr = new JobManager({ queueMax: 3, jobTimeoutMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const order: string[] = [];
    const j1 = mgr.submit('generate', 1, async () => { await gate; order.push('first'); return {}; });
    const j2 = mgr.submit('generate', 1, async () => { order.push('second'); return {}; });
    const j3 = mgr.submit('generate', 1, async () => { order.push('third'); return {}; });
    expect(j2?.status).toBe('queued');
    expect(mgr.queueAheadOf(j2!)).toBe(1);
    expect(mgr.queueAheadOf(j3!)).toBe(2);
    expect(mgr.summary(j2!).queueAhead).toBe(1);
    expect(j2?.startedAt).toBeNull();
    release();
    await wait(() => mgr.get(j3!.id)?.status === 'done');
    expect(order).toEqual(['first', 'second', 'third']);
    expect(mgr.get(j2!.id)?.status).toBe('done');
    expect(mgr.get(j2!.id)?.startedAt).not.toBeNull();
  });

  it('a queued job whose SSE client never connects still runs', async () => {
    const mgr = new JobManager({ queueMax: 3, jobTimeoutMs: 60_000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mgr.submit('generate', 1, async () => { await gate; return {}; });
    const j2 = mgr.submit('generate', 1, async () => ({}));
    release();
    await wait(() => mgr.get(j2!.id)?.status === 'done');
    expect(mgr.get(j2!.id)?.status).toBe('done');
  });
});

describe('bug2: stale running jobs fail on startup', () => {
  it('Store.failStaleRunningJobs marks running+queued failed with finished_at', () => {
    const root = tmp();
    const dbPath = join(root, 't.db');
    const s = Store.open(dbPath);
    s.insertJob({ id: 'stale1', brandId: null, mode: 'protected', sizes: [], sources: [] });
    s.insertJob({ id: 'stale2', brandId: null, mode: 'protected', sizes: [], sources: [], status: 'queued' });
    s.insertJob({ id: 'ok1', brandId: null, mode: 'protected', sizes: [], sources: [] });
    s.finishJob('ok1', 'done', null, 0, 0);
    expect(s.failStaleRunningJobs()).toBe(2);
    expect(s.getJob('stale1')).toMatchObject({ status: 'failed', error: 'err_job_interrupted' });
    expect(s.getJob('stale1')?.finished_at).not.toBeNull();
    expect(s.getJob('ok1')?.status).toBe('done');
    s.close();
  });

  it('createApp fails stale rows left by a previous process', () => {
    const root = tmp();
    const dbPath = join(root, 'data', 't.db');
    mkdirSync(join(root, 'web'), { recursive: true });
    writeFileSync(join(root, 'web', 'index.html'), '<html>hi</html>');
    const s = Store.open(dbPath);
    s.insertJob({ id: 'dead', brandId: null, mode: 'protected', sizes: [], sources: [] });
    s.close();
    createApp({ repoRoot: root, dbPath, webRoot: join(root, 'web') });
    const s2 = Store.open(dbPath);
    expect(s2.getJob('dead')).toMatchObject({ status: 'failed', error: 'err_job_interrupted' });
    s2.close();
  });
});

describe('bug3+4: run DTO carries final checks and real duration', () => {
  function seeded(root: string) {
    const dbPath = join(root, 't.db');
    const s = Store.open(dbPath);
    const created = '2026-11-03T10:00:00.000Z';
    s.insertJob({ id: 'j1', brandId: null, mode: 'protected', sizes: ['ig-feed-11'], sources: ['s1'], createdAt: created });
    const oid = s.insertOutput({
      jobId: 'j1', sourceId: 's1', preset: 'ig-feed-11', mode: 'protected', status: 'needs_review',
      imagePath: 'data/x.png', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
      modelCalls: 0, imageCalls: 0, latencyMs: 1, traceJson: '[]', error: null,
      checksJson: JSON.stringify({ protected_pixels: { status: 'pending', detail: '' }, text: { status: 'pending', detail: '' }, layout_review: { status: 'pending', detail: '' }, repaired: null }),
      createdAt: '2026-11-03T10:01:50.000Z',
    });
    return { s, oid };
  }

  it('chips converge to the stored final checks, not pending and not always pass', () => {
    const { s, oid } = seeded(tmp());
    let dto = buildJob(s, 'j1')!;
    expect(dto.outputs[0]?.checks.protected).toBe('pending');
    s.updateOutput(oid, {
      status: 'needs_review',
      checksJson: JSON.stringify({ protected_pixels: { status: 'passed', detail: '' }, text: { status: 'passed', detail: '' }, layout_review: { status: 'fixed', detail: '' }, repaired: { before: 'data/b.png', patches: [] } }),
    });
    dto = buildJob(s, 'j1')!;
    expect(dto.outputs[0]?.status).toBe('needs_review');
    expect(dto.outputs[0]?.checks).toEqual({ protected: 'passed', text: 'passed', layout: 'fixed', repaired: true });
    s.close();
  });

  it('totalMs uses created→finished (8:23), never elapsed-until-now', () => {
    const { s } = seeded(tmp());
    s.finishJob('j1', 'done', null, 0, 0, '2026-11-03T10:08:23.000Z');
    const dto = buildJob(s, 'j1')!;
    expect(dto.totalMs).toBe(503_000);
    expect(dto.firstPreviewMs).toBe(110_000);
    s.close();
  });

  it('a queued job is timed from when it started, not from submission', () => {
    const s = Store.open(join(tmp(), 'q.db'));
    s.insertJob({ id: 'q1', brandId: null, mode: 'protected', sizes: ['ig-feed-11'], sources: ['s1'], createdAt: '2026-11-03T10:00:00.000Z', status: 'queued' });
    expect(s.getJob('q1')?.started_at).toBeNull();
    s.setJobStatus('q1', 'running', '2026-11-03T10:07:00.000Z');
    s.setJobStatus('q1', 'running', '2026-11-03T10:09:00.000Z'); // a second call keeps the first start
    s.insertOutput({
      jobId: 'q1', sourceId: 's1', preset: 'ig-feed-11', mode: 'protected', status: 'pass',
      imagePath: 'data/x.png', planJson: '{}', proofJson: null, qaJson: null, retries: 0,
      modelCalls: 0, imageCalls: 0, latencyMs: 1, traceJson: '[]', error: null, createdAt: '2026-11-03T10:09:00.000Z',
    });
    s.finishJob('q1', 'done', null, 0, 0, '2026-11-03T10:16:40.000Z');
    const dto = buildJob(s, 'q1')!;
    expect(dto.totalMs).toBe(580_000); // 9:40 of running, not 16:40 since submission
    expect(dto.firstPreviewMs).toBe(120_000);
    s.close();
  });
});

describe('bug6: no-brand layout does not overlap text on the panel stack', () => {
  it('price/shipping row stays clear of headline, subtext, panel and product on every preset', () => {
    const analysis = {
      language: 'en', direction: 'ltr',
      products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 390, y: 210, w: 300, h: 560 } }],
      logo_bbox: { x: 850, y: 56, w: 170, h: 84 },
      headline: { text: 'Big Sale', bbox: { x: 90, y: 600, w: 900, h: 100 }, bold: true, color: '#111111' },
      subtext: { text: 'Sub text', bbox: { x: 90, y: 710, w: 900, h: 60 }, bold: false, color: '#222222' },
      panel: { bbox: { x: 90, y: 820, w: 900, h: 170 }, opaque: true, bg_color: '#ff5a3c', text_color: '#ffffff', texts: ['Order now'] },
      other_texts: [
        { text: '$42', bbox: { x: 90, y: 760, w: 200, h: 50 }, bold: true, color: '#111111' },
        { text: 'Free shipping', bbox: { x: 300, y: 760, w: 300, h: 50 }, bold: false, color: '#111111' },
      ],
      background: { type: 'gradient', description: 'teal', colors: ['#e9f5f3'] },
      unreadable: [],
    } as unknown as SourceAnalysis;
    const ov = (a: { x: number; y: number; w: number; h: number }, b: typeof a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const id of ['ig-feed-11', 'ig-feed-45', 'ig-story-916', 'fb-feed', 'fb-link', 'li-post', 'yt-thumb', 'tiktok-916']) {
      const preset = presetById(id)!;
      const plan = planLayout({ preset, source: analysis, sourceWidth: 1080, sourceHeight: 1080, productCuts: [{ w: 300, h: 560 }], logoCut: { w: 170, h: 84 }, template: null });
      const m = enforceManifest({ manifest: manifestFromPlan({ plan, preset, planner: 'code', direction: 'ltr', freeText: freeHeadlineSubtext(analysis, plan), ctaPanel: false }), direction: 'ltr' });
      const els = m.elements.filter((e) => e.kind !== 'frame' && e.kind !== 'shadow');
      for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
        expect(ov(els[i]!.box, els[j]!.box), `${id}: ${els[i]!.id} overlaps ${els[j]!.id}`).toBe(false);
      }
    }
  });
});

describe('bug7: href safety keeps relative downloads, drops dangerous schemes', () => {
  it('allows the download/media/hash links the UI builds', () => {
    for (const h of ['api/runs/job-1/zip', 'media/thumb/12?v=1', '#/run/job-1', '/matchpic/', 'https://example.com/x']) expect(isSafeHref(h), h).toBe(true);
  });
  it('drops javascript:, data:, protocol-relative and backslash hrefs', () => {
    for (const h of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', '\\\\evil\\x']) expect(isSafeHref(h), h).toBe(false);
  });
});
