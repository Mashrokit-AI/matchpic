/** How it works: 4-step visual + short limits list. */
import type { Lang } from '../shared/i18n.js';
import { arrowSvg, el, t } from './lib.js';

export function renderAbout(root: HTMLElement, lang: Lang): void {
  const rtl = lang === 'he';
  root.append(el({ tag: 'h1', text: t(lang, 'about_title') }));
  const steps: Array<{ t: string; l: string; m: string }> = [
    { t: t(lang, 'about_v1t'), l: t(lang, 'about_v1l'), m: 'muse-spark-1.3' },
    { t: t(lang, 'about_v2t'), l: t(lang, 'about_v2l'), m: 'sam-3.1' },
    { t: t(lang, 'about_v3t'), l: t(lang, 'about_v3l'), m: 'muse-wonder-1.0' },
    { t: t(lang, 'about_v4t'), l: t(lang, 'about_v4l'), m: 'muse-image-1.0' },
  ];
  const viz = el({ tag: 'div', cls: 'viz' });
  steps.forEach((s, i) => {
    viz.append(el({
      tag: 'div', cls: 'vstep', children: [
        el({ tag: 'span', cls: 'n', text: `${i + 1}` }),
        el({ tag: 'span', cls: 't', text: s.t }),
        el({ tag: 'span', cls: 'l', text: s.l }),
        el({ tag: 'span', cls: 'm', text: s.m, attrs: { dir: 'ltr' } }),
        el({ tag: 'span', cls: 'arr', html: arrowSvg(rtl) }),
      ],
    }));
  });
  root.append(viz);
  const limits = el({ tag: 'section', cls: 'limits' });
  limits.append(el({ tag: 'h2', text: t(lang, 'about_limits') }));
  const ul = el({ tag: 'ul' });
  for (const key of ['about_limit1', 'about_limit2', 'about_limit3', 'about_limit4'] as const) {
    ul.append(el({ tag: 'li', text: t(lang, key) }));
  }
  limits.append(ul);
  root.append(limits);
}
