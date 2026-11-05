/**
 * Timber worktrees and TODOs: list, create, open sessions in, and safely remove managed Git worktrees, read and edit the TODO list of a worktree or of its repository, read and merge the pull requests of a worktree's stack, and open a worktree's pull request, from pages, from panels on a wide screen, and from Pi's tools, which a session in a worktree is told to use for worktrees and their pull requests.
 * Wraps the `timber` CLI on the server (with `gh` to read and merge pull requests, and `gh stack` to merge a stack up to a chosen PR): listing, creation, safe removal, registration, rename, and removal of bare repositories, periodic fetching so merged branches show as Merged, a fresh read of the row an action changed, open-or-create PR per worktree (pushing the branch to `origin/<branch>` first when GitHub lacks it), the pull requests of a worktree's stack, the TODO files that `timber todo --path` and `--repo` resolve, and a linked session that Pi starts in a worktree's folder.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
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
  // The PR's title, for its link's tooltip. Set only with a PR.
  title?: string;
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
  // The stack the open PR belongs to, or null when it is not in one. Set only
  // with a PR. A stack shares one worktree: its branches are local branches of
  // the repository, and only one of them is checked out.
  stack?: StackInfo | null;
};

// One pull request in a stack. Position 1 is the branch closest to the stack's
// base; the last position is the top, whose merge lands the whole stack.
type StackPr = {
  number: number;
  url: string;
  title: string;
  branch: string;
  position: number;
  state: string;
  // Whether this is the branch checked out in the worktree.
  current: boolean;
  checks: ChecksState;
  // Why this PR cannot merge yet, or null when it can. GitHub's answer alone:
  // the branches of a stack other than the checked-out one have no local push
  // state to measure.
  blocker: string | null;
};

// The stack of a worktree's pull request.
type StackInfo = {
  number: number;
  size: number;
  base: string;
  prs: StackPr[];
};
let prCache: {
  at: number;
  map: Record<string, PrEntry>;
} | null = null;
// Whether a fetch has moved the refs a row's push state reads. The rows were
// read before it, so their entries are older than it whatever their age.
let prCacheStale = false;
// The pass that reads every row, and whether a read that arrived while it ran
// must repeat it: a pass that started before the change it was asked for cannot
// answer for it.
let prRefresh: { again: boolean; done: Promise<void> } | null = null;
const PR_CACHE_TTL = 60_000;

// Drop a row's cached read, so that the next read of it starts fresh.
function forgetRow(repo: string, name: string): void {
  if (!prCache) return;
  const key = `${repo}\0${name}`;
  if (!(key in prCache.map)) return;
  const map = { ...prCache.map };
  delete map[key];
  prCache = { at: prCache.at, map };
}

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

// A route's body holds what the page sent, untyped: a field that is not a
// string reads as empty, as if the page had left it out.
function textField(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

// A positive whole number in a route's body, or null when the field is not
// one. A stack's merge names the PR it merges; a row with no stack leaves it
// out.
function numberField(
  body: Record<string, unknown>,
  key: string,
): number | null {
  const value = body[key];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
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

// The worktree a folder belongs to: the folder of a session that works in it,
// or one of its subfolders.
function worktreeAt(
  worktrees: Worktree[],
  folder: string,
): Worktree | undefined {
  const target = resolve(folder);
  return worktrees.find((w) => {
    const rest = relative(resolve(w.path), target);
    return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
  });
}

// The worktree that a tool works on: the one that repo and name select, or the
// one that holds the session's folder when neither is given.
async function toolWorktree(
  repo: string | undefined,
  name: string | undefined,
  folder: string | undefined,
): Promise<Worktree> {
  const listing = await readListing();
  if (repo !== undefined || name !== undefined) {
    const namedRepo = repo ?? "";
    const namedWorktree = name ?? "";
    checkRepoName(namedRepo);
    checkBranchName(namedWorktree, "worktree name");
    const found = listing.worktrees.find(
      (w) => w.repo === namedRepo && w.name === namedWorktree,
    );
    if (!found) {
      throw new Error(
        `Worktree not found: ${namedWorktree}@${namedRepo}. Look one up with timber_list.`,
      );
    }
    return found;
  }
  if (!folder) {
    throw new Error(
      "This session has no folder, so pass repo and name to name the worktree.",
    );
  }
  const found = worktreeAt(listing.worktrees, folder);
  if (!found) {
    throw new Error(
      `This session's folder is not a Timber worktree: ${folder}. Pass repo and name, or make one with timber_create.`,
    );
  }
  return found;
}

// The worktree a session works in, for its prompt section. Cached: a section
// renders before every request, and a worktree moves under a session no more
// often than timber lists it. In-memory only, so a reload reads it again.
const WORKTREE_LOOKUP_TTL = 30_000;
let worktreeLookup: { at: number; worktrees: Worktree[] } | null = null;

// After a change that adds, moves, or removes a worktree, so that the next
// request's rules name the folder's worktree as it is now.
function forgetWorktreeLookup(): void {
  worktreeLookup = null;
}

async function worktreeOfFolder(folder: string): Promise<Worktree | undefined> {
  if (
    worktreeLookup === null ||
    Date.now() - worktreeLookup.at > WORKTREE_LOOKUP_TTL
  ) {
    const listing = await readListing();
    worktreeLookup = { at: Date.now(), worktrees: listing.worktrees };
  }
  return worktreeAt(worktreeLookup.worktrees, folder);
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
  // The prompt section's cached folders are older than this worktree, whatever
  // the verification below finds.
  forgetWorktreeLookup();

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

// A repository name as timber stores it: `timber repo list` prints the name it
// trimmed and kept, so a name from the page compares against a listed one only
// after the same trim.
function storedRepoName(value: string): string {
  const edges = /^\/+|\/+$/g;
  return value
    .trim()
    .replace(edges, "")
    .replace(/\.git$/, "")
    .replace(edges, "");
}

// The reads of one repository's rows, dropped: the rows are gone, and what was
// read for them cannot be shown for the rows that remain.
function dropRepoEntries(repo: string): void {
  if (!prCache) return;
  const map: Record<string, PrEntry> = {};
  for (const [key, entry] of Object.entries(prCache.map)) {
    if (!key.startsWith(`${repo}\0`)) map[key] = entry;
  }
  prCache = { at: prCache.at, map };
}

// `timber repo rename` renames the bare repository and moves the folder of every
// worktree it manages, so the paths of those worktrees change with it. A plan
// that fails partway is rolled back by timber itself: this reads the listing
// after the command and reports what it did and did not confirm.
async function renameRepository(
  repo: string,
  to: string,
): Promise<{
  from: string;
  to: string;
  worktrees: number;
  warnings: string[];
}> {
  checkRepoName(repo);
  const target = cleanName(to);
  if (!target) throw new Error("New repository name is empty");
  checkRepoName(target);

  const from = storedRepoName(repo);
  const next = storedRepoName(target);
  if (!next) throw new Error("New repository name is empty");

  const before = await readListing();
  refuseOnWarnings(before.warnings);
  if (!before.repositories.includes(from)) {
    throw new Error(`Repository is not registered: ${from}`);
  }
  if (next === from) {
    throw new Error(`Repository is already named ${from}`);
  }
  if (before.repositories.includes(next)) {
    throw new Error(`Repository is already registered: ${next}`);
  }
  const moved = before.worktrees.filter((w) => w.repo === from).length;

  const result = await runTimber(["repo", "rename", from, next]);
  // The folder lookup names the repository's old worktree paths.
  forgetWorktreeLookup();
  const after = await readListing();
  const renamed =
    after.repositories.includes(next) && !after.repositories.includes(from);
  if (result.code !== 0 || !renamed) {
    const detail = result.stderr.trim() || `timber exited ${result.code}`;
    throw new Error(
      `Rename not confirmed; inspect the repositories before retrying. ${detail}`,
    );
  }
  // The rows of this repository are listed under a new name now, so every cached
  // read of them is older than the rename: the next state read reads them again.
  prCacheStale = true;
  return { from, to: next, worktrees: moved, warnings: after.warnings };
}

// `timber repo remove` drops a registered bare repository. It refuses one that
// still has worktrees, and so does this: the worktrees of a repository are rows
// that this page removes one at a time.
async function removeRepository(repo: string): Promise<{ removed: string }> {
  checkRepoName(repo);
  const name = storedRepoName(repo);
  if (!name) throw new Error("Repository is empty");

  const before = await readListing();
  refuseOnWarnings(before.warnings);
  if (!before.repositories.includes(name)) {
    throw new Error(`Repository is not registered: ${name}`);
  }
  const left = before.worktrees
    .filter((w) => w.repo === name)
    .map((w) => w.name);
  if (left.length > 0) {
    throw new Error(
      `Repository still has worktrees (${left.join(", ")}); remove them first`,
    );
  }

  const result = await runTimber(["repo", "remove", name]);
  const after = await readListing();
  if (result.code !== 0 || after.repositories.includes(name)) {
    const detail = result.stderr.trim();
    throw new Error(
      `Removal not verified; inspect the repositories before retrying.${detail ? ` ${detail}` : ""}`,
    );
  }
  dropRepoEntries(name);
  return { removed: name };
}

// A destructive operation refuses a listing that reported diagnostics: what it
// would act on may not be what timber described.
function refuseOnWarnings(warnings: string[]): void {
  if (warnings.length > 0) {
    throw new Error(
      "Listing reported diagnostics; refusing a destructive operation",
    );
  }
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
    // The fetch moved origin/<branch>, which is what a row's push state reads,
    // so every cached row is older than the fetch, whatever its age.
    prCacheStale = true;
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
  "number,url,title,state,isDraft,statusCheckRollup,mergeStateStatus,headRefName";

// What the pull request's checks are doing: all passed, at least one failed,
// some still to finish (or queued), or none at all. "none" is not "no checks
// ran": a push whose CI has not registered yet reads the same way.
type ChecksState = "passed" | "failed" | "pending" | "none";

type PrView = {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  checks: ChecksState;
  // GitHub's own answer on whether the PR can merge now, in upper case; null
  // when this `gh` does not report it.
  mergeState: string | null;
  // The branch that holds the PR's commits, which is the checked-out branch
  // when this is the worktree's own PR.
  branch: string;
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
      const branch = parsed["headRefName"];
      const title = parsed["title"];
      return {
        number: parsed["number"],
        url: parsed["url"],
        title: typeof title === "string" ? title : "",
        draft: parsed["isDraft"] === true,
        checks: checksState(checks),
        mergeState:
          typeof mergeState === "string" ? mergeState.toUpperCase() : null,
        branch: typeof branch === "string" ? branch : "",
      };
    }
  } catch {
    // No PR (or unreadable output): treated as none.
  }
  return null;
}

// The number and branch of the PR `gh pr view` printed, whatever its state. A
// stack's checked-out branch can merge while the PRs above it stay open, and
// the stack still has to be read from that PR.
function parsePrHead(
  stdout: string,
): { number: number; branch: string } | null {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed) && typeof parsed["number"] === "number") {
      const branch = parsed["headRefName"];
      return {
        number: parsed["number"],
        branch: typeof branch === "string" ? branch : "",
      };
    }
  } catch {
    // Unreadable output: no PR.
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

// Why a stack's PR cannot merge yet, or null when it can. Only the checked-out
// branch has a local push state to measure, so every other entry asks GitHub
// alone: its merge state and its checks.
function stackPrBlocker(pr: PrView): string | null {
  if (pr.draft) return "PR is a draft";
  const stateBlocker = mergeStateBlocker(pr);
  if (stateBlocker) return stateBlocker;
  if (pr.checks === "failed" || pr.checks === "pending") {
    return "Checks have not all passed";
  }
  return null;
}

// The stack of a pull request. `gh pr view` has no stack field, so this asks
// GitHub's GraphQL API. A stack's entries carry every member's state and
// checks, so one read serves the whole list.
const PR_STACK_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      stack {
        number
        size
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest {
              number
              url
              title
              state
              isDraft
              headRefName
              mergeStateStatus
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { status conclusion }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

// The record at a path of record fields, or null when any step is missing.
function recordAt(
  value: unknown,
  ...keys: string[]
): Record<string, unknown> | null {
  let at: unknown = value;
  for (const key of keys) {
    if (!isRecord(at)) return null;
    at = at[key];
  }
  return isRecord(at) ? at : null;
}

// The stack in the answer to PR_STACK_QUERY, or null when the PR is not in one
// or the answer is unreadable. The checked-out branch's entry carries the same
// blocker as the worktree's own PR, push state included.
function parsePrStack(
  stdout: string,
  currentBranch: string,
  push: PushInfo,
): StackInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const stack = recordAt(parsed, "data", "repository", "pullRequest", "stack");
  if (!stack) return null;
  const entries = recordAt(stack, "entries");
  const nodes =
    entries && Array.isArray(entries["nodes"]) ? entries["nodes"] : [];
  const prs: StackPr[] = [];
  for (const node of nodes) {
    if (!isRecord(node)) continue;
    const pr = recordAt(node, "pullRequest");
    if (!pr) continue;
    const number = typeof pr["number"] === "number" ? pr["number"] : 0;
    const url = typeof pr["url"] === "string" ? pr["url"] : "";
    const title = typeof pr["title"] === "string" ? pr["title"] : "";
    const branch =
      typeof pr["headRefName"] === "string" ? pr["headRefName"] : "";
    const state =
      typeof pr["state"] === "string" ? pr["state"].toUpperCase() : "OPEN";
    if (!number || !url) continue;
    const contexts = recordAt(pr, "statusCheckRollup", "contexts");
    const checks = checksState(
      contexts && Array.isArray(contexts["nodes"]) ? contexts["nodes"] : [],
    );
    const mergeState =
      typeof pr["mergeStateStatus"] === "string"
        ? pr["mergeStateStatus"].toUpperCase()
        : null;
    const view: PrView = {
      number,
      url,
      title,
      draft: pr["isDraft"] === true,
      checks,
      mergeState,
      branch,
    };
    const current = branch === currentBranch;
    prs.push({
      number,
      url,
      title,
      branch,
      position: typeof node["position"] === "number" ? node["position"] : 0,
      state,
      current,
      checks,
      blocker:
        state === "OPEN"
          ? current
            ? mergeBlocker(view, push)
            : stackPrBlocker(view)
          : null,
    });
  }
  if (prs.length === 0) return null;
  prs.sort((a, b) => a.position - b.position);
  const number = typeof stack["number"] === "number" ? stack["number"] : 0;
  if (!number) return null;
  return {
    number,
    size: typeof stack["size"] === "number" ? stack["size"] : prs.length,
    base: typeof stack["baseRefName"] === "string" ? stack["baseRefName"] : "",
    prs,
  };
}

// The stack of a PR, read in the worktree's folder. A failed read is no stack:
// a repository without stacks, or a GitHub host without the field, keeps the
// row it has.
async function readPrStack(
  repo: string,
  number: number,
  currentBranch: string,
  push: PushInfo,
  cwd: string,
): Promise<StackInfo | null> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return null;
  const result = await runCmd(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${PR_STACK_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${repoName}`,
      "-F",
      `number=${number}`,
    ],
    cwd,
  );
  return result.code === 0
    ? parsePrStack(result.stdout, currentBranch, push)
    : null;
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

// Push the worktree's branch to origin/<branch>, the head of its pull request.
// An explicit refspec works under any push.default and never touches the
// upstream config. Plain push already refuses non-fast-forwards, so a remote
// that moved since the check fails atomically instead of pushing.
async function pushBranch(w: Worktree): Promise<{ pushed: boolean }> {
  const push = await pushInfo(w.path, w.name);
  // A branch that origin lacks is nothing to report as unpushed: pushInfo counts
  // against the upstream, which a branch without one cannot name.
  if (push.destExists && push.unpushed === 0) return { pushed: false };
  if (!push.ff) {
    throw new Error(
      `${w.name}@${w.repo} is not a fast-forward over origin/${w.name}; fetch first`,
    );
  }
  const pushed = await runCmd(
    "git",
    ["push", "origin", `HEAD:${w.name}`],
    w.path,
    180_000,
  );
  if (pushed.code !== 0) {
    throw new Error(
      pushed.stderr.trim() || `git push failed (exit ${pushed.code})`,
    );
  }
  return { pushed: true };
}

// The cache entry for a worktree that has an open PR.
function prEntry(pr: PrView, push: PushInfo, stack: StackInfo | null): PrEntry {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    checks: pr.checks,
    destExists: push.destExists,
    unpushed: push.unpushed,
    ff: push.ff,
    mergeBlocker: mergeBlocker(pr, push),
    stack,
  };
}

// The open PR, its stack, and push state of one worktree, read in the
// worktree's folder, with the key that the PR cache and the rows use.
async function readPushAndPr(w: Worktree): Promise<{
  key: string;
  pr: PrView | null;
  push: PushInfo;
  repo: string | null;
  stack: StackInfo | null;
}> {
  const key = `${w.repo}\0${w.name}`;
  const [viewed, push, remote] = await Promise.all([
    runCmd("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], w.path),
    pushInfo(w.path, w.name),
    runCmd("git", ["remote", "get-url", "origin"], w.path),
  ]);
  const pr = viewed.code === 0 ? parsePrView(viewed.stdout) : null;
  const head = viewed.code === 0 ? parsePrHead(viewed.stdout) : null;
  const repo = remote.code === 0 ? repoFromRemoteUrl(remote.stdout) : null;
  // The checked-out branch's PR can be merged while the PRs above it stay open,
  // and the stack still has to be read: the head names the PR either way.
  const stack =
    head && repo
      ? await readPrStack(
          repo,
          head.number,
          head.branch || w.name,
          push,
          w.path,
        )
      : null;
  return { key, pr, push, repo, stack };
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
  forgetRow(repo, name);
  const listing = await readListing();
  const found = listing.worktrees.find(
    (w) => w.repo === repo && w.name === name,
  );
  if (!found) return null;
  const { pr, push, repo: origin, stack } = await readPushAndPr(found);
  const entry: PrEntry = {
    ...(pr ? prEntry(pr, push, stack) : push),
    repo: origin,
  };
  prCache = { at: Date.now(), map: { ...(prCache?.map ?? {}), [key]: entry } };
  return { worktree: found, pr: entry };
}

// Tell every open tab that the state it shows changed, so that each one re-reads
// the state now instead of at its next poll. The extension sets this when it is
// made, which is before a route or a tool can run, so a caller can await it.
let announceState: () => Promise<void> = async () => {};

// Show a row's new state at once: read this row and no other, so its button
// shows what it can do now, and tell the tabs. Best effort: the background
// refresh covers a failure.
async function warmRow(repo: string, name: string): Promise<void> {
  try {
    await refreshWorktreeState(repo, name);
    await announceState();
  } catch {
    // Warming is best-effort; the background refresh covers it.
  }
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

// The base branch that a worktree's pull request targets, for a command that
// must name it: the branch's upstream, or the remote head. Each failure says
// what to pass instead, since `--base` names a base without either.
async function baseBranch(w: Worktree): Promise<string> {
  let target: { base: string };
  try {
    target = await prTarget(w.path, w.name);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "no base branch is known";
    throw new Error(`${message} Pass base to name it.`);
  }
  if (target.base === w.name) {
    throw new Error(
      `${w.name}@${w.repo} tracks a branch of its own name, so it names no base branch. Pass base.`,
    );
  }
  return target.base;
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
  options: { base?: string; draft?: boolean } = {},
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
    ...(options.base ? ["--base", options.base] : []),
    ...(draft.body.trim() ? ["--body", draft.body] : []),
    ...(options.draft ? ["--draft"] : []),
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
  refuseOnWarnings(listing.warnings);
  const synced = (found.ahead ?? 0) === 0 && (found.behind ?? 0) === 0;
  if (found.statusError || !found.clean || (!found.merged && !synced)) {
    throw new Error(
      "Removal requires a clean worktree that is merged or fully in sync (0 ahead, 0 behind) with known status",
    );
  }
  // A stack shares this worktree: removing it while a PR above the checked-out
  // branch is still open would take the folder the rest of the stack needs.
  const { stack } = await readPushAndPr(found);
  if (stack && stack.prs.some((pr) => pr.state === "OPEN")) {
    throw new Error(
      "Removal requires every pull request in the worktree's stack to be merged",
    );
  }

  const result = await runTimber(["remove", `${name}@${repo}`]);
  // The prompt section's cached folders still hold the worktree that is gone.
  forgetWorktreeLookup();
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
    // The row exists now, and its push and PR state with it, so its button can
    // say what it can do: a row with no cached read offers to remove the
    // worktree that the person has just made.
    await warmRow(created.worktree.repo, created.worktree.name);
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
    forgetRow(args.repo, args.name);
    await announceState();
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
    await announceState();
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

const timberRepoRename = defineTool({
  name: "timber_repo_rename",
  description:
    "Rename a registered Timber repository. Timber moves the folders of its managed worktrees with it, so sessions in the old folders no longer open them.",
  parameters: Type.Object({
    repo: Type.String({ description: "Registered repo, e.g. nnutter/timber" }),
    to: Type.String({ description: "New name, e.g. nnutter/timber-archive" }),
  }),
  execute: async (args) => {
    const renamed = await renameRepository(args.repo, args.to);
    // The rows of the repository are listed under its new name now, and their
    // cached reads are older than the rename: this reads them again first.
    await announceState();
    const moved =
      renamed.worktrees === 0
        ? ""
        : ` and moved ${renamed.worktrees} worktree${renamed.worktrees === 1 ? "" : "s"}`;
    return {
      output: [
        {
          type: "text" as const,
          text: `Renamed repository ${renamed.from} to ${renamed.to}${moved}${renamed.warnings.length ? `\nwarnings: ${renamed.warnings.join("\n")}` : ""}`,
        },
      ],
    };
  },
});

const timberRepoRemove = defineTool({
  name: "timber_repo_remove",
  description:
    "Remove a registered Timber repository that has no worktrees. Refuses a repository that still has worktrees.",
  parameters: Type.Object({
    repo: Type.String({ description: "Registered repo, e.g. nnutter/timber" }),
  }),
  execute: async (args) => {
    const removed = await removeRepository(args.repo);
    await announceState();
    return {
      output: [
        {
          type: "text" as const,
          text: `Removed repository ${removed.removed}`,
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
    // The fetch moved origin/<branch>, which is what a row's push state reads:
    // this reads the rows again, and only then tells the tabs.
    await announceState();
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

// The rules for a session that works in a Timber worktree: it changes that
// folder's files, and the work of other worktrees goes to linked sessions. Git
// writes into the repository's folder, which is outside the worktree, so the
// rules name that write: a rule that forbids it would forbid every commit.
function worktreeRules(worktree: Worktree): string {
  return [
    `This session works in the Timber worktree \`${worktree.name}@${worktree.repo}\` at \`${worktree.path}\`. Change files only in this folder. Do not read, edit, or commit in another worktree, in another checkout of the repository, or in a scratch folder such as \`/tmp\`. Git keeps the repository's data outside this folder, and this worktree's \`.git\` file points to it: a \`git\` command writes there, and that is part of working here.`,
    "Ask the person to approve a new worktree before you make one with `timber_create`, and again before you start work in it.",
    "Use the `timber_*` tools to manage worktrees and their pull requests (`timber_list`, `timber_create`, `timber_remove`, `timber_start_session`, `timber_pr_create`). Do not run `git worktree add`. Do not run `gh pr create`: `timber_pr_create` opens a worktree's pull request, and `gh` reads and merges pull requests here.",
    "When the work must change more than one worktree or repository, start a linked session in each of them with `timber_start_session`. Start one in this worktree too for the work that belongs here, then coordinate the linked sessions and leave their edits to them. A linked session does not start linked sessions: do the work in it.",
  ].join("\n");
}

// The rules for a session that works in a Timber worktree, and nothing for a
// session that starts in any other folder: a session outside a worktree may be
// about anything, such as OS maintenance, and these rules would only misdirect
// it. A broken timber says nothing about the folder, so it leaves the section
// out rather than name the wrong worktree; it must not stop a request either
// way.
const timberWorktreeRule = section("timber_worktree", async (input) => {
  const folder = input.agent.cwd;
  if (!folder) return undefined;
  let found: Worktree | undefined;
  try {
    found = await worktreeOfFolder(folder);
  } catch {
    return undefined;
  }
  return found ? worktreeRules(found) : undefined;
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

  // The pull request of the worktree that Pi works in. It pushes the branch the
  // way `push.default = current` does, to origin's branch of the same name, so
  // that `gh pr create` is not the shorter way out: that command names neither
  // the base branch nor the push, and the worktree's upstream is usually the
  // base branch rather than the branch's destination.
  const timberPrCreate = defineTool({
    name: "timber_pr_create",
    description:
      "Open the pull request for a Timber worktree with `timber pr create`, after pushing its branch to origin/<branch> when origin lacks it or is behind. Defaults to the worktree of this session's folder. Use this instead of `gh pr create`.",
    parameters: Type.Object({
      title: Type.String({
        description:
          "Pull request title, one line of at most 72 characters, in the repository's commit subject style",
      }),
      repo: Type.Optional(
        Type.String({
          description:
            "Registered repo, e.g. nnutter/timber; with name, for a worktree other than this session's",
        }),
      ),
      name: Type.Optional(
        Type.String({ description: "Worktree/branch name, with repo" }),
      ),
      base: Type.Optional(
        Type.String({
          description:
            "Base branch; the branch's upstream branch, or origin's default branch",
        }),
      ),
      draft: Type.Optional(
        Type.Boolean({ description: "Open the pull request as a draft" }),
      ),
      push: Type.Optional(
        Type.Boolean({
          description:
            "Push the branch first when origin lacks it or is behind (default true)",
        }),
      ),
    }),
    execute: async (args, api, context) => {
      const title = args.title.trim();
      if (title === "") {
        throw new Error(
          "timber_pr_create needs a title: the subject of the pull request.",
        );
      }

      const folder =
        args.repo === undefined && args.name === undefined
          ? (await api.agent(context)).cwd
          : undefined;
      const worktree = await toolWorktree(args.repo, args.name, folder);

      const pushed =
        args.push === false ? { pushed: false } : await pushBranch(worktree);
      // The base comes from the branch's upstream, so read it before anything
      // makes the branch its own upstream: with `--base` the command needs no
      // upstream at all. A branch that tracks its own name names no base.
      const base = args.base ?? (await baseBranch(worktree));
      // The subject carries the summary, so a pull request that Pi opens has no
      // body: the title alone tells the reviewer what the change is.
      const created = await openOrCreatePr(
        worktree.repo,
        worktree.name,
        title,
        "",
        { base, draft: args.draft === true },
      );
      await warmRow(worktree.repo, worktree.name);

      const pushedNote = pushed.pushed
        ? ` Pushed origin/${worktree.name}.`
        : "";
      const verb = created.created ? "Created" : "Found";
      return {
        output: [
          {
            type: "text" as const,
            text: `${verb} the pull request of ${worktree.name}@${worktree.repo} on base ${base}: ${created.url} (#${created.number}).${pushedNote}`,
          },
        ],
      };
    },
  });

  // A version tag belongs to the repository, but it names one commit: the newest
  // tag plus one, on the commit of the worktree that this tool names. timber
  // reads the worktree from its own folder, so the selector names it, and the
  // command fetches first: a stale tag list would repeat a version, and a
  // checkout behind its upstream would tag a commit that is not the branch tip.
  const timberBump = defineTool({
    name: "timber_bump",
    description:
      "Bump the newest semantic version tag of a Timber worktree with `timber bump`, which fetches first, tags the worktree's commit, and pushes the tag to origin. Defaults to the worktree of this session's folder.",
    parameters: Type.Object({
      kind: Type.Union(
        [Type.Literal("major"), Type.Literal("minor"), Type.Literal("patch")],
        { description: "Which version component to bump" },
      ),
      repo: Type.Optional(
        Type.String({
          description:
            "Registered repo, e.g. nnutter/timber; with name, for a worktree other than this session's",
        }),
      ),
      name: Type.Optional(
        Type.String({ description: "Worktree/branch name, with repo" }),
      ),
    }),
    execute: async (args, api, context) => {
      const folder =
        args.repo === undefined && args.name === undefined
          ? (await api.agent(context)).cwd
          : undefined;
      const worktree = await toolWorktree(args.repo, args.name, folder);

      const bumped = await runTimber([
        "bump",
        `--${args.kind}`,
        `${worktree.name}@${worktree.repo}`,
      ]);
      if (bumped.code !== 0) {
        throw new Error(
          timberMessage(bumped.stderr) ||
            `timber bump failed (exit ${bumped.code}); it needs Timber v0.23.0 or later`,
        );
      }
      // The command prints the new tag, and the URL of a draft release after it.
      const [tag = "", release = ""] = bumped.stdout.trim().split("\n");
      if (tag === "") {
        throw new Error(
          `timber bump tagged ${worktree.name}@${worktree.repo} but printed no tag. Check the tags before retrying.`,
        );
      }
      const releaseNote = release.trim()
        ? ` Draft release: ${release.trim()}.`
        : "";
      return {
        output: [
          {
            type: "text" as const,
            text: `Bumped ${worktree.name}@${worktree.repo} to ${tag} and pushed it to origin.${releaseNote}`,
          },
        ],
      };
    },
  });

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

  // One pass over the rows: every worktree's PR and push state, read now. The
  // list is read here rather than handed in, so a pass reads the rows that
  // exist when it runs.
  const readPrEntries = async (): Promise<void> => {
    const listing = await readListing();
    const entries = await Promise.all(
      listing.worktrees.map(async (w) => {
        const { key, pr, push, repo, stack } = await readPushAndPr(w);
        return [
          key,
          { ...(pr ? prEntry(pr, push, stack) : push), repo },
        ] as const;
      }),
    );
    const map: Record<string, PrEntry> = {};
    for (const [key, entry] of entries) map[key] = entry;
    prCache = { at: Date.now(), map };
    prCacheStale = false;
  };

  // Refresh the open-PR cache in the background and tell tabs to re-read
  // state when it lands. Stale-while-revalidate: state serves the cache
  // immediately and only one refresh runs at a time. A read asked for while one
  // runs repeats the pass rather than joining it, so that a button drawn from
  // the answer is never drawn from a read that began before the ask. A pass
  // whose reads all failed still tells the tabs: the change that asked for it
  // happened, whatever the read could make of it.
  const refreshPrCache = async (): Promise<void> => {
    if (prRefresh) {
      prRefresh.again = true;
      return prRefresh.done;
    }
    const run: { again: boolean; done: Promise<void> } = {
      again: false,
      done: Promise.resolve(),
    };
    prRefresh = run;
    run.done = (async () => {
      try {
        do {
          run.again = false;
          try {
            await readPrEntries();
          } catch {
            // A timber read failed: the cache keeps what it had, and the next
            // pass tries again.
          }
        } while (run.again);
      } finally {
        prRefresh = null;
      }
      try {
        web.send("state", { at: prCache?.at ?? Date.now() });
      } catch {
        // Tabs may be gone; the next poll picks up the fresh listing.
      }
    })();
    return run.done;
  };

  // Tell every open tab that the state it shows changed, so that each one
  // re-reads it now rather than at its next poll. Rows that a change made stale
  // are read again first, because their entries are older than the change; that
  // pass tells the tabs itself when it lands, so no tab reads a state from
  // before the change.
  announceState = async (): Promise<void> => {
    if (prCacheStale) {
      await refreshPrCache();
      return;
    }
    try {
      web.send("state", { at: Date.now() });
    } catch {
      // Tabs may be gone; the next poll picks up the change.
    }
  };

  web.route("GET", "state", async (): Promise<State & { models: string[] }> => {
    try {
      const listing = await readListing();
      if (!prCache || prCacheStale || Date.now() - prCache.at > PR_CACHE_TTL) {
        void refreshPrCache();
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
        // The fetch moved origin/<branch>, which is what a row's push state
        // reads: read the rows again before answering, so the state the page
        // reads next is current instead of a minute old. A pass already running
        // repeats itself, so this answer is never a read that began before the
        // fetch.
        await announceState();
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
        const repo = textField(body, "repo");
        const name = textField(body, "name");
        const upstream = textField(body, "upstream");
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
        const source = textField(body, "source");
        const name = textField(body, "name");
        const alias = textField(body, "alias");
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

  // POST repo-rename: rename a registered repository, with the folders of its
  // managed worktrees. Sessions that worked in those folders keep the paths they
  // had, and the page says so.
  web.route(
    "POST",
    "repo-rename",
    async ({
      body,
    }): Promise<{
      from: string;
      to: string;
      worktrees: number;
      warnings: string[];
    }> => {
      try {
        return await renameRepository(
          textField(body, "repo"),
          textField(body, "to"),
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "rename failed";
        if (message.includes("not registered")) throw web.error(404, message);
        if (message.includes("is empty") || message.includes("Invalid")) {
          throw web.error(422, message);
        }
        if (
          message.includes("already") ||
          message.includes("diagnostics") ||
          message.includes("still has worktrees")
        ) {
          throw web.error(409, message);
        }
        throw web.error(502, message);
      }
    },
  );

  // POST repo-remove: drop a registered repository that has no worktrees.
  web.route(
    "POST",
    "repo-remove",
    async ({ body }): Promise<{ removed: string }> => {
      try {
        return await removeRepository(textField(body, "repo"));
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "remove failed";
        if (message.includes("not registered")) throw web.error(404, message);
        if (message.includes("is empty") || message.includes("Invalid")) {
          throw web.error(422, message);
        }
        if (
          message.includes("diagnostics") ||
          message.includes("still has worktrees")
        ) {
          throw web.error(409, message);
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
        const repo = textField(body, "repo");
        const name = textField(body, "name");
        const title = textField(body, "title");
        const prBody = textField(body, "body");
        const result = await openOrCreatePr(repo, name, title, prBody);
        await warmRow(repo, name);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "pr failed";
        if (message.includes("not found")) throw web.error(404, message);
        throw web.error(502, message);
      }
    },
  );

  web.route(
    "POST",
    "push",
    async ({
      body,
    }): Promise<{
      pushed: boolean;
      state: WorktreeState | null;
    }> => {
      try {
        const repo = textField(body, "repo");
        const name = textField(body, "name");
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
        // Re-verify everything fresh: the panel's counts may be stale, so push
        // state is measured directly with git.
        const { pushed } = await pushBranch(found);
        if (!pushed) {
          throw web.error(409, `Nothing to push for ${name}@${repo}`);
        }
        // Read this row and no other, so its button shows what it can do now:
        // merge the open PR, or open the create form. Emptying the cache would
        // strip every other row of its PR until a pass landed.
        let state: WorktreeState | null = null;
        try {
          state = await refreshWorktreeState(repo, name);
        } catch {
          // The row's cached entry stays dropped, so the next state poll reads it
          // fresh.
        }
        return { pushed: true, state };
      } catch (error) {
        if (error instanceof Error && "status" in error) throw error;
        const message = error instanceof Error ? error.message : "push failed";
        if (message.includes("not a fast-forward")) {
          throw web.error(409, message);
        }
        throw web.error(502, message);
      }
    },
  );

  // Merge a pull request. A stack merges through `gh stack merge`: the chosen
  // PR and every PR below it land together, all or nothing, and the top PR
  // lands the whole stack. A PR that is not in a stack merges on its own.
  // Git and gh are read fresh, not from the panel's cache. The single-PR path
  // pins the merge to the head commit it just read, so a push after the check
  // makes gh refuse; a stack merge lets GitHub enforce its rules instead.
  web.route(
    "POST",
    "merge",
    async ({
      body,
    }): Promise<{
      merged: number;
      url: string;
      state: WorktreeState | null;
      stack?: boolean;
      whole?: boolean;
    }> => {
      try {
        const repo = textField(body, "repo");
        const name = textField(body, "name");
        const requested = numberField(body, "number");
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
        const prHead = viewed.code === 0 ? parsePrHead(viewed.stdout) : null;
        // A stack line can name a PR while the checked-out branch's own PR is
        // already merged: the head still names the PR the stack hangs from.
        if (!prHead) throw web.error(409, `No PR for ${name}@${repo}`);
        if (!pr && !requested) {
          throw web.error(409, `No open PR for ${name}@${repo}`);
        }
        const push = await pushInfo(found.path, name);
        const remote = await runCmd(
          "git",
          ["remote", "get-url", "origin"],
          found.path,
        );
        const origin =
          remote.code === 0 ? repoFromRemoteUrl(remote.stdout) : null;
        const stack = origin
          ? await readPrStack(
              origin,
              prHead.number,
              prHead.branch || name,
              push,
              found.path,
            )
          : null;

        if (stack) {
          const selected = requested
            ? stack.prs.find((entry) => entry.number === requested)
            : stack.prs.find((entry) => entry.number === prHead.number);
          if (!selected) {
            throw web.error(
              409,
              `PR #${requested} is not in the stack of ${name}@${repo}`,
            );
          }
          if (selected.state !== "OPEN") {
            throw web.error(
              409,
              `PR #${selected.number} is ${selected.state.toLowerCase()}`,
            );
          }
          if (selected.blocker) {
            // The row drew this button from a reading that can be a minute old,
            // and this read is the one that refused it: hand the row the fresh
            // reading, so it stops offering a merge that cannot happen.
            await warmRow(repo, name);
            throw web.error(
              409,
              `Cannot merge PR #${selected.number}: ${selected.blocker}`,
            );
          }
          const merged = await runCmd(
            "gh",
            ["stack", "merge", String(selected.number), "--yes", "--merge"],
            found.path,
            180_000,
          );
          if (merged.code !== 0) {
            throw new Error(
              merged.stderr.trim() ||
                `gh stack merge failed (exit ${merged.code})`,
            );
          }
          // The repository's own fetch is what lets timber call the merged
          // branches merged, since the base branch holds them on the remote now.
          await runTimber(["git", `@${repo}`, "--", "fetch"]);
          let state: WorktreeState | null = null;
          try {
            state = await refreshWorktreeState(repo, name);
          } catch {
            // The row's cached entry stays dropped, so the next state poll reads
            // it fresh.
          }
          const whole =
            selected.position === stack.prs[stack.prs.length - 1]?.position;
          return {
            merged: selected.number,
            url: selected.url,
            state,
            stack: true,
            whole,
          };
        }

        if (requested) {
          throw web.error(
            409,
            `PR #${requested} is not in a stack for ${name}@${repo}`,
          );
        }

        if (!pr) throw web.error(409, `No open PR for ${name}@${repo}`);
        const blocker = mergeBlocker(pr, push);
        if (blocker) {
          // The row drew this button from a reading that can be a minute old,
          // and this read is the one that refused it: hand the row the fresh
          // reading, so it stops offering a merge that cannot happen.
          await warmRow(repo, name);
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
      const repo = textField(body, "repo");
      const name = textField(body, "name");
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
      const repo = textField(body, "repo");
      const name = textField(body, "name");
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
      const repo = textField(body, "repo");
      const name = textField(body, "name");
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
        const repo = textField(body, "repo");
        const name = textField(body, "name");
        return await removeWorktree(repo, name);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "remove failed";
        if (message.includes("not found")) throw web.error(404, message);
        if (
          message.includes("requires a clean") ||
          message.includes("Invalid") ||
          message.includes("refusing") ||
          message.includes("not merged") ||
          message.includes("stack")
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
        const repo = textField(body, "repo");
        const name = textField(body, "name");
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
      // A fetch moves origin/<branch>, which is what a row's push state reads,
      // so the rows are read again before the tabs are told.
      await fetchAllRepos();
      await announceState();
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
    sections: [timberWorktreeRule],
    tools: [
      timberList,
      timberCreate,
      timberPrCreate,
      timberBump,
      timberRemove,
      timberRepoAdd,
      timberRepoRename,
      timberRepoRemove,
      timberFetch,
      timberStartSession,
    ],
  });
}
