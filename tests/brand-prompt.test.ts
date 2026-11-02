import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import sharp from 'sharp';
import {
  brandPromptBlockForSize,
  brandPromptContentSchema,
  brandPromptTraceTag,
  brandPromptUseForSize,
  formatBrandPromptForPlan,
  guessScopeFromAspect,
  parseBrandColors,
  parseStoredBrandPrompt,
  renderBrandPromptText,
  validateBrandPromptContent,
  type StoredBrandPrompt,
} from '../src/shared/brand-prompt.js';
import { presetById } from '../src/shared/presets.js';
import type { SourceAnalysis } from '../src/shared/schemas.js';
import { buildWonderPlanPrompt } from '../src/server/models/wonder.js';
import { buildFastPrompt, buildPlatePrompt, type OutputRequest } from '../src/server/adfit/pipeline.js';
import { generateBrandPrompt } from '../src/server/models/brand-prompt.js';

function content(): { general: string[]; perPreset: Record<string, string[]>; never: string[]; proportions: Array<{ element: string; dimension: 'width' | 'height'; pct: number }>; text: string[] } {
  return {
    general: ['When the source shows the logo on a white panel, keep it on a white panel; otherwise keep the source structure.'],
    perPreset: { 'ig-story-916': ['On story, stack headline above the product with breathing room.'] },
    never: ['Never add extra bands, tabs, logos or buttons.'],
    proportions: [{ element: 'logo', dimension: 'width', pct: 18 }],
    text: ['Headlines stay right-aligned for Hebrew.'],
  };
}

function stored(over: Partial<StoredBrandPrompt> = {}): StoredBrandPrompt {
  return {
    ...content(),
    version: 3,
    generatedBy: 'muse-wonder-1.0',
    generatedAt: '2026-11-02T10:00:00.000Z',
    editedByUser: false,
    colors: ['#0f4c5c'],
    fonts: [],
    ...over,
  };
}

function analysis(): SourceAnalysis {
  return {
    language: 'en', direction: 'ltr',
    products: [{ label: 'bottle', sam_phrase: 'bottle', bbox: { x: 1, y: 1, w: 10, h: 10 } }],
    logo_bbox: null, headline: null, subtext: null, panel: null, other_texts: [],
    background: { type: 'flat', description: 'cream', colors: ['#f4ecdd'] },
    unreadable: [],
  };
}

function reqWithBrand(block: string | null): OutputRequest {
  return {
    source: { analysis: analysis() },
    preset: presetById('ig-story-916')!,
    mode: 'protected',
    template: null,
    framePng: null,
    brandName: 'Demo',
    brandPrompt: block === null ? null : { version: 3, block },
  } as unknown as OutputRequest;
}

function plan(): Parameters<typeof buildFastPrompt>[1] {
  return {
    preset: 'ig-story-916', width: 1080, height: 1920, from_template: false, template_id: null,
    safe: { x: 1, y: 1, w: 10, h: 10 }, logo: null, products: [], headline: null,
    subtext: null, panel: null, other_texts: [], product_scales: [], logo_scale: null, notes: ['default rules'],
  };
}

function mockClient(reply: unknown): OpenAI {
  return {
    chat: { completions: { create: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { input_tokens: 100, output_tokens: 50 } }) } },
  } as unknown as OpenAI;
}

