/**
 * Timber worktrees and TODOs: list, create, open sessions in, and safely remove managed Git worktrees, and read and edit the TODO list of a worktree or of its repository, from pages, from panels on a wide screen, and from Pi's tools.
 * Wraps the `timber` CLI on the server (with `gh` to read and merge pull requests): listing, creation, safe removal, periodic fetching so merged branches show as Merged, a fresh read of the row an action changed, open-or-create PR per worktree, the TODO files that `timber todo --path` and `--repo` resolve, and a linked session that Pi starts in a worktree's folder.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { LinkedSessions, Web } from "./_pocket.d.ts";

const execFileAsync = promisify(execFileCb);

// It returns `output`, so it needs version 2 of the extension API.
export const pocketApi = 2;

type Worktree = {
  name: string;
  repo: string;
  path: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  commit: string;
  clean: boolean;
  merged: boolean;
  statusError: boolean;
  todoDone?: number;
  todoTotal?: number;
  pullRequest?: string;
  review?: { approved: number; total: number } | null;
};

type State = {
  repositories: string[];
  worktrees: Worktree[];
  warnings: string[];
  at: number;
  fetchedAt: number | null;
  fetchError: string | null;
  prs: Record<string, PrEntry>;
  prsAt: number | null;
};

// A pass of `timber git @repo -- fetch` over the repositories that have
// worktrees. In-memory only: a reload fetches again.
type FetchRun = { fetchedAt: number; errors: string[] };
let lastFetchAt: number | null = null;
let lastFetchError: string | null = null;
// The pass in flight. A second caller waits for it instead of reporting a fetch
// that did not run: the pass moves the same refs to the same place, so its
// answer is the caller's answer.
let fetching: Promise<FetchRun> | null = null;

// PR and push state per worktree (`repo\0name`), refreshed in
// the background so every state poll doesn't fan out to `gh`. In-memory only.
// NOTE: timber's ahead/behind counts against the worktree's upstream, which is
// usually the base branch - so they measure PR scope, not push state. Push
// state (unpushed vs origin/<branch>) is measured separately here.
type PrEntry = {
  number?: number;
  url?: string;
  destExists: boolean;
  unpushed: number;
  ff: boolean;
  // Why the open PR cannot merge yet, or null when it can. Set only with a PR.
  mergeBlocker?: string | null;
  // What the PR's checks are doing. Set only with a PR.
  checks?: ChecksState;
  // `owner/name` from the worktree's `origin` remote, for its link. Null when
  // the remote does not name one.
  repo?: string | null;
};
let prCache: {
  at: number;
  map: Record<string, PrEntry>;
} | null = null;
let prRefreshing = false;
const PR_CACHE_TTL = 60_000;

// A row after an action changed its worktree: the worktree as timber lists it
// now, and its PR and push state.
type WorktreeState = { worktree: Worktree; pr: PrEntry };

async function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(cmd, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      cwd,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr =
      typeof err.stderr === "string" && err.stderr
        ? err.stderr
        : String(err.message ?? `${cmd} failed`);
    const code = typeof err.code === "number" ? err.code : 1;
    return { stdout, stderr, code };
  }
}

async function runTimber(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("timber", args, {
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const err = error as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
    };
    const stdout = typeof err.stdout === "string" ? err.stdout : "";
    const stderr =
      typeof err.stderr === "string" && err.stderr
        ? err.stderr
        : String(err.message ?? "timber failed");
    const code = typeof err.code === "number" ? err.code : 1;
    return { stdout, stderr, code };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorktree(value: unknown): value is Worktree {
  if (!isRecord(value)) return false;
  if (typeof value["name"] !== "string" || typeof value["repo"] !== "string")
    return false;
  if (typeof value["path"] !== "string") return false;
  if (
    typeof value["clean"] !== "boolean" ||
    typeof value["merged"] !== "boolean"
  )
    return false;
  if (typeof value["statusError"] !== "boolean") return false;
  return true;
}

function cleanName(value: string): string {
  return value.trim();
}

function checkBranchName(value: string, label: string): void {
  const name = cleanName(value);
  if (!name) throw new Error(`${label} is empty`);
  if (name.startsWith("-") || name.startsWith("@") || name.includes("@")) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
  if ([...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new Error(`Invalid ${label}: control characters`);
  }
}

function checkRepoName(value: string): void {
  const name = cleanName(value);
  if (!name) throw new Error("Repository is empty");
  if (name.startsWith("-") || name.startsWith("@") || name.includes("@")) {
    throw new Error(`Invalid repository: ${name}`);
  }
}

// The two timber commands read the same registry and answer apart, so they run
// together: this read backs every state poll, and the pair took 0.8 s when one
// waited for the other.
async function readListing(): Promise<{
  repositories: string[];
  worktrees: Worktree[];
  warnings: string[];
}> {
  const [reposResult, listResult] = await Promise.all([
    runTimber(["repo", "list", "-q"]),
    runTimber(["list", "--json", "--sort", "recency"]),
  ]);
  if (reposResult.code !== 0) {
    throw new Error(`timber repo list failed: ${reposResult.stderr.trim()}`);
  }
  const repositories = reposResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (listResult.code !== 0) {
    throw new Error(`timber list failed: ${listResult.stderr.trim()}`);
  }
  const raw = listResult.stdout.trim();
  const parsed: unknown = raw === "" || raw === "null" ? [] : JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every(isWorktree)) {
    throw new Error("timber list returned an unexpected shape");
  }

  const warnings: string[] = [];
  for (const text of [reposResult.stderr, listResult.stderr]) {
    const t = text.trim();
    if (t) warnings.push(t);
  }
  return { repositories, worktrees: parsed, warnings };
}

function formatWorktree(w: Worktree): string {
  const state = w.merged ? "Merged" : w.clean ? "Clean" : "Dirty";
  const ahead = w.ahead ?? 0;
  const behind = w.behind ?? 0;
  const todo =
    w.todoTotal !== undefined ? ` todo ${w.todoDone ?? 0}/${w.todoTotal}` : "";
  const review = w.review
    ? ` review ${w.review.approved}/${w.review.total}`
    : "";
  const pr = w.pullRequest ? ` PR ${w.pullRequest}` : "";
  return `${w.name}@${w.repo} [${state}] up ${ahead} down ${behind}${todo}${review}${pr} :: ${w.path}`;
}

async function createWorktree(
  repo: string,
  name: string,
  upstream: string,
): Promise<{ worktree: Worktree; warnings: string[] }> {
  checkRepoName(repo);
  const branch = cleanName(name);
  const up = cleanName(upstream);
  if (branch) checkBranchName(branch, "branch name");
  if (up) checkBranchName(up, "upstream");

  const before = await readListing();
  if (!before.repositories.includes(repo)) {
    throw new Error(`Repository is not registered: ${repo}`);
  }
  if (
    branch &&
    before.worktrees.some((w) => w.repo === repo && w.name === branch)
  ) {
    throw new Error(`Worktree already exists: ${branch}@${repo}`);
  }

  const target = branch ? `${branch}@${repo}` : `@${repo}`;
  const argv = ["create", target, "--no-herdr"];
  if (up) argv.push("--upstream", up);
  const result = await runTimber(argv);

  const after = await readListing();
  const oldPaths = new Set(before.worktrees.map((w) => w.path));
  const created = after.worktrees.filter(
    (w) =>
      w.repo === repo &&
      !oldPaths.has(w.path) &&
      (!branch || w.name === branch),
  );
  if (created.length !== 1 || created[0] === undefined) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `Creation not verified; refresh before retrying.${detail ? ` ${detail}` : ""}`,
    );
  }
  const warnings = [...after.warnings];
  if (result.code !== 0 || result.stderr.trim()) {
    const msg = result.stderr.trim() || `timber exited ${result.code}`;
    if (!msg.startsWith("created ")) warnings.push(msg);
  }
  return { worktree: created[0], warnings };
}

async function addRepository(
  source: string,
  name: string,
  alias: string,
): Promise<{ repository: string; warnings: string[] }> {
  const src = source.trim();
  if (!src || src.startsWith("-")) throw new Error("Invalid repository source");
  if ([...src].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    throw new Error("Invalid repository source");
  }
  try {
    const parsed = new URL(src);
    if (parsed.username || parsed.password) {
      throw new Error("Credentials in repository URLs are not allowed");
    }
  } catch {
    // Not a URL (e.g. scp-like `git@github.com:org/repo` or a path): no credential check.
  }

  const before = await readListing();
  const argv = ["repo", "add", src];
  if (cleanName(name)) argv.push("--name", cleanName(name));
  if (cleanName(alias)) argv.push("--alias", cleanName(alias));
  const result = await runTimber(argv);

  const after = await readListing();
  const added = after.repositories.filter(
    (r) => !before.repositories.includes(r),
  );
  if (result.code !== 0 || added.length !== 1 || added[0] === undefined) {
    const detail = result.stderr.trim();
    throw new Error(
      `Repository addition not confirmed cleanly; refresh and inspect before retrying.${detail ? ` ${detail}` : ""}`,
    );
  }
  return { repository: added[0], warnings: after.warnings };
}

// `items` run through `run`, `limit` of them at a time, with the answers in
// the order given. Each `timber git @repo -- fetch` waits on the network, so a
// pass over every repository takes a burst of fetches rather than their sum;
// the limit keeps the burst from reaching every remote at once.
async function mapPool<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const answers = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next;
      next += 1;
      const item = items[at];
      if (at >= items.length || item === undefined) return;
      answers[at] = await run(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return answers;
}

// How many repositories fetch at once.
const FETCH_CONCURRENCY = 4;

async function fetchAllRepos(): Promise<FetchRun> {
  if (fetching) return fetching;
  fetching = runFetch();
  try {
    return await fetching;
  } finally {
    fetching = null;
  }
}

async function runFetch(): Promise<FetchRun> {
  try {
    const listing = await readListing();
    // Only a repository with worktrees can put a row on the page, and the fetch
    // is for those rows: their merged flag compares the branch with the remote.
    // A registered repository that has no worktrees has nothing to show, so it
    // keeps its remote as it is.
    const repos = [...new Set(listing.worktrees.map((w) => w.repo))].sort();
    const answered = await mapPool(repos, FETCH_CONCURRENCY, (repo) =>
      runTimber(["git", `@${repo}`, "--", "fetch"]),
    );
    const errors: string[] = [];
    repos.forEach((repo, at) => {
      const result = answered[at];
      if (!result || result.code === 0 || !result.stderr.trim()) return;
      errors.push(`${repo}: ${result.stderr.trim().split("\n")[0]}`);
    });
    lastFetchAt = Date.now();
    lastFetchError = errors.length > 0 ? errors.join("; ") : null;
    return { fetchedAt: lastFetchAt, errors };
  } catch (error) {
    lastFetchError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

// `pi --print` reads its prompt from stdin when stdin is not a terminal, so it
// must not inherit a pipe that nobody closes: it would wait until the timeout.
function runPi(
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const cap = 2 * 1024 * 1024;
    const keep = (text: string) =>
      text.length > cap ? text.slice(-cap) : text;
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: unknown) => {
      stdout = keep(stdout + String(chunk));
    });
    child.stderr.on("data", (chunk: unknown) => {
      stderr = keep(stderr + String(chunk));
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: error.message, code: 127 });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: signal
          ? `${stderr}${stderr ? " " : ""}stopped by ${signal}`
          : stderr,
        code: code ?? 1,
      });
    });
  });
}

// A draft can take minutes: the CLI reads the repository and writes prose.
const PR_DRAFT_TIMEOUT = 5 * 60_000;

// Purpose-focused guidance, as the audit-commits skill gives it, with the
// output shape that the form needs back.
const PR_DRAFT_PROMPT = [
  "Draft a pull request title and body for the committed changes of this worktree.",
  "Read the repository, the commits against the base branch, and their diff.",
  "Ignore uncommitted changes.",
  "Explain why the change is needed and what it makes possible for the people who use the project, not a list of internal edits. Use plain words, with no unexplained acronyms.",
  "Keep the title on one line of at most 72 characters. Keep the body brief and factual: a short summary, then whatever the reader needs to review or try it. Do not invent tests, results, or links.",
  "If the change cannot be described from the repository, say so instead of guessing.",
  "Do not modify files, commit, push, or create or edit a pull request.",
  'Reply with one JSON object and nothing else: {"title": string, "body": string}. The body is Markdown.',
].join("\n");

// The CLI may wrap its answer in prose or a code fence. Take the first JSON
// object that has both fields, and nothing else.
function parseDraft(stdout: string): { title: string; body: string } | null {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    if (
      isRecord(parsed) &&
      typeof parsed["title"] === "string" &&
      typeof parsed["body"] === "string" &&
      parsed["title"].trim() !== "" &&
      parsed["body"].trim() !== ""
    ) {
      return { title: parsed["title"].trim(), body: parsed["body"].trim() };
    }
  } catch {
    // Not JSON: report no draft.
  }
  return null;
}

// Fields `gh pr view` must return for parsePrView.
const PR_VIEW_FIELDS =
  "number,url,state,isDraft,statusCheckRollup,mergeStateStatus";

// What the pull request's checks are doing: all passed, at least one failed,
// some still to finish (or queued), or none at all. "none" is not "no checks
// ran": a push whose CI has not registered yet reads the same way.
type ChecksState = "passed" | "failed" | "pending" | "none";

type PrView = {
  number: number;
  url: string;
  draft: boolean;
  checks: ChecksState;
  // GitHub's own answer on whether the PR can merge now, in upper case; null
  // when this `gh` does not report it.
  mergeState: string | null;
};

const FAILING_CONCLUSIONS = [
  "FAILURE",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
];

const PASSING_CONCLUSIONS = ["SUCCESS", "NEUTRAL", "SKIPPED"];

function checkPassed(check: unknown): boolean {
  if (!isRecord(check)) return false;
  if (check["__typename"] === "StatusContext") {
    return check["state"] === "SUCCESS";
  }
  return (
    check["status"] === "COMPLETED" &&
    typeof check["conclusion"] === "string" &&
    PASSING_CONCLUSIONS.includes(check["conclusion"])
  );
}

// The state of a pull request's `statusCheckRollup`.
function checksState(checks: unknown): ChecksState {
  if (!Array.isArray(checks) || checks.length === 0) return "none";
  if (checks.some(checkFailed)) return "failed";
  if (checks.every(checkPassed)) return "passed";
  return "pending";
}

function checkFailed(check: unknown): boolean {
  if (!isRecord(check)) return false;
  if (check["__typename"] === "StatusContext") {
    return check["state"] === "FAILURE" || check["state"] === "ERROR";
  }
  return (
    typeof check["conclusion"] === "string" &&
    FAILING_CONCLUSIONS.includes(check["conclusion"])
  );
}

// The open PR in `gh pr view` output, or null when there is none or the
// output is unreadable.
function parsePrView(stdout: string): PrView | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (
      isRecord(parsed) &&
      parsed["state"] === "OPEN" &&
      typeof parsed["url"] === "string" &&
      typeof parsed["number"] === "number"
    ) {
      const checks = parsed["statusCheckRollup"];
      const mergeState = parsed["mergeStateStatus"];
      return {
        number: parsed["number"],
        url: parsed["url"],
        draft: parsed["isDraft"] === true,
        checks: checksState(checks),
        mergeState:
          typeof mergeState === "string" ? mergeState.toUpperCase() : null,
      };
    }
  } catch {
    // No PR (or unreadable output): treated as none.
  }
  return null;
}

type PushInfo = { destExists: boolean; unpushed: number; ff: boolean };

// What GitHub says stands in the way of a merge, or null when it reports
// nothing in the way. Its own read is the only one that can tell a repository
// without CI from a push whose CI has not started: both have an empty check
// rollup, and only GitHub knows whether checks are expected.
function mergeStateBlocker(pr: PrView): string | null {
  switch (pr.mergeState) {
    case null:
    case "CLEAN":
    case "HAS_HOOKS":
    // A failing check, which GitHub lets a merge through: the check state below
    // refuses it with the reason that names the checks.
    case "UNSTABLE":
      return null;
    case "DRAFT":
      return "PR is a draft";
    case "DIRTY":
      return "The PR has conflicts with its base branch";
    case "BEHIND":
      return "The base branch has commits the PR lacks";
    case "BLOCKED":
      // A check still running reads the same as a review not yet given; only
      // the check state can say which one it is.
      return pr.checks === "failed" || pr.checks === "pending"
        ? "Checks have not all passed"
        : "GitHub blocks the merge: a required check or review is missing, or a thread is unresolved";
    default:
      // UNKNOWN, or a state this module does not know: GitHub has not finished
      // reading the PR, so a merge now can still be refused.
      return "GitHub has not finished reading the PR's merge state";
  }
}

// Why an open PR cannot merge yet, or null when it can. The panel shows this
// reason and the merge route enforces it.
function mergeBlocker(pr: PrView, push: PushInfo): string | null {
  if (pr.draft) return "PR is a draft";
  if (!push.destExists) return "Branch is not pushed";
  if (!push.ff) return "origin has commits this branch lacks";
  if (push.unpushed > 0) return "Local has unpushed commits";
  const stateBlocker = mergeStateBlocker(pr);
  if (stateBlocker) return stateBlocker;
  // Checks that do not exist are not checks that failed: a repository without
  // CI merges straight away, and where required checks exist but have not
  // started, GitHub itself refuses the merge.
  if (pr.checks === "failed" || pr.checks === "pending") {
    return "Checks have not all passed";
  }
  return null;
}

// Push state for one worktree, measured against origin/<branch> - the PR
// head and push destination - never against the base-branch upstream that
// timber's ahead/behind counts use. All reads are local and fail closed.
async function pushInfo(
  cwd: string,
  name: string,
): Promise<{ destExists: boolean; unpushed: number; ff: boolean }> {
  const dest = `origin/${name}`;
  const verify = await runCmd(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${dest}`],
    cwd,
  );
  const destExists = verify.code === 0;
  let unpushed = 0;
  const count = await runCmd(
    "git",
    ["rev-list", "--count", `${destExists ? dest : "@{u}"}..HEAD`],
    cwd,
  );
  if (count.code === 0) {
    const n = parseInt(count.stdout.trim(), 10);
    if (Number.isFinite(n) && n >= 0) unpushed = n;
  }
  if (!destExists) return { destExists, unpushed, ff: true };
  const base = await runCmd(
    "git",
    ["merge-base", "--is-ancestor", dest, "HEAD"],
    cwd,
  );
  return { destExists, unpushed, ff: base.code === 0 };
}

// The cache entry for a worktree that has an open PR.
function prEntry(pr: PrView, push: PushInfo): PrEntry {
  return {
    number: pr.number,
    url: pr.url,
    checks: pr.checks,
    destExists: push.destExists,
    unpushed: push.unpushed,
    ff: push.ff,
    mergeBlocker: mergeBlocker(pr, push),
  };
}

// The open PR and push state of one worktree, read in the worktree's folder,
// with the key that the PR cache and the rows use.
async function readPushAndPr(w: Worktree): Promise<{
  key: string;
  pr: PrView | null;
  push: PushInfo;
  repo: string | null;
}> {
  const key = `${w.repo}\0${w.name}`;
  const [viewed, push, remote] = await Promise.all([
    runCmd("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], w.path),
    pushInfo(w.path, w.name),
    runCmd("git", ["remote", "get-url", "origin"], w.path),
  ]);
  return {
    key,
    pr: viewed.code === 0 ? parsePrView(viewed.stdout) : null,
    push,
    repo: remote.code === 0 ? repoFromRemoteUrl(remote.stdout) : null,
  };
}

// A row's state after something changed its worktree: the worktree as timber
// lists it now, and its PR and push state. Only this row is read, and its cached
// entry is dropped first, so a read that fails cannot leave an entry that the
// action has just made wrong.
async function refreshWorktreeState(
  repo: string,
  name: string,
): Promise<WorktreeState | null> {
  const key = `${repo}\0${name}`;
  if (prCache) {
    const map = { ...prCache.map };
    delete map[key];
    prCache = { at: prCache.at, map };
  }
  const listing = await readListing();
  const found = listing.worktrees.find(
    (w) => w.repo === repo && w.name === name,
  );
  if (!found) return null;
  const { pr, push, repo: origin } = await readPushAndPr(found);
  const entry: PrEntry = { ...(pr ? prEntry(pr, push) : push), repo: origin };
  prCache = { at: Date.now(), map: { ...(prCache?.map ?? {}), [key]: entry } };
  return { worktree: found, pr: entry };
}

// `owner/name` from a git remote URL: ssh, scp-like, or https. Null when the
// URL names no repository on GitHub.
function repoFromRemoteUrl(url: string): string | null {
  const text = url.trim().replace(/\.git$/, "");
  const scp = /^[^@/]+@[^:/]+:(.+)$/.exec(text);
  const path = scp ? scp[1] : /^(?:[a-z+]+:\/\/)?[^/]+\/(.+)$/i.exec(text)?.[1];
  if (!path) return null;
  const parts = path.split("/").filter((part) => part !== "");
  if (parts.length < 2) return null;
  const [owner, repo] = parts.slice(-2);
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

// The branch checked out in a worktree. `gh pr view --repo` needs one, since
// with --repo it cannot infer the pull request from the folder alone.
async function currentBranch(cwd: string): Promise<string> {
  const result = await runCmd(
    "git",
    ["rev-parse", "--abbrev-ref", "HEAD"],
    cwd,
  );
  const name = result.stdout.trim();
  if (result.code !== 0 || name === "" || name === "HEAD") {
    throw new Error(`No branch is checked out in ${cwd}.`);
  }
  return name;
}

// The pull request `timber pr create` prints, as a URL.
function prFromCreateOutput(
  stdout: string,
): { url: string; number: number } | null {
  const found = /https:\/\/[^\s]+\/pull\/(\d+)/.exec(stdout);
  if (!found) return null;
  return { url: found[0], number: Number(found[1]) };
}

// Where a pull request for this worktree goes: the repository of its upstream's
// remote, and the upstream branch. gh otherwise picks the base branch, and for
// a fork it can pick the fork's source instead of the remote this branch tracks.
async function prTarget(
  cwd: string,
  name: string,
): Promise<{ repo: string; base: string; remote: string }> {
  const up = await runCmd(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    cwd,
  );
  let remote = "";
  let base = "";
  if (up.code === 0 && up.stdout.trim().includes("/")) {
    const upstream = up.stdout.trim();
    remote = upstream.slice(0, upstream.indexOf("/"));
    base = upstream.slice(upstream.indexOf("/") + 1);
  } else {
    // No upstream yet: use the remote head of `origin`, when git knows it.
    const head = await runCmd(
      "git",
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd,
    );
    if (head.code !== 0 || !head.stdout.trim().startsWith("origin/")) {
      throw new Error(
        `No upstream for ${name}, so the pull request's repository and base branch are unknown. Set one with: git branch --set-upstream-to=origin/<branch>`,
      );
    }
    remote = "origin";
    base = head.stdout.trim().slice("origin/".length);
  }
  const url = await runCmd("git", ["remote", "get-url", remote], cwd);
  if (url.code !== 0) {
    throw new Error(`No remote named ${remote} in ${cwd}.`);
  }
  const repo = repoFromRemoteUrl(url.stdout);
  if (!repo) {
    throw new Error(
      `The ${remote} remote is not a GitHub repository: ${url.stdout.trim()}`,
    );
  }
  return { repo, base, remote };
}

// timber styles its reports for a terminal, so its stderr arrives as a box
// with wrapped lines. Join them back into one message.
function timberMessage(stderr: string): string {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line !== "ERROR" && line !== "STATUS")
    .reduce(
      (text, line) =>
        text === ""
          ? line
          : text.endsWith("-")
            ? text + line
            : `${text} ${line}`,
      "",
    );
}

// A title and body for an empty form, from the commits the pull request would
// carry, the way `gh pr create --fill` derives them: one commit describes
// itself, and several title the pull request with the branch's name and list
// their subjects. The upstream names the base branch, so these are the PR's
// commits.
async function fillDraft(
  cwd: string,
  name: string,
): Promise<{ title: string; body: string }> {
  const log = await runCmd(
    "git",
    ["log", "--reverse", "--format=%s%x1f%b%x1e", "@{u}..HEAD"],
    cwd,
  );
  if (log.code !== 0) {
    throw new Error(
      `No upstream for ${name}, so an empty form has no commits to describe. Type a subject, or set one with: git branch --set-upstream-to=origin/<branch>`,
    );
  }
  const commits = log.stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.trim() !== "")
    .map((record) => {
      const [subject = "", body = ""] = record.split("\x1f");
      return { subject: subject.trim(), body: body.trim() };
    });
  const newest = commits[commits.length - 1];
  if (!newest) {
    throw new Error(
      `No commits in ${name} that its upstream lacks, so an empty form has nothing to describe. Type a subject.`,
    );
  }
  if (commits.length === 1) {
    return { title: newest.subject, body: newest.body };
  }
  return {
    title: name.replace(/[-_]/g, " "),
    body: commits.map((commit) => `- **${commit.subject}**`).join("\n"),
  };
}

// The pull request for a worktree, created when none is open. `timber pr
// create` names the base repository and branch from the branch's upstream,
// refuses a branch GitHub does not have, and never pushes or changes the
// upstream.
async function openOrCreatePr(
  repo: string,
  name: string,
  title: string,
  body: string,
): Promise<{ url: string; number: number; created: boolean }> {
  checkRepoName(repo);
  checkBranchName(name, "worktree name");

  const listing = await readListing();
  const found = listing.worktrees.find(
    (w) => w.repo === repo && w.name === name,
  );
  if (!found) throw new Error(`Worktree not found: ${name}@${repo}`);
  const cwd = found.path;

  if (!title.trim() && body.trim()) {
    throw new Error("A PR subject is required when a body is provided.");
  }
  const draft = title.trim() ? { title, body } : await fillDraft(cwd, name);

  const created = await runTimber([
    "pr",
    "create",
    `${name}@${repo}`,
    "--title",
    draft.title,
    ...(draft.body.trim() ? ["--body", draft.body] : []),
  ]);
  const printed = prFromCreateOutput(created.stdout);
  if (created.code === 0 && printed) return { ...printed, created: true };
  if (created.code === 0) {
    throw new Error(
      "PR create reported success but printed no pull request; refresh and inspect before retrying.",
    );
  }

  const message =
    timberMessage(created.stderr) ||
    `timber pr create failed (exit ${created.code})`;
  // The row said no pull request was open, but one may have been opened since.
  // timber refuses a second one, so open the one that exists.
  if (/already exists/i.test(message)) {
    const viewed = await runCmd(
      "gh",
      ["pr", "view", "--json", "number,url,state"],
      cwd,
    );
    const opened = viewed.code === 0 ? parsePrView(viewed.stdout) : null;
    if (opened) {
      return { url: opened.url, number: opened.number, created: false };
    }
  }
  throw new Error(message);
}

async function removeWorktree(
  repo: string,
  name: string,
): Promise<{ removed: string }> {
  checkRepoName(repo);
  checkBranchName(name, "worktree name");

  const listing = await readListing();
  const found = listing.worktrees.find(
    (w) => w.repo === repo && w.name === name,
  );
  if (!found) throw new Error(`Worktree not found: ${name}@${repo}`);
  if (listing.warnings.length > 0) {
    throw new Error(
      "Listing reported diagnostics; refusing a destructive operation",
    );
  }
  const synced = (found.ahead ?? 0) === 0 && (found.behind ?? 0) === 0;
  if (found.statusError || !found.clean || (!found.merged && !synced)) {
    throw new Error(
      "Removal requires a clean worktree that is merged or fully in sync (0 ahead, 0 behind) with known status",
    );
  }

  const result = await runTimber(["remove", `${name}@${repo}`]);
  const after = await readListing();
  const stillThere = after.worktrees.some(
    (w) => w.path === found.path || (w.repo === repo && w.name === name),
  );
  if (stillThere || result.code !== 0) {
    const errText = result.stderr.trim();
    const friendly = errText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .find((line) => /not merged/i.test(line));
    if (friendly) throw new Error(friendly);
    if (stillThere) {
      throw new Error(
        `Removal not verified; no force retry.${errText ? ` ${errText}` : ""}`,
      );
    }
    throw new Error(`timber remove failed: ${errText}`);
  }
  return { removed: `${name}@${repo}` };
}

// Which list a worktree has: its own, or the one that its repository shares
// with every worktree of that repository.
type TodoScope = "worktree" | "repo";

function isTodoScope(value: unknown): value is TodoScope {
  return value === "worktree" || value === "repo";
}

// One Markdown checkbox of a TODO list. `id` is its 1-based line number in the
// file, and `depth` is how far it nests under the items above it.
type TodoItem = {
  id: number;
  title: string;
  complete: boolean;
  depth: number;
};

type TodoList = {
  scope: TodoScope;
  summary: { incomplete: number; complete: number };
  todos: TodoItem[];
};

// The arguments that name one TODO list: the positional worktree selector,
// and the flag for the repository's shared list. `timber todo` resolves both
// the worktree and the file, so nothing here guesses a path.
function todoArgs(repo: string, name: string, scope: TodoScope): string[] {
  checkRepoName(repo);
  checkBranchName(name, "worktree name");
  const argv = ["todo", `${name}@${repo}`];
  if (scope === "repo") argv.push("--repo");
  return argv;
}

// What timber says when it fails: its error panel is several lines of padding
// around one sentence, so the lines become one.
function cliMessage(
  result: { stdout: string; stderr: string; code: number },
  fallback: string,
): string {
  const text = [result.stderr, result.stdout]
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" ");
  const one = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  return (one || fallback).slice(0, 400);
}

// The error of a `timber todo` call. A repository list needs timber 0.22.0,
// which added `--repo`: an older timber answers with an unknown flag, and that
// is worth naming, because the person can install the newer one.
function todoFailure(
  result: { stdout: string; stderr: string; code: number },
  fallback: string,
): Error {
  const message = cliMessage(result, fallback);
  if (/unknown flag/i.test(message) && /repo/i.test(message)) {
    return new Error(
      "Repository TODOs need timber 0.22.0 or newer; upgrade timber, then refresh.",
    );
  }
  return new Error(message);
}

// The `timber todo --json` document, with each item's depth resolved from the
// id of the item that it nests under.
function parseTodoList(scope: TodoScope, stdout: string): TodoList {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("timber todo --json printed no JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed["todos"])) {
    throw new Error("timber todo --json returned an unexpected shape");
  }
  const counts = isRecord(parsed["summary"]) ? parsed["summary"] : {};
  const summary = {
    incomplete:
      typeof counts["incomplete"] === "number" ? counts["incomplete"] : 0,
    complete: typeof counts["complete"] === "number" ? counts["complete"] : 0,
  };
  // An item nests under the nearest earlier item with less indentation, so
  // its depth is one more than its parent's. Parents come first in the file.
  const depths = new Map<number, number>();
  const todos: TodoItem[] = [];
  for (const entry of parsed["todos"]) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    const title = entry["title"];
    if (typeof id !== "number" || typeof title !== "string") continue;
    const parent = entry["depends_on"];
    const depth =
      typeof parent !== "number"
        ? 0
        : Math.min((depths.get(parent) ?? 0) + 1, 8);
    depths.set(id, depth);
    todos.push({ id, title, complete: entry["complete"] === true, depth });
  }
  return { scope, summary, todos };
}

// One worktree's TODO list, or its repository's, as timber reads it.
async function readTodoList(
  repo: string,
  name: string,
  scope: TodoScope,
): Promise<TodoList> {
  const result = await runTimber([...todoArgs(repo, name, scope), "--json"]);
  if (result.code !== 0) {
    throw todoFailure(result, `timber todo failed (exit ${result.code})`);
  }
  return parseTodoList(scope, result.stdout);
}

// The scope that a request asked for. Anything else is the caller's mistake,
// not a list that this module can pick.
function todoScopeOf(value: unknown): TodoScope {
  if (!isTodoScope(value)) {
    throw new Error("Invalid scope: use worktree or repo.");
  }
  return value;
}

// One item's text, as a person typed it: one line, and not empty. A newline
// would end the item and start a line that is not a checkbox.
function checkTodoTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (title === "") throw new Error("Invalid TODO: the text is empty.");
  if (title.length > 500) {
    throw new Error("Invalid TODO: the text is longer than 500 characters.");
  }
  const control = [...title].some((c) => {
    const code = c.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (control)
    throw new Error("Invalid TODO: the text has control characters.");
  return title;
}

// The line number and the text that name one item that is already in the
// file. The title is what the panel read there, so a write can tell that the
// line still holds that item.
function todoTarget(body: Record<string, unknown>): {
  id: number;
  title: string;
} {
  const id = body["id"];
  const title = body["title"];
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
    throw new Error("Invalid TODO: the line is unknown.");
  }
  if (typeof title !== "string") {
    throw new Error("Invalid TODO: the text is unknown.");
  }
  return { id, title };
}

// One checkbox line of a TODO file, by the rules that timber counts items
// with: a `- ` bullet, then `[ ]`, `[x]`, or `[X]`.
function parseCheckboxLine(
  line: string,
): { complete: boolean; title: string } | null {
  const item = line.trim();
  if (!item.startsWith("- ")) return null;
  const rest = item.slice(2);
  if (rest.startsWith("[ ]")) {
    return { complete: false, title: rest.slice(3).trim() };
  }
  if (rest.startsWith("[x]") || rest.startsWith("[X]")) {
    return { complete: true, title: rest.slice(3).trim() };
  }
  return null;
}

// The line of the item with this id, when it still holds the title that the
// panel read. A file that changed since then is reported, not guessed at: the
// ids are line numbers, and a line that moved would change the wrong item.
function todoLineAt(lines: string[], id: number, title: string): number {
  const at = id - 1;
  const line = at >= 0 && at < lines.length ? lines[at] : undefined;
  const parsed = typeof line === "string" ? parseCheckboxLine(line) : null;
  if (parsed === null || parsed.title !== title) {
    throw new Error("The TODO list changed; it is refreshed, so try again.");
  }
  return at;
}

// The file of one TODO list. A write needs it, and only timber resolves it:
// the path of a worktree's list is not its checkout's.
async function todoPath(
  repo: string,
  name: string,
  scope: TodoScope,
): Promise<string> {
  const result = await runTimber([...todoArgs(repo, name, scope), "--path"]);
  const path = result.stdout.trim();
  if (result.code !== 0 || path === "") {
    throw todoFailure(
      result,
      `timber todo --path failed (exit ${result.code})`,
    );
  }
  return path;
}

// Read the list, change the lines that hold its items, and write it back. The
// read and the write share one turn, so two taps cannot land on a file that
// one of them has already moved.
function editTodoFile(path: string, edit: (lines: string[]) => void): void {
  const lines = readFileSync(path, "utf8").split("\n");
  edit(lines);
  writeFileSync(path, lines.join("\n"), "utf8");
}

// Append one open item after the list's last item, before any blank lines
// that follow it.
function addTodoLine(path: string, title: string): void {
  editTodoFile(path, (lines) => {
    let at = lines.length;
    while (at > 0 && (lines[at - 1] ?? "").trim() === "") at -= 1;
    lines.splice(at, 0, `- [ ] ${title}`);
  });
}

// Mark one item done or open, keeping the rest of its line as it is.
function toggleTodoLine(
  path: string,
  id: number,
  title: string,
  complete: boolean,
): void {
  editTodoFile(path, (lines) => {
    const at = todoLineAt(lines, id, title);
    lines[at] = (lines[at] ?? "").replace(
      /^(\s*-\s+)\[[ xX]\]/,
      (_whole, lead: string) => `${lead}[${complete ? "x" : " "}]`,
    );
  });
}

// Drop one item's line. The file keeps every other line, including items that
// are already done.
function removeTodoLine(path: string, id: number, title: string): void {
  editTodoFile(path, (lines) => {
    lines.splice(todoLineAt(lines, id, title), 1);
  });
}

// One change to a list, then the list as timber reads it afterwards, so the
// panel shows what the file now holds.
async function editTodoList(
  repo: string,
  name: string,
  scope: TodoScope,
  edit: (path: string) => void,
): Promise<TodoList> {
  const path = await todoPath(repo, name, scope);
  edit(path);
  return readTodoList(repo, name, scope);
}

const timberList = defineTool({
  name: "timber_list",
  description:
    "List Timber-managed Git worktrees (branch, repo, clean/merged, ahead/behind).",
  parameters: Type.Object({
    repo: Type.Optional(
      Type.String({
        description: "Only this registered repo, e.g. nnutter/timber",
      }),
    ),
    search: Type.Optional(
      Type.String({ description: "Substring filter over name@repo and path" }),
    ),
  }),
  replay: "safe",
  execute: async (args) => {
    const listing = await readListing();
    const needle = (args.search ?? "").trim().toLowerCase();
    const rows = listing.worktrees.filter((w) => {
      if (args.repo && w.repo !== args.repo) return false;
      if (!needle) return true;
      return `${w.name}@${w.repo} ${w.path}`.toLowerCase().includes(needle);
    });
    const lines = rows.map(formatWorktree);
    const head = `${rows.length} of ${listing.worktrees.length} worktrees`;
    const tail =
      listing.warnings.length > 0
        ? `\nwarnings:\n${listing.warnings.join("\n")}`
        : "";
    return {
      output: [
        { type: "text" as const, text: `${head}\n${lines.join("\n")}${tail}` },
      ],
    };
  },
});

const timberCreate = defineTool({
  name: "timber_create",
  description:
    "Create a Timber worktree in a registered repo. Leave name empty to let Timber choose.",
  parameters: Type.Object({
    repo: Type.String({ description: "Registered repo, e.g. nnutter/timber" }),
    name: Type.Optional(
      Type.String({ description: "Branch/worktree name (optional)" }),
    ),
    upstream: Type.Optional(
      Type.String({ description: "Upstream branch (optional)" }),
    ),
  }),
  execute: async (args) => {
    const created = await createWorktree(
      args.repo,
      args.name ?? "",
      args.upstream ?? "",
    );
    return {
      output: [
        {
          type: "text" as const,
          text: `Created ${formatWorktree(created.worktree)}${created.warnings.length ? `\nwarnings: ${created.warnings.join("\n")}` : ""}`,
        },
      ],
    };
  },
});

const timberRemove = defineTool({
  name: "timber_remove",
  description:
    "Remove a clean, merged Timber worktree (checkout and local branch). Refuses dirty or unmerged worktrees.",
  parameters: Type.Object({
    repo: Type.String({ description: "Registered repo, e.g. nnutter/timber" }),
    name: Type.String({ description: "Worktree/branch name" }),
  }),
  execute: async (args) => {
    const removed = await removeWorktree(args.repo, args.name);
    return {
      output: [{ type: "text" as const, text: `Removed ${removed.removed}` }],
    };
  },
});

const timberRepoAdd = defineTool({
  name: "timber_repo_add",
  description:
    "Register a bare repository with Timber from a remote URL or local path.",
  parameters: Type.Object({
    source: Type.String({ description: "Remote URL or local path" }),
    name: Type.Optional(
      Type.String({ description: "Repository name (optional)" }),
    ),
    alias: Type.Optional(
      Type.String({ description: "Display alias (optional)" }),
    ),
  }),
  execute: async (args) => {
    const added = await addRepository(
      args.source,
      args.name ?? "",
      args.alias ?? "",
    );
    return {
      output: [
        {
          type: "text" as const,
          text: `Added repository ${added.repository}${added.warnings.length ? `\nwarnings: ${added.warnings.join("\n")}` : ""}`,
        },
      ],
    };
  },
});

const timberFetch = defineTool({
  name: "timber_fetch",
  description:
    "Fetch the remotes of the Timber repositories that have worktrees, so merged PRs show as Merged (timber git @repo -- fetch).",
  parameters: Type.Object({}),
  replay: "safe",
  execute: async () => {
    const result = await fetchAllRepos();
    return {
      output: [
        {
          type: "text" as const,
          text: `Fetched remotes at ${new Date(result.fetchedAt).toLocaleTimeString()}${result.errors.length ? ` with errors: ${result.errors.join("; ")}` : ""}`,
        },
      ],
    };
  },
});

export default function createTimber(host: unknown, web: Web) {
  const allowedModels = (): string[] => {
    try {
      const h = host as { subagentModels?: () => unknown };
      const list =
        typeof h.subagentModels === "function" ? h.subagentModels() : [];
      return Array.isArray(list)
        ? list.filter((m): m is string => typeof m === "string")
        : [];
    } catch {
      return [];
    }
  };

  // A session in a worktree's folder, linked to this one, so that Pi can send it
  // the next message and read what it sends back. The page's Open button starts
  // a plain session instead: a person opens a worktree to work in, not to
  // orchestrate. Nothing creates a worktree here: `timber_create` does that.
  const timberStartSession = defineTool({
    name: "timber_start_session",
    description:
      "Start a session in a Timber worktree's folder, linked to this session, with its first message. Refuses a worktree that does not exist: use timber_create first.",
    parameters: Type.Object({
      name: Type.String({ description: "Worktree/branch name" }),
      message: Type.String({
        description:
          "The new session's first message: everything that it needs, since it does not see this conversation",
      }),
      repo: Type.Optional(
        Type.String({
          description:
            "Registered repo, e.g. nnutter/timber; needed when two repos have a worktree of that name",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Its title; the default is name@repo" }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "provider/modelId, one of the models the owner allows for subagents; left out, this session's model",
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description:
            "A thinking level (off, minimal, low, medium, high, xhigh, max); left out, this session's level",
        }),
      ),
    }),
    // A start carries the call's own key, so a replay finds the session of the
    // first run instead of starting a second one.
    replay: "safe",
    execute: async (args, api) => {
      const reply = (said: string) => ({
        output: [{ type: "text" as const, text: said }],
      });

      const name = args.name.trim();
      if (name === "") {
        throw new Error("timber_start_session needs a worktree name.");
      }
      const message = args.message.trim();
      if (message === "") {
        throw new Error("timber_start_session needs a first message.");
      }

      const linked = (host as { linkedSessions?: LinkedSessions })
        .linkedSessions;
      if (linked === undefined) {
        throw new Error(
          "This Pi Pocket cannot start a linked session. Ask the owner to restart the server.",
        );
      }

      const listing = await readListing();
      const named = listing.worktrees.filter(
        (worktree) =>
          worktree.name === name && (!args.repo || worktree.repo === args.repo),
      );
      if (named.length !== 1) {
        throw new Error(
          named.length === 0
            ? `No worktree is named ${name}${args.repo ? ` in ${args.repo}` : ""}. Look one up with timber_list, or make it with timber_create.`
            : `${named.length} worktrees are named ${name}: ${named.map((worktree) => `${worktree.name}@${worktree.repo}`).join(", ")}. Pass repo.`,
        );
      }
      const worktree = named[0] as Worktree;

      // The owner's list of models for subagents is the only choice while it
      // has any, so name them here: the refusal from the start names no rule.
      const allowed = allowedModels();
      if (
        args.model !== undefined &&
        allowed.length > 0 &&
        !allowed.includes(args.model)
      ) {
        throw new Error(
          `The owner allows these models: ${allowed.join(", ")}. Pass one of them as model.`,
        );
      }

      let address: string;
      try {
        ({ address } = await linked.start(
          api.conversationId,
          {
            title:
              (args.title ?? "").trim() || `${worktree.name}@${worktree.repo}`,
            message,
            model: args.model,
            thinking: args.thinking,
            cwd: worktree.path,
          },
          `${api.taskId}:${api.callId}`,
        ));
      } catch (error) {
        // Pi Pocket says what went wrong; what Pi can do about it is this
        // tool's to say.
        const why = error instanceof Error ? error.message : String(error);
        const status = (error as { status?: unknown } | null)?.status;
        throw new Error(
          status === 413
            ? `${why} Send a shorter first message.`
            : // The fix is Pi's: a model from the owner's list.
              (error as { choose?: unknown } | null)?.choose === true
              ? why
              : `${why} Do not look for a way around it: stop and tell the person.`,
        );
      }

      return reply(
        `Started a linked session in ${worktree.name}@${worktree.repo} (${worktree.path}) as ${address}. It does not see this conversation: its first message is all it has. Send to that address for more, and ask it to send back what it finds, once.`,
      );
    },
  });

  // Refresh the open-PR cache in the background and tell tabs to re-read
  // state when it lands. Stale-while-revalidate: state serves the cache
  // immediately and only one refresh runs at a time.
  const refreshPrCache = async (worktrees: Worktree[]): Promise<void> => {
    if (prRefreshing) return;
    prRefreshing = true;
    try {
      const entries = await Promise.all(
        worktrees.map(async (w) => {
          const { key, pr, push, repo } = await readPushAndPr(w);
          return [key, { ...(pr ? prEntry(pr, push) : push), repo }] as const;
        }),
      );
      const map: Record<string, PrEntry> = {};
      for (const [key, entry] of entries) map[key] = entry;
      prCache = { at: Date.now(), map };
      try {
        web.send("fetched", { at: prCache.at });
      } catch {
        // Tabs may be gone; the next poll picks up the fresh listing.
      }
    } finally {
      prRefreshing = false;
    }
  };

  web.route("GET", "state", async (): Promise<State & { models: string[] }> => {
    try {
      const listing = await readListing();
      if (!prCache || Date.now() - prCache.at > PR_CACHE_TTL) {
        void refreshPrCache(listing.worktrees);
      }
      return {
        ...listing,
        at: Date.now(),
        fetchedAt: lastFetchAt,
        fetchError: lastFetchError,
        models: allowedModels(),
        prs: prCache?.map ?? {},
        prsAt: prCache?.at ?? null,
      };
    } catch (error) {
      throw web.error(
        502,
        error instanceof Error ? error.message : "timber failed",
      );
    }
  });

  web.route(
    "POST",
    "fetch",
    async (): Promise<{ fetchedAt: number; errors: string[] }> => {
      try {
        const result = await fetchAllRepos();
        try {
          web.send("fetched", { at: result.fetchedAt });
        } catch {
          // Tabs may be gone; the next poll picks up the fresh listing.
        }
        return result;
      } catch (error) {
        throw web.error(
          502,
          error instanceof Error ? error.message : "fetch failed",
        );
      }
    },
  );

  web.route(
    "POST",
    "create",
    async ({ body }): Promise<{ worktree: Worktree; warnings: string[] }> => {
      try {
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        const upstream =
          typeof body["upstream"] === "string" ? body["upstream"] : "";
        return await createWorktree(repo, name, upstream);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "create failed";
        if (message.includes("not registered") || message.includes("Invalid")) {
          throw web.error(422, message);
        }
        if (message.includes("already exists")) throw web.error(409, message);
        throw web.error(502, message);
      }
    },
  );

  web.route(
    "POST",
    "repositories",
    async ({ body }): Promise<{ repository: string; warnings: string[] }> => {
      try {
        const source = typeof body["source"] === "string" ? body["source"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        const alias = typeof body["alias"] === "string" ? body["alias"] : "";
        return await addRepository(source, name, alias);
      } catch (error) {
        const message = error instanceof Error ? error.message : "add failed";
        if (message.includes("Invalid") || message.includes("Credentials")) {
          throw web.error(422, message);
        }
        throw web.error(502, message);
      }
    },
  );

  web.route(
    "POST",
    "pr",
    async ({
      body,
    }): Promise<{
      url: string;
      number: number;
      created: boolean;
    }> => {
      try {
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        const title = typeof body["title"] === "string" ? body["title"] : "";
        const prBody = typeof body["body"] === "string" ? body["body"] : "";
        const result = await openOrCreatePr(repo, name, title, prBody);
        // Warm the PR cache so the row can show the PR without waiting for the
        // next background refresh. This is the refresh's own read, so the entry
        // holds the real draft and check state; the pull request exists, so the
        // read finds it.
        try {
          await refreshWorktreeState(repo, name);
          try {
            web.send("fetched", { at: Date.now() });
          } catch {
            // Tabs may be gone; the next poll picks up the listing.
          }
        } catch {
          // Warming is best-effort; the background refresh covers it.
        }
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "pr failed";
        if (message.includes("not found")) throw web.error(404, message);
        throw web.error(502, message);
      }
    },
  );

  web.route("POST", "push", async ({ body }): Promise<{ pushed: boolean }> => {
    try {
      const repo = typeof body["repo"] === "string" ? body["repo"] : "";
      const name = typeof body["name"] === "string" ? body["name"] : "";
      checkRepoName(repo);
      checkBranchName(name, "worktree name");
      const listing = await readListing();
      const found = listing.worktrees.find(
        (w) => w.repo === repo && w.name === name,
      );
      if (!found) throw web.error(404, `Worktree not found: ${name}@${repo}`);
      if (found.statusError) {
        throw web.error(409, "Git status unknown; refresh and inspect first");
      }
      // Re-verify everything fresh: the panel's counts may be stale, and
      // timber's ahead/behind counts against the base-branch upstream, not
      // the push destination, so push state is measured directly with git.
      const push = await pushInfo(found.path, name);
      if (push.unpushed === 0) {
        throw web.error(409, `Nothing to push for ${name}@${repo}`);
      }
      if (!push.ff) {
        throw web.error(
          409,
          `${name}@${repo} is not a fast-forward over origin/${name}; fetch first`,
        );
      }
      // Explicit refspec: works under any push.default, never touches the
      // upstream config. Plain push already refuses non-fast-forwards, so a
      // remote that moved since the check fails atomically instead of pushing.
      const pushed = await runCmd(
        "git",
        ["push", "origin", `HEAD:${name}`],
        found.path,
        180_000,
      );
      if (pushed.code !== 0) {
        throw new Error(
          pushed.stderr.trim() || `git push failed (exit ${pushed.code})`,
        );
      }
      prCache = null;
      return { pushed: true };
    } catch (error) {
      if (error instanceof Error && "status" in error) throw error;
      const message = error instanceof Error ? error.message : "push failed";
      throw web.error(502, message);
    }
  });

  // Merge the open PR once it passes mergeBlocker. Git and gh are read fresh,
  // not from the panel's cache. --match-head-commit pins the merge to the
  // commit that was checked, so a push after the check makes gh refuse.
  web.route(
    "POST",
    "merge",
    async ({
      body,
    }): Promise<{
      merged: number;
      url: string;
      state: WorktreeState | null;
    }> => {
      try {
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        checkRepoName(repo);
        checkBranchName(name, "worktree name");
        const listing = await readListing();
        const found = listing.worktrees.find(
          (w) => w.repo === repo && w.name === name,
        );
        if (!found) throw web.error(404, `Worktree not found: ${name}@${repo}`);
        if (found.statusError) {
          throw web.error(409, "Git status unknown; refresh and inspect first");
        }
        const target = await prTarget(found.path, name);
        const branch = await currentBranch(found.path);
        const viewed = await runCmd(
          "gh",
          [
            "pr",
            "view",
            branch,
            "--repo",
            target.repo,
            "--json",
            PR_VIEW_FIELDS,
          ],
          found.path,
        );
        const pr = viewed.code === 0 ? parsePrView(viewed.stdout) : null;
        if (!pr) throw web.error(409, `No open PR for ${name}@${repo}`);
        const blocker = mergeBlocker(pr, await pushInfo(found.path, name));
        if (blocker) {
          // The row drew this button from a reading that can be a minute old,
          // and this read is the one that refused it: hand the row the fresh
          // reading, so it stops offering a merge that cannot happen.
          try {
            await refreshWorktreeState(repo, name);
            web.send("fetched", { at: Date.now() });
          } catch {
            // The row's entry stays dropped, so the next poll reads it fresh.
          }
          throw web.error(409, `Cannot merge ${name}@${repo}: ${blocker}`);
        }
        const head = await runCmd("git", ["rev-parse", "HEAD"], found.path);
        if (head.code !== 0) {
          throw new Error(
            head.stderr.trim() || `git rev-parse failed (exit ${head.code})`,
          );
        }
        const merged = await runCmd(
          "gh",
          [
            "pr",
            "merge",
            String(pr.number),
            "--repo",
            target.repo,
            "--merge",
            "--match-head-commit",
            head.stdout.trim(),
          ],
          found.path,
          180_000,
        );
        if (merged.code !== 0) {
          throw new Error(
            merged.stderr.trim() || `gh pr merge failed (exit ${merged.code})`,
          );
        }
        // Refresh this row and no other. The repository's own fetch is what lets
        // timber call the branch merged, since the base branch holds it on the
        // remote now; it is one fetch of one repository, not a pass over every
        // worktree. Without it the row reads Merged on the periodic fetch.
        await runTimber(["git", `@${repo}`, "--", "fetch"]);
        let state: WorktreeState | null = null;
        try {
          state = await refreshWorktreeState(repo, name);
        } catch {
          // The row's cached entry stays dropped, so it cannot offer this merged
          // PR again. The next state poll reads it fresh.
        }
        return { merged: pr.number, url: pr.url, state };
      } catch (error) {
        if (error instanceof Error && "status" in error) throw error;
        const message = error instanceof Error ? error.message : "merge failed";
        throw web.error(502, message);
      }
    },
  );

  // The folder of the session a tab shows, so the page can keep that worktree's
  // row at the top. The tab cannot read the folder itself, and a server older
  // than 0.20.0 has no `sessions()`: it answers null, and the page keeps its
  // plain order.
  web.route(
    "GET",
    "folder",
    async (request): Promise<{ path: string | null }> => {
      const asked = (request.query.get("session") ?? "").trim();
      const id = Number(asked);
      if (!asked || !Number.isInteger(id)) {
        throw web.error(400, "session is required");
      }
      if (typeof request.sessions !== "function") return { path: null };
      const found = request.sessions().find((session) => session.id === id);
      return { path: found ? found.cwd : null };
    },
  );

  // The sessions that work in a folder, for removing the worktree there and for
  // the row's open button, which shows the newest of them instead of starting a
  // second session. The page archives them as the person who asked, because a
  // route cannot archive. Only those this person sees, and only those still in
  // the list, the newest first. A server older than 0.20.0 has no `sessions()`
  // and answers none.
  web.route(
    "GET",
    "sessions",
    async (request): Promise<{ sessions: { id: number; title: string }[] }> => {
      const path = request.query.get("path") ?? "";
      if (!path) throw web.error(400, "path is required");
      if (typeof request.sessions !== "function") return { sessions: [] };
      return {
        sessions: request
          .sessions()
          .filter((session) => session.cwd === path && !session.archived)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((session) => ({ id: session.id, title: session.title })),
      };
    },
  );

  // A TODO failure as the status that the panel shows. What the person can
  // fix is theirs; the rest is timber's own report.
  const todoRouteError = (error: unknown): never => {
    const message = error instanceof Error ? error.message : "TODO failed";
    if (/unknown worktree|not found/i.test(message)) {
      throw web.error(404, message);
    }
    if (/changed/i.test(message)) {
      throw web.error(409, message);
    }
    if (/needs timber|invalid|is empty|control characters/i.test(message)) {
      throw web.error(422, message);
    }
    throw web.error(502, message);
  };

  // One worktree's TODO list, or its repository's: the items, their nesting,
  // and the count of the two states.
  web.route("GET", "todo", async (request): Promise<TodoList> => {
    const repo = (request.query.get("repo") ?? "").trim();
    const name = (request.query.get("name") ?? "").trim();
    const scope = request.query.get("scope") ?? "worktree";
    if (!isTodoScope(scope)) {
      throw web.error(400, "scope is worktree or repo");
    }
    try {
      return await readTodoList(repo, name, scope);
    } catch (error) {
      return todoRouteError(error);
    }
  });

  // POST todo-add: append one open item to the list, and answer with the list
  // as timber reads it now.
  web.route("POST", "todo-add", async ({ body }): Promise<TodoList> => {
    try {
      const repo = typeof body["repo"] === "string" ? body["repo"] : "";
      const name = typeof body["name"] === "string" ? body["name"] : "";
      const scope = todoScopeOf(body["scope"]);
      const title = checkTodoTitle(body["text"]);
      return await editTodoList(repo, name, scope, (path) => {
        addTodoLine(path, title);
      });
    } catch (error) {
      return todoRouteError(error);
    }
  });

  // POST todo-toggle: mark one item done, or open again.
  web.route("POST", "todo-toggle", async ({ body }): Promise<TodoList> => {
    try {
      const repo = typeof body["repo"] === "string" ? body["repo"] : "";
      const name = typeof body["name"] === "string" ? body["name"] : "";
      const scope = todoScopeOf(body["scope"]);
      const target = todoTarget(body);
      return await editTodoList(repo, name, scope, (path) => {
        toggleTodoLine(
          path,
          target.id,
          target.title,
          body["complete"] === true,
        );
      });
    } catch (error) {
      return todoRouteError(error);
    }
  });

  // POST todo-remove: drop one item's line.
  web.route("POST", "todo-remove", async ({ body }): Promise<TodoList> => {
    try {
      const repo = typeof body["repo"] === "string" ? body["repo"] : "";
      const name = typeof body["name"] === "string" ? body["name"] : "";
      const scope = todoScopeOf(body["scope"]);
      const target = todoTarget(body);
      return await editTodoList(repo, name, scope, (path) => {
        removeTodoLine(path, target.id, target.title);
      });
    } catch (error) {
      return todoRouteError(error);
    }
  });

  web.route(
    "POST",
    "remove",
    async ({ body }): Promise<{ removed: string }> => {
      try {
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        return await removeWorktree(repo, name);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "remove failed";
        if (message.includes("not found")) throw web.error(404, message);
        if (
          message.includes("requires a clean") ||
          message.includes("Invalid") ||
          message.includes("refusing") ||
          message.includes("not merged")
        ) {
          throw web.error(409, message);
        }
        throw web.error(502, message);
      }
    },
  );

  // Draft a PR title and body with the `pi` CLI, in the worktree's folder.
  // The CLI reads the repository itself, so the draft follows the code and the
  // commit messages without shipping them to the panel. It runs with the model
  // and thinking level of the conversation that asked, when Pi has them.
  if (typeof web.conversationRoute === "function") {
    web.conversationRoute(
      "POST",
      "pr-draft/:source",
      async (request) => {
        const { body } = request;
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        try {
          checkRepoName(repo);
          checkBranchName(name, "worktree name");
        } catch {
          throw web.error(400, "Invalid repository or worktree name.");
        }
        const listing = await readListing();
        const found = listing.worktrees.find(
          (w) => w.repo === repo && w.name === name,
        );
        if (!found) throw web.error(404, "Worktree not found.");
        if (found.statusError) throw web.error(409, "Git status is unknown.");
        const model = request.conversation.model;
        const modelArg =
          model && typeof model.provider === "string"
            ? `${model.provider}/${String(model.modelId)}`
            : "";
        const thinking = request.conversation.thinkingLevel;
        const args = [
          "-p",
          "--no-session",
          "--mode",
          "text",
          ...(modelArg ? ["--model", modelArg] : []),
          ...(thinking ? ["--thinking", String(thinking)] : []),
          PR_DRAFT_PROMPT,
        ];
        const run = await runPi(args, found.path, PR_DRAFT_TIMEOUT);
        if (run.code !== 0) {
          throw web.error(
            502,
            run.stderr.trim().slice(-400) || `pi exited ${String(run.code)}`,
          );
        }
        const draft = parseDraft(run.stdout);
        if (!draft) {
          throw web.error(502, "pi did not return a title and body.");
        }
        return draft;
      },
      { conversation: "source", access: "steer" },
    );
  }

  web.client("timber");

  // Periodic `timber git @repo -- fetch` so merged PRs flip to Merged.
  // Slow work stays out of module load: first run after 30s, then every 5 minutes.
  // Skips when a run is already going. Cleared when this version goes.
  const fetchLoop = async () => {
    try {
      await fetchAllRepos();
      try {
        web.send("fetched", { at: lastFetchAt });
      } catch {
        // No tabs to tell; the next poll reads the fresh listing.
      }
    } catch {
      // Best effort: fetch errors surface via state.fetchError.
    }
  };
  const firstFetch = setTimeout(() => {
    void fetchLoop();
  }, 30_000);
  const fetchTimer = setInterval(() => {
    void fetchLoop();
  }, 5 * 60_000);
  if (
    typeof firstFetch === "object" &&
    firstFetch !== null &&
    "unref" in firstFetch
  ) {
    (firstFetch as { unref: () => void }).unref();
  }
  if (
    typeof fetchTimer === "object" &&
    fetchTimer !== null &&
    "unref" in fetchTimer
  ) {
    (fetchTimer as { unref: () => void }).unref();
  }
  web.onDispose(() => {
    clearTimeout(firstFetch);
    clearInterval(fetchTimer);
  });

  return defineExtension({
    name: "timber",
    tools: [
      timberList,
      timberCreate,
      timberRemove,
      timberRepoAdd,
      timberFetch,
      timberStartSession,
    ],
  });
}
