<!-- UI spec produced by muse-wonder-1.0 from the session-11 brief + current-UI screenshots -->

# MatchPic — Redesign UI Spec v1.0

Stack constraint: hand-written DOM, one CSS file, `Noto Sans` + `Noto Sans Hebrew`. No framework utilities. All sizing below is final — do not re-derive.

---

## 1. Layout Grid & Breakpoints

### 1.1 Tokens

```css
:root{
  --maxw:1280px;          /* results, brands, detail */
  --maxw-home:1280px;
  --gutter:24px;          /* ≥1024px */
  --header-h:64px;
  --radius:12px;
  --radius-sm:8px;
}
@media (max-width:767px){ :root{ --gutter:16px; --header-h:56px; } }
```

Page shell: `.shell{max-width:var(--maxw);margin-inline:auto;padding-inline:var(--gutter);}` Body `overflow-x:clip`. Every grid child `min-width:0`. Every `img{max-width:100%;display:block}`.

### 1.2 Breakpoints

| Name | Range | Behaviour |
|---|---|---|
| Desktop | ≥1024px | Home 2-column, results 12-col grid |
| Tablet | 768–1023px | Home 1-column (setup, then showcase), results 2-col |
| Mobile | ≤767px | Single column, sticky Generate, 1-row header |
| Small | ≤390px | Tested width; no horizontal scroll, no font shrink below §3 floors |

### 1.3 Header (all widths)

Height 64px desktop / 56px mobile, `--surface` bg, `border-bottom:1px solid --line`, sticky `top:0;z-index:40`.
Inner: shell flex, `gap:16px`, logo at inline-start, nav centre-start, language toggle at inline-end.

- **≥768px:** logo (28×28 mark + `MatchPic` 18/700) + tagline `One creative → every placement size.` (13px, `--ink-2`, hidden <1100px), nav links Home / Brands / How it works (14/600, padding 8px 12px, active = `--accent-soft` bg, radius 8px), EN/עב segmented toggle (see §5.10).
- **≤767px (390 target): exactly one row, 56px:** logo mark 24×24 + wordmark, language toggle (compact, 64×32px total), menu button 40×40px (`☰` drawn as 3 CSS bars 18×2px, no emoji). Nav collapses into a dropdown panel under header, full-width, links 48px tall rows. Tagline hidden. Nothing wraps to a second row.

### 1.4 Home first viewport (desktop ≥1024px)

```
.shell
  .hero-head   (full width)
  .hero-grid   grid-template-columns: minmax(0,7fr) minmax(0,5fr); gap:32px; align-items:start
    [inline-start] .setup-card
    [inline-end]   .showcase  (position:sticky; top:88px)
```

- Hero head: headline + 1 supporting line only (§3 roles). Max-width 720px. Margin-bottom 24px.
- Judge test: at 1440×900, headline, upload dropzone, example strip, Generate, and showcase source+3 outputs must all be visible without scroll. Setup card content is capped by the progressive rules in §5.1 — if brand/sizes/mode are not yet relevant they are collapsed, keeping card height ≤560px.
- Showcase column never exceeds 5fr; its images use fixed aspect boxes (§5.3) so the column height is stable at ≤600px and never pushes the setup card.

### 1.5 Home mobile order (≤767px, incl. 390px)

Strict DOM/visual order, single column, `gap:20px`:

1. Headline + supporting line
2. Setup card — step 1 only: upload dropzone
3. Example strip (horizontal scroll-snap row, §5.2)
4. Showcase (selected example: source + 3 outputs stacked, §5.3)
5. Rest of setup (brand, sizes, mode, Generate) — revealed in card after upload/example load; Generate also duplicated as sticky bar (§5.1)

No element order changes between EN and HE; RTL only flips inline direction.

### 1.6 Results / Detail / Brands widths

- Results grid lives in `--maxw:1280px` shell (wider than current ~860px). Grid §5.6.
- Detail page: shell 1280px; main stage column 8fr, inspector rail 4fr (§5.8); ≤1023px stacks stage then rail.
- Brands: shell 1280px; card grid §5.11.

---

## 2. Spacing Scale

4px base. Use only these steps; no arbitrary margins.

