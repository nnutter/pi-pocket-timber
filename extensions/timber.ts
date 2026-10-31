/**
 * Timber worktrees: list, create, open sessions in, and safely remove managed Git worktrees, from a side panel.
 * Wraps the `timber` CLI on the server (with `gh` for pull requests): listing, creation, safe removal, periodic fetching so merged branches show as Merged, and open-or-create PR per worktree.
 */
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Web } from "./_pocket.d.ts";

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

// Last background `timber git @repo -- fetch` run. In-memory only: a reload refetches.
let lastFetchAt: number | null = null;
let lastFetchError: string | null = null;
let fetching = false;

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
};
let prCache: {
  at: number;
  map: Record<string, PrEntry>;
} | null = null;
let prRefreshing = false;
const PR_CACHE_TTL = 60_000;

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

async function readListing(): Promise<{
  repositories: string[];
  worktrees: Worktree[];
  warnings: string[];
}> {
  const reposResult = await runTimber(["repo", "list", "-q"]);
  if (reposResult.code !== 0) {
    throw new Error(`timber repo list failed: ${reposResult.stderr.trim()}`);
  }
  const repositories = reposResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const listResult = await runTimber(["list", "--json", "--sort", "recency"]);
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

async function fetchAllRepos(): Promise<{
  fetchedAt: number;
  errors: string[];
}> {
  if (fetching) return { fetchedAt: lastFetchAt ?? Date.now(), errors: [] };
  fetching = true;
  try {
    const listing = await readListing();
    const errors: string[] = [];
    for (const repo of listing.repositories) {
      const result = await runTimber(["git", `@${repo}`, "--", "fetch"]);
      if (result.code !== 0 && result.stderr.trim()) {
        errors.push(`${repo}: ${result.stderr.trim().split("\n")[0]}`);
      }
    }
    lastFetchAt = Date.now();
    lastFetchError = errors.length > 0 ? errors.join("; ") : null;
    return { fetchedAt: lastFetchAt, errors };
  } catch (error) {
    lastFetchError = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    fetching = false;
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
const PR_VIEW_FIELDS = "number,url,state,isDraft,statusCheckRollup";

type PrView = {
  number: number;
  url: string;
  draft: boolean;
  checksPassed: boolean;
};

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
      return {
        number: parsed["number"],
        url: parsed["url"],
        draft: parsed["isDraft"] === true,
        checksPassed:
          Array.isArray(checks) &&
          checks.length > 0 &&
          checks.every(checkPassed),
      };
    }
  } catch {
    // No PR (or unreadable output): treated as none.
  }
  return null;
}

type PushInfo = { destExists: boolean; unpushed: number; ff: boolean };

