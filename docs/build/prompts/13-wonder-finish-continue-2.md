CONTINUATION (headless). You are running as muse-wonder-1.0 at medium depth. A previous run of this task was interrupted by provider/network errors; this run may itself be a restart of an interrupted run. The full task is in `.local/prompt-13b-continue.md` — read it first. Its uncommitted work is in the working tree: run `git status` and `git diff --stat`, keep what is good, and do not redo finished work.

Where the previous run stopped (its own recap): §1 is done — engine fixes in masks/render/pipeline/planner/manifest, the five brand demos (LUMA, STRIDE, NORTHBEAN, טבע, שקט) regenerated and assembled under `fixtures/brands/*/demo/`, brand prompts in `fixtures/brands/*/prompt.json`. §2 (Brands page) and §3 (site audit) were in progress: web built, UI screenshots taken, an i18n subtitle edited. Next actions were: check that a fresh, empty database seeds the five demos correctly, then finish §3 and do §4.

Do now, in this order, timeboxed:
1. Fresh-DB seed check (use a temp data dir, never the real one).
2. Finish §2/§3 only where something is visibly broken in the screenshots — at most the 5 worst defects. Don't gold-plate.
3. §4: `npm test`, `npm run typecheck`, `npm run build:web` — all must pass.
4. Write your final report to `.local/logs/13c-report.md` (what changed by section, the demo table: example / native size / sizes kept / statuses, ledger spend, screenshot paths, anything not done). Writing this file is the LAST thing you do — it signals completion.

Rules (hard): follow AGENTS.md. Never `git push`, never commit, never run anything with `--execute`, never call the Graph API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo. Model API spend for engine runs in this run: ≤ $2 by the ledger — do not regenerate demos again unless one is clearly broken.

Browser rule (hard): never launch the system Google Chrome (`channel: 'chrome'`, `--single-process`, any executablePath under /Applications). Use only Playwright's own browser (`~/Library/Caches/ms-playwright`) with a plain `chromium.launch()`. If a launch fails, stop and say so; don't loop.
