/** Brands: clean cards, style examples, the automatic brand prompt. No zone boxes. */
import { nativeName, type Lang } from '../shared/i18n.js';
import { PRESETS } from '../shared/presets.js';
import type { Route } from './app.js';
import type { BrandDto, BrandPromptDto } from './dto.js';
import { api, apiDelete, apiPatch, apiPost, el, t, uploadFilesWithProgress } from './lib.js';

function swatches(colors: Array<{ hex: string }>): HTMLElement {
  const row = el({ tag: 'div', cls: 'swatches' });
  for (const c of colors.slice(0, 5)) {
    row.append(el({ tag: 'span', cls: 'sw', attrs: { style: `background:${c.hex}`, title: c.hex } }));
  }
  return row;
}

function fmtTime(lang: Lang, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(lang === 'he' ? 'he-IL' : 'en-US', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function scopeLabel(lang: Lang, scope: string): string {
  return scope === 'general' ? t(lang, 'ex_scope_general') : nativeName(lang, scope);
}

export async function renderBrands(root: HTMLElement, lang: Lang, route: Route): Promise<void> {
  if (route.brand) {
    await renderOpenBrand(root, lang, route.brand);
    return;
  }
  await renderList(root, lang);
}

async function renderList(host: HTMLElement, lang: Lang): Promise<void> {
  let brands: BrandDto[] = [];
  try {
    const r = await api<{ brands: BrandDto[] }>('api/brands');
    brands = r.brands;
  } catch {
    host.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'err_unknown') }));
    return;
  }
  const head = el({ tag: 'div', cls: 'page-head' });
  const titles = el({ tag: 'div' });
  titles.append(el({ tag: 'h1', text: t(lang, 'brands_title') }));
  titles.append(el({ tag: 'p', cls: 'sub', text: t(lang, 'brands_sub') }));
  const newTop = el({ tag: 'a', cls: 'btn', text: t(lang, 'brand_new'), attrs: { href: '#new-brand-form' } });
  newTop.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('new-brand-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('new-brand-name')?.focus({ preventScroll: true });
  });
  head.append(titles, newTop);
  host.append(head);

  const grid = el({ tag: 'div', cls: 'brands-grid' });
  for (const b of brands) {
    const card = el({ tag: 'article', cls: 'brand-card' });
    const top = el({ tag: 'div', cls: 'top' });
    if (b.logo) {
      top.append(el({ tag: 'img', cls: 'logo', attrs: { src: b.logo as string, alt: '' } }) as HTMLImageElement);
    } else {
      top.append(el({ tag: 'span', cls: 'logo ph', text: (b.name[0] ?? '?').toUpperCase() }));
    }
    const title = el({ tag: 'div' });
    title.append(el({ tag: 'h3', text: b.name }));
    const tags = el({ tag: 'div', cls: 'tags' });
    if (b.demo) tags.append(el({ tag: 'span', cls: 'tag demo', text: t(lang, 'brand_demo_tag') }));
    else tags.append(el({ tag: 'span', cls: 'tag', text: t(lang, 'brand_expires') }));
    title.append(tags);
    top.append(title);
    card.append(top);
    if (b.colors.length > 0) card.append(swatches(b.colors));
    card.append(el({ tag: 'div', cls: 'excount', text: t(lang, 'brand_examples_count').replace('{n}', String(b.examples.length)) }));
    const foot = el({ tag: 'div', cls: 'foot' });
    const open = el({ tag: 'a', cls: 'btn small secondary', text: t(lang, 'brand_open'), attrs: { href: `#/brands/${b.id}` } });
    foot.append(open);
    if (b.demo) {
      const dup = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'brand_duplicate'), attrs: { type: 'button' } }) as HTMLButtonElement;
      dup.addEventListener('click', async () => {
        dup.disabled = true;
        try {
          const res = await apiPost(`api/brands/${b.id}/duplicate`, {});
          if (!res.ok) throw new Error('dup');
          const created = (await res.json()) as { id: string };
          window.location.hash = `#/brands/${created.id}`;
        } catch {
          dup.disabled = false;
        }
      });
      foot.append(dup);
    }
    card.append(foot);
    grid.append(card);
  }
  host.append(grid);

  // New brand.
  const card = el({ tag: 'section', cls: 'card', attrs: { id: 'new-brand-form' } });
  card.append(el({ tag: 'h3', text: t(lang, 'brands_new') }));
  const name = el({ tag: 'input', cls: 'input', attrs: { id: 'new-brand-name', placeholder: t(lang, 'brand_name'), 'aria-label': t(lang, 'brand_name') } }) as HTMLInputElement;
  const colors: string[] = ['#111111', '#ffffff'];
  const colorRow = el({ tag: 'div', cls: 'color-row' });
  const hex = el({ tag: 'input', cls: 'input small', attrs: { placeholder: '#0e6b45', 'aria-label': '#hex', size: '10' } }) as HTMLInputElement;
  const renderColors = (): void => {
    colorRow.textContent = '';
    for (const c of colors) {
      const pick = el({ tag: 'input', attrs: { type: 'color', value: c, 'aria-label': c } }) as HTMLInputElement;
      pick.addEventListener('input', () => {
        colors[colors.indexOf(c)] = pick.value;
      });
      colorRow.append(pick);
    }
    colorRow.append(hex);
  };
  renderColors();
  hex.addEventListener('change', () => {
    const v = hex.value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v) && colors.length < 6) {
      colors.push(v);
      hex.value = '';
      renderColors();
    }
  });
  const fonts = el({ tag: 'input', cls: 'input', attrs: { placeholder: t(lang, 'brand_fonts_ph'), 'aria-label': t(lang, 'brand_fonts_label') } }) as HTMLInputElement;
  const create = el({ tag: 'button', cls: 'btn', text: t(lang, 'brand_create'), attrs: { type: 'button' } }) as HTMLButtonElement;
  const err = el({ tag: 'div' });
  create.addEventListener('click', async () => {
    err.textContent = '';
    if (name.value.trim().length === 0) return;
    create.disabled = true;
    try {
      const res = await apiPost('api/brands', {
        name: name.value.trim(),
        colors,
        fonts: fonts.value.split(',').map((f) => f.trim()).filter(Boolean),
      });
      if (!res.ok) throw new Error('create');
      const created = (await res.json()) as { id: string };
      try {
        if (sessionStorage.getItem('mp-brand-return') === 'home') {
          sessionStorage.removeItem('mp-brand-return');
          sessionStorage.setItem('mp-brand-new', created.id);
          window.location.hash = '#/';
          return;
        }
      } catch { /* private mode: plain navigation */ }
      window.location.hash = `#/brands/${created.id}?new=1`;
    } catch {
      err.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'err_unknown') }));
      create.disabled = false;
    }
  });
  const form = el({ tag: 'div', cls: 'field' });
  form.append(
    el({ tag: 'label', text: t(lang, 'brand_name') }),
    name,
    el({ tag: 'label', text: t(lang, 'brand_colors_label') }),
    colorRow,
    el({ tag: 'label', text: t(lang, 'brand_fonts_label') }),
    fonts,
  );
  card.append(form);
  card.append(el({ tag: 'div', cls: 'toolbar', children: [create] }));
  card.append(err);
  host.append(card);
  // Create mode (linked from Home's "+ New brand"): jump to the form.
  if (window.location.hash.includes('create=1')) {
    card.scrollIntoView({ block: 'start' });
    name.focus({ preventScroll: true });
  }
}

