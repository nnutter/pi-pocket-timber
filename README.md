# pi-pocket-timber

A [Pi Pocket](https://github.com/TannerMidd/pi-pocket) drop-in for
[Timber](https://github.com/nnutter/timber) worktrees and TODOs: list, create, open sessions in, and safely remove managed Git worktrees, and read and edit the TODO list of a worktree or of its repository.
Both have a page, and a panel on a wide screen.

Wraps the `timber` CLI on the server (with `gh` for pull requests, and `gh stack` for a stack of them).

## Requirements

- [`timber`](https://github.com/nnutter/timber) 0.22.0 or newer on the machine Pi Pocket runs on (`timber pr create`, and `timber todo --repo` for the repository's TODO list; an older timber shows the worktree's list and says why the other one is missing)
- [`gh`](https://cli.github.com/) signed in, to read and merge pull requests (`gh auth login`)
- [`gh stack`](https://github.com/github/gh-stack) to merge a stack of pull requests (`gh extension install github/gh-stack`); without it, the page still reads stacks and merges a single PR, but a stack's merge buttons fail with gh's message
- `git` (for the worktree's commits and push state)
- Pi Pocket 0.19.0 or newer (`conversationRoute`, panels, and `cwd` starts).
  Archiving a removed worktree's sessions and pinning the session's worktree need 0.20.0; an older server leaves those sessions as they are, and lists the worktrees in their plain order.

## Install

Manual:

```sh
cp -r extensions/* ~/.pi-pocket/extensions/
```

Then Menu → Extensions → turn on **Timber**.
The files follow the gallery layout (`timber.ts` + `timber/` browser folder, no `node_modules`), so publishing is Menu → Extensions → **Share…** on the installed drop-in.

## The Extensions sheet

`docs/gallery-entry.json` is the entry for the gallery index: its files with their hashes, and what the module installs.
Its `source.commit` must name a pushed commit that holds these files.

Pi Pocket reads no entry from a repository.
It reads the provenance of an installed drop-in, the sidecar `timber.gallery.json` beside the module, and a sidecar gives the sheet's title and version:

```sh
mise run sidecar
```

The row then reads **Timber**, and its second line says that it came from another index, `nnutter/pi-pocket-timber`, because the default index does not list it.
Installing from an index that lists it shows the author there instead.
Write the sidecar again after the files change: it records their hashes.

## What it adds

- **Timber worktrees page** (rail + launcher), and a panel on a wide screen: search, sort, per-worktree status (Merged / Clean / Dirty), ahead/behind, TODO and review counts.
  Each row's buttons work on that row alone, so several worktrees can push, merge, or open a PR at once.
  The worktree the session works in stays first, marked with an accent stripe, whatever the search and the sort say.
  A row's status is one line: the session button, then the TODO and review counts beside it, then the commit count next to the one action button; a count of zero is left out.
  The button's color says what it will do: periwinkle removes, green merges or acts on a clean worktree, amber is a dirty worktree or checks still running, red is a failed check run or a branch that must be synced first
- **TODOs page** (rail + launcher), and a panel on a wide screen: the tasks of the worktree the session works in, with a picker for another worktree and a toggle for the list that its repository shares with every worktree of that repository.
  A task is added in one field, ticked to done, or removed with two taps; nested tasks stay indented, and done tasks are struck through.
  The items are the Markdown checkboxes of the worktree's `TODO.md`, or of the repository's `TODO.repo.md`: both live in the Git directory, not in the checkout, and `timber todo --path` and `timber todo --repo --path` resolve them.
- **Open**: opens the worktree's session, or starts a plain one in its folder, titled `name@repo`, when the folder has none.
  The session it opens is the newest one in that folder with that title, so opening a worktree again continues the work left in it, and a person's own session in the same folder does not take over the button.
  The worktrees screen goes so that the session shows: the page at any width, and a panel too on a screen too narrow to dock it beside the conversation
  It is not linked to the session whose page it is: a linked session would make that one the root of a team, and a person opens a worktree to work in, not to orchestrate
- **New worktree / Add repository** forms
- **Repositories**: the toolbar's second button lists the registered repositories, with the number of worktrees each one has.
  A row renames its repository in a field (`timber repo rename`), which moves the folders of that repository's worktrees with it, and a repository with no worktrees offers a removal (`timber repo remove`).
  A repository that still has worktrees shows how many instead of a removal, because timber refuses to remove it
- **Delete** (clean worktrees that are merged or fully in sync only, two-tap confirm); the sessions that worked in its folder are archived with it.
  A worktree whose PR is in a stack is deleted only after every PR in the stack has merged
- **Repository link**: the repository name in a row links to its page on GitHub, built from the worktree's `origin` remote; a worktree whose `origin` names no repository keeps the plain name
- **PR link**: each row links its open pull request, right-aligned in the name row.
  The server reads the PR with `gh pr view` in the worktree's folder, so a pull request made in a session or on GitHub appears too, within a minute while the page or panel is open.
  A worktree whose PR is in a stack links each PR on its stack line instead
- **Stacked PRs**: when a worktree's pull request belongs to a GitHub stack, the row lists the stack under its name: the stack's number, linking its page, and each PR's branch, link, and one merge button.
  The button's color says whether that PR can merge: green ready, amber waiting (checks or a draft), red blocked, magenta merged.
  The stack shares one worktree, so its other branches have no worktree actions of their own: a lower PR's button merges the stack up to that PR, and the top PR's button merges the whole stack.
  Merging runs `gh stack merge`, so the chosen PR and every PR below it land together or not at all
- **Action button**: one per row, chosen by what the row needs, and drawn only when it can act.
  A worktree whose PR is in a stack has no merge button of its own: its stack lines carry the merges, and the row keeps the worktree actions (push, delete, create)
  A ready pull request offers its merge; one that cannot merge yet opens the pull request (its title says why not), and both wear the merge glyph; unpushed commits offer a push; a worktree that can be removed offers delete; a row with no PR opens the create form (a subject and body, or an empty form that describes the commits ahead of the branch's upstream, or a `pi`-written draft).
  A merged worktree with uncommitted changes, or one whose git status is unknown, shows no button and says why in a note.
  Creating one does not open a browser tab: the notice names the PR, and the row links it
- **Upload**: when a PR is open and the worktree has unpushed commits over `origin/<branch>` with a fast-forward path, push via explicit `git push origin HEAD:<name>` (works under any `push.default`, never touches upstream, never force).
  Note: timber's own ahead/behind counts against the base branch, so push state is measured directly with git and cached with the PR data
- **Refresh**: lists worktrees and fetches the remotes of the repositories that have worktrees; auto-fetch every 5 minutes so merged branches flip to Merged.
  It then re-reads every row's PR and push state, and answers when that read lands, so a push you made in a terminal turns the row's button into Merge or New PR by the time the spinner stops.
  A read that is already running repeats itself, so no row is drawn from a read that began before your push.
  A merge refreshes its own row at once: it fetches that worktree's repository, which is what lets timber call the branch merged, and re-reads that row, so the row offers Delete as soon as the merge lands.
  The other rows keep the state they had.
- Tools for Pi: `timber_list`, `timber_create`, `timber_pr_create`, `timber_remove`, `timber_repo_add`, `timber_repo_rename`, `timber_repo_remove`, `timber_fetch`, and `timber_start_session`, which starts a session in a worktree's folder, linked to the one that asked
- Rule for Pi: a session whose folder is a managed worktree is told which worktree it works in, and to open its pull request with `timber_pr_create` rather than `gh pr create`.
  Sessions in other folders are told nothing: no worktree means no base branch or push to name.
  Nothing blocks `gh`: a pull request that needs a reviewer, a label, or a stack is still gh's work.

## Safety notes

- Removal runs `timber remove` with no force flag, and only for worktrees that are clean with known status and merged (or 0 ahead / 0 behind).
  A worktree whose PR is in a stack is removed only after every PR in the stack has merged, because the stack's branches share that worktree.
- Removal archives the sessions whose folder is the worktree's, so that no session is left in a folder that is gone.
  The page archives them as the signed-in person; a failure to archive leaves the removal done, and the notice says so.
- A rename reaches a repository whose worktrees timber can plan a move for, and timber rolls a plan that fails partway back itself.
  Its worktree folders move with it, so the sessions that worked in those folders keep the paths they had: the notice says so, and the row's open button starts a new session in the moved folder.
- A removal runs `timber repo remove`, only for a repository with no worktrees; the page draws its button only for one, and the route refuses one that has them, with their names.
- `timber pr create` names the base repository and branch from the branch's upstream, and refuses a branch GitHub does not have, with the push command to run.
  It never pushes, and it never changes the branch's upstream, so the extension removes neither; creating a PR no longer edits git config.
  `timber_pr_create` is the one exception to the missing push: it pushes the worktree's branch to `origin/<branch>` first when origin lacks it or is behind, the way `push.default = current` does, with an explicit refspec that never touches the upstream config and never forces.
- A TODO write changes one line of its file: it appends one `- [ ]` line, rewrites one marker, or drops one line.
  An item is named by its line number and its text, so a file that changed under the panel is refused until the panel reads it again.
- Removing a done task is possible here, although the `timber-todo` skill tells Pi to keep them; every other line of the file stays as it is.
- The module shells out to `timber`, `gh`, and `git` as described above, and reads nothing else off the machine.

## License

MIT — see [LICENSE](LICENSE).

## Tooling

mise + hk, following the go-template baseline adapted for TypeScript:

- `mise run check` — prettier, mdlint, gitleaks, tombi, yamlfmt (CI runs the same)
- `mise run fix` — apply the formatters
- `mise run setup` — install git hooks (secret scan on pre-commit, Change-Id on commit-msg)