describe('brand prompt content', () => {
  it('rejects empty sections and out-of-range proportions', () => {
    expect(brandPromptContentSchema.safeParse({ ...content(), general: [] }).success).toBe(false);
    expect(brandPromptContentSchema.safeParse({ ...content(), never: [] }).success).toBe(false);
    expect(brandPromptContentSchema.safeParse({ ...content(), proportions: [{ element: 'x', dimension: 'width', pct: 0 }] }).success).toBe(false);
    expect(brandPromptContentSchema.safeParse({ ...content(), proportions: [{ element: 'x', dimension: 'width', pct: 96 }] }).success).toBe(false);
    expect(brandPromptContentSchema.safeParse(content()).success).toBe(true);
  });

  it('tolerates bare-string lists and string proportions', () => {
    const parsed = brandPromptContentSchema.parse({
      general: 'One general rule.',
      perPreset: { 'ig-story-916': 'One story rule.' },
      never: 'Never invent.',
      proportions: ['logo ≈ 18% of the canvas width', 'bottom band ~ 14% of height'],
      text: 'Headlines right-aligned.',
    });
    expect(parsed.general).toEqual(['One general rule.']);
    expect(parsed.perPreset).toEqual({ 'ig-story-916': ['One story rule.'] });
    expect(parsed.proportions).toEqual([
      { element: 'logo', dimension: 'width', pct: 18 },
      { element: 'bottom band', dimension: 'height', pct: 14 },
    ]);
    // Missing optionals default to empty; unparseable proportions are dropped.
    const sparse = brandPromptContentSchema.parse({ general: ['g'], perPreset: {}, never: ['n'], proportions: ['vibes'] });
    expect(sparse.proportions).toEqual([]);
    expect(sparse.text).toEqual([]);
  });

  it('allows perPreset keys only for presets that have examples', () => {
    expect(validateBrandPromptContent(content(), new Set(['ig-story-916']))).toEqual([]);
    expect(validateBrandPromptContent(content(), new Set())).toEqual([
      'perPreset rule for a size with no examples: ig-story-916',
    ]);
    expect(validateBrandPromptContent(
      { ...content(), perPreset: { 'nope-preset': ['x'] } },
      new Set(['nope-preset']),
    )).toEqual(['unknown preset in perPreset: nope-preset']);
  });

  it('renders readable grouped text', () => {
    const text = renderBrandPromptText(stored());
    expect(text).toContain('General:');
    expect(text).toContain('Never:');
    expect(text).toContain('Stories / Reels 9:16:');
    expect(text).toContain('logo ≈ 18% of the canvas width');
  });

  it('resolves one size: general + perPreset[size] only', () => {
    const story = brandPromptBlockForSize(stored(), 'ig-story-916');
    const feed = brandPromptBlockForSize(stored(), 'ig-feed-11');
    expect(story).toContain('white panel');
    expect(story).toContain('stack headline above the product');
    expect(story).toContain('Never add:');
    expect(feed).toContain('white panel');
    expect(feed).not.toContain('stack headline above the product');
    expect(feed).toContain('Never add:');
  });

  it('lets a user-edited text win over generated JSON', () => {
    const use = brandPromptUseForSize({ prompt: stored({ editedByUser: true }), text: 'USER TEXT' }, 'ig-story-916');
    expect(use).toEqual({ version: 3, block: 'USER TEXT' });
    const planLines = formatBrandPromptForPlan({ prompt: stored({ editedByUser: true }), text: 'USER TEXT' }, ['ig-story-916']).join('\n');
    expect(planLines).toContain('USER TEXT');
    expect(planLines).not.toContain('white panel');
  });

  it('parses stored rows, tolerating corrupt JSON', () => {
    const s = stored();
    expect(parseStoredBrandPrompt(JSON.stringify(s), 'readable')?.text).toBe('readable');
    expect(parseStoredBrandPrompt(JSON.stringify(s), null)?.text).toContain('General:');
    expect(parseStoredBrandPrompt(null, null)).toBeNull();
    expect(parseStoredBrandPrompt('{nope', null)).toBeNull();
  });

  it('tags traces with the prompt version, or nothing', () => {
    expect(brandPromptTraceTag({ version: 3, block: 'x' })).toBe(' brand-prompt=v3');
    expect(brandPromptTraceTag(null)).toBe('');
    expect(brandPromptTraceTag(undefined)).toBe('');
  });
});

