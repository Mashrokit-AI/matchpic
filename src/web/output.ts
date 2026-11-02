/** Output detail: stage + inspection tools + rail. */
import { presetName, type Lang } from '../shared/i18n.js';
import type { ChecksDto, JobDto, ManifestDto, OutputDetailDto } from './dto.js';
import { api, apiPost, arrowSvg, dims, el, isOkStatus, presetLabel, statusChip, t, trRow } from './lib.js';

const STATUS_WORD: Record<string, 'check_passed' | 'check_fixed' | 'check_needs_review' | 'check_pending'> = {
  passed: 'check_passed',
  fixed: 'check_fixed',
  needs_review: 'check_needs_review',
  pending: 'check_pending',
};

interface Sibling {
  id: number;
  preset: string;
}

type CheckState = 'passed' | 'fixed' | 'needs_review' | 'pending';

function chipsFor(lang: Lang, c: { protected: CheckState; text: CheckState; layout: CheckState }): HTMLElement[] {
  return [
    statusChip(t(lang, 'check_protected'), c.protected, t(lang, STATUS_WORD[c.protected])),
    statusChip(t(lang, 'check_text'), c.text, t(lang, STATUS_WORD[c.text])),
    statusChip(t(lang, 'check_layout'), c.layout, t(lang, STATUS_WORD[c.layout])),
  ];
}

/** Canvas colours come from the CSS tokens in styles.css. */
function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('img'));
    img.src = src;
  });
}

