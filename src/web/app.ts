/** App shell: header, language, hash routes. */
import type { Lang } from '../shared/i18n.js';
import { BRAND_NAME, applyLang, el, getLang, setLang, t } from './lib.js';
import { renderAbout } from './about.js';
import { renderBrands } from './brands.js';
import { renderHome } from './home.js';
import { renderOutput } from './output.js';

export type Page = 'home' | 'brands' | 'about' | 'output' | 'run' | 'notfound';

export interface Route {
  page: Page;
  id?: string;
  brand?: string;
}

export function parseHash(hash: string): Route {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  const [path] = h.split('?');
  const parts = (path ?? '').split('/').filter(Boolean);
  if (parts.length === 0) return { page: 'home' };
  if (parts[0] === 'brands') return { page: 'brands', brand: parts[1] };
  if (parts[0] === 'about') return { page: 'about' };
  if (parts[0] === 'output' && parts[1]) return { page: 'output', id: parts[1] };
  if (parts[0] === 'run' && parts[1]) return { page: 'run', id: parts[1] };
  return { page: 'notfound' };
}

function logoSvg(): string {
  return `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="6" fill="var(--sky)"/><path d="M7 13.5 11.5 18 19 9.5" stroke="var(--night)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function switchLang(lang: Lang): void {
  // Keep the route and the scroll target across language switches.
  const y = window.scrollY;
  const hash = window.location.hash;
  setLang(lang);
  applyLang(lang);
  void render().then(() => {
    if (window.location.hash !== hash) window.location.hash = hash;
    window.scrollTo(0, y);
  });
}

export function header(lang: Lang, route: Route): HTMLElement {
  const bar = el({ tag: 'header', cls: 'topbar' });
  const inner = el({ tag: 'div', cls: 'topbar-inner' });
  const brand = el({
    tag: 'a',
    cls: 'brand',
    attrs: { href: '#/' },
    children: [
      el({ tag: 'span', html: logoSvg() }),
      el({ tag: 'span', cls: 'brand-name', text: BRAND_NAME }),
    ],
  });
  const tagline = el({ tag: 'span', cls: 'tagline', text: t(lang, 'app_tagline') });
  const nav = el({ tag: 'nav', cls: 'nav', attrs: { 'aria-label': BRAND_NAME } });
  const links: Array<[string, string, Page[]]> = [
    ['#/', t(lang, 'nav_home'), ['home']],
    ['#/brands', t(lang, 'nav_brands'), ['brands']],
    ['#/about', t(lang, 'nav_about'), ['about']],
  ];
  for (const [href, label, pages] of links) {
    const a = el({ tag: 'a', text: label, attrs: { href } });
    if (pages.includes(route.page)) a.setAttribute('aria-current', 'page');
    nav.append(a);
  }
  const toggle = el({ tag: 'div', cls: 'lang-toggle', attrs: { role: 'group', 'aria-label': 'Language / שפה' } });
  for (const l of ['en', 'he'] as Lang[]) {
    const b = el({ tag: 'button', text: l === 'en' ? 'EN' : 'עב', attrs: { type: 'button', 'aria-pressed': String(l === lang) } });
    b.addEventListener('click', () => switchLang(l));
    toggle.append(b);
  }
  const menuBtn = el({
    tag: 'button',
    cls: 'menu-btn',
    attrs: { type: 'button', 'aria-label': t(lang, 'menu_open'), 'aria-expanded': 'false' },
    children: [el({ tag: 'span' })],
  });
  const panel = el({ tag: 'nav', cls: 'menu-panel', attrs: { 'aria-label': BRAND_NAME } });
  for (const [href, label, pages] of links) {
    const a = el({ tag: 'a', text: label, attrs: { href } });
    if (pages.includes(route.page)) a.setAttribute('aria-current', 'page');
    a.addEventListener('click', () => {
      panel.classList.remove('open');
      menuBtn.setAttribute('aria-expanded', 'false');
    });
    panel.append(a);
  }
  menuBtn.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', String(open));
  });
  inner.append(brand, tagline, nav, toggle, menuBtn);
  bar.append(inner, panel);
  return bar;
}

const REPO = 'https://github.com/Mashrokit-AI/matchpic';

function footer(lang: Lang): HTMLElement {
  return el({
    tag: 'footer',
    cls: 'footer',
    children: [
      el({ tag: 'span', text: t(lang, 'footer_synthetic') }),
      el({ tag: 'a', text: t(lang, 'footer_repo'), attrs: { href: REPO, target: '_blank', rel: 'noopener' } }),
      el({ tag: 'span', text: t(lang, 'footer_by') }),
    ],
  });
}

export async function render(): Promise<void> {
  const lang = getLang();
  const route = parseHash(window.location.hash);
  applyLang(lang);
  document.body.textContent = '';
  document.body.append(header(lang, route));
  const wrap = el({ tag: 'main', cls: 'wrap' });
  document.body.append(wrap);
  if (route.page === 'home' || route.page === 'run') renderHome(wrap, lang, route);
  else if (route.page === 'brands') await renderBrands(wrap, lang, route);
  else if (route.page === 'about') renderAbout(wrap, lang);
  else if (route.page === 'output' && route.id) await renderOutput(wrap, lang, route.id);
  else wrap.append(el({ tag: 'p', text: t(lang, 'err_not_found') }));
  wrap.append(footer(lang));
}

window.addEventListener('hashchange', () => {
  void render().then(() => window.scrollTo(0, 0));
});
void render();
