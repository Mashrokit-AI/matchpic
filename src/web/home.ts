/** Home: hero, setup card + showcase, live run, results. */
import { nativeName, presetName, type Lang } from '../shared/i18n.js';
import { PRESETS } from '../shared/presets.js';
import type { Route } from './app.js';
import type { ChecksDto, DetectedTextsDto, ExampleDto, JobDto, JobRow, OutputCardDto, OutputDetailDto } from './dto.js';
import {
  api, apiPost, arrowDownSvg, checkBadge, el, fmtDur, groupOf, isOkStatus, presetDims,
  presetLabel, statusChip, t, uploadFilesWithProgress,
} from './lib.js';

const DEFAULT_SIZES = ['ig-feed-11', 'ig-feed-45', 'fb-link', 'ig-story-916'];
const STATUS_WORD: Record<string, 'check_passed' | 'check_fixed' | 'check_needs_review' | 'check_pending'> = {
  passed: 'check_passed',
  fixed: 'check_fixed',
  needs_review: 'check_needs_review',
  pending: 'check_pending',
};

type TextsState =
  | { phase: 'idle' }
  | { phase: 'detecting' }
  | { phase: 'ready'; detected: DetectedTextsDto['texts'] }
  | { phase: 'editing'; detected: DetectedTextsDto['texts'] }
  | { phase: 'confirmed'; values: DetectedTextsDto['texts'] }
  | { phase: 'skipped' }
  | { phase: 'failed' };