| Token | px | Applies to |
|---|---|---|
| `--s1` | 4 | chip internal gap, swatch gap, icon-to-dot |
| `--s2` | 8 | label-to-field, chip padding-inline, thumbnail label gap, step-line item gap |
| `--s3` | 12 | field groups inside card, card footer padding, toolbar gap |
| `--s4` | 16 | card padding (mobile), grid gap mobile, section inner gaps |
| `--s5` | 20 | mobile section separation (home order blocks) |
| `--s6` | 24 | card padding (desktop), grid gap desktop, hero-head margin-bottom |
| `--s8` | 32 | hero-grid column gap, major block separation |
| `--s10` | 40 | section top margin (Results, How it works) |
| `--s12` | 48 | page bottom padding |

Rules: card padding 24px desktop / 16px mobile. Vertical rhythm inside setup card: groups separated by 16px, group label-to-control 8px. Grid gaps: 24px desktop, 16px mobile. Chips row gap 8px. Never use spacing >48px inside first viewport.

---

## 3. Type Scale — Latin + Hebrew

Fonts: `font-family:"Noto Sans","Noto Sans Hebrew",sans-serif`. Hebrew text uses same stack (Noto Sans Hebrew subset loads for HE glyphs). **Hebrew is never smaller than Latin for the same role; Hebrew line-height is +4–8% to clear ascenders/diacritics.**

| Role | EN size/weight/LH | HE size/weight/LH | Use |
|---|---|---|---|
| Display / headline | 40/700/1.10 (44px) @1440 | 40/700/1.20 (48px) | Home headline only |
| Display @390 | 28/700/1.15 (32px) | 28/700/1.25 (35px) | Home headline mobile |
| H2 | 24/700/1.20 | 24/700/1.30 | Section titles (Results, Brands) |
| H3 | 18/700/1.30 | 18/700/1.40 | Card titles, brand name |
| Body | 16/400/1.50 | 16/400/1.60 | Supporting line, descriptions |
| Body-sm | 14/400/1.50 | 14/400/1.60 | Field help, one-liners, step lines |
| Label | 13/600/1.35 | 13/600/1.45 | Field labels, chip text (uppercase EN only; HE no uppercase transform) |
| Caption | 12/400/1.40 | 12/400/1.50 | Dimensions, timestamps, run line |
| Mono | 12/400/1.50 `"Noto Sans Mono",monospace` | same (always LTR) | Model ids, hex, dimensions, trace |

Headline copy (exact):
- EN: `One approved ad. Every placement. Product and logo untouched.`
- HE: `מודעה אחת שאושרה. כל הגדלים. המוצר והלוגו לא נוגעים בהם.`

Supporting line (exact, one line role, wraps to max 2 lines):
- EN: `Our studio resizes every approved creative into 6–8 formats by hand, every day, for 100+ brands.`
- HE: `בסטודיו שלנו מתאימים כל קריאייטיב ל-6–8 גדלים ידנית, כל יום, ליותר מ-100 מותגים.`

Floors: no text below 12px anywhere. Chip text 12/600. Thumbnail label 11px is **forbidden** — use 12px.

---

## 4. Colour Tokens & Contrast

Current green family retained. No gradients of any hue, no glassmorphism, no emoji icons (icons = inline SVG 16/20px, stroke 1.5px, `currentColor`).

| Token | Hex | Used for |
|---|---|---|
| `--bg` | `#EEF2EE` | Page background |
| `--surface` | `#FFFFFF` | Cards, header, tiles |
| `--surface-2` | `#F6F8F6` | Dropzone idle, skeleton base, rail bg |
| `--ink` | `#16211B` | Headlines, primary text |
| `--ink-2` | `#3D4A42` | Body text, nav |
| `--muted` | `#52645A` | Captions, help text (darkened from current grey-green to pass 4.5:1) |
| `--line` | `#D5DED5` | Borders, dividers (non-text) |
| `--accent` | `#0E6B45` | Primary buttons, selected states, logo mark |
| `--accent-hover` | `#0A5738` | Primary hover/active |
| `--accent-soft` | `#E2EEE6` | Selected thumbnail ring bg, active nav, Protected chip bg |
| `--accent-disabled` | `#9DB8A9` | Disabled Generate bg (with `--ink` text, see table) |
| `--amber-bg` / `--amber-ink` | `#FFF1D4` / `#744500` | Pending chip, queue banner |
| `--red-bg` / `--red-ink` | `#FCE8E8` / `#8F1D1D` | Needs review, errors, Remove template |
| `--fixed-bg` / `--fixed-ink` | `#DFF0F3` / `#0B4A5E` | Fixed chip, "Fixed by Wonder" badge |
| `--mask-green` | `#1FA84F` | X-ray protected mask overlay (60% opacity fill) |
| `--box-pink` | `#E5488C` | X-ray actual placement boxes (2px solid) |
| `--zone-dash` | `#16211B` | Template target zones (2px dashed, 70% opacity) |

