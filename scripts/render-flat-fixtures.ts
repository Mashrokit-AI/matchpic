#!/usr/bin/env tsx
/**
 * Flat-design fixture generator: ZAZO (EN sunglasses, 1.91:1) + TODA (HE
 * headphones, 16:9). Solid background + SVG product + Chromium-rendered text,
 * no photo background — the flat counterpoint to the photo fixtures.
 * Renders source creative + logo lockup + brand.json (no templates: these
 * brands exercise the engine's no-template default-layout path).
 *
 *   npx tsx scripts/render-flat-fixtures.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { findRepoRoot } from '../src/shared/env.js';

const REPO_ROOT = findRepoRoot(import.meta.url);

interface FlatBrand {
  id: string;
  name: string;
  lang: 'he' | 'en';
  dirAttr: 'rtl' | 'ltr';
  colors: string[];
  W: number;
  H: number;
  bg: string;
  disc: string;
  discRings: string;
  ink: string;
  subInk: string;
  panelFill: string;
  panelInk: string;
  logoMark: string;
  wordmark: string;
  headline: string;
  subline: string;
  price: string;
  cta: string;
  terms: string;
  product: string;
  sourceFile: string;
}

const ZAZO: FlatBrand = {
  id: 'zazo',
  name: 'ZAZO',
  lang: 'en',
  dirAttr: 'ltr',
  colors: ['#17323d', '#e8a13d', '#f4ecdd', '#c96f2e'],
  W: 1200,
  H: 628,
  bg: '#f4ecdd',
  disc: '#e8a13d',
  discRings: '#c96f2e',
  ink: '#17323d',
  subInk: '#4a6a75',
  panelFill: '#17323d',
  panelInk: '#f4ecdd',
  logoMark: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#17323d"/><path d="M14 36 a18 18 0 0 1 36 0" fill="#e8a13d"/><rect x="12" y="37" width="40" height="5" rx="2.5" fill="#f4ecdd"/></svg>`,
  wordmark: 'ZAZO',
  headline: 'Shade season is on',
  subline: 'Polarized lenses · under $50',
  price: '$49',
  cta: 'Shop now',
  terms: 'Free shipping · 30-day returns',
  product: `<svg viewBox="0 0 420 170" width="520" height="210">
    <rect x="4" y="52" width="60" height="16" rx="8" fill="#17323d"/>
    <rect x="356" y="52" width="60" height="16" rx="8" fill="#17323d"/>
    <rect x="30" y="30" width="170" height="120" rx="44" fill="#17323d"/>
    <rect x="220" y="30" width="170" height="120" rx="44" fill="#17323d"/>
    <path d="M200 62 Q210 50 220 62" stroke="#17323d" stroke-width="16" fill="none" stroke-linecap="round"/>
    <path d="M62 40 L100 40 L66 140 L44 140 z" fill="#ffffff" opacity=".28"/>
    <path d="M252 40 L290 40 L256 140 L234 140 z" fill="#ffffff" opacity=".28"/>
    <circle cx="385" cy="135" r="7" fill="#e8a13d"/>
  </svg>`,
  sourceFile: 'source-en.png',
};

const TODA: FlatBrand = {
  id: 'toda',
  name: 'TODA',
  lang: 'he',
  dirAttr: 'rtl',
  colors: ['#4a1f33', '#c98aa0', '#f7ede0', '#7a3c55'],
  W: 1280,
  H: 720,
  bg: '#4a1f33',
  disc: '#c98aa0',
  discRings: '#7a3c55',
  ink: '#f7ede0',
  subInk: '#e3c4cf',
  panelFill: '#f7ede0',
  panelInk: '#4a1f33',
  logoMark: `<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#f7ede0"/><path d="M20 38 a12 12 0 0 1 24 0" stroke="#4a1f33" stroke-width="7" fill="none" stroke-linecap="round"/><rect x="15" y="34" width="8" height="14" rx="4" fill="#4a1f33"/><rect x="41" y="34" width="8" height="14" rx="4" fill="#4a1f33"/></svg>`,
  wordmark: 'TODA',
  headline: 'שומעים כל פרט',
  subline: 'אלחוטיות · 40 שעות סוללה',
  price: '₪349',
  cta: 'לקנייה',
  terms: 'משלוח חינם · אחריות לשנתיים',
  product: `<svg viewBox="0 0 380 320" width="470" height="396">
    <path d="M55 250 C55 130 120 55 190 55 C260 55 325 130 325 250" stroke="#f7ede0" stroke-width="30" fill="none" stroke-linecap="round"/>
    <rect x="18" y="200" width="76" height="110" rx="34" fill="#f7ede0"/>
    <rect x="286" y="200" width="76" height="110" rx="34" fill="#f7ede0"/>
    <rect x="32" y="218" width="48" height="74" rx="22" fill="#7a3c55"/>
    <rect x="300" y="218" width="48" height="74" rx="22" fill="#7a3c55"/>
    <circle cx="190" cy="55" r="12" fill="#e8a13d"/>
  </svg>`,
  sourceFile: 'source-he.png',
};

function doc(b: FlatBrand): string {
  const textLeft = b.dirAttr === 'rtl';
  const discCx = textLeft ? Math.round(b.W * 0.24) : Math.round(b.W * 0.76);
  const discCy = Math.round(b.H * 0.52);
  const discR = Math.round(Math.min(b.W, b.H) * 0.42);
  const prodW = b.id === 'zazo' ? 520 : 470;
  const prodH = b.id === 'zazo' ? 210 : 396;
  const prodX = discCx - Math.round(prodW / 2);
  const prodY = discCy - Math.round(prodH / 2);
  const tx = textLeft ? Math.round(b.W * 0.5) : 70;
  const tw = Math.round(b.W * 0.44);
  const align = b.dirAttr === 'rtl' ? 'right' : 'left';
  return `<!doctype html>
<html lang="${b.lang}" dir="${b.dirAttr}">
<head><meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${b.W}px; height: ${b.H}px; overflow: hidden; }
  body { font-family: Arial, "Arial Hebrew", sans-serif; position: relative; background: ${b.bg}; }
  .disc { position: absolute; left: ${discCx - discR}px; top: ${discCy - discR}px; width: ${discR * 2}px; height: ${discR * 2}px; border-radius: 50%; background: ${b.disc}; }
  .ring { position: absolute; border-radius: 50%; border: 3px solid ${b.discRings}; opacity: .55; }
  .product { position: absolute; left: ${prodX}px; top: ${prodY}px; }
  .pshadow { position: absolute; left: ${prodX - 20}px; top: ${prodY + prodH - 12}px; width: ${prodW + 40}px; height: 30px;
             background: radial-gradient(ellipse at center, rgba(20,20,20,.30) 0%, rgba(20,20,20,0) 70%); }
  .logo { position: absolute; left: ${tx}px; top: 44px; width: ${tw}px; height: 56px; display: flex; align-items: center; gap: 12px; direction: ltr; justify-content: ${textLeft ? 'flex-end' : 'flex-start'}; }
  .logo svg { width: 56px; height: 56px; flex: none; }
  .logo span { font: 800 44px/1 Arial, sans-serif; letter-spacing: 6px; color: ${b.ink}; }
  .headline { position: absolute; left: ${tx}px; top: 128px; width: ${tw}px; font-size: 62px; font-weight: 800; line-height: 1.12; color: ${b.ink}; text-align: ${align}; }
  .subline { position: absolute; left: ${tx}px; top: 278px; width: ${tw}px; font-size: 32px; color: ${b.subInk}; text-align: ${align}; }
  .panel { position: absolute; left: ${tx}px; top: ${b.H - 218}px; width: ${tw}px; height: 168px; border-radius: 24px;
           background: ${b.panelFill}; color: ${b.panelInk}; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .panel .price { font-size: 66px; font-weight: 800; line-height: 1.05; }
  .panel .cta { font-size: 34px; font-weight: 700; margin-top: 4px; text-decoration: underline; }
  .panel .terms { font-size: 25px; margin-top: 6px; opacity: .9; }
</style>
</head><body>
<div class="disc"></div>
<div class="ring" style="left:${discCx - discR - 26}px;top:${discCy - discR - 26}px;width:${(discR + 26) * 2}px;height:${(discR + 26) * 2}px"></div>
<div class="ring" style="left:${discCx - discR - 52}px;top:${discCy - discR - 52}px;width:${(discR + 52) * 2}px;height:${(discR + 52) * 2}px"></div>
<div class="pshadow"></div>
<div class="product">${b.product}</div>
<div class="logo">${b.logoMark}<span>${b.wordmark}</span></div>
<div class="headline">${b.headline}</div>
<div class="subline">${b.subline}</div>
<div class="panel"><div class="price">${b.price}</div><div class="cta">${b.cta}</div><div class="terms">${b.terms}</div></div>
</body></html>`;
}

function logoDoc(b: FlatBrand): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>html, body { margin: 0; width: 520px; height: 180px; overflow: hidden; background: transparent; }
.lockup { width: 520px; height: 180px; display: flex; align-items: center; justify-content: center; gap: 18px; direction: ltr; }
.lockup svg { width: 120px; height: 120px; }
.lockup span { font: 800 96px/1 Arial, sans-serif; letter-spacing: 8px; color: ${b.ink}; }</style>
</head><body><div class="lockup">${b.logoMark}<span>${b.wordmark}</span></div></body></html>`;
}

async function launchOne(): Promise<Awaited<ReturnType<typeof chromium.launch>>> {
  // Plain Playwright Chromium only. Never the system Chrome channel and
  // never --single-process: those crashed the owner's machine (session 11).
  return chromium.launch();
}

async function render(html: string, w: number, h: number, transparent: boolean): Promise<Buffer> {
  const browser = await launchOne();
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    try {
      await page.setContent(html, { waitUntil: 'load' });
      return await page.screenshot({ type: 'png', omitBackground: transparent });
    } finally {
      await page.close().catch(() => undefined);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  for (const b of [ZAZO, TODA]) {
    const dir = join(REPO_ROOT, 'fixtures', 'brands', b.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, b.sourceFile), await render(doc(b), b.W, b.H, false));
    console.log(`${b.id}/${b.sourceFile} written`);
    await writeFile(join(dir, 'logo.png'), await render(logoDoc(b), 520, 180, true));
    console.log(`${b.id}/logo.png written`);
    await writeFile(join(dir, 'brand.json'), `${JSON.stringify({
      id: b.id, name: b.name, colors: b.colors, fonts: [], logo: 'logo.png', templates: [],
    }, null, 2)}\n`);
    console.log(`${b.id}/brand.json written`);
  }
}

await main();