export async function renderOutput(root: HTMLElement, lang: Lang, id: string): Promise<void> {
  const rtl = lang === 'he';
  const back = el({
    tag: 'div', cls: 'backrow', children: [
      el({ tag: 'a', cls: 'btn small secondary', text: t(lang, 'back_home'), attrs: { href: '#/' } }),
    ],
  });
  root.append(back);
  let d: OutputDetailDto;
  try {
    d = await api<OutputDetailDto>(`api/outputs/${id}`);
  } catch {
    root.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'detail_missing') }));
    return;
  }
  const manifest = d.manifest as ManifestDto | null;

  const grid = el({ tag: 'div', cls: 'detail-grid' });
  root.append(grid);
  const stageCol = el({ tag: 'div' });
  const rail = el({ tag: 'aside', cls: 'rail' });
  grid.append(stageCol, rail);

  // ---------- placement switcher ----------
  const switcher = el({ tag: 'div', cls: 'switcher' });
  stageCol.append(switcher);
  const switchLabel = el({ tag: 'span', cls: 'lbl' });
  const prevBtn = el({ tag: 'button', cls: 'toolbtn', attrs: { type: 'button', 'aria-label': t(lang, 'detail_prev') }, html: arrowSvg(!rtl) }) as HTMLButtonElement;
  const nextBtn = el({ tag: 'button', cls: 'toolbtn', attrs: { type: 'button', 'aria-label': t(lang, 'detail_next') }, html: arrowSvg(rtl) }) as HTMLButtonElement;
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  switcher.append(prevBtn, switchLabel, nextBtn);
  const setSwitchLabel = (list: Sibling[], idx: number): void => {
    const cur = list[idx];
    switchLabel.textContent = cur
      ? `${idx + 1} / ${list.length} · ${presetName(lang, cur.preset, presetLabel(cur.preset))}`
      : presetName(lang, d.preset, presetLabel(d.preset));
  };
  setSwitchLabel([], -1);
  void api<JobDto>(`api/runs/${d.jobId}`).then(
    (job) => {
      const list: Sibling[] = job.outputs.filter((o) => isOkStatus(o.status)).map((o) => ({ id: o.id, preset: o.preset }));
      const idx = list.findIndex((o) => o.id === d.id);
      setSwitchLabel(list, idx);
      if (idx > 0) {
        prevBtn.disabled = false;
        prevBtn.addEventListener('click', () => {
          window.location.hash = `#/output/${(list[idx - 1] as Sibling).id}`;
        });
      }
      if (idx >= 0 && idx < list.length - 1) {
        nextBtn.disabled = false;
        nextBtn.addEventListener('click', () => {
          window.location.hash = `#/output/${(list[idx + 1] as Sibling).id}`;
        });
      }
    },
    () => undefined,
  );

  // ---------- stage ----------
  const stage = el({ tag: 'div', cls: 'stage' });
  stageCol.append(stage);
  const outer = el({ tag: 'div', cls: 'zoom-outer' });
  stage.append(outer);
  const zoombox = el({ tag: 'div', cls: 'zoombox' });
  outer.append(zoombox);
  const full = el({ tag: 'img', cls: 'full', attrs: { src: d.image, alt: presetLabel(d.preset) } }) as HTMLImageElement;
  zoombox.append(full);
  const tools = el({ tag: 'div', cls: 'tools', attrs: { role: 'toolbar' } });
  stageCol.append(tools);

  const state = { slider: false, xray: false, safe: false, zoom: 'fit' as 'fit' | '100' | '200' };
  const redraw = (): void => {
    zoombox.textContent = '';
    zoombox.append(full);
    full.className = 'full';
    const W = manifest?.width ?? d.plan?.width ?? 0;
    const H = manifest?.height ?? d.plan?.height ?? 0;
    if (state.zoom !== 'fit' && W > 0) {
      const scale = state.zoom === '100' ? 1 : 2;
      full.style.width = `${W * scale}px`;
      full.style.maxWidth = 'none';
      full.style.maxHeight = 'none';
    } else {
      full.style.width = '';
      full.style.maxWidth = '';
      full.style.maxHeight = '';
    }
    if (state.slider) {
      full.remove();
      zoombox.append(compareBox(lang, d, manifest));
    }
    if ((state.xray || state.safe) && manifest && W > 0) {
      zoombox.append(xrayCanvas(manifest, { masks: state.xray, placed: state.xray, zones: state.xray, safe: state.safe }));
    }
    void H;
  };

  const mkToggle = (label: string, get: () => boolean, set: (v: boolean) => void): HTMLButtonElement => {
    const b = el({ tag: 'button', cls: 'toolbtn', text: label, attrs: { type: 'button', 'aria-pressed': 'false' } }) as HTMLButtonElement;
    b.addEventListener('click', () => {
      set(!get());
      b.setAttribute('aria-pressed', String(get()));
      redraw();
    });
    return b;
  };
  const sliderBtn = mkToggle(t(lang, 'tool_slider'), () => state.slider, (v) => { state.slider = v; });
  const xrayBtn = mkToggle(t(lang, 'tool_xray'), () => state.xray, (v) => { state.xray = v; });
  const safeBtn = mkToggle(t(lang, 'tool_safe'), () => state.safe, (v) => { state.safe = v; });
  if (!manifest) {
    xrayBtn.disabled = true;
    safeBtn.disabled = true;
    xrayBtn.title = t(lang, 'xray_no_manifest');
  }
  const zoomSeg = el({ tag: 'div', cls: 'seg', attrs: { role: 'group', 'aria-label': 'zoom' } });
  for (const z of ['fit', '100', '200'] as const) {
    const b = el({ tag: 'button', text: z === 'fit' ? t(lang, 'tool_zoom_fit') : `${z}%`, attrs: { type: 'button', 'aria-pressed': String(z === state.zoom) } });
    b.addEventListener('click', () => {
      state.zoom = z;
      for (const c of zoomSeg.children) (c as HTMLElement).setAttribute('aria-pressed', String((c as HTMLElement).textContent === b.textContent));
      redraw();
    });
    zoomSeg.append(b);
  }
  tools.append(sliderBtn, xrayBtn, safeBtn, zoomSeg);
  const legend = el({
    tag: 'div', cls: 'xray-legend', attrs: { hidden: 'true' }, children: [
      el({ tag: 'span', html: `<span class="sw" style="background:var(--mask-green)"></span>${t(lang, 'xray_masks')}` }),
      el({ tag: 'span', html: `<span class="sw" style="background:var(--box-pink)"></span>${t(lang, 'toggle_placed')}` }),
      el({ tag: 'span', html: `<span class="sw" style="border:1px dashed var(--zone-dash)"></span>${t(lang, 'xray_zones')}` }),
    ],
  });
  stageCol.append(legend);
  xrayBtn.addEventListener('click', () => {
    if (state.xray) legend.removeAttribute('hidden');
    else legend.setAttribute('hidden', 'true');
  });

  const actions = el({ tag: 'div', cls: 'toolbar' });
  const dl = el({ tag: 'a', cls: 'btn', text: t(lang, 'btn_download'), attrs: { href: d.image, download: '' } });
  actions.append(dl);
  if (d.status !== 'failed') {
    const regen = el({ tag: 'button', cls: 'btn secondary', text: t(lang, 'btn_regenerate'), attrs: { type: 'button' } }) as HTMLButtonElement;
    regen.addEventListener('click', async () => {
      regen.disabled = true;
      try {
        const res = await apiPost(`api/outputs/${d.id}/regenerate`, {});
        if (!res.ok) throw new Error('regen');
        const created = (await res.json()) as { jobId: string };
        window.location.hash = `#/run/${created.jobId}`;
      } catch {
        regen.disabled = false;
      }
    });
    actions.append(regen);
  }
  stageCol.append(actions);

  // ---------- rail ----------
  const srcCard = el({ tag: 'div', cls: 'card' });
  srcCard.append(el({ tag: 'h3', text: t(lang, 'detail_before') }));
  const srcRow = el({ tag: 'div', cls: 'src-mini' });
  srcRow.append(el({ tag: 'img', attrs: { src: d.sourceThumb, alt: '' } }) as HTMLImageElement);
  srcRow.append(el({ tag: 'span', cls: 'small muted', text: dims(d.sourceWidth, d.sourceHeight) }));
  srcCard.append(srcRow);
  rail.append(srcCard);

  const statusCard = el({ tag: 'div', cls: 'card' });
  statusCard.append(el({ tag: 'h3', text: t(lang, 'run_title') }));
  if (d.checks) {
    const c = d.checks as ChecksDto;
    const chips = chipsFor(lang, {
      protected: c.protected_pixels.status,
      text: c.text.status,
      layout: c.layout_review.status,
    });
    if (c.repaired) chips.push(el({ tag: 'span', cls: 'fixed-badge', text: t(lang, 'fixed_badge') }));
    statusCard.append(el({ tag: 'div', cls: 'chipsrow', children: chips }));
  } else {
    // Legacy rows without checks_json (old seeds): honest mapping from status.
    const ok = isOkStatus(d.status) && d.qaPass !== false;
    const st = d.status === 'failed' || d.status === 'needs_review' || !ok ? 'needs_review' : 'passed';
    statusCard.append(el({
      tag: 'div', cls: 'chipsrow', children: chipsFor(lang, {
        protected: d.mode === 'fast' ? 'pending' : st,
        text: st,
        layout: st,
      }),
    }));
  }
  rail.append(statusCard);

  // Protected-pixel crops (source vs output, synchronized scale).
  const cropEls = manifest?.elements.filter((e) => (e.kind === 'product' || e.kind === 'logo') && e.srcBox) ?? [];
  if (cropEls.length > 0 && manifest) {
    const card = el({ tag: 'div', cls: 'card' });
    card.append(el({ tag: 'h3', text: t(lang, 'check_protected') }));
    const host = el({ tag: 'div', cls: 'crops' });
    card.append(host);
    rail.append(card);
    const man = manifest;
    void (async () => {
      let srcImg: HTMLImageElement;
      let outImg: HTMLImageElement;
      try {
        [srcImg, outImg] = await Promise.all([loadImage(d.sourceImage), loadImage(d.image)]);
      } catch {
        host.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'crops_missing') }));
        return;
      }
      for (const e of cropEls) {
        const srcBox = e.srcBox as { x: number; y: number; w: number; h: number };
        const pair = el({ tag: 'div', cls: 'crop-pair' });
        const mk = (img: HTMLImageElement, box: { x: number; y: number; w: number; h: number }, frameW: number, frameH: number, label: string): HTMLElement => {
          const fig = el({ tag: 'figure' });
          const canvas = document.createElement('canvas');
          // Same output height for both sides (synchronized); pad 12%.
          const pad = 0.12;
          const pw = box.w * (1 + pad * 2);
          const ph = box.h * (1 + pad * 2);
          const H = 180;
          const W = Math.max(40, Math.round((H * pw) / Math.max(1, ph)));
          canvas.width = W;
          canvas.height = H;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            const sx = Math.max(0, box.x - box.w * pad);
            const sy = Math.max(0, box.y - box.h * pad);
            ctx.drawImage(
              img,
              (sx * img.naturalWidth) / frameW, (sy * img.naturalHeight) / frameH,
              (pw * img.naturalWidth) / frameW, (ph * img.naturalHeight) / frameH,
              0, 0, W, H,
            );
          }
          const cov = d.proof?.[e.id]?.coverage;
          fig.append(canvas);
          fig.append(el({
            tag: 'figcaption', children: [
              el({ tag: 'span', text: label }),
              el({ tag: 'span', text: typeof cov === 'number' ? `${(cov * 100).toFixed(1)}%` : '', attrs: { dir: 'ltr' } }),
            ],
          }));
          return fig;
        };
        pair.append(mk(srcImg, srcBox, d.sourceWidth, d.sourceHeight, t(lang, 'detail_before')));
        pair.append(mk(outImg, e.box, man.width, man.height, t(lang, 'detail_after')));
        host.append(pair);
      }
    })();
  }

  // Verification details.
  const verify = el({ tag: 'details', cls: 'verify' });
  verify.append(el({ tag: 'summary', text: t(lang, 'verify_title') }));
  const vbody = el({ tag: 'div', cls: 'vbody' });
  verify.append(vbody);
  if (d.checks) {
    const c = d.checks as ChecksDto;
    vbody.append(el({ tag: 'h4', text: t(lang, 'verify_text') }));
    vbody.append(el({ tag: 'pre', text: c.text.detail }));
    vbody.append(el({ tag: 'h4', text: t(lang, 'verify_rationale') }));
    vbody.append(el({ tag: 'pre', text: manifest?.rationale ?? '—' }));
    if (c.repaired) {
      vbody.append(el({ tag: 'h4', text: t(lang, 'verify_patch') }));
      vbody.append(el({ tag: 'pre', text: c.repaired.patches.join('\n') }));
    }
  }
  vbody.append(el({ tag: 'h4', text: t(lang, 'trace_title') }));
  const table = el({ tag: 'table', cls: 'trace' });
  table.append(el({
    tag: 'tr', children: [
      el({ tag: 'th', text: t(lang, 'trace_step') }),
      el({ tag: 'th', text: t(lang, 'trace_tool') }),
      el({ tag: 'th', text: t(lang, 'trace_io') }),
      el({ tag: 'th', text: t(lang, 'trace_dur') }),
    ],
  }));
  for (const row of (d.trace ?? []) as Array<{ step: string; tool_or_model: string; output_summary: string; duration_ms: number; cached: boolean }>) {
    table.append(trRow([
      row.cached ? `${row.step} · ${t(lang, 'trace_cached')}` : row.step,
      row.tool_or_model,
      row.output_summary,
      String(row.duration_ms),
    ]));
  }
  const tracewrap = el({ tag: 'div', cls: 'tracewrap', children: [table] });
  vbody.append(tracewrap);
  rail.append(verify);
}

