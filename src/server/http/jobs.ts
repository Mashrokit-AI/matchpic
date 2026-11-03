import { randomBytes } from 'node:crypto';

/**
 * One heavy job at a time (a generation job), bounded queue, per-IP hourly
 * rate limit, SSE fan-out with replay. All in-memory: the server is a single
 * process and jobs are short-lived demo runs.
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/** One finished output inside a job (a source × size cell). */
export interface JobRow {
  outputId: number;
  sourceId: string;
  sourceIndex: number;
  preset: string;
  status: 'pass' | 'needs_review' | 'failed';
  retries: number;
  /** Distinct model ids from the cell trace (for the live card footer). */
  models: string[];
  /** Summed trace durations in ms (for the live card footer). */
  traceMs: number;
  /** True while the batch review for this streamed preview is still pending. */
  pending?: boolean;
  error?: string;
  /** Final/preview chip states, same shape as the run-page card checks. */
  checks?: { protected: string; text: string; layout: string; repaired: boolean } | null;
}

export interface JobProgressEvent {
  type: 'progress';
  done: number;
  total: number;
  row: JobRow;
}

/** A streamed preview reached its final state (no progress increment). */
export interface JobUpdateEvent {
  type: 'update';
  done: number;
  total: number;
  row: JobRow;
}

export interface JobTerminalEvent {
  type: 'done' | 'failed';
  done: number;
  total: number;
  jobId?: string;
  error?: string;
}

/** Shared preparation step (analyze / masks / plan), emitted once per source. */
export interface JobPrepEvent {
  type: 'prep';
  step: 'analyze' | 'masks' | 'plan';
  state: 'start' | 'done';
  /** Step duration in ms (done events only). */
  ms?: number;
  /** Human detail, e.g. the planned size count. */
  detail?: string;
}

export interface JobQueueEvent {
  type: 'queue';
  status: JobStatus;
  /** Jobs ahead of this one (running + earlier queued); 0 once running. */
  ahead: number;
}

export type JobEvent = JobProgressEvent | JobUpdateEvent | JobTerminalEvent | JobPrepEvent | JobQueueEvent;

export type JobTask = (onRow: (row: JobRow) => void, onUpdate: (row: JobRow) => void, onPrep: (step: JobPrepEvent['step'], state: 'start' | 'done', ms?: number, detail?: string) => void) => Promise<JobResult>;

export interface JobResult {
  jobId?: string;
}

export interface Job {
  id: string;
  kind: 'generate' | 'regenerate' | 'demo-live';
  status: JobStatus;
  total: number;
  done: number;
  rows: JobRow[];
  jobId?: string;
  errorKey?: string;
  log: JobEvent[];
  listeners: Set<(e: JobEvent) => void>;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  task: JobTask | null;
}

export interface JobSummary {
  id: string;
  kind: 'generate' | 'regenerate' | 'demo-live';
  status: JobStatus;
  total: number;
  done: number;
  rows: JobRow[];
  jobId?: string;
  error?: string;
  /** Jobs ahead of this one; 0 when running/done. */
  queueAhead: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export function queueAhead(job: Job, waiting: Job[]): number {
  if (job.status !== 'queued') return 0;
  const i = waiting.indexOf(job);
  return i < 0 ? 0 : i + 1; // the running job is the +1
}

export function summarize(job: Job, waiting: Job[] = []): JobSummary {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    total: job.total,
    done: job.done,
    rows: [...job.rows],
    jobId: job.jobId,
    error: job.errorKey,
    queueAhead: queueAhead(job, waiting),
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly perHour: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when the call is allowed (and recorded); false when over the limit. */
  check(ip: string): boolean {
    const t = this.now();
    const list = (this.hits.get(ip) ?? []).filter((x) => t - x < 3600_000);
    if (list.length >= this.perHour) {
      this.hits.set(ip, list);
      return false;
    }
    list.push(t);
    this.hits.set(ip, list);
    return true;
  }
}

export class JobManager {
  private readonly jobs = new Map<string, Job>();
  private running: Job | null = null;
  private readonly waiting: Job[] = [];

  constructor(
    private readonly opts: { queueMax: number; jobTimeoutMs: number; now?: () => number },
  ) {}

  get(id: string): Job | null {
    return this.jobs.get(id) ?? null;
  }

  queuedCount(): number {
    return this.waiting.length;
  }

  queueAheadOf(job: Job): number {
    return queueAhead(job, this.waiting);
  }

  summary(job: Job): JobSummary {
    return summarize(job, this.waiting);
  }

  isBusy(): boolean {
    return this.running !== null;
  }

