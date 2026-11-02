You are running as muse-wonder-1.0. Owner request: the site's design should be **more polished and follow Mashrokit's brand book** (the agency's 2026 brand guidelines). Session 14 already moved the colours to Mashrokit's palette with Rubik; now apply the brand book properly. Medium depth, finish tonight.

Rules (hard): follow AGENTS.md. Never `git push`, never commit, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. No live Model API calls are needed — do not make any. Browser rule: only Playwright's own browser (`~/Library/Caches/ms-playwright`) with a plain `chromium.launch()`, never the system Google Chrome (`channel: 'chrome'`, `--single-process`, any executablePath under /Applications). If a launch fails, stop and say so.

You run headless and may be restarted after a network error: check `git status` first and don't redo finished work. `node` may be missing from PATH; use `PATH=/opt/homebrew/Cellar/node@20/20.18.3/bin:$PATH`.

## The brand book
Pages are in `.local/brand-book/` (`page-2.png` fonts, `page-3.png` colours, `page-4.png` do's and don'ts, `page-7.png` an example composition, `text.txt` the extracted text). Look at them first. The essentials:

- **Type.** Hebrew: Heebo (the free stand-in for Almoni Tzar). English and numbers: Plus Jakarta Sans. Body weight **300**, buttons **500**, headings **600**. Never a heavy body. Self-host both from npm (`@fontsource/heebo`, `@fontsource/plus-jakarta-sans`, needed weights only, Hebrew + Latin subsets) like the current fonts — zero external requests. Replace Rubik. Keep the mono face for dimensions and model ids.
- **Colours.** Night blue `#121E30` (primary, surfaces), sky `#20B0E9` (highlight), turquoise `#1FC1B1` (secondary), mint `#41D8BA`, aqua `#42D3F0`, ocean `#0077B2`; navy 900 `#0C1522`, 700 `#1A283D`, 600 `#273549`, 500 `#344255`; slate `#ACBBC3`, mist `#E6EDF0`, ink `#111D2E`, white. **Coloured text on white only in `#0F6A93` (blue) or `#147B71` (teal)** — never sky or turquoise text on white. Composition ratio roughly 60% night blue, 20% white, 15% sky + turquoise, 5% aqua / mint / ocean. **At most two brand colours on a screen.**
- **Components.** Buttons fully rounded (pill), filled or outline — never square. Cards: 12px corners, a soft shadow, lots of air. Headlines: one highlighted phrase in turquoise (on night blue), e.g. "One approved ad. Every placement. **Product and logo untouched.**" — pick the phrase in EN and HE. Night-blue background with one solid colour section.
- **Checklist before done:** night-blue or white background, body 300 and headings 600, one filled colour, a highlighted phrase, round buttons, contrast ≥ 4.5:1 everywhere.

## What to do
1. A night-blue header and hero band (the headline with its turquoise phrase, the one-line subtitle in body 300), in the spirit of `page-7.png`. The working area below stays light (white / mist cards) so the ads read well — ad images must sit on light wells with true aspect ratios, never on night blue.
2. Re-style buttons (pill), size chips, mode toggle, status chips, cards, inputs, the example strip, the Brands page, the detail page and How it works to the brand book. Keep layout, copy and behaviour unchanged except the hero/header treatment above — this is a design pass, not a redesign of the product.
3. Tokens in one place in `src/web/styles.css`; no hard-coded colours outside it (grep). Update the MatchPic mark if needed so it sits well on night blue.
4. Hebrew and English both: check RTL, Hebrew in Heebo, Latin/numbers in Plus Jakarta Sans (a `unicode-range` split or font stacks per `lang`).
5. Verify: `npm test`, `npm run typecheck`, `npm run build:web`, then Playwright screenshots → `artifacts/ui/bb-*` (Home EN+HE at 1440 and 390, an example clicked, a detail page, Brands, How it works). Look at every one as a strict art director against `page-4.png`; fix what's off. Zero console errors, zero external requests.

The LAST thing you do: write the report to `.local/logs/16-report.md` — what changed, the checklist above item by item, the contrast pairs checked, screenshot paths, anything not done. Writing this file signals completion.
