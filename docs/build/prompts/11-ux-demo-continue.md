CONTINUATION (third restart). Earlier runs of this session already did much of the work below; the changes are uncommitted in the working tree. Run `git status` / `git diff --stat` first, read what exists (docs/ui-spec.md, scripts/render-flat-fixtures.ts, scripts/assemble-demo.ts, the rewritten src/server/adfit/seed.ts, fixtures/brands/{zazo,toda}, fixtures/brands/README.md, artifacts/, the ledger files) and do NOT redo finished work. Stay inside what remains of the $20 cap per the ledgers.

## BROWSER RULE (hard — the last run was stopped because of this)
The previous run launched the owner's system Google Chrome (`/Applications/Google Chrome.app`, via Playwright `channel: 'chrome'` and `--single-process`). It crashed every few seconds and flooded the owner's screen with macOS crash dialogs while he was working.
- NEVER launch the system Chrome. Never use `channel: 'chrome'`, never `--single-process`, never any `executablePath` pointing into /Applications.
- Playwright's own browser is now installed in the default cache (`~/Library/Caches/ms-playwright`, chromium + headless shell v1248) and this run's shell is unsandboxed, so a plain `chromium.launch()` works. Use only that.
- Remove the `channel: 'chrome'` fallback and the `--single-process` paths from every script under `scripts/` (keep the server's src/server/repair/render.ts behaviour on Linux untouched, but on macOS it must not fall back to system Chrome either).
- If a browser launch fails, stop retrying and say so in the report; do not loop.
The shell is unsandboxed only for the browser. Every other rule still holds and matters more now: never read `.env`, `~/.config/offer-guard/secrets.env` or any TOKEN/KEY/SECRET variable, never touch files outside this repo (except the Playwright cache read), never `git push`, never `--execute`, never the Graph API, do not commit.

## Where it stopped (third restart — the previous run died on a Model API network timeout after 3 hours of good work)
Already DONE (verify quickly, don't redo): browser rule; ZAZO no-text root cause fixed; owner Home requests 1–4; §0b and §0–§8 gaps. Demo engine runs exist in `artifacts/demo-11/{zazo,toda,dafna-story,noa,vela}` plus a story re-run in `artifacts/demo-11/zazo-story2` (the last thing you were doing). Session-11 spend so far ≈ $6.6 by the ledgers.
LEFT: finish §9 — look at every output in those dirs at full size, keep only client-worthy ones, decide on the zazo story re-run, assemble with `scripts/assemble-demo.ts`, seed — then §10 (tests, typecheck, web rebuild, Playwright screenshots with Playwright's own browser, look at them) and the full report. Avoid new live model calls unless an output is unusable; if a Model API call fails, wait 60 s and retry, never end the turn on it.

## Owner's new Home-page requests (do these too)
1. **Mode selector (Protected / Fast):** its border box currently stretches to the full width of the card — it looks bad. The segmented control is only as wide as its two buttons (or no outer border at all). Next to it a small "?" / info icon opens a short floating tooltip (hover + tap + keyboard focus, closes on Esc/outside click): EN "Protected — product and logo stay pixel-exact; AI builds only the background and re-sets the text." / "Fast — the image model redraws the whole ad; quicker, but details may change." HE: "מוגן — המוצר והלוגו נשארים בדיוק כמו במקור; ה-AI בונה רק את הרקע ומסדר מחדש את הטקסט." / "מהיר — מודל התמונה מצייר מחדש את כל המודעה; מהיר יותר, אבל פרטים עלולים להשתנות." Remove the inline one-liners if the tooltip replaces them.
2. **Remove the "Meta models" row from Home** (SAM 3.1 — protects…, Muse Image — builds…, Muse Spark — reads…). That information lives on the How-it-works / About page only. The single run line under live results (model ids + timings of that run) stays.
3. **"Add brand" must be obvious:** a clear "+ New brand" / "+ מותג חדש" button on Home next to the brand select (opens the Brands page in create mode, then returns to Home with the new brand selected), and a prominent primary "+ New brand" button at the top of the Brands page.
4. **Delete a brand:** user-created brands get a "Delete brand" / "מחיקת מותג" action on the Brands page with a confirm step (the API `DELETE /api/brands/:id` exists; demo brands stay read-only and cannot be deleted — keep the guard and add a test).
Note: the Brands page will get a full redesign in the NEXT session (style examples → auto brand prompt). In this session keep Brands changes to items 3–4 plus what §6 already did; don't spend more on it.

--- ORIGINAL SESSION PROMPT ---
Next: a focused UX/UI pass so a judge understands MatchPic in 10 seconds without scrolling, then regenerate the demo with the new engine. Not a rewrite — the changes below, done well. Follow AGENTS.md. You run without approval prompts, so be careful: never `git push`, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Do not commit.

**Model API budget for this session: up to $20** (mostly the demo runs — up to 5 examples × ~7 sizes). Use the ledger from session 10.

Hebrew: every new `he` string follows the style rules in `.local/he-strings.md` (short, spoken, buttons = one word, plural present for instructions, product names in Latin). Every new string exists in both languages.

## 0. Wonder is the design lead for this session
Before writing UI code: take Playwright screenshots of the current Home (EN+HE, 1440 and 390), a detail page and Brands, and send them together with sections 1–8 of this prompt to `muse-wonder-1.0` (via the repo's Model API client, high reasoning effort). Ask it for a precise, implementable UI spec: layout grid and breakpoints, spacing scale, type scale (Latin + Hebrew), colour tokens with contrast ratios, component specs (setup card, example strip, skeleton tile, status chips, result card, detail tools row, brand card), empty/loading/error states, and RTL rules. Save it to `docs/ui-spec.md` (commit-worthy, mention it was produced by muse-wonder-1.0) and implement against it. Where the spec conflicts with this prompt, this prompt wins.
At the end, send the new screenshots to Wonder once more for a strict design critique (specific defects with exact fixes, no scores); apply the fixes, take final screenshots, and include the critique and what you changed in the report. Budget for these Wonder design calls: ≤ $3 of the session budget.

## 0b. Engine fixes first (owner review of the session-10 outputs in `artifacts/engine-10/`)
Fix these in the engine before any demo run; they would ruin the demo:
1. **Vertical 9:16 is shrunk to the top third** (VELA, DAFNA, GALI and NOA stories): products ~20% of the height, headline/price/CTA tiny and unreadable, the bottom half empty. Products must reach ≥45% of the safe height, text keeps a legible minimum size for 1080×1920, and the composition fills the safe area top-to-bottom (headline top, products middle, price/CTA panel just above the bottom UI zone). Find the root cause (enforcement clamp, revert or scale-down) — don't patch per fixture.
2. **Floating products**: NOA's bag hangs in mid-air above the table in fb-link and the story. A product stands on the plate's visible support surface with a contact shadow, or the plate brief is changed so the surface lines up with the product's base.
3. **Landscape text cohesion**: VELA fb-link — the subline sits far below the headline, detached; the jar nearly touches the bottom edge. Text group = one tight stack with consistent gaps; nothing within the 6% margin.
4. **NOA square**: the big source headline becomes small text in the bottom corner — keep the source's hierarchy (headline stays dominant).
5. **Revert noise**: after a revert, let Wonder re-propose once (one extra call per source, inside the cap) so "Needs review" means a real problem.
Verify each fix on the same 3 sizes for VELA, DAFNA and NOA, look at them at full size, then move on. Disk on this Mac is nearly full (~3.5 GB free): delete your own superseded runs as you go, keep artifacts small.

## 1. First viewport (Home)
- Desktop: two columns. Start side = the setup card (upload → source preview → brand → sizes → Generate). End side = a compact showcase: the selected example's source and 3 contrasting outputs with a thin arrow between them. Mobile (390): headline, upload, the example strip, then the showcase.
- Headline = the benefit, e.g. EN "One approved ad. Every placement. Product and logo untouched." / HE "מודעה אחת שאושרה. כל הגדלים. המוצר והלוגו לא נוגעים בהם." One supporting line with the real pain: EN "Our studio resizes every approved creative into 6–8 formats by hand, every day, for 100+ brands." / HE "בסטודיו שלנו מתאימים כל קריאייטיב ל-6–8 גדלים ידנית, כל יום, ליותר מ-100 מותגים."
- **The demo = an example strip of up to 5 thumbnails** (see §9), next to / under the upload. Each thumbnail shows the source creative and one small label with its native size (e.g. "Story 9:16", "Feed 1:1"). Clicking one loads that example instantly (no credits spent): its source large + a compact grid of its conversions into every other size. Default example follows the UI language. This replaces the current demo section entirely — no long scrolling demo, no repeated near-identical images, no per-card text walls.
- Remove the saved-demo timestamp from the hero; keep it in the example's details.
- **Owner feedback (top priority):** the current demo looks bad because it is many near-identical images of one bottle from the previous project, and it is cluttered with long, unclear text. The demo area must be calm and visual: images first, one short label per image, everything technical (models, timings, trace, proof) one click away on the detail page.

## 2. Setup flow
Progressive and compact: after upload show the source preview with detected text (read-only list with a small "Edit" to confirm detected text before generating — edits feed the text renderer, never the protected pixels). Brand select with "+ New brand". Sizes default to 1:1, 4:5, 1.91:1, 9:16 with "All Meta placements" one click away. Mode as a segmented control with an inline one-liner each: Protected — "keeps product & logo pixel-exact"; Fast — "may redraw details". Generate button explains why it's disabled. Sticky Generate on mobile.

## 3. Results while running
Show shared preparation once ("Reading the ad · Cutting product & logo · Wonder is planning 8 layouts") as a compact step line with live timers, then a skeleton tile per size in its real aspect ratio that fills in as each size streams in, with its status chips (Protected pixels / Text / Layout review: Pending → Passed / Fixed / Needs review). One failed size never blocks the others; each tile has its own Retry. Explicit messages for queue and spend cap. Under the grid, ONE line for the whole run: `Meta models: muse-wonder-1.0 · muse-spark-1.3 · sam-3.1 · muse-image-1.0 · first preview 14.2 s · all 8 in 61 s` (real numbers). Prominent "Download all (ZIP)".

## 4. Result cards
Output art dominates: wider max content width on desktop (≈1280), fixed-ratio grid grouped by orientation, square/portrait/vertical first. Card = image, placement + dimensions, the three status chips. Model ids per card move into the card's hover/"Details" (the run line above keeps them visible). A "Fixed by Wonder" badge on sizes the review repaired.

## 5. Detail page = inspection and export
Large output, compact source reference, placement switcher (prev/next through sizes, mirrored in RTL), Download PNG. Tools row: **Before / After slider** (for sizes Wonder repaired: before-repair vs final; otherwise source vs output), **X-ray** toggle (protected mask in green, actual placement boxes in pink, template target zones dashed — from the resolved manifest), **Safe area** toggle, zoom. **Protected-pixel crops**: side-by-side synchronized crops of each protected element (source vs output) with the coverage %. "Verification details" collapsible: text check results, Wonder's rationale and repair patch, the trace table with model ids, durations, cached/live.

## 6. Brands
Brand cards (logo, colour swatches, which sizes have templates). Open one brand, then one size at a time. Colour pickers with optional hex. Demo brands read-only with "Duplicate to edit". Rename "Reject" → "Remove template" (HE "הסרת תבנית"). After creating a brand show the 3 steps inline: logo → template per size → use it on Home.

## 7. How it works
Replace the long text with a 4-step visual: Spark reads → SAM cuts → Wonder art-directs + reviews → Muse Image builds the background; each step one line + the model id. Keep "What's not done yet" as a short list.

## 8. Mobile + RTL
At 390 px the header must be one row: logo, language toggle, compact menu. Setup before showcase. No horizontal scroll anywhere. Logical CSS properties; dimensions, prices and model ids isolated as LTR inside Hebrew; arrows mirrored; switching language keeps the current route and scroll target.

## 9. Regenerate the demo (after 1–8 work)
**Up to 5 saved examples, and each one's source creative has a DIFFERENT native size** — e.g. one Feed 1:1, one Portrait 4:5, one Story 9:16, one Link 1.91:1, one YouTube 16:9. Each example converts its source into all the other Meta placements (protected mode, session-10 engine). The point the demo must make at a glance: "whatever shape you start from, you get every other shape".
- Make them visually distinct: different invented brands and product categories, a mix of English and Hebrew (at least 2 of each language is not required — but at least one EN and one HE complex), photo background vs flat design. Use the two complex fixtures from session 10 (`fixtures/brands/vela` EN, `fixtures/brands/dafna` HE) and NOA; create the extra sources you need in the missing aspect ratios the same way session 10 built its fixtures (Muse Image background + Chromium-rendered text, invented brands only, documented in `fixtures/brands/README.md`). A source in a non-square size must be a real designed creative for that size, not a padded square.
- **Drop the current GALI bottle demo** (the 9 near-identical bottle outputs, including the duplicated `li-post`) from the seed. GALI may stay as a brand, but it is not a demo example unless it looks clearly different from the others.
- Include at least one size where Wonder's review genuinely found and fixed a defect (keep its before/after) — do not fake one; if none occurs naturally, say so.
- Every output must be one you'd show a client; if a size isn't, fix the engine or leave that size out of that example and tell me. Fewer, better examples beat five mediocre ones.
- Overwrite the seed so a fresh DB seeds exactly these examples (no leftovers from the old demo, no duplicate presets); list the fixture files that changed (the server DB must be reseeded).

## 10. Verify
`npm test`, `npm run typecheck`, rebuild web. Playwright, zero console errors: Home EN+HE at 1440 and 390 (first viewport only, and full page — the full Home page must be short: no long demo scroll), each example in the strip clicked, a running job mid-stream (use a cached job or mock the stream — no live credits), a detail page with slider / X-ray / crops, Brands, How it works → `artifacts/ui/`. Look at every screenshot; fix overflow, RTL mixing, cropping, contrast. Report what changed, the demo table (example, preset, statuses, Wonder fixed?, seconds), ledger spend, screenshot list, anything unfinished.