### Contrast table (computed, WCAG relative luminance)

| Foreground on background | Ratio | Pass |
|---|---|---|
| `--ink #16211B` on `--surface #FFFFFF` | 16.4:1 | Body ✓ |
| `--ink` on `--bg #EEF2EE` | 14.6:1 | Body ✓ |
| `--ink-2 #3D4A42` on `#FFFFFF` | 9.2:1 | Body ✓ |
| `--ink-2` on `--bg` | 8.2:1 | Body ✓ |
| `--muted #52645A` on `#FFFFFF` | 6.1:1 | Body ✓ |
| `--muted` on `--surface-2 #F6F8F6` | 5.7:1 | Body ✓ |
| `#FFFFFF` on `--accent #0E6B45` | 6.6:1 | Body ✓ |
| `#FFFFFF` on `--accent-hover #0A5738` | 8.4:1 | Body ✓ |
| `--accent #0E6B45` on `#FFFFFF` (links, selected label) | 6.6:1 | Body ✓ |
| `--accent` on `--accent-soft #E2EEE6` | 5.6:1 | Body ✓ |
| `--ink` on `--accent-disabled #9DB8A9` | 7.9:1 | Body ✓ (disabled button uses ink text, never white) |
| `--amber-ink #744500` on `--amber-bg #FFF1D4` | 7.3:1 | Body ✓ |
| `--red-ink #8F1D1D` on `--red-bg #FCE8E8` | 7.6:1 | Body ✓ |
| `--fixed-ink #0B4A5E` on `--fixed-bg #DFF0F3` | 8.1:1 | Body ✓ |
| `--ink-2` on `--accent-soft` (Passed chip) | 7.8:1 | Body ✓ |
| Headline `--ink` on `--bg` (large text) | 14.6:1 | Large ✓ (≥3:1) |

Non-text: `--line` borders, skeleton shimmer, mask/box overlays are decorative or redundant with labels — exempt, but X-ray overlays always pair with a text legend (§5.8).

Focus: `outline:2px solid var(--accent); outline-offset:2px` on every interactive element, both languages.

---

## 5. Component Specs

### 5.1 Setup card

Anatomy (single `--surface` card, radius 12, border 1px `--line`, padding 24/16):