// Why an open PR cannot merge yet, or null when it can. The panel shows this
// reason and the merge route enforces it.
function mergeBlocker(pr: PrView, push: PushInfo): string | null {
  if (pr.draft) return "PR is a draft";
  if (!push.destExists) return "Branch is not pushed";
  if (!push.ff) return "origin has commits this branch lacks";
  if (push.unpushed > 0) return "Local has unpushed commits";
  if (!pr.checksPassed) return "Checks have not all passed";
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

async function openOrCreatePr(
  repo: string,
  name: string,
  title: string,
  body: string,
): Promise<{
  url: string;
  number: number;
  created: boolean;
  warnings: string[];
}> {
  checkRepoName(repo);
  checkBranchName(name, "worktree name");

  const listing = await readListing();
  const found = listing.worktrees.find(
    (w) => w.repo === repo && w.name === name,
  );
  if (!found) throw new Error(`Worktree not found: ${name}@${repo}`);
  const cwd = found.path;

  const viewPr = async (): Promise<{ url: string; number: number } | null> => {
    const result = await runCmd(
      "gh",
      ["pr", "view", "--json", PR_VIEW_FIELDS],
      cwd,
    );
    return result.code === 0 ? parsePrView(result.stdout) : null;
  };

  const existing = await viewPr();
  if (existing) return { ...existing, created: false, warnings: [] };

  // `gh pr create` switches the branch upstream to the new PR branch.
  // Snapshot it and put it back (or remove what gh added) afterwards.
  const upstreamOf = async (): Promise<string> => {
    const result = await runCmd(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      cwd,
    );
    return result.code === 0 ? result.stdout.trim() : "";
  };

  if (!title.trim() && body.trim()) {
    throw new Error("A PR subject is required when a body is provided.");
  }

  const warnings: string[] = [];
  const before = await upstreamOf();
  try {
    const created = await runCmd(
      "gh",
      title.trim() || body.trim()
        ? ["pr", "create", "--title", title, "--body", body]
        : ["pr", "create", "--fill"],
      cwd,
      180_000,
    );
    if (created.code !== 0) {
      throw new Error(
        created.stderr.trim() || `gh pr create failed (exit ${created.code})`,
      );
    }
  } finally {
    try {
      const after = await upstreamOf();
      if (before && after !== before) {
        const restored = await runCmd(
          "git",
          ["branch", `--set-upstream-to=${before}`],
          cwd,
        );
        if (restored.code !== 0) {
          warnings.push(
            `Upstream was ${before}; could not restore it: ${restored.stderr.trim()}`,
          );
        }
      } else if (!before && after) {
        const unset = await runCmd("git", ["branch", "--unset-upstream"], cwd);
        if (unset.code !== 0) {
          warnings.push(
            `Could not remove upstream ${after} that gh set: ${unset.stderr.trim()}`,
          );
        }
      }
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }
  }

  const opened = await viewPr();
  if (!opened) {
    throw new Error(
      "PR create reported success but no PR is visible; refresh and inspect before retrying.",
    );
  }
  return { ...opened, created: true, warnings };
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
    "Fetch all Timber remotes so merged PRs show as Merged (timber git @repo -- fetch).",
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

  // Refresh the open-PR cache in the background and tell tabs to re-read
  // state when it lands. Stale-while-revalidate: state serves the cache
  // immediately and only one refresh runs at a time.
  const refreshPrCache = async (worktrees: Worktree[]): Promise<void> => {
    if (prRefreshing) return;
    prRefreshing = true;
    try {
      const entries = await Promise.all(
        worktrees.map(async (w) => {
          const key = `${w.repo}\0${w.name}`;
          const [viewed, push] = await Promise.all([
            runCmd("gh", ["pr", "view", "--json", PR_VIEW_FIELDS], w.path),
            pushInfo(w.path, w.name),
          ]);
          const pr = viewed.code === 0 ? parsePrView(viewed.stdout) : null;
          if (pr) {
            return [
              key,
              {
                number: pr.number,
                url: pr.url,
                destExists: push.destExists,
                unpushed: push.unpushed,
                ff: push.ff,
                mergeBlocker: mergeBlocker(pr, push),
              },
            ] as const;
          }
          return [key, push] as const;
        }),
      );
      const map: Record<string, PrEntry> = {};
      for (const entry of entries) {
        if (entry) map[entry[0]] = entry[1];
      }
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
      warnings: string[];
    }> => {
      try {
        const repo = typeof body["repo"] === "string" ? body["repo"] : "";
        const name = typeof body["name"] === "string" ? body["name"] : "";
        const title = typeof body["title"] === "string" ? body["title"] : "";
        const prBody = typeof body["body"] === "string" ? body["body"] : "";
        const result = await openOrCreatePr(repo, name, title, prBody);
        // Warm the PR cache so the row's upload icon can appear without
        // waiting for the next background refresh.
        try {
          const listing = await readListing();
          const found = listing.worktrees.find(
            (w) => w.repo === repo && w.name === name,
          );
          if (found) {
            const push = await pushInfo(found.path, name);
            const key = `${repo}\0${name}`;
            prCache = {
              at: Date.now(),
              map: {
                ...(prCache?.map ?? {}),
                [key]: {
                  number: result.number,
                  url: result.url,
                  destExists: push.destExists,
                  unpushed: push.unpushed,
                  ff: push.ff,
                  mergeBlocker: mergeBlocker(
                    { ...result, draft: false, checksPassed: false },
                    push,
                  ),
                },
              },
            };
            try {
              web.send("fetched", { at: prCache.at });
            } catch {
              // Tabs may be gone; the next poll picks up the listing.
            }
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
    async ({ body }): Promise<{ merged: number; url: string }> => {
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
        const viewed = await runCmd(
          "gh",
          ["pr", "view", "--json", PR_VIEW_FIELDS],
          found.path,
        );
        const pr = viewed.code === 0 ? parsePrView(viewed.stdout) : null;
        if (!pr) throw web.error(409, `No open PR for ${name}@${repo}`);
        const blocker = mergeBlocker(pr, await pushInfo(found.path, name));
        if (blocker) {
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
        prCache = null;
        return { merged: pr.number, url: pr.url };
      } catch (error) {
        if (error instanceof Error && "status" in error) throw error;
        const message = error instanceof Error ? error.message : "merge failed";
        throw web.error(502, message);
      }
    },
  );

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
    tools: [timberList, timberCreate, timberRemove, timberRepoAdd, timberFetch],
  });
}
