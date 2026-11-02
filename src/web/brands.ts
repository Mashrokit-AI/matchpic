/** Brands: cards, one open brand, one size at a time. */
import type { Lang } from '../shared/i18n.js';
import { PRESETS } from '../shared/presets.js';
import type { Route } from './app.js';
import type { BrandDto } from './dto.js';
import { api, apiDelete, apiPatch, apiPost, el, t, uploadFilesWithProgress } from './lib.js';

const FONT_STACKS = [
  'Noto Sans Hebrew',
  'Noto Sans',
  'Noto Sans,Noto Sans Hebrew',
  'Noto Sans Hebrew,Noto Sans',
];

function swatches(colors: string[]): HTMLElement {
  const row = el({ tag: 'div', cls: 'swatches' });
  for (const c of colors.slice(0, 5)) {
    row.append(el({ tag: 'span', cls: 'sw', attrs: { style: `background:${c}`, title: c } }));
  }
  return row;
}

export async function renderBrands(root: HTMLElement, lang: Lang, route: Route): Promise<void> {
  root.append(el({ tag: 'h1', text: t(lang, 'brands_title') }));
  const host = el({ tag: 'div' });
  root.append(host);
  if (route.brand) {
    await renderOpenBrand(host, lang, route.brand);
    return;
  }
  await renderList(host, lang);
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
  const newTop = el({ tag: 'a', cls: 'btn', text: t(lang, 'brand_new'), attrs: { href: '#new-brand-form' } });
  newTop.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('new-brand-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('new-brand-name')?.focus({ preventScroll: true });
  });
  host.append(el({ tag: 'div', cls: 'toolbar', children: [newTop] }));
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
    if (b.demo) tags.append(el({ tag: 'span', cls: 'tag demo', text: t(lang, 'brand_readonly') }));
    else tags.append(el({ tag: 'span', cls: 'tag', text: t(lang, 'brand_expires') }));
    title.append(tags);
    top.append(title);
    card.append(top);
    if (b.colors.length > 0) card.append(swatches(b.colors));
    // Which sizes have templates: fetched per brand below.
    const sizes = el({ tag: 'div', cls: 'sizelist' });
    card.append(sizes);
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
    void api<BrandDto>(`api/brands/${b.id}`).then(
      (d) => {
        const have = new Set(d.templates.map((x) => x.preset).filter((p): p is string => !!p));
        sizes.textContent = PRESETS.filter((p) => have.has(p.id)).map((p) => `${p.width}×${p.height}`).join(' · ') || '—';
        sizes.setAttribute('dir', 'ltr');
      },
      () => undefined,
    );
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
  const fonts = el({ tag: 'select', attrs: { 'aria-label': t(lang, 'brand_fonts_label') } }) as HTMLSelectElement;
  for (const f of FONT_STACKS) {
    fonts.append(el({ tag: 'option', text: f, attrs: { value: f } }) as HTMLOptionElement);
  }
  const create = el({ tag: 'button', cls: 'btn', text: t(lang, 'brand_create'), attrs: { type: 'button' } }) as HTMLButtonElement;
  const err = el({ tag: 'div' });
  create.addEventListener('click', async () => {
    err.textContent = '';
    if (name.value.trim().length === 0) return;
    create.disabled = true;
    try {
      const res = await apiPost('api/brands', { name: name.value.trim(), colors, fonts: fonts.value.split(',') });
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
  host.append(el({ tag: 'h2', text: detail.name }));
  if (detail.demo) host.append(el({ tag: 'div', cls: 'notice info', text: t(lang, 'brand_readonly') }));
  if (isNew) {
    host.append(el({
      tag: 'div', cls: 'steps', children: [t(lang, 'brand_step1'), t(lang, 'brand_step2'), t(lang, 'brand_step3')].map((s, i) => el({
        tag: 'div', cls: 'step', children: [el({ tag: 'span', cls: 'n', text: String(i + 1) }), el({ tag: 'span', text: s })],
      })),
    }));
  }

  // Logo.
  const logoCard = el({ tag: 'section', cls: 'card' });
  logoCard.append(el({ tag: 'h3', text: t(lang, 'brand_logo_label') }));
  if (detail.logo) {
    logoCard.append(el({ tag: 'img', cls: 'logo', attrs: { src: detail.logo as string, alt: '', style: 'width:96px;height:96px;object-fit:contain' } }) as HTMLImageElement);
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
        window.location.hash = `#/brands/${detail.id}`;
        window.location.reload();
      } catch {
        up.disabled = false;
      }
    });
    logoCard.append(el({ tag: 'div', cls: 'toolbar', children: [file, up] }));
  }
  host.append(logoCard);

  // One size at a time.
  const have = new Set(detail.templates.map((x) => x.preset).filter((p): p is string => !!p));
  const tabs = el({ tag: 'div', cls: 'sizetabs', attrs: { role: 'tablist' } });
  const editor = el({ tag: 'div' });
  host.append(tabs, editor);
  const first = PRESETS.find((p) => !have.has(p.id)) ?? PRESETS[0];
  let current = first?.id ?? 'ig-feed-11';

  const renderEditor = (): void => {
    tabs.textContent = '';
    for (const p of PRESETS) {
      const b = el({
        tag: 'button', attrs: { role: 'tab', 'aria-selected': String(p.id === current), type: 'button' },
        children: [
          el({ tag: 'span', text: `${p.width}×${p.height}`, attrs: { dir: 'ltr' } }),
          have.has(p.id) ? el({ tag: 'span', cls: 'dot', text: ' ●' }) : null,
        ],
      });
      b.addEventListener('click', () => {
        current = p.id;
        renderEditor();
      });
      tabs.append(b);
    }
    editor.textContent = '';
    const preset = PRESETS.find((p) => p.id === current);
    if (!preset) return;
    const tpl = detail.templates.find((x) => x.preset === current) ?? null;
    const grid = el({ tag: 'div', cls: 'editor-grid' });
    const left = el({ tag: 'div' });
    const right = el({ tag: 'div', cls: 'field' });
    grid.append(left, right);
    editor.append(grid);
    const ratio = preset.width / preset.height;
    const frame = el({ tag: 'div', cls: `tplimg ${ratio < 0.8 ? 'tall' : ratio > 1.3 ? 'wide' : 'square'}` });
    if (tpl) {
      frame.append(el({ tag: 'img', attrs: { src: tpl.image, alt: '' } }) as HTMLImageElement);
    } else {
      frame.append(el({ tag: 'div', cls: 'small muted', text: t(lang, 'tpl_empty'), attrs: { style: 'padding:16px' } }));
    }
    left.append(frame);
    if (tpl) {
      right.append(el({ tag: 'label', text: t(lang, 'tpl_status_label') }));
      const st = tpl.status === 'ready'
        ? t(lang, 'tpl_status_ready')
        : tpl.status === 'failed'
          ? t(lang, 'tpl_status_failed')
          : t(lang, 'tpl_status_pending');
      right.append(el({ tag: 'div', text: st }));
      if (!detail.demo) {
        right.append(el({ tag: 'label', text: t(lang, 'tpl_nudge_label') }));
        const nudges = el({ tag: 'div', cls: 'nudges' });
        const dirs: Array<[string, number, number]> = [
          ['↖', -1, -1], ['↑', 0, -1], ['↗', 1, -1],
          ['←', -1, 0], ['·', 0, 0], ['→', 1, 0],
          ['↙', -1, 1], ['↓', 0, 1], ['↘', 1, 1],
        ];
        for (const [glyph, dx, dy] of dirs) {
          const b = el({ tag: 'button', text: glyph, attrs: { type: 'button' } }) as HTMLButtonElement;
          if (dx === 0 && dy === 0) b.disabled = true;
          else {
            b.addEventListener('click', async () => {
              const res = await apiPost(`api/templates/${tpl.id}/nudge`, { dx: dx * 8, dy: dy * 8 });
              if (res.ok) void refresh();
            });
          }
          nudges.append(b);
        }
        right.append(nudges);
        const del = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'tpl_reject'), attrs: { type: 'button' } }) as HTMLButtonElement;
        del.addEventListener('click', () => {
          right.append(el({
            tag: 'div', cls: 'confirm-row', children: [
              el({ tag: 'span', text: t(lang, 'tpl_confirm_remove') }),
              (() => {
                const yes = el({ tag: 'button', cls: 'btn small danger-text', text: t(lang, 'tpl_confirm'), attrs: { type: 'button' } }) as HTMLButtonElement;
                yes.addEventListener('click', async () => {
                  const res = await apiDelete(`api/templates/${tpl.id}`);
                  if (res.ok) void refresh();
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
        right.append(el({ tag: 'div', cls: 'toolbar', children: [del] }));
      }
    } else if (!detail.demo) {
      right.append(el({ tag: 'label', text: t(lang, 'tpl_size') }));
      const file = el({ tag: 'input', attrs: { type: 'file', accept: 'image/png,image/jpeg' } }) as HTMLInputElement;
      const up = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'tpl_upload'), attrs: { type: 'button' } }) as HTMLButtonElement;
      up.addEventListener('click', async () => {
        if (!file.files?.[0]) return;
        up.disabled = true;
        try {
          const res = await uploadFilesWithProgress('api/templates', [file.files[0]], { brandId: detail.id, preset: current }, () => undefined);
          if (!res.ok) throw new Error('tpl');
          void refresh();
        } catch {
          up.disabled = false;
        }
      });
      right.append(file, up);
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      detail = await api<BrandDto>(`api/brands/${id}`);
      for (const x of detail.templates) { if (x.preset) have.add(x.preset); }
      renderEditor();
    } catch {
      // Keep the stale view on refresh failure.
    }
  };
  renderEditor();

  // Colours (editable copies only).
  if (!detail.demo) {
    const colorCard = el({ tag: 'section', cls: 'card' });
    colorCard.append(el({ tag: 'h3', text: t(lang, 'brand_colors_label') }));
    const row = el({ tag: 'div', cls: 'color-row' });
    const colors = [...detail.colors];
    const hex = el({ tag: 'input', cls: 'input small', attrs: { placeholder: '#0e6b45', 'aria-label': '#hex', size: '10' } }) as HTMLInputElement;
    const paint = (): void => {
      row.textContent = '';
      colors.forEach((c, i) => {
        const pick = el({ tag: 'input', attrs: { type: 'color', value: c, 'aria-label': c } }) as HTMLInputElement;
        pick.addEventListener('input', () => {
          colors[i] = pick.value;
        });
        row.append(pick);
      });
      row.append(hex);
    };
    paint();
    hex.addEventListener('change', () => {
      const v = hex.value.trim();
      if (/^#[0-9a-fA-F]{6}$/.test(v) && colors.length < 6) {
        colors.push(v);
        hex.value = '';
        paint();
      }
    });
    const save = el({ tag: 'button', cls: 'btn small secondary', text: t(lang, 'texts_confirm'), attrs: { type: 'button' } }) as HTMLButtonElement;
    save.addEventListener('click', async () => {
      const res = await apiPatch(`api/brands/${detail.id}`, { colors });
      if (res.ok) save.disabled = true;
    });
    colorCard.append(row, el({ tag: 'div', cls: 'toolbar', children: [save] }));
    host.append(colorCard);
  }

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
