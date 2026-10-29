# pi-pocket-timber

A [Pi Pocket](https://github.com/TannerMidd/pi-pocket) drop-in for
[Timber](https://github.com/nnutter/timber) worktrees: list, create, open sessions in, and safely remove managed Git worktrees from a side panel.

Wraps the `timber` CLI on the server (with `gh` for pull requests).

## Requirements

- [`timber`](https://github.com/nnutter/timber) on the machine Pi Pocket runs on
- [`gh`](https://cli.github.com/) signed in, for pull requests (`gh auth login`)
- `git` (for upstream bookkeeping around `gh pr create`)
- Pi Pocket 0.19.0 or newer (`conversationRoute`, panels, and `cwd` starts)

## Install

Manual:

```sh
cp -r extensions/* ~/.pi-pocket/extensions/
```

Then Menu → Extensions → turn on **timber**.
The files follow the gallery layout (`timber.ts` + `timber/` browser folder, no `node_modules`), so publishing is Menu → Extensions → **Share…** on the installed drop-in.

## What it adds

- **Timber worktrees panel** (rail + launcher): search, sort, per-worktree status (Merged / Clean / Dirty), ahead/behind, TODO and review counts
- **Open**: starts a linked session in the worktree's folder
- **New worktree / Add repository** forms
- **Delete** (clean worktrees that are merged or fully in sync only, two-tap confirm); otherwise a **PR button** that opens the worktree's pull request or creates one with `gh pr create --fill`
- **Refresh**: lists worktrees and fetches all remotes; auto-fetch every 5 minutes so merged branches flip to Merged
- Tools for Pi: `timber_list`, `timber_create`, `timber_remove`, `timber_repo_add`, `timber_fetch`

## Safety notes

- Removal runs `timber remove` with no force flag, and only for worktrees that are clean with known status and merged (or 0 ahead / 0 behind).
- `gh pr create` normally switches the branch upstream; the extension snapshots `@{u}` first and restores it afterwards (or unsets what `gh` added), warning instead of failing silently.
- The module shells out to `timber`, `gh`, and `git` as described above, and reads nothing else off the machine.

## License

MIT — see [LICENSE](LICENSE).