  /**
   * Submit a heavy task. The task runs `onRow` per finished output,
   * `onUpdate` when a streamed preview reaches its final state, and `onPrep`
   * for shared preparation steps, and resolves with the resulting store job
   * id. Returns null when the server is busy (running + queue full).
   */
  submit(kind: Job['kind'], total: number, task: JobTask): Job | null {
    if (this.running && this.waiting.length >= this.opts.queueMax) return null;
    const now = this.opts.now ?? Date.now;
    const job: Job = {
      id: randomBytes(9).toString('hex'),
      kind,
      status: this.running ? 'queued' : 'running',
      total,
      done: 0,
      rows: [],
      log: [],
      listeners: new Set(),
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      task,
    };
    this.jobs.set(job.id, job);
    if (this.jobs.size > 50) {
      const oldest = [...this.jobs.values()].find((j) => j.status === 'done' || j.status === 'failed');
      if (oldest && oldest.id !== job.id) this.jobs.delete(oldest.id);
    }
    if (this.running) {
      this.waiting.push(job);
      this.emit(job, { type: 'queue', status: 'queued', ahead: this.queueAheadOf(job) });
    } else {
      void this.execute(job);
    }
    return job;
  }

  onRow(job: Job, row: JobRow): void {
    job.done += 1;
    job.rows.push(row);
    this.emit(job, { type: 'progress', done: job.done, total: job.total, row });
  }

  /** Patch an already-streamed row to its final state (review landed). */
  updateRow(job: Job, row: JobRow): void {
    const i = job.rows.findIndex((r) => r.outputId === row.outputId);
    if (i >= 0) job.rows[i] = row;
    this.emit(job, { type: 'update', done: job.done, total: job.total, row });
  }

  prep(job: Job, step: JobPrepEvent['step'], state: 'start' | 'done', ms?: number, detail?: string): void {
    this.emit(job, { type: 'prep', step, state, ms, detail });
  }

  private emit(job: Job, event: JobEvent): void {
    job.log.push(event);
    for (const fn of job.listeners) {
      try {
        fn(event);
      } catch {
        // A broken listener must not break the job.
      }
    }
  }

  private finish(job: Job, event: JobTerminalEvent): void {
    if (job.status === 'done' || job.status === 'failed') return; // timeout already finished it
    if (event.type === 'done') {
      job.status = 'done';
      job.jobId = event.jobId;
    } else {
      job.status = 'failed';
      job.errorKey = event.error ?? 'err_job_failed';
    }
    job.finishedAt = (this.opts.now ?? Date.now)();
    this.emit(job, event);
    if (this.running === job) this.running = null;
    const next = this.waiting.shift();
    for (const w of [...this.waiting]) this.emit(w, { type: 'queue', status: 'queued', ahead: this.queueAheadOf(w) });
    if (next && next.task) {
      void this.execute(next);
    }
  }

  private async execute(job: Job): Promise<void> {
    const task = job.task;
    if (!task) {
      job.status = 'failed';
      job.errorKey = 'err_job_failed';
      return;
    }
    this.running = job;
    job.status = 'running';
    job.startedAt = (this.opts.now ?? Date.now)();
    this.emit(job, { type: 'queue', status: 'running', ahead: 0 });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.finish(job, { type: 'failed', done: job.done, total: job.total, error: 'err_job_timeout' });
    }, this.opts.jobTimeoutMs);
    // Don't hold the process open for a hung job.
    timer.unref?.();
    try {
      const result = await task(
        (row) => this.onRow(job, row),
        (row) => this.updateRow(job, row),
        (step, state, ms, detail) => this.prep(job, step, state, ms, detail),
      );
      if (timedOut) return;
      clearTimeout(timer);
      this.finish(job, { type: 'done', done: job.done, total: job.total, jobId: result.jobId });
    } catch {
      if (timedOut) return;
      clearTimeout(timer);
      this.finish(job, { type: 'failed', done: job.done, total: job.total, error: 'err_job_failed' });
    }
  }
}

/** SSE response: replays the job log, then streams until a terminal event. */
export function sseResponse(job: Job): Response {
  const encode = (e: JobEvent): string => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const enc = new TextEncoder();
  let listener: ((e: JobEvent) => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of job.log) controller.enqueue(enc.encode(encode(e)));
      const terminal = job.log.find((e) => e.type === 'done' || e.type === 'failed');
      if (terminal) {
        controller.close();
        return;
      }
      listener = (e: JobEvent): void => {
        controller.enqueue(enc.encode(encode(e)));
        if (e.type === 'done' || e.type === 'failed') {
          if (listener) job.listeners.delete(listener);
          controller.close();
        }
      };
      job.listeners.add(listener);
    },
    cancel() {
      if (listener) job.listeners.delete(listener);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}
