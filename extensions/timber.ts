/**
 * Timber worktrees: list, create, open sessions in, and safely remove managed Git worktrees, from a side panel.
 * Wraps the `timber` CLI on the server (with `gh` for pull requests): listing, creation, safe removal, periodic fetching so merged branches show as Merged, and open-or-create PR per worktree.
 */
import { execFile as execFileCb } from "node:child_process";
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
};

// Last background `timber git @repo -- fetch` run. In-memory only: a reload refetches.
let lastFetchAt: number | null = null;
let lastFetchError: string | null = null;
let fetching = false;

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

async function openOrCreatePr(
  repo: string,
  name: string,
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
      ["pr", "view", "--json", "number,url"],
      cwd,
    );
    if (result.code !== 0) return null;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (
        isRecord(parsed) &&
        typeof parsed["url"] === "string" &&
        typeof parsed["number"] === "number"
      ) {
        return { url: parsed["url"], number: parsed["number"] };
      }
    } catch {
      // Fall through to create.
    }
    return null;
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

  const warnings: string[] = [];
  const before = await upstreamOf();
  try {
    const created = await runCmd(
      "gh",
      ["pr", "create", "--fill"],
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

  const effectiveModel = (request: {
    conversation?: { model?: unknown };
    body?: Record<string, unknown>;
  }): string | undefined => {
    const allowed = allowedModels();
    const asked =
      request.body && typeof request.body["model"] === "string"
        ? (request.body["model"] as string).trim()
        : "";
    if (asked) return asked;
    if (allowed.length === 0) return undefined;
    const src = request.conversation?.model as
      | string
      | { provider?: unknown; modelId?: unknown; id?: unknown }
      | undefined;
    let srcSpec: string | undefined;
    if (typeof src === "string") srcSpec = src;
    else if (src && typeof src.provider === "string") {
      if (typeof src.modelId === "string")
        srcSpec = `${src.provider}/${src.modelId}`;
      else if (typeof src.id === "string")
        srcSpec = `${src.provider}/${src.id}`;
    }
    if (srcSpec && allowed.includes(srcSpec)) return undefined;
    return allowed[0];
  };

  web.route("GET", "state", async (): Promise<State & { models: string[] }> => {
    try {
      const listing = await readListing();
      return {
        ...listing,
        at: Date.now(),
        fetchedAt: lastFetchAt,
        fetchError: lastFetchError,
        models: allowedModels(),
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
        return await openOrCreatePr(repo, name);
      } catch (error) {
        const message = error instanceof Error ? error.message : "pr failed";
        if (message.includes("not found")) throw web.error(404, message);
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

  // Open a session in a worktree's folder. Browser can't create sessions,
  // so the panel (session-bound) calls this conversation-bound route,
  // which starts a linked session with cwd set to the worktree path.
  if (typeof web.conversationRoute === "function") {
    web.conversationRoute(
      "POST",
      "open/:source",
      async (request) => {
        try {
          const repo =
            typeof request.body["repo"] === "string"
              ? request.body["repo"]
              : "";
          const name =
            typeof request.body["name"] === "string"
              ? request.body["name"]
              : "";
          const key =
            typeof request.body["key"] === "string" ? request.body["key"] : "";
          if (!key.trim())
            throw web.error(400, "Missing open key; reload the panel.");
          checkRepoName(repo);
          checkBranchName(name, "worktree name");
          const listing = await readListing();
          const found = listing.worktrees.find(
            (w) => w.repo === repo && w.name === name,
          );
          if (!found)
            throw web.error(404, `Worktree not found: ${name}@${repo}`);
          const model = effectiveModel(request);
          const started = await request.linkedSessions.start(
            {
              title: `${name}@${repo}`,
              message: `Working in worktree ${name}@${repo} at ${found.path}.`,
              cwd: found.path,
              ...(model ? { model } : {}),
            },
            `x.timber.open:${key.trim()}`,
          );
          return started;
        } catch (error) {
          if (error instanceof Error && "status" in error) throw error;
          const message =
            error instanceof Error ? error.message : "open failed";
          throw web.error(502, message);
        }
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