1. **Upload dropzone** — min-height 120px desktop / 104px mobile, `--surface-2`, 2px dashed `--line` (accent on dragover + `--accent-soft` bg), radius 8. Centred: upload SVG 24px, primary line 16/600 `Drop creatives here, or choose files`, caption 12px `--muted` (formats/limits). Whole zone is a `<button>`/label for the file input; keyboard focusable.
2. **Source preview** (appears after upload/example load, replaces dropzone content area, dropzone shrinks to a 40px "Replace" row): image max-height 220px, `object-fit:contain`, `--surface-2` bg. Below: **Detected text** — read-only list, one row per string (14px, `--surface-2` chip rows, padding 6px 10px, radius 6), with one small `Edit` text-button (13/600 accent) at list inline-end. Edit turns rows into inputs; `Confirm` returns to read-only. Nothing else editable here.
3. **Brand row** — label + `<select>` full width, height 44px, plus `+ New brand` button (secondary, 44px, inline-end of label row) routing to Brands with create form open.
4. **Sizes** — `All Meta placements` secondary button (36px) + checkbox pill group. Default checked: `1:1`, `4:5`, `1.91:1`, `9:16`. Pill: 36px tall, padding-inline 12px, radius 999, border `--line`; checked = `--accent` bg/white text; label format `Feed 1:1` + mono LTR dimension span `1080×1080` (12px). Pills wrap; never scroll horizontally.
5. **Mode segmented control** — 2 segments, 44px tall, container border `--line` radius 8; selected = `--ink` bg/white text (as current). Under it, one inline one-liner (13px `--muted`, swaps with selection): Protected → `keeps product & logo pixel-exact`; Fast → `may redraw details`.
6. **Generate** — primary button, full width of card, 48px, 16/700. **Disabled state must explain itself:** directly under button, 13px `--muted` reason line, exactly one of: `Add a creative to start` / `Pick at least one size` / `Confirm the detected text` / hidden when enabled. Disabled bg `--accent-disabled`, text `--ink`, `cursor:not-allowed`, reason always visible (not tooltip-only).
7. **Mobile sticky Generate:** at ≤767px, once a source exists, a sticky bottom bar (`position:sticky;bottom:0`, `--surface`, top border, padding 12px 16px, `z-index:30`) holds Generate 48px + reason line 12px. It docks after the setup card; it never covers the showcase (showcase is above it in scroll order per §1.5).

States: idle / dragover / uploading (progress bar 4px accent inside dropzone, % caption) / error (red border, `--red-ink` 13px message + Retry) / ready.

### 5.2 Example strip

- Placement: inside setup card directly under dropzone (desktop), or as its own block after upload (mobile §1.5). Label row: `Try an example` 13/600 + nothing else. **No timestamps here** (timestamp lives on detail page only).
- Up to 5 thumbnails, each **72×72px** (mobile 64×64), radius 8, `object-fit:cover`, border 1px `--line`. Under each: exactly one label, 12px `--ink-2`, native-size only: `Story 9:16`, `Feed 1:1`, etc. One label per image, nothing else — no model names, no timings.
- Layout: desktop = row of 5, gap 12px, wraps never; mobile = horizontal scroll-snap row (`scroll-snap-type:x mandatory`, padding-inline 16px, scrollbar hidden) — this is the only permitted horizontal scroller, and it must not cause page-level horizontal scroll.
- Selected state: 2px `--accent` ring (`box-shadow:0 0 0 2px var(--accent)`), label becomes 600 `--accent`. Hover: ring `--line`→`--ink-2`. Focus-visible per §4.
- Click behaviour: loads instantly (preloaded assets) — source large in showcase + setup preview, conversions grid in showcase. Default selected example follows UI language (EN UI → EN example, HE UI → HE example) on first load only; manual selection is sticky across language switch.

### 5.3 Showcase block (end column)

Calm and visual rule: images + one short label per image. No chips, no models, no timings, no trace.

Anatomy:
- Header row: `Example` 13/600 `--muted` + example name 14/600. Nothing else.
- Source image: full column width, aspect box = source's native ratio (max-height 300px, `object-fit:contain`, `--surface-2`, radius 8), label under: `Source · Feed 1:1` (12px).
- Arrow: thin SVG arrow, 24×16px, `--muted`, pointing inline-end (LTR →, RTL ←, §7), centred, margin 8px auto.
- 3 contrasting outputs in a row (mobile: row of 3, gap 8px): pick the 3 most different ratios from the selected example (default 9:16, 1.91:1, 4:5). Each: fixed aspect box (`aspect-ratio` per size, width 100%), `object-fit:cover`, radius 8, one label under: placement + ratio only (`Story 9:16`). Clicking any output or source opens its detail page.
- Full conversion grid (all sizes) appears **below** the 3 outputs only after an example is clicked/expanded via `See all sizes` text-button (13/600 accent) — grid 3 cols desktop-in-column / 2 cols mobile, gap 12px, same label style. Default state shows only 3, keeping first viewport calm.

### 5.4 Run preparation step line + skeleton tiles

