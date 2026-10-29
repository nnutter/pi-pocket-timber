# AGENTS.md

## Source of truth

Work in this repo. `~/.pi-pocket/extensions/` is a deployment target, not a workspace — never edit it directly.

- Server module: `extensions/timber.ts`
- Browser UI: `extensions/timber/`

## Workflow

1. Edit here.
1. Verify: `mise run check` (prettier, mdlint, gitleaks, pkl, tombi, yamlfmt — CI runs the same).
1. `tsc` is NOT gated here: it needs Pi Pocket's private `_pocket.d.ts`, so type errors only surface on extension load.
   Reload the live install after deploying and watch for load errors.
1. Commit in small, single-purpose commits.
1. Deploy: `cp -r extensions/* ~/.pi-pocket/extensions/`, then toggle the extension off/on in Menu → Extensions to reload.

## Conventions

- 2-space indent, prettier-clean — CI fails otherwise.
- Gallery layout: keep `timber.ts` + `timber/` names, no `node_modules`, no hidden files.
  Import only own files, Node builtins, and Pi Pocket packages (`@earendil-works/*`); `import type` from `_pocket.d.ts` is fine.
- The module `/** … */` comment's first paragraph is the gallery description — keep it accurate (names the `timber`/`gh` dependency).
