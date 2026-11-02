#!/usr/bin/env tsx
/**
 * Generate the committed brand prompts for the demo brands (one Wonder call
 * each) and save them as fixtures/brands/<brand>/prompt.json, so a fresh DB
 * shows them without spending.
 *
 *   npx tsx scripts/gen-brand-prompts.ts [--brand vela] [--force]
 *
 * Never prints secrets (only masked config + dollar totals).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { loadModelConfig } from '../src/shared/config.js';
import { findRepoRoot, loadEnvFiles } from '../src/shared/env.js';
import {
  parseBrandColors,
  renderBrandPromptText,
  validateBrandPromptContent,
} from '../src/shared/brand-prompt.js';
import { createModelClient } from '../src/server/models/client.js';
import { generateBrandPrompt, type BrandPromptExample } from '../src/server/models/brand-prompt.js';
import { CostLedger } from '../src/server/models/costs.js';

const REPO_ROOT = findRepoRoot(import.meta.url);
loadEnvFiles(REPO_ROOT);

const argv = process.argv.slice(2);
const brandArg = argv.indexOf('--brand');
const onlyBrand = brandArg >= 0 ? argv[brandArg + 1] : null;
const force = argv.includes('--force');

interface Manifest {
  id: string;
  name: string;
  colors: Array<string | { hex: string; role: string }>;
  fonts: string[];
  logo: string | null;
  templates: Array<{ preset: string | null; image: string }>;
  examples?: Array<{ scope: string; image: string }>;
}

async function dimsOf(path: string): Promise<{ width: number; height: number }> {
  const meta = await sharp(path).metadata();
  return { width: meta.width ?? 0, height: meta.height ?? 0 };
}

async function main(): Promise<void> {
  const cfg = loadModelConfig(process.env);
  const client = createModelClient(cfg);
  const ledger = new CostLedger(6);
  const brandsDir = join(REPO_ROOT, 'fixtures', 'brands');
  const ids = ['gali', 'noa', 'vela', 'dafna', 'zazo', 'toda'].filter((id) => !onlyBrand || id === onlyBrand);
  if (ids.length === 0) throw new Error(`unknown brand: ${onlyBrand}`);
  for (const id of ids) {
    const outPath = join(brandsDir, id, 'prompt.json');
    if (existsSync(outPath) && !force) {
      console.log(`${id}: prompt.json exists (use --force to regenerate)`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(brandsDir, id, 'brand.json'), 'utf8')) as Manifest;
    // Unique example images (GALI reuses files across presets): one send per
    // file, labelled with its first scope; validation still allows every
    // preset that has a row.
    const seen = new Set<string>();
    const examples: BrandPromptExample[] = [];
    const withExamples = new Set<string>();
    const add = async (scope: string, file: string): Promise<void> => {
      if (scope !== 'general') withExamples.add(scope);
      if (seen.has(file)) return;
      seen.add(file);
      const abs = join(brandsDir, id, file);
      if (!existsSync(abs)) throw new Error(`${id}: missing example image ${file}`);
      const bytes = readFileSync(abs);
      const { width, height } = await dimsOf(abs);
      examples.push({ imageBytes: bytes, mimeType: 'image/png', scope, width, height });
    };
    for (const t of manifest.templates) await add(t.preset ?? 'general', t.image);
    for (const e of manifest.examples ?? []) await add(e.scope, e.image);
    const colors = parseBrandColors(manifest.colors).map((c) => c.hex);
    let logo: { imageBytes: Buffer; mimeType: string } | null = null;
    if (manifest.logo) {
      const abs = join(brandsDir, id, manifest.logo);
      if (existsSync(abs)) logo = { imageBytes: readFileSync(abs), mimeType: 'image/png' };
    }
    console.log(`${id}: ${examples.length} example images (${manifest.templates.length} templates + ${(manifest.examples ?? []).length} extras), logo ${logo ? 'yes' : 'no'}`);
    const res = await generateBrandPrompt(client, {
      model: cfg.MODEL_WONDER,
      brandName: manifest.name,
      colors,
      fonts: manifest.fonts ?? [],
      logo,
      examples,
      ledger,
    });
    if (!res.ok || !res.content) throw new Error(`${id}: ${res.reason}`);
    const errors = validateBrandPromptContent(res.content, withExamples);
    if (errors.length > 0) throw new Error(`${id}: invalid prompt: ${errors.join('; ')}`);
    const stored = {
      ...res.content,
      version: 1,
      generatedBy: cfg.MODEL_WONDER,
      generatedAt: new Date().toISOString(),
      editedByUser: false,
      colors,
      fonts: manifest.fonts ?? [],
    };
    writeFileSync(outPath, JSON.stringify(stored, null, 2) + '\n');
    console.log(`${id}: wrote prompt.json — general=${stored.general.length} perPreset=[${Object.keys(stored.perPreset).join(',') || '—'}] never=${stored.never.length} ($${res.costUsd.toFixed(4)})`);
    console.log(`${id} readable:\n${renderBrandPromptText(stored)}\n`);
  }
  const totals = ledger.totals();
  console.log(`total: $${totals.totalUsd.toFixed(4)} across ${totals.entries} call(s) (cap $6)`);
}

void main();