On Generate:
1. **Shared prep step line** (one compact horizontal line, wraps to 2 lines mobile): 3 steps joined by 16px `--line` connectors: `Reading the ad` · `Cutting product & logo` · `Wonder is planning 8 layouts` (count = selected sizes). Each step: 16px status icon (spinner ring 2px accent / check SVG / hollow dot), 13/600 label, live timer mono 12px `--muted` (`0:04`). States: done = accent check + `--ink-2`; active = spinner + `--ink`; queued = dot + `--muted`. One line total height 32px; no cards per step.
2. **Skeleton tile per size**, in the results grid (§5.6 positions), each with its **real `aspect-ratio`** (e.g. `aspect-ratio:9/16`), `--surface-2` bg, radius 8, shimmer = single 1.6s linear sweep using `--surface` at 40% (no coloured gradient). Under each: placement label + dimension (mono LTR) + status chip `Pending`.
3. Tiles fill in independently as each size streams; a failed tile shows `--red-bg` panel, 13px error + own `Retry` button (36px secondary) — other tiles unaffected. Queue state: banner above grid, `--amber-bg`, 14px: `Queued — starts when a slot frees.` Spend-cap state: `--red-bg` banner: `Spend cap reached for today — downloads of finished sizes still work.` Both banners have no dismiss; they clear on state change.

### 5.5 Status chips

One chip component, 4 states. Anatomy: height 24px, padding-inline 8px, radius 999, 12/600, leading 8px dot or 12px SVG icon, gap 4px. Three chip slots per result card, always in this order: **Protected pixels**, **Text**, **Layout review**. Chip text = slot name + state only when not Passed (e.g. `Text`, `Layout review: Pending`).

| State | Bg / ink / icon | Meaning |
|---|---|---|
| Passed | `--accent-soft` / `--ink-2` / check SVG accent | Verified |
| Pending | `--amber-bg` / `--amber-ink` / hollow dot | Running/queued |
| Fixed | `--fixed-bg` / `--fixed-ink` / wrench SVG | Repaired by review (also triggers §5.6 badge) |
| Needs review | `--red-bg` / `--red-ink` / `!` triangle SVG | Failed check, still downloadable |

Chips never wrap inside a card footer: footer is flex-wrap with 8px gap, card min-width prevents crush (§5.6).

### 5.6 Result card + results grid

Grid grouped by orientation, order fixed: **Square/Portrait/Vertical first** (1:1, 4:5, 9:16), then Landscape (1.91:1, 16:9…). Group = subhead row (13/600 `--muted`, e.g. `Portrait`) + grid: `repeat(auto-fill,minmax(260px,1fr))` desktop, 2 cols ≤767px (min tile 150px), 1 col ≤360px. Gap 24/16.

Card anatomy (art dominates — image ≥78% of card height):
- Image area: fixed `aspect-ratio` per placement, `object-fit:cover`, radius 8 top (card radius 12, overflow hidden), `--surface-2` bg. Click → detail page.
- `Fixed by Wonder` badge (only on repaired sizes): absolute, top-inline-start 8px, `--fixed-bg`/`--fixed-ink`, 12/600, 24px tall, wrench icon.
- Footer (padding 12px): line 1 = placement name 14/600 + mono LTR dimensions 12px `--muted` (`1080×1920`). Line 2 = the 3 status chips (§5.5). Line 3 (only on hover/focus-within desktop, always visible as a 32px `Details` text-button on touch/mobile) = mono model ids 12px `--muted` + `Details →`. **Model ids never print on the card face by default.**
- Actions row appears on hover/focus: `Download PNG` icon-button 32px top-inline-end over image.

### 5.7 Run line + Download all

Exactly **one line** under the grid, 12px mono for ids/numbers, 13px for labels, `--ink-2`, wraps to 2 lines max on mobile with ids kept LTR (§7):

`Meta models: muse-wonder-1.0 · muse-spark-1.3 · sam-3.1 · muse-image-1.0 · first preview 14.2 s · all 8 in 61 s`

(real values substituted). Above it, right-aligned (inline-end): `Download all (ZIP)` primary button 44px, download icon. Disabled until ≥1 size Passed/Fixed; caption under it if disabled: `Waiting for first finished size`.

### 5.8 Detail page

Layout: back link (`← Back`, mirrors in RTL) top; then grid 8fr/4fr gap 32px (stack ≤1023px).

