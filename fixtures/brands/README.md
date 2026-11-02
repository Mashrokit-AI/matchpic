# MatchPic demo brands — synthetic only

Every brand under `fixtures/brands/` is **fictional and synthetic**, made for
this demo. No real client brand data may enter the repo.

- **GALI** — fictional thermal-bottle brand. `source-he.png` / `source-en.png`
  are the source creatives; `tpl-*.png` are Chromium-rendered brand templates
  (see `scripts/render-adfit-fixtures.ts`); `logo.png` is the rendered logo
  lockup; `frame-9x16.png` is a transparent brand frame overlay for 9:16.
  `spec-*.json` files are Spark-parsed layout specs of the templates,
  committed so fresh clones work without re-parsing (regenerate with the live
  script). GALI has no `demo/` dir: it is a brand only, not a demo example
  (the old single-bottle demo seed was removed in session 11).
- **NOA** — fictional coffee brand. `source.png` is an **AI-generated
  synthetic** photographic creative (Muse Image `muse-image-1.0`,
  `/v1/images/generations`, generated once and committed); `tpl-*.png` are
  Chromium-rendered templates for 2 sizes; `logo.png` is the rendered logo.
- **VELA** — fictional English skincare brand (complex engine fixture).
  `bg-photo.png` is a Muse Image lifestyle background, generated once and
  committed (`scripts/gen-fixture-backgrounds.ts`); `source-en.png` and
  `tpl-*.png` (1:1, 1.91:1, 9:16) are Chromium composites of that photo with
  2 SVG products (serum bottle + cream jar), headline "Morning glow,
  bottled", subline, offer panel ("$39" + "Shop now" + terms line) and logo
  (see `scripts/render-complex-fixtures.ts`). `spec-*.json` are authored from
  the same geometry constants as the HTML — no Spark re-read needed.
- **DAFNA** — fictional Hebrew cosmetics brand (complex engine fixture,
  invented name). Same structure as VELA: committed Muse Image background,
  Chromium composites with 2 products, headline "זוהר בוקר בבקבוק", subline
  with exact Hebrew (gershayim מ״ל), offer panel ("₪149" + "לקנייה" + terms),
  logo. Templates for 1:1, 1.91:1, 9:16; specs authored from HTML geometry.
  `source-story.png` is the 9:16 creative (copy of `tpl-9x16.png`) — the
  story-native demo source.
- **ZAZO** — fictional English sunglasses brand (flat-design fixture).
  `source-en.png` (1200×628, link-native) is a Chromium render: solid cream
  background, sun disc + rings, SVG sunglasses, headline "Shade season is
  on", offer panel ("$49" + "Shop now" + terms), logo (see
  `scripts/render-flat-fixtures.ts`). No templates: ZAZO exercises the
  no-template default-layout path.
- **TODA** — fictional Hebrew headphones brand (flat-design fixture).
  `source-he.png` (1280×720, YouTube-native) is a Chromium render: solid
  plum background, blush disc + rings, SVG headphones, headline "שומעים כל
  פרט", offer panel ("₪349" + "לקנייה" + terms), Latin TODA wordmark. No
  templates (no-template path).

## Saved demo examples (session 11)

Each brand with a `demo/` dir is one demo example: its source creative in
one native size plus conversions into 4 other sizes (protected mode).
Assembled from engine runs by `scripts/assemble-demo.ts`; seeded by
`src/server/adfit/seed.ts` (`demo-*` jobs). Sizes that failed or were not
client-showable are left out of `demo.json`, never faked.

| Example | Native size | Source |
|---|---|---|
| VELA (EN skincare, photo) | Feed 1:1 | `vela/source-en.png` |
| DAFNA (HE cosmetics, photo) | Story 9:16 | `dafna/source-story.png` |
| ZAZO (EN sunglasses, flat) | Link 1.91:1 | `zazo/source-en.png` |
| NOA (HE coffee, photo) | Portrait 4:5 | `noa/source.png` |
| TODA (HE headphones, flat) | YouTube 16:9 | `toda/source-he.png` |

GALI stays as a brand (templates + logo) but is no longer a demo example:
its `demo/` dir was removed with the old single-bottle seed.

## Demo v2 (Nov 2, afternoon)

The live demo now uses five fictional brands whose **source** creatives were generated as test inputs with Google's Gemini image model ("Nano Banana", via our server) because the code-rendered fixtures looked too synthetic: LUMA (skincare, Feed 1:1), STRIDE (running shoes, Story 9:16), NORTHBEAN (cold brew, Link 1.91:1), טבע (juice, Portrait 4:5, Hebrew), שקט (headphones, YouTube 16:9, Hebrew). Each source is cropped to its exact native size. Every **output** is MatchPic's own (Meta models only). The previous demo dirs are kept as `demo-unused/`.
