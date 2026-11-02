You are running as muse-wonder-1.0. Goal: the remaining visible defects in the saved demo outputs — the owner reviewed every output at full size after session 13. Medium depth: verify what matters, fix root causes in the engine, don't gold-plate.

Rules (hard): follow AGENTS.md. Never `git push`, never commit, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Browser rule: only Playwright's own browser (`~/Library/Caches/ms-playwright`) with a plain `chromium.launch()`, never the system Google Chrome (`channel: 'chrome'`, `--single-process`, any executablePath under /Applications). If a launch fails, stop and say so; don't loop.

Budget: Model API spend for engine/demo runs in this session ≤ $5 by the ledger. Regenerate only the examples you changed.

You run headless and may be restarted after a network error: check `git status` and `.local/logs/` first and don't redo finished work. `node` may be missing from PATH; use `PATH=/opt/homebrew/Cellar/node@20/20.18.3/bin:$PATH`.

## Defects (owner's review of `fixtures/brands/*/demo/*.png`, look at each yourself at full size first)
1. **NORTHBEAN (source: Link 1.91:1):** the CTA "Order now" is missing in all three outputs (Feed 1:1, Feed 4:5, Story 9:16). The cans are tiny and float in the middle of empty wood; the lying can hangs in the air with no contact with the surface. In the source the cans dominate (~55% of the height) and stand on the table. Fix: keep product scale proportional to the source (hero product ≥ ~40% of the canvas height on square/portrait), ground every product on the same surface line with a contact shadow, and never drop the CTA.
2. **שקט / sheket (source: YouTube 16:9, HE):** the headphones are cut by a straight vertical edge on the right side in both outputs (the headband and the right cup are sliced). Find why (mask clipped to a crop box? source bbox? padding?) and fix it at the root so a product is never cut by a straight edge unless it was cut in the source.
3. **טבע / teva (source: Feed 4:5, HE)** — currently removed from the demo list (`DEMO_JOBS` in `src/server/adfit/seed.ts`): the bottom of all three bottles is torn and jagged where fruit overlapped them in the source. Fix the occluded-edge handling (e.g. complete the occluded base cleanly, or keep the original foreground objects together with the product) so the bottles look whole. Only if all its outputs are now client-worthy, add teva back to `DEMO_JOBS` (order: LUMA, STRIDE, NORTHBEAN, then טבע, שקט) and update the order test in `tests/web.test.ts`.
4. **LUMA Link 1.91:1:** the price "$42" floats alone at the bottom-left, far from the headline/CTA group. Keep the text group together.
5. **STRIDE** outputs come out `needs_review` though they look fine; check whether the review is right. Don't fake statuses — fix the cause or leave the honest status.

## Then
- Regenerate only the affected examples, assemble the demo (`scripts/assemble-demo.ts`), check a fresh temp DB seeds them (never the real data dir).
- `npm test`, `npm run typecheck`, `npm run build:web` — all pass. Add a regression test for each engine root cause you fix.
- The LAST thing you do: write the report to `.local/logs/15-report.md` — what changed per defect (root cause → fix → test), the demo table (example / native size / sizes kept / statuses), ledger spend, before/after image paths, anything not done. Writing this file signals completion.