**Stage (8fr):**
- Large output: width 100%, native aspect box, max-height 70vh, `object-fit:contain`, `--surface-2`, radius 12.
- **Placement switcher** (§5.9) above stage, **tools row** (§5.10) below stage.

**Inspector rail (4fr), order:**
1. Title block: placement 18/700, mono dimensions, saved-demo timestamp here (12px `--muted`) — the only place it appears.
2. Compact source reference: thumbnail 96px wide, native ratio, label `Source`.
3. Status chips (3, §5.5) + `Fixed by Wonder` badge if repaired.
4. `Download PNG` primary 44px full width.
5. **Protected-pixel crops block** (§5.11).
6. **Verification details** `<details>` collapsible (closed by default): text check results (per-string Pass/Fixed list 13px), Wonder's rationale (14px, max 6 lines + patch summary), repair patch (mono diff-style lines), trace table (columns: Step / Model (mono LTR) / Duration (mono) / Source = `cached`|`live` chip 12px). Table font 12px, row height 32px, horizontal scroll inside the details element only if needed.

### 5.9 Placement switcher

Row: Prev button (40×40 icon button, chevron), centre label `3 / 8 · Story 9:16` (14/600, dimensions mono LTR), Next button. Cycles through the run's sizes in grid order, wraps around. In RTL chevrons mirror (Prev points right, §7) and keyboard: `←/→` follow visual direction in both languages. Also a thumbnail rail under it: 48×48 thumbs, selected = accent ring (same as §5.2).

### 5.10 Detail tools row

One row (wraps to 2 rows ≤767px), height 44px controls, gap 8px, all toggle buttons = secondary style, active = `--ink` bg/white:

- **Before/After slider:** segmented toggle `Before | After | Slider`. In Slider mode the stage shows output with a draggable divider: vertical 2px white line + 32px circular handle (accent, ↔ SVG), `input[type=range]` 0–100 overlaid for keyboard/a11y, clip via `clip-path:inset(0 X% 0 0)` on the before layer (use inline-end-aware inset per §7). Semantics: repaired size → before-repair vs final; otherwise source vs output. Label chip on each side (`Before`/`After`, 12px, `--ink` bg 70% + white text).
- **X-ray toggle:** overlays on stage — protected mask = `--mask-green` 60% fill over protected regions; actual placement boxes = 2px solid `--box-pink` with 12px labels (`product`, `logo`, `panel`); template target zones = 2px dashed `--zone-dash`. Legend row appears under stage when on: 3 items with colour swatches 12×12. Data from resolved manifest only; if manifest missing, toggle disabled with caption `No manifest for this size`.
- **Safe area toggle:** inset dashed rectangle at platform safe margins (from manifest; default 5% sides, 12% top/bottom for 9:16), `--ink` dashed 1px + caption chip `Safe area`.
- **Zoom:** segmented `Fit | 100% | 200%` + drag-to-pan on stage when >Fit. Zoom resets on placement switch.
- Language toggle component (header, reused spec): 2 segments EN | עב, 32px tall, selected `--ink`/white, radius 8. Switching keeps route, query, hash and scroll position — only `lang`/`dir` change.

### 5.11 Protected-pixel crops block

Per protected element (product, logo, panel…): subhead 13/600 (`Product · coverage 100%` — coverage mono LTR %). Two synchronized crops side by side, each `aspect-ratio:1/1`, width 100% of half-rail (stack on ≤390 if rail <320px), labels `Source` / `Output` 12px. Synchronized = same zoom/pan transform applied to both (shared state; dragging one moves both). Crops use `object-fit:none` at matched scale derived from manifest boxes. If element absent in output: red border + `Not found` chip.

### 5.12 Brand card

Grid: `repeat(auto-fill,minmax(300px,1fr))`, gap 24/16. Card (radius 12, padding 20):
- Row 1: logo image 40px tall max-width 120px `object-fit:contain` (or brand initial tile 40×40 `--accent-soft` if none), brand name 18/700, `demo` chip if demo brand (neutral: `--surface-2`/`--ink-2`).
- Row 2: colour swatches — 24×24 radius 6 squares, gap 8, each with mono hex under on hover / always 10px→**use 12px caption below row** listing hexes LTR.
- Row 3: template coverage: one mini-chip per size (`1:1 ✓`, `9:16 —`) 12px; present = `--accent-soft`, missing = `--surface-2` dashed border.
- Footer: `Open` primary-text button; demo brands show `Duplicate to edit` instead of edit affordances, and a lock caption `Demo brand — read-only`.
- Visitor expiry caption 12px `--muted` where applicable (`Expires in 24 h`).