/** Before/after slider: before-repair vs final, else source vs output. */
function compareBox(lang: Lang, d: OutputDetailDto, manifest: ManifestDto | null): HTMLElement {
  const before = d.beforeImage ?? d.sourceImage;
  const box = el({ tag: 'div', cls: 'compare' });
  const W = manifest?.width ?? d.plan?.width ?? 0;
  const H = manifest?.height ?? d.plan?.height ?? 0;
  if (W > 0 && H > 0) box.setAttribute('style', `aspect-ratio:${W}/${H}`);
  const base = el({ tag: 'img', cls: 'base', attrs: { src: before, alt: t(lang, 'tool_before') } }) as HTMLImageElement;
  const wrap = el({ tag: 'div', cls: 'after-wrap' });
  const after = el({ tag: 'img', attrs: { src: d.image, alt: t(lang, 'tool_after') } }) as HTMLImageElement;
  wrap.append(after);
  const handle = el({ tag: 'div', cls: 'handle' });
  const range = el({ tag: 'input', attrs: { type: 'range', min: '0', max: '100', value: '50', 'aria-label': t(lang, 'tool_slider') } }) as HTMLInputElement;
  const set = (): void => {
    const p = Number(range.value);
    wrap.style.insetInlineStart = `${p}%`;
    handle.style.insetInlineStart = `calc(${p}% - 1px)`;
  };
  range.addEventListener('input', set);
  box.append(base, wrap, handle, range);
  box.append(el({ tag: 'span', cls: 'tag b', text: t(lang, 'tool_before') }));
  box.append(el({ tag: 'span', cls: 'tag a', text: t(lang, 'tool_after') }));
  set();
  return box;
}

