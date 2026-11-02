You are running as muse-wonder-1.0. Next owner request, after session 13: **MatchPic's colours and design must follow Mashrokit's design line** (the agency's site, mashrokit.co.il). Medium depth, finish today. Same rules as always (AGENTS.md; never `git push`, never `--execute`, never the Graph API, never read `.env` / secrets / TOKEN-KEY-SECRET variables, never touch files outside this repo, do not commit). Browser rule: only Playwright's own browser, never the system Chrome. No live Model API calls are needed.

## Mashrokit's design line (exact values)
From Mashrokit's logo and the site's design tokens (as used on the agency's own pages):
- Logo strokes: navy `#121E30`, sky `#20B0E9`, turquoise `#41D8BA`, deep blue `#055A84`.
- Site (dark): background `hsl(216 45% 13%)`, raised `hsl(216 38% 18%)`, card `hsl(216 40% 17%)`, border `hsl(216 24% 27%)`, text `hsl(195 25% 92%)`, muted text `hsl(200 16% 72%)`, primary `hsl(197 82% 52%)` (hover `hsl(197 82% 45%)`), turquoise `hsl(174 72% 44%)`, green `hsl(168 66% 55%)`, deep shadow `0 18px 52px -8px #04091099`.
- Typeface: **Rubik** (400/500/600/700), Latin and Hebrew.

## Scope (owner's decision)
**Colour palette only.** Do not copy the site's layout elements (no rotated polaroid cards, no progress rings, no numbered circles, no colour-band redesign). Keep MatchPic's current layout, components and copy exactly; change colours (and the typeface to Rubik) so it clearly belongs to the Mashrokit family. A screenshot of the site is in `.local/mashrokit-site.webp` for colour reference only: navy `#121E30`/`hsl(216 45% 13%)`, sky `#20B0E9`/`hsl(197 82% 52%)`, turquoise `#41D8BA`/`hsl(174 72% 44%)`, deep blue `#055A84`, white header.

## What to do
1. Re-colour the whole UI with this palette (light pages, white header, navy text; navy for headings and dark accents), sky-blue / deep-blue primary actions (text on sky = navy, check ≥ 4.5:1), turquoise for success / "Protected" / selected accents, Rubik everywhere (keep a mono face for dimensions and model ids). Replace the green palette completely — tokens in one place in `src/web/styles.css`, no hard-coded colours left (grep). Status chips (Passed / Pending / Fixed / Needs review) re-tuned to the new palette with ≥ 4.5:1 text.
2. Output images must still read well: image wells slightly lighter than the card so light ads don't glow and dark ads don't vanish; keep true aspect ratios.
3. The MatchPic mark (favicon/header): recolour to the brand colours (deep blue + sky, white check). Small "by Mashrokit" in the footer.
4. Keep layout, copy and behaviour unchanged — this is a colour/type pass, not a redesign.
5. Verify: `npm test`, `npm run typecheck`, rebuild web, Playwright screenshots (Home EN+HE 1440 and 390, an example clicked, a detail page, Brands, How it works) → `artifacts/ui/theme-*`. Look at every one; fix contrast and anything that looks off. Report what changed and the contrast pairs you checked.

## Notes for this run
- Fonts must be self-hosted (the site makes zero external requests today — keep it that way). If Rubik isn't in the repo, add it from the `@fontsource/rubik` npm package (Latin + Hebrew subsets, 400/500/600/700) and serve it like the current fonts.
- `node` may be missing from the default PATH; use `PATH=/opt/homebrew/Cellar/node@20/20.18.3/bin:$PATH`.
- You run headless and may be restarted after a network error: check `git status` first and don't redo finished work.
- The LAST thing you do: write your final report to `.local/logs/14-report.md` (it signals completion).
