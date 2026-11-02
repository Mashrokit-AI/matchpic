Next: redesign Brands around **style examples → an automatic brand prompt**. The owner looked at the live Brands page and doesn't like it: template images covered with coloured zone boxes and labels ("לוגו", "פאנל מבצע", "טקסט משני"), misplaced and overlapping, hard to understand. He wants a clean, pleasant, clear page where you upload a few examples of the brand's design style — some general, some for a specific size/platform — and the system writes the brand prompt by itself. Follow AGENTS.md. You run without approval prompts, so be careful: never `git push`, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Do not commit.

**Browser rule:** never launch the system Google Chrome (`channel: 'chrome'`, `--single-process`, any executablePath under /Applications). Use only Playwright's own browser in `~/Library/Caches/ms-playwright` with a plain `chromium.launch()`. If a launch fails, stop and report; don't loop.

**Model API budget for this session: up to $6** (ledger; the image work in §0 needs no model calls). Hebrew strings follow `.local/he-strings.md`; every string in both languages.

## 0. First: two leftovers from session 11 (live since 14:10 today)
1. **Image weight (top priority).** Demo outputs are served as 1.2–2.3 MB PNGs and take 1.5–3 s each on the live site, so the Home showcase and example strip look empty for the first seconds. Serve sized derivatives: a WebP/AVIF thumbnail for strips, cards and the showcase (≈ 600 px long side, cached, generated once per output and per source), the full PNG only on the detail page and for download. Preload the default example's images. Measure before/after on the live-like build (time until the showcase images are painted) and report it.
2. Session 11 was stopped before its §10 pass: take the Playwright screenshots (Home EN+HE 1440/390, each example clicked, a detail page with slider / X-ray / crops, How it works), look at them, fix what's broken (empty showcase tiles, overflow, RTL), zero console errors. The "?" mode tooltip must open on hover, tap and keyboard focus — verify it.

## What we learned from our production tool (the agency's own resizer)
Our in-house resizer has 22 client profiles. Each one is plain text written from measuring the client's real finished ads: one **general rule** paragraph plus optional **per-format rules**. What made them work, keep all of it:
- Every rule is **conditional on what's visible in the source** ("only when the source shows the logo on a white panel…; otherwise keep the source structure") and has explicit **never-add** limits — so the model doesn't invent bands, tabs or logos.
- Per-format rules are sent **only in that format's call**; the general rule goes to every call.
- The key finding: brands keep **logos, bands and tabs at a fixed size/proportion** and give extra height or width to the photo/background. Rules state proportions (e.g. logo ≈ 18% of the width, bottom band ≈ 14% of the height), not vibes.
- Weaknesses to avoid here: rules were hand-written by a developer, colours/fonts weren't structured fields, no example images reached the model, and there was no screen to add, edit or approve a brand.

## 1. Data model
A brand = name, logo (optional), colours (structured: hex list with roles primary/secondary/accent/text/background), fonts (optional names), **style examples**, and a **brand prompt**.
- Style example = an uploaded finished ad + a scope: `general`, or a specific placement preset (default guessed from the aspect ratio, editable).
- Brand prompt = structured JSON + its readable text: `general` (rules for every size), `perPreset` (rules for one size), `never` (never-add list), `colors`, `fonts`, plus `version`, `generatedBy` (model id), `generatedAt`, `editedByUser`.
- Existing GALI/NOA template data: migrate each template image into a per-size style example. Zone boxes may still be derived internally if the engine needs them, but they are **never drawn in the UI**.

## 2. Generating the brand prompt (Wonder)
One `muse-wonder-1.0` call per generate: send all the brand's examples (labelled with scope and size, ≥ 768 px long side), the logo, the colours, and instructions modelled on our production rules above (conditional rules, never-add list, fixed-size elements vs flexible background, proportions as % of canvas, Hebrew/English text conventions if visible). Structured output with a JSON schema. Code validates it (no empty sections, proportions in range, per-preset keys only for presets that have examples).
- Runs automatically after examples are added or changed (debounced), shows progress, and is cheap to re-run ("Regenerate").
- The user can edit the readable text inline; edits are saved and marked `editedByUser`. Regenerating asks before overwriting user edits.
- Spend cap applies (`ADFIT_WONDER_DAILY_USD`); over the cap → a clear message, nothing breaks.

## 3. Using it in the engine
The brand prompt feeds the Wonder art director (§3 of session 10) and the plate brief: `general` + `never` for every size, `perPreset[size]` only for that size. A brand with examples but no per-size example for a size still works from `general`. Record in the trace which brand-prompt version was used. Tests: injection per size, missing sections, user-edited text wins.

## 4. The Brands page (clean)
- Top: page title + a prominent primary **"+ New brand" / "+ מותג חדש"**.
- A simple grid of brand cards: logo, name, colour dots, "N examples", small "Demo" tag on demo brands.
- Brand page, three calm sections, no boxes drawn on images:
  1. **Basics** — name, logo, colour pickers (+hex), fonts.
  2. **Style examples** — one drop zone ("Drop a few finished ads — general or for a specific size"); thumbnails in a tidy grid at their true aspect ratio, each with a small scope chip (General / Feed 1:1 / Story 9:16…, editable) and a remove ×. Hint: 3–6 examples is enough.
  3. **Brand prompt** — the generated rules as short readable bullets grouped General / per size / Never, with Edit, Regenerate, "Generated by muse-wonder-1.0 · time". A one-line explanation of what it's for.
- **Delete brand** with a confirm step for user brands. Demo brands: read-only, "Duplicate to edit".
- Empty state for a new brand: the three steps (basics → examples → prompt) as a short checklist.
- Mobile 390 and RTL correct; no horizontal scroll.

## 5. Demo brands
Give GALI, NOA and the session-11 demo brands (VELA, DAFNA, ZAZO, TODA, whichever exist) their examples (from their fixtures) and a generated brand prompt, saved into the fixtures/seed so a fresh DB shows them without spending. Keep them read-only.

## 6. Verify
`npm test`, `npm run typecheck`, rebuild web. Generate one brand prompt live for one demo brand and for a brand you create from 3 fixture images (one general, two per-size), and run one protected 3-size job with it to show the prompt changes the layout (before/after, honest — if it doesn't change anything visible, say so). Playwright screenshots (EN+HE, 1440 and 390): Brands list, a brand page with examples and its prompt, the new-brand empty state, delete confirm → `artifacts/ui/`. Look at every screenshot. Report what changed, the generated prompt for one brand, spend, anything unfinished.