### 5.13 Template editor (one brand → one size at a time)

- Open brand = full-width section under grid (or routed view): brand header (logo, name, swatches with **colour pickers**: native `<input type=color>` 40×40 + optional hex text input mono LTR 96px wide, invalid hex = red border + 12px error).
- Size selector: pill tabs (one per placement, same pill spec §5.1) — **exactly one size visible at a time**; editor canvas shows that size's template image with zone overlays (same colours as X-ray §5.10).
- Actions per size: `Remove template` (renamed from Reject; HE `הסרת תבנית`) — destructive secondary: `--red-ink` text, `--red-bg` hover, confirm inline (`Remove?` + Confirm/Cancel 36px). Never a filled red button.
- Demo brand opened: all inputs disabled, banner `--surface-2` 13px `This is a demo brand.` + `Duplicate to edit` primary 40px.
- **After creating a brand**, inline 3-step checklist replaces the create form (numbered 24px accent circles): `1 Add a logo` → `2 Add a template per size` → `3 Use it in Generate`, each 14px with its CTA button; steps check off as completed.

Create-brand form: Name input + colours as picker rows (not comma-separated text — the comma field is removed): repeatable row = colour input + hex input + remove ×; `+ Add colour`.

### 5.14 How-it-works — 4-step visual

Replaces long text. Grid 4 cols ≥1024 / 2 cols 768–1023 / 1 col ≤767, gap 24. Each step card (padding 20, radius 12): step number (12/600 accent), icon 24px SVG, title 16/700, **one line** 14px, model id mono chip 12px LTR at bottom:

1. **Spark reads** — `Reads text, product and layout of the approved ad.` — `muse-spark-1.3`
2. **SAM cuts** — `Cuts product & logo out pixel-exact.` — `sam-3.1`
3. **Wonder art-directs + reviews** — `Plans each layout, then checks and repairs it.` — `muse-wonder-1.0`
4. **Muse Image builds** — `Builds the new background around the protected pixels.` — `muse-image-1.0`

Connected by thin arrow (24px, mirrors RTL) between cards on desktop. Below: `What's not done yet` — short `<ul>`, max 5 items, 14px, no prose paragraphs anywhere on the page.

---

## 6. Empty / Loading / Error States

| Surface | Empty | Loading | Error |
|---|---|---|---|
| Example strip | If no examples: strip hidden entirely; dropzone caption adds `No examples available` 12px. Never an empty box. | Thumbnails = 72×72 `--surface-2` shimmer blocks ×5, labels = 40×12 bars. Max 1 frame perceptible — assets preloaded. | Strip replaced by one 40px row: `--red-ink` 13px `Examples failed to load` + `Retry` text-button. Setup still fully usable. |
| Showcase | Before any selection: show default example (per UI language) — showcase is never blank in first viewport. | Source/output boxes hold aspect-correct shimmer; labels visible immediately. | Image area = `--surface-2` + centred 13px `Preview unavailable` + Retry; labels remain. |
| Run grid | Before first run: grid absent; results section absent (page ends after setup+showcase). | §5.4 step line + per-size skeletons in real aspect ratios. | Per-tile error + Retry (§5.4); queue & spend-cap banners as specified; total failure = banner `--red-bg` `Run failed — nothing was charged.` + `Try again` primary. |
| Detail page | Direct visit with no run: centred message 16px `This output is no longer available.` + `Back to home` primary. | Stage = aspect shimmer; rail blocks shimmer in order; tools disabled. | Output failed to load: stage shows error panel + `Retry` + `Download` disabled with reason; source thumb and chips still render if data exists. Missing manifest: X-ray/safe-area disabled with captions (§5.10). |
| Brands list | No brands: one dashed-border panel, 16px `No brands yet`, `+ New brand` primary, plus the 3-step hint (§5.13) greyed. Demo brands always present in demo build, so this is the visitor-expired case: add caption `Visitor brands expire after 24 h`. | Card skeletons ×3 (logo bar + swatch row shimmer). | List error: `--red-bg` banner + Retry; create form error inline per-field (red border + 12px message under field). Duplicate-name error: `A brand with this name exists`. |