describe('example scopes', () => {
  it('guesses the scope from the aspect ratio', () => {
    expect(guessScopeFromAspect(1080, 1080)).toBe('ig-feed-11');
    expect(guessScopeFromAspect(1080, 1920)).toBe('ig-story-916');
    expect(guessScopeFromAspect(1200, 628)).toBe('fb-link');
    expect(guessScopeFromAspect(1000, 100)).toBe('general');
    expect(guessScopeFromAspect(0, 0)).toBe('general');
  });

  it('parses structured colours and legacy hex lists', () => {
    expect(parseBrandColors([{ hex: '#112233', role: 'primary' }])).toEqual([{ hex: '#112233', role: 'primary' }]);
    expect(parseBrandColors(['#112233', '#445566'])).toEqual([
      { hex: '#112233', role: 'primary' },
      { hex: '#445566', role: 'secondary' },
    ]);
    expect(parseBrandColors(['nope', { hex: '#112233', role: 'weird' }])).toEqual([]);
    expect(parseBrandColors('nope')).toEqual([]);
  });
});

describe('engine injection', () => {
  const sizes = [
    { preset: presetById('ig-story-916')!, template: null },
    { preset: presetById('ig-feed-11')!, template: null },
  ];

  function planPrompt(withBrand: boolean, edited: boolean): string {
    return buildWonderPlanPrompt({
      sourceBytes: Buffer.alloc(8), sourceMime: 'image/png', sourceWidth: 1080, sourceHeight: 1080,
      analysis: analysis(), elementBoxes: [], measuredText: {}, freeOthers: [], sizes,
      brandPrompt: withBrand ? { prompt: stored({ editedByUser: edited }), text: edited ? 'USER TEXT' : renderBrandPromptText(stored()) } : null,
    });
  }

  it('injects general for every size and perPreset only for its size', () => {
    const p = planPrompt(true, false);
    expect(p).toContain('BRAND STYLE RULES (v3');
    expect(p).toContain('white panel');
    expect(p).toContain('Never add:');
    const storyLine = p.split('\n').find((l) => l.startsWith('BRAND RULES FOR ig-story-916')) ?? '';
    const feedLine = p.split('\n').find((l) => l.startsWith('BRAND RULES FOR ig-feed-11')) ?? '';
    expect(storyLine).toContain('stack headline above the product');
    expect(feedLine).toContain('follow the general rules');
    expect(feedLine).not.toContain('stack headline above the product');
  });

  it('sends nothing without a brand prompt', () => {
    expect(planPrompt(false, false)).not.toContain('BRAND');
    expect(buildFastPrompt(reqWithBrand(null), plan(), [])).not.toContain('Brand style rules');
    expect(buildPlatePrompt(reqWithBrand(null), plan(), [], {})).not.toContain('Brand style rules');
  });

  it('feeds the resolved block to the fast and plate briefs', () => {
    const block = brandPromptBlockForSize(stored(), 'ig-story-916');
    const fast = buildFastPrompt(reqWithBrand(block), plan(), []);
    expect(fast).toContain('Brand style rules (v3');
    expect(fast).toContain('stack headline above the product');
    const plate = buildPlatePrompt(reqWithBrand(block), plan(), [], {});
    expect(plate).toContain('Brand style rules (v3');
    expect(plate).toContain('Never add:');
  });
});

describe('brand prompt generation', () => {
  it('returns parsed content from one Wonder call', async () => {
    const example = await sharp({ create: { width: 900, height: 900, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
    const res = await generateBrandPrompt(mockClient(content()), {
      model: 'muse-wonder-1.0', brandName: 'Demo', colors: ['#112233'], fonts: [],
      logo: null,
      examples: [{ imageBytes: example, mimeType: 'image/png', scope: 'general', width: 900, height: 900 }],
    });
    expect(res.ok).toBe(true);
    expect(res.content?.general).toHaveLength(1);
    expect(res.costUsd).toBeGreaterThan(0);
  });

  it('fails without examples and never calls', async () => {
    let calls = 0;
    const counting = { chat: { completions: { create: async () => { calls++; throw new Error('must not call'); } } } } as unknown as OpenAI;
    const res = await generateBrandPrompt(counting, {
      model: 'muse-wonder-1.0', brandName: 'Demo', colors: [], fonts: [], logo: null, examples: [],
    });
    expect(res.ok).toBe(false);
    expect(calls).toBe(0);
  });
});