const ROLES = ['primary', 'secondary', 'accent', 'text', 'background'] as const;

function roleLabel(lang: Lang, role: string): string {
  switch (role) {
    case 'primary': return t(lang, 'role_primary');
    case 'secondary': return t(lang, 'role_secondary');
    case 'accent': return t(lang, 'role_accent');
    case 'text': return t(lang, 'role_text');
    case 'background': return t(lang, 'role_background');
    default: return role;
  }
}

async function renderOpenBrand(host: HTMLElement, lang: Lang, id: string): Promise<void> {
  let detail: BrandDto;
  try {
    detail = await api<BrandDto>(`api/brands/${id}`);
  } catch {
    host.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'err_not_found') }));
    return;
  }
  const isNew = window.location.hash.includes('new=1');
  host.append(el({
    tag: 'div', cls: 'backrow', children: [
      el({ tag: 'a', cls: 'btn small secondary', text: t(lang, 'brands_title'), attrs: { href: '#/brands' } }),
    ],
  }));
  const titleRow = el({ tag: 'div', cls: 'page-head' });
  titleRow.append(el({ tag: 'h2', text: detail.name }));
  if (detail.demo) {
    const dup = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'brand_duplicate'), attrs: { type: 'button' } }) as HTMLButtonElement;
    dup.addEventListener('click', async () => {
      dup.disabled = true;
      try {
        const res = await apiPost(`api/brands/${detail.id}/duplicate`, {});
        if (!res.ok) throw new Error('dup');
        const created = (await res.json()) as { id: string };
        window.location.hash = `#/brands/${created.id}`;
      } catch {
        dup.disabled = false;
      }
    });
    titleRow.append(dup);
  }
  host.append(titleRow);
  if (detail.demo) host.append(el({ tag: 'div', cls: 'notice info', text: t(lang, 'brand_readonly') }));
  if (isNew) {
    host.append(el({
      tag: 'div', cls: 'steps', children: [t(lang, 'brand_new_step1'), t(lang, 'brand_new_step2'), t(lang, 'brand_new_step3')].map((s, i) => el({
        tag: 'div', cls: 'step', children: [el({ tag: 'span', cls: 'n', text: String(i + 1) }), el({ tag: 'span', text: s })],
      })),
    }));
  }

  const basicsHost = el({ tag: 'section', cls: 'card' });
  const examplesHost = el({ tag: 'section', cls: 'card' });
  const promptHost = el({ tag: 'section', cls: 'card' });
  host.append(basicsHost, examplesHost, promptHost);

  let editingPrompt = false;
  let polling = false;

  const refresh = async (): Promise<void> => {
    try {
      detail = await api<BrandDto>(`api/brands/${id}`);
    } catch {
      return;
    }
    renderBasics();
    renderExamples();
    if (!editingPrompt) renderPrompt('ready');
  };

  // Poll the prompt until it lands (ready / failed / capped), then refresh.
  const pollPrompt = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      for (let i = 0; i < 90; i++) {
        if (!promptHost.isConnected || editingPrompt) return;
        let state: { status: string; prompt?: BrandPromptDto; error?: string };
        try {
          state = await api<{ status: string; prompt?: BrandPromptDto; error?: string }>(`api/brands/${id}/prompt`);
        } catch {
          return;
        }
        if (state.status === 'ready') {
          await refresh();
          return;
        }
        if (state.status === 'failed' || state.status === 'capped') {
          renderPrompt(state.status);
          return;
        }
        if (state.status === 'none') {
          renderPrompt('none');
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      await refresh();
    } finally {
      polling = false;
    }
  };

  const startGenerate = async (): Promise<void> => {
    renderPrompt('generating');
    try {
      const res = await apiPost(`api/brands/${id}/prompt/generate`, {});
      if (res.status === 429) {
        renderPrompt('capped');
        return;
      }
      if (!res.ok) throw new Error('gen');
      await pollPrompt();
    } catch {
      renderPrompt('failed');
    }
  };

  // Debounced auto-generate after examples change (never over user edits).
  let autoTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleAutoGenerate = (): void => {
    if (detail.demo) return;
    if (detail.prompt?.editedByUser) return;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (!promptHost.isConnected || editingPrompt || polling) return;
      if (detail.examples.length === 0) return;
      void startGenerate();
    }, 2500);
  };

  // ---------- 1. Basics ----------
  const renderBasics = (): void => {
    basicsHost.textContent = '';
    basicsHost.append(el({ tag: 'h3', text: t(lang, 'ex_section_basics') }));
    const form = el({ tag: 'div', cls: 'field' });
    // Name.
    const nameInput = el({ tag: 'input', cls: 'input', attrs: { value: detail.name, 'aria-label': t(lang, 'brand_name') } }) as HTMLInputElement;
    if (detail.demo) nameInput.disabled = true;
    form.append(el({ tag: 'label', text: t(lang, 'brand_name') }), nameInput);
    // Logo.
    form.append(el({ tag: 'label', text: t(lang, 'logo_label') }));
    const logoRow = el({ tag: 'div', cls: 'logo-row' });
    if (detail.logo) {
      logoRow.append(el({ tag: 'img', cls: 'logo', attrs: { src: detail.logo as string, alt: '' } }) as HTMLImageElement);
    }
    if (!detail.demo) {
      const file = el({ tag: 'input', attrs: { type: 'file', accept: 'image/png,image/jpeg' } }) as HTMLInputElement;
      const up = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'brand_logo_upload'), attrs: { type: 'button' } }) as HTMLButtonElement;
      up.addEventListener('click', async () => {
        if (!file.files?.[0]) return;
        up.disabled = true;
        try {
          const res = await uploadFilesWithProgress(`api/brands/${detail.id}/logo`, [file.files[0]], {}, () => undefined);
          if (!res.ok) throw new Error('logo');
          await refresh();
        } catch {
          up.disabled = false;
        }
      });
      logoRow.append(el({ tag: 'div', cls: 'toolbar', children: [file, up] }));
    }
    form.append(logoRow);
    // Colours.
    form.append(el({ tag: 'label', text: t(lang, 'brand_colors_label') }));
    const colors = detail.colors.map((c) => ({ ...c }));
    const list = el({ tag: 'div', cls: 'color-list' });
    const paint = (): void => {
      list.textContent = '';
      colors.forEach((c, i) => {
        const row = el({ tag: 'div', cls: 'color-edit' });
        const pick = el({ tag: 'input', attrs: { type: 'color', value: c.hex, 'aria-label': c.hex } }) as HTMLInputElement;
        if (detail.demo) pick.disabled = true;
        pick.addEventListener('input', () => {
          colors[i] = { hex: pick.value, role: colors[i]?.role ?? 'primary' };
          hexInput.value = pick.value;
        });
        const hexInput = el({ tag: 'input', cls: 'input small', attrs: { value: c.hex, 'aria-label': '#hex', size: '9', dir: 'ltr' } }) as HTMLInputElement;
        if (detail.demo) hexInput.disabled = true;
        hexInput.addEventListener('change', () => {
          const v = hexInput.value.trim();
          if (/^#[0-9a-fA-F]{6}$/.test(v)) {
            colors[i] = { hex: v, role: colors[i]?.role ?? 'primary' };
            pick.value = v;
          } else {
            hexInput.value = colors[i]?.hex ?? '#000000';
          }
        });
        const role = el({ tag: 'select', attrs: { 'aria-label': 'role' } }) as HTMLSelectElement;
        for (const r of ROLES) {
          const opt = el({ tag: 'option', text: roleLabel(lang, r), attrs: { value: r } }) as HTMLOptionElement;
          if (c.role === r) opt.selected = true;
          role.append(opt);
        }
        if (detail.demo) role.disabled = true;
        role.addEventListener('change', () => {
          colors[i] = { hex: colors[i]?.hex ?? '#000000', role: role.value };
        });
        row.append(pick, hexInput, role);
        if (!detail.demo) {
          const rm = el({ tag: 'button', cls: 'linkbtn', text: '×', attrs: { type: 'button', 'aria-label': t(lang, 'ex_remove') } }) as HTMLButtonElement;
          rm.addEventListener('click', () => {
            colors.splice(i, 1);
            paint();
          });
          row.append(rm);
        }
        list.append(row);
      });
      if (!detail.demo && colors.length < 8) {
        const add = el({ tag: 'button', cls: 'btn small secondary', text: '+', attrs: { type: 'button', 'aria-label': '#hex' } }) as HTMLButtonElement;
        add.addEventListener('click', () => {
          colors.push({ hex: '#0e6b45', role: 'accent' });
          paint();
        });
        list.append(add);
      }
    };
    paint();
    form.append(list);
    // Fonts.
    const fontsInput = el({ tag: 'input', cls: 'input', attrs: { value: detail.fonts.join(', '), placeholder: t(lang, 'brand_fonts_ph'), 'aria-label': t(lang, 'brand_fonts_label') } }) as HTMLInputElement;
    if (detail.demo) fontsInput.disabled = true;
    form.append(el({ tag: 'label', text: t(lang, 'brand_fonts_label') }), fontsInput);
    basicsHost.append(form);
    if (!detail.demo) {
      const save = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'btn_save'), attrs: { type: 'button' } }) as HTMLButtonElement;
      save.addEventListener('click', async () => {
        save.disabled = true;
        const res = await apiPatch(`api/brands/${detail.id}`, {
          name: nameInput.value.trim() || detail.name,
          colors,
          fonts: fontsInput.value.split(',').map((f) => f.trim()).filter(Boolean),
        });
        if (res.ok) await refresh();
        else save.disabled = false;
      });
      basicsHost.append(el({ tag: 'div', cls: 'toolbar', children: [save] }));
    }
  };

  // ---------- 2. Style examples ----------
  const renderExamples = (): void => {
    examplesHost.textContent = '';
    examplesHost.append(el({ tag: 'h3', text: t(lang, 'ex_section_examples') }));
    if (!detail.demo) {
      const drop = el({ tag: 'div', cls: 'drop', attrs: { role: 'button', tabindex: '0', 'aria-label': t(lang, 'ex_drop_title') } });
      const fileInput = el({ tag: 'input', attrs: { type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: 'true', hidden: 'true' } }) as HTMLInputElement;
      const bar = el({ tag: 'div', cls: 'bar', children: [el({ tag: 'div' })] });
      bar.hidden = true;
      drop.append(
        el({ tag: 'div', cls: 'drop-title', text: t(lang, 'ex_drop_title') }),
        el({ tag: 'div', cls: 'hint', text: t(lang, 'ex_drop_hint') }),
        bar,
      );
      const send = async (files: File[]): Promise<void> => {
        const imgs = files.filter((f) => f.type.startsWith('image/'));
        if (imgs.length === 0) return;
        bar.hidden = false;
        const fill = bar.children[0] as HTMLElement;
        try {
          let done = 0;
          for (const f of imgs) {
            const res = await uploadFilesWithProgress(`api/brands/${detail.id}/examples`, [f], {}, (r) => {
              fill.style.width = `${Math.round(((done + r) / imgs.length) * 100)}%`;
            });
            if (!res.ok) throw new Error('ex');
            done++;
          }
          await refresh();
          scheduleAutoGenerate();
        } catch {
          examplesHost.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'err_unknown') }));
        } finally {
          bar.hidden = true;
        }
      };
      fileInput.addEventListener('change', () => void send([...fileInput.files ?? []]));
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
      drop.addEventListener('drop', (e) => void send([...(e.dataTransfer?.files ?? [])]));
      examplesHost.append(drop, fileInput);
    } else {
      examplesHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'ex_drop_hint') }));
    }
    const grid = el({ tag: 'div', cls: 'ex-grid' });
    for (const ex of detail.examples) {
      const cell = el({ tag: 'div', cls: 'ex-cell' });
      cell.append(el({ tag: 'img', attrs: { src: ex.thumb, alt: scopeLabel(lang, ex.scope), loading: 'lazy' } }) as HTMLImageElement);
      const bar = el({ tag: 'div', cls: 'ex-bar' });
      if (detail.demo) {
        bar.append(el({ tag: 'span', cls: 'scope-chip', text: scopeLabel(lang, ex.scope) }));
      } else {
        const sel = el({ tag: 'select', cls: 'scope-chip', attrs: { 'aria-label': t(lang, 'ex_scope_change') } }) as HTMLSelectElement;
        const opts: Array<[string, string]> = [['general', scopeLabel(lang, 'general')]];
        for (const p of PRESETS) opts.push([p.id, nativeName(lang, p.id)]);
        for (const [value, label] of opts) {
          const opt = el({ tag: 'option', text: label, attrs: { value } }) as HTMLOptionElement;
          if (ex.scope === value) opt.selected = true;
          sel.append(opt);
        }
        sel.addEventListener('change', async () => {
          const res = await apiPatch(`api/examples/${ex.id}`, { scope: sel.value });
          if (res.ok) {
            await refresh();
            scheduleAutoGenerate();
          }
        });
        bar.append(sel);
      }
      if (ex.status === 'pending') bar.append(el({ tag: 'span', cls: 'small muted', text: t(lang, 'tpl_status_pending') }));
      if (ex.status === 'failed') bar.append(el({ tag: 'span', cls: 'small muted', text: t(lang, 'tpl_status_failed') }));
      cell.append(bar);
      if (!detail.demo) {
        const rm = el({ tag: 'button', cls: 'ex-remove', text: '×', attrs: { type: 'button', 'aria-label': t(lang, 'ex_remove') } }) as HTMLButtonElement;
        rm.addEventListener('click', () => {
          cell.append(el({
            tag: 'div', cls: 'confirm-row', children: [
              el({ tag: 'span', text: t(lang, 'ex_remove_confirm') }),
              (() => {
                const yes = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'tpl_confirm'), attrs: { type: 'button' } }) as HTMLButtonElement;
                yes.addEventListener('click', async () => {
                  const res = await apiDelete(`api/examples/${ex.id}`);
                  if (res.ok) {
                    await refresh();
                    scheduleAutoGenerate();
                  }
                });
                return yes;
              })(),
              (() => {
                const no = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'tpl_cancel'), attrs: { type: 'button' } }) as HTMLButtonElement;
                no.addEventListener('click', () => void refresh());
                return no;
              })(),
            ],
          }));
        });
        cell.append(rm);
      }
      grid.append(cell);
    }
    examplesHost.append(grid);
  };

  // ---------- 3. Brand prompt ----------
  const bullets = (items: string[]): HTMLElement =>
    el({ tag: 'ul', cls: 'prompt-list', children: items.map((b) => el({ tag: 'li', text: b })) });

  const renderPromptGroups = (p: BrandPromptDto): HTMLElement => {
    const wrap = el({ tag: 'div', cls: 'prompt-groups' });
    wrap.append(el({ tag: 'h4', text: t(lang, 'prompt_general') }));
    wrap.append(bullets(p.general));
    if (p.proportions.length > 0) {
      wrap.append(el({ tag: 'h4', text: t(lang, 'prompt_fixed') }));
      wrap.append(bullets(p.proportions.map((pr) => `${pr.element} ≈ ${pr.pct}% ${pr.dimension}`)));
    }
    for (const key of Object.keys(p.perPreset).sort()) {
      wrap.append(el({ tag: 'h4', text: nativeName(lang, key) }));
      wrap.append(bullets(p.perPreset[key] ?? []));
    }
    if (p.text.length > 0) {
      wrap.append(el({ tag: 'h4', text: t(lang, 'prompt_text_sec') }));
      wrap.append(bullets(p.text));
    }
    wrap.append(el({ tag: 'h4', text: t(lang, 'prompt_never') }));
    wrap.append(bullets(p.never));
    return wrap;
  };

  const renderPrompt = (state: string): void => {
    promptHost.textContent = '';
    promptHost.append(el({ tag: 'h3', text: t(lang, 'ex_section_prompt') }));
    promptHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'prompt_what') }));
    const p = detail.prompt;
    if (state === 'generating' || polling) {
      promptHost.append(el({ tag: 'div', cls: 'shimmer', attrs: { style: 'min-height:120px' } }));
      promptHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'prompt_generating') }));
      return;
    }
    if (state === 'capped') {
      promptHost.append(el({ tag: 'div', cls: 'notice warn', text: t(lang, 'prompt_capped') }));
      if (p) promptHost.append(renderPromptGroups(p));
      return;
    }
    if (state === 'failed') {
      promptHost.append(el({ tag: 'div', cls: 'notice error', text: t(lang, 'prompt_failed') }));
      if (!detail.demo) {
        const retry = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'prompt_regenerate'), attrs: { type: 'button' } }) as HTMLButtonElement;
        retry.addEventListener('click', () => void startGenerate());
        promptHost.append(el({ tag: 'div', cls: 'toolbar', children: [retry] }));
      }
      if (p) promptHost.append(renderPromptGroups(p));
      return;
    }
    if (!p) {
      promptHost.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'prompt_none') }));
      return;
    }
    if (editingPrompt) {
      const area = el({ tag: 'textarea', cls: 'prompt-edit', attrs: { rows: '14', dir: 'auto' } }) as HTMLTextAreaElement;
      area.value = p.readable;
      promptHost.append(area);
      const save = el({ tag: 'button', cls: 'btn small', text: t(lang, 'prompt_save'), attrs: { type: 'button' } }) as HTMLButtonElement;
      save.addEventListener('click', async () => {
        if (area.value.trim().length === 0) return;
        save.disabled = true;
        const res = await apiPatch(`api/brands/${detail.id}/prompt`, { text: area.value });
        if (res.ok) {
          editingPrompt = false;
          await refresh();
        } else {
          save.disabled = false;
        }
      });
      const cancel = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'prompt_cancel'), attrs: { type: 'button' } }) as HTMLButtonElement;
      cancel.addEventListener('click', () => {
        editingPrompt = false;
        renderPrompt('ready');
      });
      promptHost.append(el({ tag: 'div', cls: 'toolbar', children: [save, cancel] }));
      return;
    }
    if (p.editedByUser) {
      promptHost.append(el({ tag: 'pre', cls: 'prompt-text', text: p.readable }));
    } else {
      promptHost.append(renderPromptGroups(p));
    }
    const byline = el({ tag: 'div', cls: 'byline' });
    byline.append(el({ tag: 'span', text: t(lang, 'prompt_by').replace('{model}', p.generatedBy).replace('{time}', fmtTime(lang, p.generatedAt)) }));
    if (p.editedByUser) byline.append(el({ tag: 'span', cls: 'tag', text: t(lang, 'prompt_edited') }));
    promptHost.append(byline);
    if (!detail.demo) {
      const edit = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'prompt_edit'), attrs: { type: 'button' } }) as HTMLButtonElement;
      edit.addEventListener('click', () => {
        editingPrompt = true;
        renderPrompt('ready');
      });
      const regen = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'prompt_regenerate'), attrs: { type: 'button' } }) as HTMLButtonElement;
      regen.addEventListener('click', () => {
        if (!p.editedByUser) {
          void startGenerate();
          return;
        }
        promptHost.append(el({
          tag: 'div', cls: 'confirm-row', children: [
            el({ tag: 'span', text: t(lang, 'prompt_overwrite') }),
            (() => {
              const yes = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'prompt_regenerate'), attrs: { type: 'button' } }) as HTMLButtonElement;
              yes.addEventListener('click', () => void startGenerate());
              return yes;
            })(),
            (() => {
              const no = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'tpl_cancel'), attrs: { type: 'button' } }) as HTMLButtonElement;
              no.addEventListener('click', () => renderPrompt('ready'));
              return no;
            })(),
          ],
        }));
      });
      promptHost.append(el({ tag: 'div', cls: 'toolbar', children: [edit, regen] }));
    }
  };

  renderBasics();
  renderExamples();
  renderPrompt('ready');

  // Delete (user-created brands only; demo brands stay read-only).
  if (!detail.demo) {
    const danger = el({ tag: 'section', cls: 'card' });
    const del = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'brand_delete'), attrs: { type: 'button' } }) as HTMLButtonElement;
    del.addEventListener('click', () => {
      del.disabled = true;
      danger.append(el({
        tag: 'div', cls: 'confirm-row', children: [
          el({ tag: 'span', text: t(lang, 'brand_delete_confirm') }),
          (() => {
            const yes = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'brand_delete_yes'), attrs: { type: 'button' } }) as HTMLButtonElement;
            yes.addEventListener('click', async () => {
              const res = await apiDelete(`api/brands/${detail.id}`);
              if (res.ok) window.location.hash = '#/brands';
              else {
                yes.disabled = false;
                del.disabled = false;
              }
            });
            return yes;
          })(),
          (() => {
            const no = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'tpl_cancel'), attrs: { type: 'button' } }) as HTMLButtonElement;
            no.addEventListener('click', () => {
              danger.textContent = '';
              danger.append(el({ tag: 'div', cls: 'toolbar', children: [del] }));
              del.disabled = false;
            });
            return no;
          })(),
        ],
      }));
    });
    danger.append(el({ tag: 'div', cls: 'toolbar', children: [del] }));
    host.append(danger);
  }
}