/** X-ray canvas over the stage image: masks green, placed pink, zones dashed, safe dimmed. */
function xrayCanvas(
  manifest: ManifestDto,
  show: { masks: boolean; placed: boolean; zones: boolean; safe: boolean },
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  const W = manifest.width;
  const H = manifest.height;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  // The stage image renders scaled; the canvas backing store is exact W/H and
  // CSS stretches it over the same box, so coordinates map 1:1.
  if (show.safe) {
    const s = manifest.safe;
    ctx.fillStyle = 'rgba(18,30,48,0.35)';
    ctx.fillRect(0, 0, W, s.y);
    ctx.fillRect(0, s.y + s.h, W, H - s.y - s.h);
    ctx.fillRect(0, s.y, s.x, s.h);
    ctx.fillRect(s.x + s.w, s.y, W - s.x - s.w, s.h);
  }
  if (show.masks) {
    // Protected placement from the resolved manifest (what the proof verified).
    ctx.fillStyle = token('--mask-green');
    ctx.globalAlpha = 0.45;
    for (const e of manifest.elements) {
      if (e.kind === 'product' || e.kind === 'logo') ctx.fillRect(e.box.x, e.box.y, e.box.w, e.box.h);
    }
    ctx.globalAlpha = 1;
  }
  if (show.zones && manifest.templateZones) {
    ctx.strokeStyle = token('--zone-dash');
    ctx.lineWidth = Math.max(2, Math.round(W / 600));
    ctx.setLineDash([8, 6]);
    for (const z of Object.values(manifest.templateZones)) {
      ctx.strokeRect(z.x + 1, z.y + 1, z.w - 2, z.h - 2);
    }
    ctx.setLineDash([]);
  }
  if (show.placed) {
    ctx.strokeStyle = token('--box-pink');
    ctx.lineWidth = Math.max(2, Math.round(W / 600));
    for (const e of manifest.elements) {
      if (e.kind === 'frame' || e.kind === 'shadow') continue;
      ctx.strokeRect(e.box.x + 1, e.box.y + 1, e.box.w - 2, e.box.h - 2);
    }
  }
  return canvas;
}
