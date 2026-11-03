/** Shared DOM/API helpers for the no-framework UI. */
import { BRAND_NAME } from '../shared/brand.js';
import { STRINGS, type Lang } from '../shared/i18n.js';
import { PRESETS } from '../shared/presets.js';

export { BRAND_NAME };

export function getLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'he' || q === 'en') {
      window.localStorage.setItem('adfit-lang', q);
      return q;
    }
    return window.localStorage.getItem('adfit-lang') === 'he' ? 'he' : 'en';
  } catch {
    return 'en';
  }
}

export function setLang(lang: Lang): void {
  try {
    window.localStorage.setItem('adfit-lang', lang);
  } catch {
    // Private mode: the toggle still works for this page load.
  }
}

export function applyLang(lang: Lang): void {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr';
  document.title = `${BRAND_NAME} — ${STRINGS[lang].hero_title}`;
}

export type ElSpec = {
  tag?: string;
  attrs?: Record<string, string>;
  text?: string;
  html?: string;
  cls?: string;
  children?: Array<HTMLElement | Text | null | undefined>;
};

/** Tiny element builder. `text` is always plain text (never parsed as HTML). */
export function el(spec: ElSpec & { tag?: string }): HTMLElement {
  const node = document.createElement(spec.tag ?? 'div');
  if (spec.cls) node.className = spec.cls;
  for (const [k, v] of Object.entries(spec.attrs ?? {})) {
    if (k === 'href' && !isSafeHref(v)) continue;
    node.setAttribute(k, v);
  }
  if (spec.text !== undefined) node.textContent = spec.text;
  else if (spec.html !== undefined) node.innerHTML = spec.html;
  for (const c of spec.children ?? []) {
    if (c) node.append(c);
  }
  return node;
}

/** Absolute paths, hashes, http(s) and scheme-less relative paths (api/…, media/…); never javascript: or data:. */
export function isSafeHref(v: string): boolean {
  return v.startsWith('/') || v.startsWith('#') || /^(https?):\/\//.test(v) || /^[\w.-]+(\/|\?|$)/.test(v);
}

export function t(lang: Lang, key: keyof typeof STRINGS.en): string {
  return STRINGS[lang][key];
}

/** Wrap an LTR token (dimensions, prices, model ids) so it never scrambles Hebrew. */
export function bidi(text: string, cls = ''): HTMLElement {
  return el({ tag: 'span', text: text, cls: `bidi ${cls}`.trim(), attrs: { dir: 'ltr' } });
}

/** Viewable output across old and new rows: 'pass', 'needs_review' (shown with an amber chip) and legacy 'done'. Only 'failed' has no image. */
export function isOkStatus(status: string): boolean {
  return status === 'done' || status === 'pass' || status === 'needs_review';
}

/** Bidi-isolated `W\u00d7H` string for dimensions inside Hebrew sentences. */
export function dims(w: number, h: number): string {
  return `\u2066${w}\u00d7${h}\u2069`;
}

export async function api<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? 'err_unknown');
  }
  return (await res.json()) as T;
}

export async function apiPost(path: string, body: FormData | Record<string, unknown>): Promise<Response> {
  const init: RequestInit =
    body instanceof FormData
      ? { method: 'POST', body }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  return fetch(path, init);
}

export async function apiPatch(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

export async function apiDelete(path: string): Promise<Response> {
  return fetch(path, { method: 'DELETE' });
}

export async function uploadFilesWithProgress(
  path: string,
  files: File[],
  fields: Record<string, string>,
  onProgress: (ratio: number) => void,
): Promise<Response> {
  const data = new FormData();
  files.forEach((f, i) => data.append(`file${i}`, f, f.name));
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  onProgress(0.05);
  try {
    const res = await fetch(path, { method: 'POST', body: data });
    onProgress(1);
    return res;
  } catch (err) {
    onProgress(0);
    throw err;
  }
}

export function presetLabel(id: string): string {
  return PRESETS.find((p) => p.id === id)?.label ?? id;
}

export function presetDims(id: string): { w: number; h: number } | null {
  const p = PRESETS.find((p) => p.id === id);
  return p ? { w: p.width, h: p.height } : null;
}

export function dimsLabel(id: string): string | null {
  const d = presetDims(id);
  return d ? `${d.w}×${d.h}` : null;
}

/** Orientation group for the result grid: square/portrait/vertical first. */
export function groupOf(presetId: string): 'square' | 'portrait' | 'vertical' | 'wide' {
  const d = presetDims(presetId);
  if (!d) return 'square';
  const r = d.w / d.h;
  if (r < 0.8) return 'vertical';
  if (r < 1) return 'portrait';
  if (r > 1.3) return 'wide';
  return 'square';
}

export type CheckState = 'pending' | 'passed' | 'fixed' | 'needs_review' | 'failed';

/** One status chip: label + state word. State drives the colour. */
export function statusChip(label: string, state: CheckState, word: string): HTMLElement {
  return el({
    tag: 'span',
    cls: `st ${state}`,
    children: [el({ tag: 'span', text: label }), el({ tag: 'span', cls: 'w', text: word })],
  });
}

/** Back-compat alias (older call sites). */
export const checkBadge = statusChip;

export function trRow(cells: Array<string | HTMLElement>): HTMLElement {
  return el({
    tag: 'tr',
    children: cells.map((c) => el({ tag: 'td', children: [typeof c === 'string' ? el({ tag: 'span', text: c }) : c] })),
  });
}

/** Paint a grayscale mask buffer green over a canvas (X-ray). */
export function maskCanvas(gray: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = gray[i] ?? 0;
    const o = i * 4;
    if (v > 0) {
      img.data[o] = 31;
      img.data[o + 1] = 168;
      img.data[o + 2] = 79;
      img.data[o + 3] = 190;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function debounce<F extends (...args: never[]) => void>(fn: F, ms: number): F {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: never[]): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  return wrapped as F;
}

/** Format ms as `14.2 s` / `61 s` / `2:05` for the run line. */
export function fmtDur(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Mirrored arrow glyph: base art points right; pass flip to mirror. */
export function arrowSvg(flip: boolean): string {
  return `<svg class="${flip ? 'flip-rtl' : ''}" width="24" height="16" viewBox="0 0 24 16" fill="none" aria-hidden="true"><path d="M1 8h21M16 2.5 21.5 8 16 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** Thin down arrow (showcase: source → conversions). Never mirrored. */
export function arrowDownSvg(): string {
  return `<svg width="16" height="24" viewBox="0 0 16 24" fill="none" aria-hidden="true"><path d="M8 1v21M2.5 16 8 21.5 13.5 16" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
