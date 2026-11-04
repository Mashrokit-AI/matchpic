You are running as a Muse Code agent on the branch `s18-resize-quality`. Small documentation task. Follow AGENTS.md. Never `git push`, never commit, never run anything with `--execute`, never call the Graph API or any model API, never read `.env`, `~/.config/offer-guard/secrets.env` or any variable whose name contains TOKEN/KEY/SECRET, never touch files outside this repo.

The README describes three Meta models, but the engine also uses Muse Wonder (`muse-wonder-1.0`). Read `src/server/adfit/planner.ts`, `src/server/adfit/batch.ts` and `src/server/models/costs.ts` to confirm what Wonder does, then:

1. In `README.md`, under "Meta models used where", add table rows for what `muse-wonder-1.0` really does in the code (layout planning and the layout review with patches). In "How it works", add one short accurate sentence about it. Change nothing else in the README.
2. In `docs/build/BUILD_LOG.md`, add a row right after the row for session 20: session `21`, date `Nov 4`, prompt link `[21-readme-models](prompts/21-readme-models.md)`, commit column `this commit`, result: one short sentence.

Keep the existing style. Don't change code. When done, run `npm run typecheck` and write one line to `.local/logs/21-report.md`.