function fmtClock(lang: Lang, iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function chipsFor(lang: Lang, c: OutputCardDto['checks']): HTMLElement[] {
  return [
    statusChip(t(lang, 'check_protected'), c.protected, t(lang, STATUS_WORD[c.protected])),
    statusChip(t(lang, 'check_text'), c.text, t(lang, STATUS_WORD[c.text])),
    statusChip(t(lang, 'check_layout'), c.layout, t(lang, STATUS_WORD[c.layout])),
  ];
}

/** Order conversions contrasting-first: vertical, wide, square, then the rest. */
function contrasting(outputs: OutputCardDto[]): OutputCardDto[] {
  const rank = (o: OutputCardDto): number => ({ vertical: 0, wide: 1, square: 2, portrait: 3 })[groupOf(o.preset)] ?? 4;
  return [...outputs].sort((a, b) => rank(a) - rank(b) || a.preset.localeCompare(b.preset));
}

export function renderHome(root: HTMLElement, lang: Lang, route: Route): void {
  root.append(
    el({
      tag: 'div', cls: 'hero-head', children: [
        el({ tag: 'h1', text: t(lang, 'hero_title') }),
        el({ tag: 'p', cls: 'sub', text: t(lang, 'hero_sub') }),
      ],
    }),
  );
  const grid = el({ tag: 'div', cls: 'hero-grid' });
  root.append(grid);
  const setupHost = el({ tag: 'section', cls: 'card setup-card', attrs: { 'aria-label': t(lang, 'try_title') } });
  const showcaseHost = el({ tag: 'aside', cls: 'showcase', attrs: { 'aria-label': t(lang, 'showcase_example') } });
  grid.append(setupHost, showcaseHost);
  const runHost = el({ tag: 'section', cls: 'run-sec' });
  root.append(runHost);

  const state = {
    files: [] as File[],
    sizes: new Set<string>(DEFAULT_SIZES),
    mode: 'protected' as string,
    texts: { phase: 'idle' } as TextsState,
    generating: false,
  };

  // ---------- setup card ----------
  setupHost.append(el({ tag: 'h2', text: t(lang, 'try_title') }));
  const drop = el({ tag: 'div', cls: 'drop', attrs: { role: 'button', tabindex: '0', 'aria-label': t(lang, 'drop_title') } });
  const fileInput = el({ tag: 'input', attrs: { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: 'true', hidden: 'true' } }) as HTMLInputElement;
  const bar = el({ tag: 'div', cls: 'bar', children: [el({ tag: 'div' })] });
  drop.append(
    el({ tag: 'div', cls: 'drop-title', text: t(lang, 'drop_title') }),
    el({ tag: 'div', cls: 'hint', text: t(lang, 'drop_hint') }),
    bar,
  );
  bar.hidden = true;
  setupHost.append(drop, fileInput);

  const previewHost = el({ tag: 'div' });
  const textsHost = el({ tag: 'div' });
  const stripHost = el({ tag: 'div', cls: 'strip-block' });
  setupHost.append(previewHost, textsHost, stripHost);

  const formRow = el({ tag: 'div', cls: 'formrow' });
  const brandSel = el({ tag: 'select', attrs: { 'aria-label': t(lang, 'brand_label') } }) as HTMLSelectElement;
  brandSel.append(el({ tag: 'option', text: t(lang, 'brand_none'), attrs: { value: '' } }) as HTMLOptionElement);
  const newBrandLink = el({ tag: 'a', cls: 'btn small secondary', text: t(lang, 'brand_new'), attrs: { href: '#/brands?create=1' } });
  newBrandLink.addEventListener('click', () => {
    try {
      sessionStorage.setItem('mp-brand-return', 'home');
    } catch { /* private mode: plain navigation */ }
  });
  const brandField = el({
    tag: 'div', cls: 'field', children: [
      el({ tag: 'label', text: t(lang, 'brand_label') }),
      el({
        tag: 'div', cls: 'brand-row', children: [
          brandSel,
          newBrandLink,
        ],
      }),
    ],
  });
  const modeSeg = el({ tag: 'div', cls: 'seg', attrs: { role: 'group', 'aria-label': t(lang, 'mode_label') } });
  const modeTip = el({
    tag: 'div', cls: 'mode-tip', attrs: { role: 'tooltip', hidden: 'true' }, children: [
      el({ tag: 'p', text: t(lang, 'mode_protected_tip') }),
      el({ tag: 'p', text: t(lang, 'mode_fast_tip') }),
    ],
  });
  const modeInfo = el({ tag: 'button', cls: 'info-btn', text: '?', attrs: { type: 'button', 'aria-label': t(lang, 'mode_tip_label'), 'aria-expanded': 'false' } }) as HTMLButtonElement;
  const setTip = (open: boolean): void => {
    modeTip.hidden = !open;
    modeInfo.setAttribute('aria-expanded', String(open));
  };
  modeInfo.addEventListener('click', (e) => {
    e.stopPropagation();
    // Open-only: hover/focus may have opened it a moment before the click,
    // so toggling here would instantly close it. Esc / outside / leave close.
    setTip(true);
  });
  modeInfo.addEventListener('mouseenter', () => setTip(true));
  modeInfo.addEventListener('mouseleave', () => setTip(false));
  modeInfo.addEventListener('focus', () => setTip(true));
  modeInfo.addEventListener('blur', () => setTip(false));
  const onDocClick = (e: MouseEvent): void => {
    if (!modeInfo.isConnected) {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      return;
    }
    if (!modeTip.hidden && !(e.target as HTMLElement).closest('.mode-row')) setTip(false);
  };
  const onDocKey = (e: KeyboardEvent): void => {
    if (!modeInfo.isConnected) {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onDocKey);
      return;
    }
    if (e.key === 'Escape' && !modeTip.hidden) {
      setTip(false);
      modeInfo.blur();
    }
  };
  document.addEventListener('click', onDocClick);
  document.addEventListener('keydown', onDocKey);
  const modeField = el({
    tag: 'div', cls: 'field', children: [
      el({ tag: 'label', text: t(lang, 'mode_label') }),
      el({ tag: 'div', cls: 'mode-row', children: [modeSeg, modeInfo, modeTip] }),
    ],
  });
  formRow.append(brandField, modeField);
  setupHost.append(formRow);

  const sizeChips = el({ tag: 'div', cls: 'chips', attrs: { role: 'group', 'aria-label': t(lang, 'sizes_label') } });
  setupHost.append(el({
    tag: 'div', cls: 'field', children: [
      el({ tag: 'label', text: t(lang, 'sizes_label') }),
      sizeChips,
    ],
  }));

  const genBtn = el({ tag: 'button', cls: 'btn', text: t(lang, 'btn_generate'), attrs: { type: 'button' } }) as HTMLButtonElement;
  const genHint = el({ tag: 'div', cls: 'gen-hint' });
  const genBlock = el({ tag: 'div', cls: 'gen-block', children: [genBtn, genHint] });
  setupHost.append(genBlock);
  const sticky = el({
    tag: 'div', cls: 'sticky-gen', children: [
      el({ tag: 'button', cls: 'btn', text: t(lang, 'btn_generate'), attrs: { type: 'button' } }),
      el({ tag: 'div', cls: 'gen-hint' }),
    ],
  });
  setupHost.append(sticky);
  const stickyBtn = sticky.children[0] as HTMLButtonElement;
  const stickyHint = sticky.children[1] as HTMLElement;
  // The sticky bar is a shortcut for after the main button scrolls away:
  // showing both at once reads as a duplicated button.
  if (typeof IntersectionObserver !== 'undefined') {
    new IntersectionObserver(
      (entries) => sticky.classList.toggle('show', !(entries[0]?.isIntersecting ?? true)),
      { threshold: 0 },
    ).observe(genBlock);
  } else {
    sticky.classList.add('show');
  }

  for (const m of ['protected', 'fast'] as const) {
    const b = el({ tag: 'button', text: m === 'protected' ? t(lang, 'mode_protected') : t(lang, 'mode_fast'), attrs: { type: 'button', 'aria-pressed': String(m === state.mode) } });
    b.addEventListener('click', () => {
      state.mode = m;
      for (const c of modeSeg.children) (c as HTMLElement).setAttribute('aria-pressed', String((c as HTMLElement).textContent === b.textContent));
      refreshGen();
    });
    modeSeg.append(b);
  }

  const refreshSizes = (): void => {
    sizeChips.textContent = '';
    const metaIds = PRESETS.filter((p) => p.meta).map((p) => p.id);
    const metaOn = metaIds.every((id) => state.sizes.has(id));
    const all = el({ tag: 'button', cls: `chipbtn${metaOn ? ' on' : ''}`, text: t(lang, 'sizes_all_meta'), attrs: { type: 'button', 'aria-pressed': String(metaOn) } });
    all.addEventListener('click', () => {
      state.sizes = new Set(metaOn ? [] : metaIds);
      refreshSizes();
      refreshGen();
    });
    sizeChips.append(all);
    for (const p of PRESETS) {
      const b = el({
        tag: 'button',
        cls: `chipbtn${state.sizes.has(p.id) ? ' on' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(state.sizes.has(p.id)) },
        children: [el({ tag: 'span', text: presetName(lang, p.id, p.label) }), el({ tag: 'span', cls: 'dims', text: `${p.width}×${p.height}`, attrs: { dir: 'ltr' } })],
      });
      b.addEventListener('click', () => {
        if (state.sizes.has(p.id)) state.sizes.delete(p.id);
        else state.sizes.add(p.id);
        refreshSizes();
        refreshGen();
      });
      sizeChips.append(b);
    }
  };
  refreshSizes();

  // ---------- detected text ----------
  const textsConfirmed = (): DetectedTextsDto['texts'] | null =>
    state.texts.phase === 'confirmed' ? state.texts.values : null;

  const refreshGen = (): void => {
    let hint = '';
    let disabled = state.generating;
    if (state.files.length === 0) {
      disabled = true;
      hint = t(lang, 'gen_need_image');
    } else if (state.sizes.size === 0) {
      disabled = true;
      hint = t(lang, 'gen_need_size');
    } else if (state.texts.phase === 'ready' || state.texts.phase === 'editing' || state.texts.phase === 'detecting') {
      disabled = true;
      hint = t(lang, 'gen_need_text');
    }
    genBtn.disabled = disabled;
    stickyBtn.disabled = disabled;
    genHint.textContent = state.generating ? '' : hint;
    stickyHint.textContent = state.generating ? '' : hint;
  };

  const renderTexts = (): void => {
    textsHost.textContent = '';
    const s = state.texts;
    if (s.phase === 'idle' || s.phase === 'skipped' || s.phase === 'failed') return;
    if (s.phase === 'detecting') {
      textsHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'texts_detecting') }));
      return;
    }
    const list = el({ tag: 'div', cls: 'texts-list' });
    const head = el({ tag: 'div', cls: 'texts-head' });
    head.append(el({ tag: 'h3', text: t(lang, 'texts_detected') }));
    const confirmed = s.phase === 'confirmed';
    const editing = s.phase === 'editing';
    const values = s.phase === 'confirmed' ? s.values : s.detected;
    const rows: Array<{ label: string; value: string; set: (v: string) => void }> = [];
    const pushRow = (label: string, value: string | null, set: (v: string) => void): void => {
      if (value === null || value === '') return;
      rows.push({ label, value, set });
    };
    const draft: DetectedTextsDto['texts'] = {
      headline: values.headline,
      subtext: values.subtext,
      panel: [...values.panel],
      others: [...values.others],
    };
    pushRow('H', values.headline, (v) => { draft.headline = v; });
    pushRow('S', values.subtext, (v) => { draft.subtext = v; });
    values.panel.forEach((p, i) => pushRow(`P${i + 1}`, p, (v) => { draft.panel[i] = v; }));
    values.others.forEach((o, i) => pushRow(`T${i + 1}`, o, (v) => { draft.others[i] = v; }));
    if (rows.length === 0) {
      textsHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'texts_none') }));
      if (s.phase === 'ready') state.texts = { phase: 'skipped' };
      refreshGen();
      return;
    }
    if (!confirmed) {
      const btns = el({ tag: 'div', children: [] });
      if (editing) {
        const ok = el({ tag: 'button', cls: 'linkbtn', text: t(lang, 'texts_confirm'), attrs: { type: 'button' } });
        ok.addEventListener('click', () => {
          state.texts = { phase: 'confirmed', values: draft };
          renderTexts();
          refreshGen();
        });
        btns.append(ok);
      } else {
        const edit = el({ tag: 'button', cls: 'linkbtn', text: t(lang, 'texts_edit'), attrs: { type: 'button' } });
        edit.addEventListener('click', () => {
          state.texts = { phase: 'editing', detected: values };
          renderTexts();
        });
        const ok = el({ tag: 'button', cls: 'linkbtn', text: t(lang, 'texts_confirm'), attrs: { type: 'button' } });
        ok.addEventListener('click', () => {
          state.texts = { phase: 'confirmed', values: draft };
          renderTexts();
          refreshGen();
        });
        const skip = el({ tag: 'button', cls: 'linkbtn', text: t(lang, 'texts_skip'), attrs: { type: 'button' } });
        skip.addEventListener('click', () => {
          state.texts = { phase: 'skipped' };
          renderTexts();
          refreshGen();
        });
        btns.append(edit, ok, skip);
      }
      head.append(btns);
    }
    list.append(head);
    for (const r of rows) {
      const row = el({ tag: 'div', cls: 'text-row' });
      if (editing) {
        const input = el({ tag: 'input', attrs: { value: r.value, 'aria-label': r.value } }) as HTMLInputElement;
        input.addEventListener('input', () => r.set(input.value));
        row.append(input);
      } else {
        row.textContent = r.value;
      }
      list.append(row);
    }
    textsHost.append(list);
  };

  const detectTexts = async (file: File): Promise<void> => {
    state.texts = { phase: 'detecting' };
    renderTexts();
    refreshGen();
    try {
      const body = new FormData();
      body.append('file0', file, file.name);
      const res = await fetch('api/analyze', { method: 'POST', body });
      if (!res.ok) throw new Error('analyze failed');
      const dto = (await res.json()) as DetectedTextsDto;
      state.texts = { phase: 'ready', detected: dto.texts };
    } catch {
      state.texts = { phase: 'failed' };
    }
    renderTexts();
    refreshGen();
  };

  // ---------- files ----------
  const renderPreview = (): void => {
    previewHost.textContent = '';
    if (state.files.length === 0) {
      drop.hidden = false;
      return;
    }
    drop.hidden = true;
    const first = state.files[0] as File;
    const url = URL.createObjectURL(first);
    const img = el({ tag: 'img', attrs: { src: url, alt: first.name } }) as HTMLImageElement;
    previewHost.append(
      el({ tag: 'div', cls: 'src-preview', children: [img] }),
      el({
        tag: 'div', cls: 'replace-row', children: [
          el({ tag: 'span', text: state.files.length === 1 ? first.name : `${state.files.length} ×` }),
          (() => {
            const b = el({ tag: 'button', cls: 'linkbtn', text: t(lang, 'texts_edit'), attrs: { type: 'button' } });
            b.textContent = t(lang, 'drop_title');
            b.addEventListener('click', () => fileInput.click());
            return b;
          })(),
        ],
      }),
    );
  };

  fileInput.addEventListener('change', () => {
    state.files = [...fileInput.files ?? []];
    state.texts = { phase: 'idle' };
    renderPreview();
    renderTexts();
    refreshGen();
    if (state.files.length > 0) void detectTexts(state.files[0] as File);
  });
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });
  for (const ev of ['dragenter', 'dragover'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop'] as const) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    });
  }
  drop.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length === 0) return;
    state.files = files;
    state.texts = { phase: 'idle' };
    renderPreview();
    renderTexts();
    refreshGen();
    void detectTexts(files[0] as File);
  });

  // ---------- brands ----------
  void api<{ brands: Array<{ id: string; name: string }> }>('api/brands').then(
    (b) => {
      for (const brand of b.brands) {
        brandSel.append(el({ tag: 'option', text: brand.name, attrs: { value: brand.id } }) as HTMLOptionElement);
      }
      // Returning from Brands-create: preselect the brand just made.
      try {
        const fresh = sessionStorage.getItem('mp-brand-new');
        if (fresh && b.brands.some((x) => x.id === fresh)) {
          brandSel.value = fresh;
          sessionStorage.removeItem('mp-brand-new');
          refreshGen();
        }
      } catch { /* private mode: no preselect */ }
    },
    () => undefined,
  );

  // ---------- example strip + showcase ----------
  let examples: ExampleDto[] = [];
  let selected: ExampleDto | null = null;
  let exampleJob: JobDto | null = null;

  const renderShowcase = (): void => {
    showcaseHost.textContent = '';
    if (!selected) {
      showcaseHost.append(el({ tag: 'div', cls: 'shimmer', attrs: { style: 'min-height:280px' } }));
      return;
    }
    const head = el({
      tag: 'div', cls: 'showcase-head', children: [
        el({ tag: 'span', cls: 'k', text: t(lang, 'showcase_example') }),
        el({ tag: 'span', cls: 'v', text: selected.brandName ?? '' }),
      ],
    });
    showcaseHost.append(head);
    const srcLink = el({ tag: 'a', cls: 'imglink', attrs: { href: `#/run/${selected.jobId}` } });
    const srcImg = el({ tag: 'img', cls: 'showcase-src', attrs: { src: selected.sourceThumb, alt: selected.brandName ?? '', fetchpriority: 'high' } }) as HTMLImageElement;
    srcImg.loading = 'eager';
    srcLink.append(srcImg);
    showcaseHost.append(srcLink);
    showcaseHost.append(el({
      tag: 'div', cls: 'imglabel', children: [
        el({ tag: 'span', text: `${t(lang, 'detail_before')} · ` }),
        selected.nativePreset ? el({ tag: 'span', text: nativeName(lang, selected.nativePreset) }) : null,
      ],
    }));
    showcaseHost.append(el({ tag: 'div', cls: 'showcase-arrow', html: arrowDownSvg() }));
    if (!exampleJob) {
      showcaseHost.append(el({ tag: 'div', cls: 'shimmer', attrs: { style: 'min-height:180px' } }));
      return;
    }
    const outs = contrasting(exampleJob.outputs.filter((o) => isOkStatus(o.status)));
    const top = outs.slice(0, 3);
    const rest = outs.slice(3);
    const row3 = el({ tag: 'div', cls: 'showcase-3' });
    for (const o of top) row3.append(showcaseCell(lang, o));
    showcaseHost.append(row3);
    if (rest.length > 0) {
      showcaseHost.append(el({ tag: 'div', cls: 'imglabel', text: t(lang, 'showcase_all_sizes').replace('{n}', String(outs.length)) }));
      const all = el({ tag: 'div', cls: 'showcase-all' });
      for (const o of rest) all.append(showcaseCell(lang, o));
      showcaseHost.append(all);
    }
    const stamp = fmtClock(lang, selected.finishedAt);
    if (stamp) showcaseHost.append(el({ tag: 'div', cls: 'imglabel', text: stamp }));
  };

  /** Preload the selected example's pixels so the showcase paints at once. */
  const preloadExample = (ex: ExampleDto, job: JobDto | null): void => {
    const urls = [ex.sourceThumb];
    if (job) {
      for (const o of contrasting(job.outputs.filter((o) => isOkStatus(o.status))).slice(0, 4)) {
        urls.push(`${o.thumb}?v=${o.retries}`);
      }
    }
    for (const href of urls) {
      if (document.querySelector(`link[rel="preload"][href="${href}"]`)) continue;
      document.head.append(el({ tag: 'link', attrs: { rel: 'preload', as: 'image', href } }));
    }
  };

  const loadExample = async (ex: ExampleDto): Promise<void> => {
    selected = ex;
    exampleJob = null;
    for (const btn of stripHost.querySelectorAll('button.strip-item')) {
      (btn as HTMLButtonElement).setAttribute('aria-pressed', String((btn as HTMLButtonElement).dataset.job === ex.jobId));
    }
    preloadExample(ex, null);
    renderShowcase();
    try {
      exampleJob = await api<JobDto>(`api/runs/${ex.jobId}`);
    } catch {
      exampleJob = null;
    }
    if (selected === ex) {
      preloadExample(ex, exampleJob);
      renderShowcase();
    }
  };

  const renderStrip = (): void => {
    stripHost.textContent = '';
    stripHost.append(el({ tag: 'div', cls: 'strip-head', text: t(lang, 'examples_title') }));
    if (examples.length === 0) {
      stripHost.append(el({ tag: 'div', cls: 'strip', children: [0, 1, 2].map(() => el({ tag: 'div', cls: 'shimmer strip-shimmer' })) }));
      return;
    }
    const strip = el({ tag: 'div', cls: 'strip', attrs: { role: 'group', 'aria-label': t(lang, 'examples_title') } });
    for (const ex of examples.slice(0, 5)) {
      const btn = el({
        tag: 'button', cls: 'strip-item', attrs: { type: 'button', 'aria-pressed': String(selected?.jobId === ex.jobId) },
        children: [
          el({ tag: 'img', attrs: { src: ex.sourceThumb, alt: ex.brandName ?? '', loading: 'lazy' } }),
          el({ tag: 'span', cls: 'lab', text: ex.nativePreset ? nativeName(lang, ex.nativePreset) : '' }),
        ],
      }) as HTMLButtonElement;
      btn.dataset.job = ex.jobId;
      btn.addEventListener('click', () => void loadExample(ex));
      strip.append(btn);
    }
    stripHost.append(strip);
  };

  renderStrip();
  renderShowcase();
  void api<{ examples: ExampleDto[] }>('api/examples').then(
    (r) => {
      examples = r.examples;
      if (examples.length === 0) {
        stripHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'example_empty') }));
        showcaseHost.textContent = '';
        return;
      }
      const def = examples.find((e) => e.lang === lang) ?? examples[0];
      renderStrip();
      if (def) void loadExample(def);
      else renderStrip();
    },
    () => {
      stripHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'examples_failed') }));
      showcaseHost.textContent = '';
    },
  );

  // ---------- run ----------
  const runState = {
    jobId: null as string | null,
    sizes: [] as string[],
    rows: new Map<number, JobRow>(),
    failed: new Map<string, string>(),
    t0: 0,
    firstPreviewAt: 0,
    prep: new Map<string, { t0: number; ms: number | null }>(),
    prepTimer: null as ReturnType<typeof setInterval> | null,
    pollTimer: null as ReturnType<typeof setInterval> | null,
    es: null as EventSource | null,
    done: false,
    models: [] as string[],
  };

  const stopPrepTimer = (): void => {
    if (runState.prepTimer) clearInterval(runState.prepTimer);
    runState.prepTimer = null;
  };

  const renderRunShell = (title: string): { prep: HTMLElement; notice: HTMLElement; tiles: HTMLElement; runline: HTMLElement; zip: HTMLElement } => {
    runHost.textContent = '';
    runHost.append(el({ tag: 'h2', text: title }));
    const prep = el({ tag: 'div', cls: 'prep-line' });
    const notice = el({ tag: 'div' });
    const tiles = el({ tag: 'div', cls: 'tiles' });
    const runline = el({ tag: 'div', cls: 'run-line' });
    const zip = el({ tag: 'div', cls: 'toolbar' });
    runHost.append(prep, notice, tiles, runline, zip);
    return { prep, notice, tiles, runline, zip };
  };

  const renderPrep = (prep: HTMLElement): void => {
    prep.textContent = '';
    const steps: Array<{ id: string; label: string }> = [
      { id: 'analyze', label: t(lang, 'prep_reading') },
      { id: 'masks', label: t(lang, 'prep_cutting') },
      { id: 'plan', label: t(lang, 'prep_planning').replace('{n}', String(runState.sizes.length)) },
    ];
    steps.forEach((s, i) => {
      const rec = runState.prep.get(s.id);
      const cls = rec ? (rec.ms !== null ? 'prep-step done' : 'prep-step running') : 'prep-step';
      const ms = rec?.ms;
      const live = rec && ms === null ? ` · ${(Date.now() - rec.t0) / 1000 < 10 ? ((Date.now() - rec.t0) / 1000).toFixed(1) : Math.round((Date.now() - rec.t0) / 1000)} s` : '';
      prep.append(el({
        tag: 'span', cls, children: [
          el({ tag: 'span', cls: 'dot' }),
          el({ tag: 'span', text: s.label }),
          el({ tag: 'span', cls: 't', text: ms !== null && ms !== undefined ? fmtDur(ms) : live, attrs: { dir: 'ltr' } }),
        ],
      }));
      if (i < steps.length - 1) prep.append(el({ tag: 'span', cls: 'prep-sep', text: '·' }));
    });
  };

  const chipsCache = new Map<number, { chips: HTMLElement[]; repaired: boolean }>();
  const groupTitle = (g: string): string => t(lang, g === 'wide' ? 'group_landscape' : `group_${g}` as 'group_square');

  const renderTiles = (tiles: HTMLElement, shell: { runline: HTMLElement; zip: HTMLElement }): void => {
    tiles.textContent = '';
    const order = ['square', 'portrait', 'vertical', 'wide'];
    // Groups in fixed rank order: collect first, then append.
    const byGroup = new Map<string, HTMLElement[]>();
    const tileFor = (preset: string): HTMLElement => {
      const row = [...runState.rows.values()].find((r) => r.preset === preset && r.status !== 'failed');
      const fail = runState.failed.get(preset);
      const tile = el({ tag: 'article', cls: 'tile' });
      const dims = presetDims(preset);
      const frame = el({ tag: 'div', cls: 'frame' });
      if (dims) frame.setAttribute('style', `aspect-ratio:${dims.w}/${dims.h}`);
      if (row) {
        const link = el({ tag: 'a', cls: 'imglink', attrs: { href: `#/output/${row.outputId}` } });
        const img = el({ tag: 'img', attrs: { src: `media/thumb/${row.outputId}?v=${row.retries}`, alt: presetLabel(preset), loading: 'lazy' } }) as HTMLImageElement;
        link.append(img);
        frame.append(link);
        tile.append(frame);
        const body = el({ tag: 'div', cls: 'body' });
        body.append(el({
          tag: 'div', cls: 'meta', children: [
            el({ tag: 'span', text: presetName(lang, preset, presetLabel(preset)) }),
            dims ? el({ tag: 'span', cls: 'dims', text: `${dims.w}×${dims.h}`, attrs: { dir: 'ltr' } }) : null,
          ],
        }));
        tile.append(body);
        const cached = chipsCache.get(row.outputId);
        if (cached) {
          body.append(el({ tag: 'div', cls: 'chipsrow', children: cached.chips.map((c) => c.cloneNode(true) as HTMLElement) }));
          if (cached.repaired) body.append(el({ tag: 'span', cls: 'fixed-badge', text: t(lang, 'fixed_badge') }));
        } else {
          body.append(el({
            tag: 'div', cls: 'chipsrow', children: [
              statusChip(t(lang, 'check_protected'), 'pending', t(lang, 'check_pending')),
              statusChip(t(lang, 'check_text'), 'pending', t(lang, 'check_pending')),
              statusChip(t(lang, 'check_layout'), 'pending', t(lang, 'check_pending')),
            ],
          }));
          void api<OutputDetailDto>(`api/outputs/${row.outputId}`).then(
            (d) => {
              const chips = detailChips(lang, d);
              chipsCache.set(row.outputId, { chips, repaired: d.checks?.repaired != null });
              const shell = currentShell;
              if (shell) renderTiles(shell.tiles, shell);
            },
            () => undefined,
          );
        }
      } else if (fail) {
        frame.append(el({ tag: 'div', cls: 'notice error', text: fail, attrs: { style: 'margin:8px' } }));
        tile.append(frame);
        const body = el({ tag: 'div', cls: 'body' });
        body.append(el({
          tag: 'div', cls: 'meta', children: [el({ tag: 'span', text: presetName(lang, preset, presetLabel(preset)) })],
        }));
        const foot = el({ tag: 'div', cls: 'foot' });
        const retry = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'retry_tile'), attrs: { type: 'button' } });
        retry.addEventListener('click', () => void retrySize(preset));
        foot.append(retry);
        body.append(foot);
        tile.append(body);
      } else {
        frame.append(el({ tag: 'div', cls: 'shimmer skel', attrs: { style: dims ? `aspect-ratio:${dims.w}/${dims.h}` : '' } }));
        tile.append(frame);
        const body = el({ tag: 'div', cls: 'body' });
        body.append(el({
          tag: 'div', cls: 'meta', children: [
            el({ tag: 'span', text: presetName(lang, preset, presetLabel(preset)) }),
            dims ? el({ tag: 'span', cls: 'dims', text: `${dims.w}×${dims.h}`, attrs: { dir: 'ltr' } }) : null,
          ],
        }));
        body.append(el({
          tag: 'div', cls: 'chipsrow', children: [
            statusChip(t(lang, 'check_protected'), 'pending', t(lang, 'check_pending')),
            statusChip(t(lang, 'check_text'), 'pending', t(lang, 'check_pending')),
            statusChip(t(lang, 'check_layout'), 'pending', t(lang, 'check_pending')),
          ],
        }));
        tile.append(body);
      }
      return tile;
    };
    for (const preset of runState.sizes) {
      const g = groupOf(preset);
      const list = byGroup.get(g) ?? [];
      list.push(tileFor(preset));
      byGroup.set(g, list);
    }
    for (const g of order) {
      const list = byGroup.get(g);
      if (!list || list.length === 0) continue;
      const sec = el({ tag: 'section', cls: 'group-sec' });
      sec.append(el({ tag: 'h3', text: groupTitle(g) }));
      const grid = el({ tag: 'div', cls: 'tiles' });
      for (const tile of list) grid.append(tile);
      sec.append(grid);
      tiles.append(sec);
    }
    renderRunLine(shell.runline, shell.zip);
  };

  const renderRunLine = (runline: HTMLElement, zip: HTMLElement): void => {
    runline.textContent = '';
    zip.textContent = '';
    if (runState.rows.size === 0 && runState.failed.size === 0) {
      if (!runState.done) runline.append(el({ tag: 'span', cls: 'muted', text: t(lang, 'run_waiting') }));
      return;
    }
    if (runState.models.length > 0 || runState.firstPreviewAt > 0) {
      const first = runState.firstPreviewAt > 0 ? fmtDur(runState.firstPreviewAt - runState.t0) : '—';
      const total = runState.done ? fmtDur(Date.now() - runState.t0) : '…';
      const line = t(lang, 'run_models_line')
        .replace('{models}', runState.models.join(' · ') || '—')
        .replace('{first}', first)
        .replace('{n}', String(runState.rows.size))
        .replace('{total}', total);
      runline.append(el({ tag: 'span', text: line }));
    }
    if (runState.jobId && (runState.done || runState.rows.size > 0)) {
      const a = el({ tag: 'a', cls: 'btn', text: t(lang, 'btn_download_all'), attrs: { href: `api/runs/${runState.jobId}/zip` } });
      zip.append(a);
    }
  };

  const retrySize = async (preset: string): Promise<void> => {
    if (!runState.jobId) return;
    try {
      const job = await api<JobDto>(`api/runs/${runState.jobId}`);
      const target = job.outputs.find((o) => o.preset === preset);
      if (!target) return;
      runState.failed.delete(preset);
      const shell = currentShell;
      if (shell) renderTiles(shell.tiles, shell);
      const res = await apiPost(`api/outputs/${target.id}/regenerate`, {});
      if (!res.ok) throw new Error('retry failed');
      const created = (await res.json()) as { jobId: string; key: string };
      followJob(created.jobId, [preset], false, created.key);
    } catch {
      runState.failed.set(preset, t(lang, 'err_unknown'));
      const shell = currentShell;
      if (shell) renderTiles(shell.tiles, shell);
    }
  };

  let currentShell: { prep: HTMLElement; notice: HTMLElement; tiles: HTMLElement; runline: HTMLElement; zip: HTMLElement } | null = null;

  const stopPollTimer = (): void => {
    if (runState.pollTimer) clearInterval(runState.pollTimer);
    runState.pollTimer = null;
  };

  const mergePolledJob = async (shell: { tiles: HTMLElement; runline: HTMLElement; zip: HTMLElement }): Promise<boolean> => {
    try {
      const job = await api<JobDto>(`api/runs/${runState.jobId}`);
      for (const m of job.models) {
        if (!runState.models.includes(m)) runState.models.push(m);
      }
      for (const o of job.outputs) {
        if (o.status === 'failed') runState.failed.set(o.preset, t(lang, 'err_unknown'));
        else {
          runState.failed.delete(o.preset);
          if (runState.firstPreviewAt === 0) runState.firstPreviewAt = Date.now();
          runState.rows.set(o.id, { outputId: o.id, sourceId: o.sourceId, sourceIndex: o.sourceIndex, preset: o.preset, status: 'pass', retries: o.retries, models: o.models, traceMs: o.traceMs });
        }
      }
      renderTiles(shell.tiles, shell);
      if (job.status === 'done' || job.status === 'failed') {
        stopPollTimer();
        runState.done = true;
        state.generating = false;
        refreshGen();
        renderRunLine(shell.runline, shell.zip);
        return true;
      }
    } catch {
      // Transient poll failure: keep following.
    }
    return false;
  };

  const followJob = (jobId: string, sizes: string[], fresh: boolean, liveKey?: string | null): void => {
    if (fresh) {
      runState.jobId = jobId;
      runState.sizes = sizes;
      runState.rows.clear();
      runState.failed.clear();
      runState.t0 = Date.now();
      runState.firstPreviewAt = 0;
      runState.prep.clear();
      runState.done = false;
      runState.models = [];
    }
    if (runState.es) runState.es.close();
    runState.es = null;
    stopPollTimer();
    const shell = currentShell ?? renderRunShell(t(lang, 'run_title'));
    currentShell = shell;
    renderPrep(shell.prep);
    renderTiles(shell.tiles, shell);
    stopPrepTimer();
    runState.prepTimer = setInterval(() => renderPrep(shell.prep), 500);
    if (!liveKey) {
      // Reload-resume (live key lost): poll the stored job until terminal.
      runState.pollTimer = setInterval(() => void mergePolledJob(shell), 2000);
      void mergePolledJob(shell);
      return;
    }
    const es = new EventSource(`api/live/${liveKey}/events`);
    runState.es = es;
    es.addEventListener('prep', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as { step: string; state: string; ms?: number };
        if (msg.state === 'start') runState.prep.set(msg.step, { t0: Date.now(), ms: null });
        else {
          const rec = runState.prep.get(msg.step);
          runState.prep.set(msg.step, { t0: rec?.t0 ?? Date.now(), ms: msg.ms ?? 0 });
        }
        renderPrep(shell.prep);
      } catch {
        // Ignore malformed prep events.
      }
    });
    es.addEventListener('progress', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as { row: JobRow; done: number; total: number };
        if (runState.firstPreviewAt === 0) runState.firstPreviewAt = Date.now();
        if (msg.row.status === 'failed') {
          runState.failed.set(msg.row.preset, msg.row.error ?? t(lang, 'err_unknown'));
        } else {
          runState.failed.delete(msg.row.preset);
          runState.rows.set(msg.row.outputId, msg.row);
        }
        for (const m of msg.row.models ?? []) {
          if (!runState.models.includes(m)) runState.models.push(m);
        }
        renderTiles(shell.tiles, shell);
      } catch {
        // Ignore malformed progress events.
      }
    });
    es.addEventListener('update', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as { row: JobRow };
        runState.rows.set(msg.row.outputId, msg.row);
        renderTiles(shell.tiles, shell);
      } catch {
        // Ignore malformed update events.
      }
    });
    const finish = async (failed: boolean, error?: string): Promise<void> => {
      es.close();
      runState.es = null;
      stopPrepTimer();
      stopPollTimer();
      state.generating = false;
      refreshGen();
      runState.done = true;
      try {
        // Merge (never replace): a retried size lands in its own job while
        // the other tiles belong to the original one.
        const job = await api<JobDto>(`api/runs/${jobId}`);
        for (const m of job.models) {
          if (!runState.models.includes(m)) runState.models.push(m);
        }
        for (const o of job.outputs) {
          if (o.status === 'failed') runState.failed.set(o.preset, t(lang, 'err_unknown'));
          else {
            runState.failed.delete(o.preset);
            runState.rows.set(o.id, { outputId: o.id, sourceId: o.sourceId, sourceIndex: o.sourceIndex, preset: o.preset, status: 'pass', retries: o.retries, models: o.models, traceMs: o.traceMs });
          }
        }
        if (failed && runState.rows.size === 0 && runState.failed.size === 0) {
          shell.notice.append(el({ tag: 'div', cls: 'notice error', text: error === 'err_busy' ? t(lang, 'run_spendcap') : t(lang, 'run_failed_all') }));
        }
      } catch {
        if (failed) shell.notice.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'run_failed_all') }));
      }
      renderPrep(shell.prep);
      renderTiles(shell.tiles, shell);
      renderRunLine(shell.runline, shell.zip);
    };
    es.addEventListener('done', () => void finish(false));
    es.addEventListener('failed', (ev) => {
      try {
        const msg = JSON.parse((ev as MessageEvent).data) as { error?: string };
        void finish(true, msg.error);
      } catch {
        void finish(true);
      }
    });
    es.onerror = () => {
      es.close();
      runState.es = null;
      if (!runState.done) {
        // Stream dropped mid-run: keep following via polling.
        stopPollTimer();
        runState.pollTimer = setInterval(() => void mergePolledJob(shell), 2000);
        return;
      }
      stopPrepTimer();
      state.generating = false;
      refreshGen();
    };
  };

  const submit = async (): Promise<void> => {
    if (state.generating || state.files.length === 0 || state.sizes.size === 0) return;
    const confirmed = textsConfirmed();
    if (state.texts.phase === 'ready' || state.texts.phase === 'editing' || state.texts.phase === 'detecting') return;
    state.generating = true;
    refreshGen();
    currentShell = renderRunShell(t(lang, 'run_title'));
    const fields: Record<string, string> = {
      sizes: [...state.sizes].join(','),
      brandId: brandSel.value,
      mode: state.mode,
    };
    if (confirmed) fields['texts'] = JSON.stringify({ 0: confirmed });
    bar.hidden = false;
    const fill = bar.children[0] as HTMLElement;
    try {
      const res = await uploadFilesWithProgress('api/jobs', state.files, fields, (r) => {
        fill.style.width = `${Math.round(r * 100)}%`;
      });
      bar.hidden = true;
      if (res.status === 429 || res.status === 503) {
        state.generating = false;
        refreshGen();
        currentShell.notice.append(el({ tag: 'div', cls: 'notice warn', text: t(lang, 'run_spendcap') }));
        return;
      }
      if (!res.ok) throw new Error('submit failed');
      const created = (await res.json()) as { jobId: string; key: string; status: string };
      if (created.status === 'queued') currentShell.notice.append(el({ tag: 'div', cls: 'notice info', text: t(lang, 'run_queue') }));
      if (window.location.hash !== `#/run/${created.jobId}`) {
        history.replaceState(null, '', `#/run/${created.jobId}`);
      }
      followJob(created.jobId, [...state.sizes], true, created.key);
    } catch {
      bar.hidden = true;
      state.generating = false;
      refreshGen();
      currentShell.notice.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'err_unknown') }));
    }
  };
  genBtn.addEventListener('click', () => void submit());
  stickyBtn.addEventListener('click', () => void submit());

  // ---------- run/:id route: finished or live job ----------
  if (route.page === 'run' && route.id) {
    const jobId = route.id;
    void (async () => {
      try {
        const job = await api<JobDto>(`api/runs/${jobId}`);
        runState.jobId = job.id;
        runState.sizes = job.sizes;
        runState.t0 = Date.parse(job.createdAt) || Date.now();
        runState.models = job.models;
        currentShell = renderRunShell(t(lang, 'run_title'));
        for (const o of job.outputs) {
          if (o.status === 'failed') runState.failed.set(o.preset, t(lang, 'err_unknown'));
          else runState.rows.set(o.id, { outputId: o.id, sourceId: o.sourceId, sourceIndex: o.sourceIndex, preset: o.preset, status: 'pass', retries: o.retries, models: o.models, traceMs: o.traceMs });
        }
        if (job.status === 'running') {
          runState.firstPreviewAt = job.firstPreviewMs !== null ? runState.t0 + job.firstPreviewMs : 0;
          followJob(job.id, job.sizes, false);
          return;
        }
        runState.done = true;
        runState.firstPreviewAt = job.firstPreviewMs !== null ? runState.t0 + job.firstPreviewMs : 0;
        renderPrep(currentShell.prep);
        renderTiles(currentShell.tiles, currentShell);
        if (job.firstPreviewMs !== null || job.totalMs !== null) {
          const first = job.firstPreviewMs !== null ? fmtDur(job.firstPreviewMs) : '—';
          const total = job.totalMs !== null ? fmtDur(job.totalMs) : '—';
          const line = t(lang, 'run_models_line')
            .replace('{models}', job.models.join(' · ') || '—')
            .replace('{first}', first)
            .replace('{n}', String(job.outputs.filter((o) => isOkStatus(o.status)).length))
            .replace('{total}', total);
          currentShell.runline.append(el({ tag: 'span', text: line }));
        }
        if (job.outputs.some((o) => isOkStatus(o.status))) {
          currentShell.zip.append(el({ tag: 'a', cls: 'btn', text: t(lang, 'btn_download_all'), attrs: { href: `api/runs/${job.id}/zip` } }));
        }
      } catch {
        currentShell = renderRunShell(t(lang, 'run_title'));
        currentShell.notice.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'detail_missing') }));
      }
    })();
  }
  refreshGen();
}