All error text 13px minimum, `--red-ink` on `--red-bg` or white; errors always include a next action (Retry/Edit), never a dead end.

---

## 7. RTL Rules

**Mirrors (inline direction flips automatically via logical properties):**
- Layout order: setup card moves to the right (inline-start in RTL), showcase to its left. Grid/flex order is DOM order + `direction:rtl` — do not reorder DOM per language.
- Arrows: showcase source→outputs arrow, How-it-works connectors, `Details →`, Back link, placement-switcher chevrons, Before/After handle icon. Implement all as SVG with `transform:scaleX(-1)` under `[dir=rtl]`, or draw with `inline-end`-pointing paths. Prev/Next: in RTL, Prev chevron points right.
- Progress/step connectors, chip icon position (icon at inline-start of chip), badge position (`inset-inline-start`).
- Before/After slider: `Before` layer clips from inline-end; handle drag direction follows pointer, labels swap sides.

**Stays LTR (wrap in `<bdi>` or `dir="ltr"` span, `unicode-bidi:isolate`):**
- Dimensions: `1080×1920`, ratios in mono contexts, `9:16` inside dimension strings
- Model ids: `muse-wonder-1.0`, `sam-3.1`, etc.
- Prices/currency amounts, timers (`0:04`, `14.2 s` numeric part), coverage `%`, hex codes (`#0f4c5c`), file sizes, trace table values, ZIP/PNG tokens
- Logo/wordmark `MatchPic`, brand names as typed

**Logical-property checklist (grep the CSS file — zero hits allowed for physical props in layout code):**
- `margin-left/right` → `margin-inline-start/end`; same for `padding-*`, `inset`/`left/right` → `inset-inline-start/end`
- `text-align:left/right` → `start/end`
- `border-left/right` → `border-inline-start/end`; `border-top-left-radius` etc. → `border-start-start-radius` family
- `float`, `clear` physical values: forbidden
- Transforms for centring (`translateX(-50%)`) and the slider handle: permitted, but pair with `inset-inline-start:50%`
- Scroll containers: `scroll-padding-inline-start` for the example strip snap offset

**Language switch:** toggling EN/עב changes only `<html lang dir>`, fonts, and copy. Route, query, hash, selected example, selected placement, and scroll position are preserved. Numbers inside Hebrew UI remain Western Arabic numerals, LTR-isolated.

---

## 8. Do Not — The 5 Fastest Ways Back to Clutter

1. **Do not print technical data on calm surfaces.** No model ids, timings, trace, timestamps, or coverage % on the home showcase, example strip, or result-card faces. Rule: home + card face = image + one label + 3 chips, maximum. Everything else lives behind `Details`/detail page (§5.3, §5.6).
2. **Do not add a second label style.** Every image in the product gets exactly one label format: `Placement Ratio` 12px (dimensions mono only where §5 specifies). No per-component caption inventions, no 11px text, no stacked metadata lines under thumbnails.
3. **Do not let pills/chips wrap into walls.** Sizes use the default-4 + `All Meta placements` pattern; chips are fixed 3-per-card in fixed order. If a new datum appears, it goes in Details — not in a fourth chip, not in a new pill row.
4. **Do not invent colours or effects.** Only §4 tokens; no gradients, no glassmorphism, no shadows beyond `0 1px 2px rgba(22,33,27,.06)` on cards, no coloured icon backgrounds except status chips and X-ray overlays. New state needed → reuse Pending/Fixed/Needs-review semantics first.
5. **Do not break the first-viewport budget.** Nothing may be added above the fold on Home without removing something of equal height. Setup card ≤560px tall in its initial state; progressive disclosure (collapsed brand/sizes/mode until source exists, showcase capped at source + 3 outputs) is the mechanism — long scrolling demos, saved-demo timestamps, and model strips in the hero are banned (§1.4, §5.2).