function showcaseCell(lang: Lang, o: OutputCardDto): HTMLElement {
  const dims = presetDims(o.preset);
  const cell = el({ tag: 'div', cls: 'showcase-cell' });
  const link = el({ tag: 'a', cls: 'imglink', attrs: { href: `#/output/${o.id}` } });
  const frame = el({ tag: 'div', cls: 'frame' });
  if (dims) frame.setAttribute('style', `aspect-ratio:${dims.w}/${dims.h}`);
  const img = el({ tag: 'img', attrs: { src: `${o.thumb}?v=${o.retries}`, alt: presetLabel(o.preset), loading: 'lazy' } }) as HTMLImageElement;
  frame.append(img);
  link.append(frame);
  cell.append(link);
  cell.append(el({ tag: 'div', cls: 'imglabel', text: presetName(lang, o.preset, presetLabel(o.preset)) }));
  return cell;
}

function detailChips(lang: Lang, o: { status: string; checks?: ChecksDto | null }): HTMLElement[] {
  if (!o.checks) {
    return [checkBadge(t(lang, o.status === 'done' ? 'check_passed' : 'check_needs_review'), o.status === 'done' ? 'passed' : 'needs_review', '')];
  }
  return chipsFor(lang, {
    protected: o.checks.protected_pixels.status,
    text: o.checks.text.status,
    layout: o.checks.layout_review.status,
    repaired: o.checks.repaired !== null,
  });
}
