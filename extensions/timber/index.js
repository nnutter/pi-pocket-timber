// Timber browser module: a rail page that lists Timber worktrees, with create / add / remove.
// The app loads this and calls its default export with `pocket`.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

export default function setup(pocket) {
  const { html, useEffect, useState, useRef, Loader, Spinner, Icon } = pocket;

  // The Timber icon: two nodes on a branch, for the rail button and the panel's
  // button.
  const TIMBER_ICON =
    "M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v2.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8M12 12v4";

  // Status items in a worktree row share the 24px height of the row buttons.
  const ROW_ITEM = {
    display: "inline-flex",
    alignItems: "center",
    height: "28px",
    boxSizing: "border-box",
    fontSize: "13px",
    whiteSpace: "nowrap",
  };

  // The sort modes: the id that `sort` holds, the label, and the icon path.
  const SORT_MODES = [
    {
      id: "recent",
      label: "Activity",
      d: "M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm7-3.25v2.992l2.028.812a.75.75 0 0 1-.557 1.392l-2.5-1A.751.751 0 0 1 7 8.25v-3.5a.75.75 0 0 1 1.5 0Z",
    },
    {
      id: "repo",
      label: "Repository Name",
      d: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
    },
    {
      id: "name",
      label: "Worktree Name",
      d: "M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.251 1.251 0 0 1 0-2.162ZM8.125 1.69a.248.248 0 0 0-.25 0l-4.63 2.685 4.63 2.685a.248.248 0 0 0 .25 0l4.63-2.685ZM1.601 7.789a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0L1.874 8.814A.75.75 0 0 1 1.6 7.789Zm0 3.5a.75.75 0 0 1 1.025-.273l5.249 3.044a.248.248 0 0 0 .25 0l5.249-3.044a.75.75 0 0 1 .752 1.298l-5.248 3.044a1.75 1.75 0 0 1-1.756 0l-5.248-3.044a.75.75 0 0 1-.273-1.025Z",
    },
  ];

  /** The key that names one worktree's row, in the state's PR map and its ids. */
  function rowKey(w) {
    return `${w.repo}\0${w.name}`;
  }

  /** The action id for a verb on one worktree row. */
  function rowAction(verb, w) {
    return `${verb}\0${rowKey(w)}`;
  }

  /**
   * The color of a row's one action button: green when the button can do its
   * job on a clean worktree, amber while the worktree is dirty or the pull
   * request's checks are still running, red when something is in the way, and
   * purple for a removal. A button that cannot work is not drawn at all.
   *
   * Push, a new pull request, running checks and a removal wear the dimmer
   * shade of their color; a merge and the two reds wear the color itself.
   */
  function actionColor(action, w, checks) {
    if (action === "delete") return dimShade("#8957e5");
    if (action === "merge") return "var(--ok)";
    if (action === "push" || action === "create-pr") {
      return dimShade(w.clean && !w.statusError ? "var(--ok)" : "var(--warn)");
    }
    if (action === "open-pr") {
      return checks === "failed" ? "var(--err)" : dimShade("var(--warn)");
    }
    if (action === "blocked") return "var(--err)";
    return "var(--muted)";
  }

  /** A color drawn back into the row's background, as the picker's shade 1. */
  function dimShade(color) {
    return `color-mix(in srgb, ${color} 78%, var(--bg))`;
  }

  /** The key that names one worktree's row, in the state's PR map and its ids. */
  function rowKey(w) {
    return `${w.repo}\0${w.name}`;
  }

  /** The action id for a verb on one worktree row. */
  function rowAction(verb, w) {
    return `${verb}\0${rowKey(w)}`;
  }

  /** The verbs whose ids name one worktree's row actions. */
  const ROW_VERBS = ["open", "pr", "push", "merge", "remove"];

  /** The action ids that rewrite the listing, so the toolbar and forms wait. */
  const TOOLBAR_ACTIONS = ["create", "add", "refresh"];

  // Calls the app's own API as the person in this tab. The module's routes run
  // on the server, which cannot create or archive a session as a person; the
  // browser can, with the same calls the app's own pages make.
  async function callApp(path, body) {
    const response = await fetch(`/api/${path}`, {
      method: "POST",
      headers: { "X-Pocket": "1", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // A plain-text answer from the server: reported below.
    }
    if (!response.ok) {
      throw new Error(
        (payload && payload.error) ||
          text.slice(0, 200) ||
          `HTTP ${response.status}`,
      );
    }
    return payload;
  }

  function TimberPage() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState("");
    // The ids of the actions in flight. Each one locks what it changes: a
    // row's action locks that row, and the actions that rewrite the listing
    // lock the toolbar and the forms.
    const [running, setRunning] = useState(() => new Set());
    const toolbarBusy = TOOLBAR_ACTIONS.some((id) => running.has(id));
    /** True while an action runs on this worktree's row. */
    const rowBusy = (w) =>
      ROW_VERBS.some((verb) => running.has(rowAction(verb, w)));
    // True while a background list reload is in flight. Row buttons lock
    // so a tap can't land on a row that is about to move.
    const [listingBusy, setListingBusy] = useState(false);
    // A phone-width panel shows how far the branch leads, not how far it lags:
    // the two numbers and two buttons do not share the line there.
    const [showBehind, setShowBehind] = useState(
      () =>
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function" ||
        !window.matchMedia("(max-width: 600px)").matches,
    );
    const listingCount = useRef(0);
    const [search, setSearch] = useState("");
    // The folder of the session this tab shows, or null. The pin needs it and
    // the page cannot read it, so the server answers it.
    const [sessionPath, setSessionPath] = useState(null);
    const [sort, setSort] = useState("recent");
    const [creating, setCreating] = useState(false);
    const [adding, setAdding] = useState(false);
    const [createRepo, setCreateRepo] = useState("");
    const [name, setName] = useState("");
    const [upstream, setUpstream] = useState("");
    const [source, setSource] = useState("");
    const [repoName, setRepoName] = useState("");
    const [alias, setAlias] = useState("");
    const [confirmKey, setConfirmKey] = useState(null);
    const [prWorktree, setPrWorktree] = useState(null);
    const [prTitle, setPrTitle] = useState("");
    const [prBody, setPrBody] = useState("");
    const [drafting, setDrafting] = useState(false);
    const draftRun = useRef(0);
    const confirmTimer = useRef(null);
    const [mergeKey, setMergeKey] = useState(null);
    const mergeTimer = useRef(null);
    // The id of the open popover ("add"), or null. Each popover's anchor
    // element is kept in menuAnchors so an outside tap can close it.
    const [openMenu, setOpenMenu] = useState(null);
    const menuAnchors = useRef({});

    useEffect(() => {
      if (openMenu === null) return undefined;
      const anchor = menuAnchors.current[openMenu];
      const onDown = (event) => {
        if (anchor && !anchor.contains(event.target)) {
          setOpenMenu(null);
        }
      };
      const onKey = (event) => {
        if (event.key === "Escape") setOpenMenu(null);
      };
      document.addEventListener("pointerdown", onDown);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("pointerdown", onDown);
        document.removeEventListener("keydown", onKey);
      };
    }, [openMenu]);

    // Mark one action's id as running or done, so a spinner shows for it and
    // nothing else starts it again. A set is replaced rather than changed: the
    // page re-renders when it is a new one.
    const startAction = (id) => {
      setRunning((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    };
    const endAction = (id) => {
      setRunning((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    };

    // A button's content, or a spinner in its place while its action runs.
    // The spinner is 0.85em, so 19px makes it 16px, the size of the icons, and
    // the fixed box keeps the button from shifting while it spins.
    const inFlight = (id, label, content) =>
      running.has(id)
        ? html`<span
            style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "16px", height: "16px", fontSize: "19px" }}
            ><${Spinner} label=${label}
          /></span>`
        : content;

    const doRefresh = async () => {
      startAction("refresh");
      setNotice("");
      try {
        await pocket.api("fetch", {}, { method: "POST" });
        const state = await pocket.api("state");
        setData(state);
        setError(
          state.fetchError ? `Fetch reported: ${state.fetchError}` : null,
        );
      } catch (failure) {
        setError(
          failure && failure.message ? failure.message : "Refresh failed",
        );
      } finally {
        endAction("refresh");
      }
    };

    const timeAgo = (at) => {
      if (!at) return "never";
      const s = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      return `${Math.floor(m / 60)}h ago`;
    };

    useEffect(() => {
      let alive = true;
      const readFolder = (id) => {
        if (id === null) {
          if (alive) setSessionPath(null);
          return;
        }
        void pocket
          .api(`folder?session=${id}`)
          .then((answer) => {
            if (alive) setSessionPath((answer && answer.path) || null);
          })
          .catch(() => {
            if (alive) setSessionPath(null);
          });
      };
      readFolder(pocket.conversationId());
      const stop =
        typeof pocket.onConversation === "function"
          ? pocket.onConversation((id) => readFolder(id))
          : () => undefined;
      return () => {
        alive = false;
        stop();
      };
    }, []);

    useEffect(() => {
      let alive = true;
      const load = async () => {
        listingCount.current += 1;
        if (alive) setListingBusy(true);
        try {
          const state = await pocket.api("state");
          if (alive) {
            setData(state);
            setError(null);
          }
        } catch (failure) {
          if (alive)
            setError(
              failure && failure.message ? failure.message : "Timber failed",
            );
        } finally {
          listingCount.current -= 1;
          if (alive && listingCount.current === 0) setListingBusy(false);
        }
      };
      void load();
      const timer = setInterval(() => {
        void load();
      }, 15000);
      const stopFetched = pocket.on("fetched", () => {
        void load();
      });
      return () => {
        alive = false;
        clearInterval(timer);
        stopFetched();
      };
    }, []);

    useEffect(() => {
      if (
        typeof window === "undefined" ||
        typeof window.matchMedia !== "function"
      ) {
        return undefined;
      }
      const narrow = window.matchMedia("(max-width: 600px)");
      const update = () => setShowBehind(!narrow.matches);
      narrow.addEventListener("change", update);
      return () => narrow.removeEventListener("change", update);
    }, []);

    useEffect(
      () => () => {
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        if (mergeTimer.current) clearTimeout(mergeTimer.current);
        draftRun.current += 1;
      },
      [],
    );

    const armRemove = (key) => {
      setConfirmKey(key);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmKey(null), 5000);
    };

    const armMerge = (key) => {
      setMergeKey(key);
      if (mergeTimer.current) clearTimeout(mergeTimer.current);
      mergeTimer.current = setTimeout(() => setMergeKey(null), 5000);
    };

    const doCreate = async (event) => {
      event.preventDefault();
      const repo = (createRepo || (data && data.repositories[0]) || "").trim();
      if (!repo) {
        setError("Select a repository first.");
        return;
      }
      startAction("create");
      setNotice("");
      try {
        const result = await pocket.api(
          "create",
          { repo, name: name.trim(), upstream: upstream.trim() },
          { method: "POST" },
        );
        setNotice(`Created ${result.worktree.name}@${result.worktree.repo}.`);
        setCreating(false);
        setName("");
        setUpstream("");
        const state = await pocket.api("state");
        setData(state);
        setError(null);
        // A new worktree is for working in, so open its session now. A failure
        // here leaves the worktree made; the row's open button still works.
        try {
          await startSession(result.worktree);
        } catch (failure) {
          setNotice(
            `Created ${result.worktree.name}@${result.worktree.repo}, but its session did not open: ${failure && failure.message ? failure.message : "unknown error"}`,
          );
        }
      } catch (failure) {
        setError(
          failure && failure.message ? failure.message : "Create failed",
        );
      } finally {
        endAction("create");
      }
    };

    const doAdd = async (event) => {
      event.preventDefault();
      if (!source.trim()) {
        setError("Enter a repository URL or path.");
        return;
      }
      startAction("add");
      setNotice("");
      try {
        const result = await pocket.api(
          "repositories",
          { source: source.trim(), name: repoName.trim(), alias: alias.trim() },
          { method: "POST" },
        );
        setNotice(`Added repository ${result.repository}.`);
        setAdding(false);
        setSource("");
        setRepoName("");
        setAlias("");
        const state = await pocket.api("state");
        setData(state);
        setError(null);
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "Add failed");
      } finally {
        endAction("add");
      }
    };

    // A session's folder is gone once its worktree is, so the sessions that
    // worked there go to the archive too: the app keeps them, and brings one
    // back when someone needs it. It answers how many it archived, of how many.
    const archiveSessions = async (path) => {
      let answer;
      try {
        answer = await pocket.api(`sessions?path=${encodeURIComponent(path)}`);
      } catch {
        // The sessions are unknown, so the notice says nothing about them.
        return null;
      }
      const ids = ((answer && answer.sessions) || []).map(
        (session) => session.id,
      );
      const results = await Promise.allSettled(
        ids.map((id) => callApp(`sessions/${id}`, { archived: true })),
      );
      return {
        total: ids.length,
        done: results.filter((result) => result.status === "fulfilled").length,
      };
    };

    // What the notice says about the sessions that went with the worktree.
    const archivedWords = (archived) => {
      if (!archived || archived.total === 0) return "";
      const many =
        archived.total === 1 ? "1 session" : `${archived.total} sessions`;
      return archived.done === archived.total
        ? ` Archived ${many}.`
        : ` Archived ${archived.done} of ${many}.`;
    };

    const doRemove = async (worktree) => {
      const key = `${worktree.repo}\0${worktree.name}`;
      if (confirmKey !== key) {
        armRemove(key);
        return;
      }
      setConfirmKey(null);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      startAction(rowAction("remove", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          "remove",
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        const archived = await archiveSessions(worktree.path);
        setNotice(`Removed ${result.removed}.${archivedWords(archived)}`);
        const state = await pocket.api("state");
        setData(state);
        setError(null);
      } catch (failure) {
        setError(
          failure && failure.message ? failure.message : "Remove failed",
        );
      } finally {
        endAction(rowAction("remove", worktree));
      }
    };

    // Start a plain session in a worktree's folder and show it. The app's own
    // endpoint creates it without a link to this session: a linked session
    // would make this one the root of an Agent Teams team, and the person is
    // opening a worktree to work in, not to orchestrate. The title is the
    // Timber name, so a row of sessions says which worktree each one is in.
    const startSession = async (worktree) => {
      const payload = await callApp("sessions", {
        cwd: worktree.path,
        title: `${worktree.name}@${worktree.repo}`,
      });
      const target = payload && payload.id;
      if (typeof target !== "number") {
        throw new Error("The session did not open.");
      }
      pocket.openConversation(target);
    };

    const doOpen = async (worktree) => {
      startAction(rowAction("open", worktree));
      setNotice("");
      try {
        await startSession(worktree);
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "Open failed");
      } finally {
        endAction(rowAction("open", worktree));
      }
    };

    // The PR is not opened in a tab here: the row links it, so the person
    // decides where to read it.
    const doPr = async (worktree, title, body) => {
      startAction(rowAction("pr", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          "pr",
          { repo: worktree.repo, name: worktree.name, title, body },
          { method: "POST" },
        );
        // Close this row's form only: another row may have opened one while
        // this PR was being created.
        setPrWorktree((open) =>
          open && open.repo === worktree.repo && open.name === worktree.name
            ? null
            : open,
        );
        setNotice(
          [
            result.created
              ? `Created PR #${result.number}.`
              : `PR #${result.number} already exists.`,
            ...(result.warnings || []),
          ].join(" "),
        );
        setError(null);
        // Re-read so the row shows the PR and its merge state. The server
        // warmed its PR cache before it answered.
        try {
          setData(await pocket.api("state"));
        } catch {
          // The PR exists; the next poll shows it.
        }
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "PR failed");
      } finally {
        endAction(rowAction("pr", worktree));
      }
    };

    // One request: the server runs the `pi` CLI in the worktree and answers
    // with a draft. The wait can be minutes, so the form shows a spinner and
    // leaves manual entry available.
    const doDraft = async (worktree) => {
      const source = pocket.conversationId();
      if (source == null) {
        setError("Open a session to generate a PR draft.");
        return;
      }
      const run = ++draftRun.current;
      const active = () =>
        run === draftRun.current && pocket.conversationId() === source;
      setDrafting(true);
      setError(null);
      try {
        const draft = await pocket.api(
          `pr-draft/${source}`,
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        if (!active()) return;
        setPrTitle(draft.title);
        setPrBody(draft.body);
      } catch (failure) {
        if (active()) {
          setError(
            failure && failure.message
              ? failure.message
              : "Draft generation failed",
          );
        }
      } finally {
        if (run === draftRun.current) setDrafting(false);
      }
    };

    const doPush = async (worktree) => {
      startAction(rowAction("push", worktree));
      setNotice("");
      try {
        await pocket.api(
          "push",
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        const state = await pocket.api("state");
        setData(state);
        setError(
          state.fetchError ? `Fetch reported: ${state.fetchError}` : null,
        );
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "Push failed");
      } finally {
        endAction(rowAction("push", worktree));
      }
    };

    // Merging is the one action here that cannot be undone from the panel, so
    // it takes two clicks. The server re-checks readiness before it merges.
    const doMerge = async (worktree) => {
      const key = `${worktree.repo}\0${worktree.name}`;
      if (mergeKey !== key) {
        armMerge(key);
        return;
      }
      setMergeKey(null);
      if (mergeTimer.current) clearTimeout(mergeTimer.current);
      startAction(rowAction("merge", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          "merge",
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        setNotice(`Merged PR #${result.merged}.`);
        const state = await pocket.api("state");
        setData(state);
        setError(null);
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "Merge failed");
      } finally {
        endAction(rowAction("merge", worktree));
      }
    };

    const currentSort =
      SORT_MODES.find((mode) => mode.id === sort) || SORT_MODES[0];
    const cycleSort = () => {
      const at = SORT_MODES.indexOf(currentSort);
      setSort(SORT_MODES[(at + 1) % SORT_MODES.length].id);
    };
    const sortIcon = (mode) =>
      html`<svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d=${mode.d} />
      </svg>`;

    const worktrees = (data && data.worktrees) || [];
    const needle = search.trim().toLowerCase();

    // The worktree the session this tab shows works in: its own folder, or the
    // deepest worktree folder that holds the session's, since a session can
    // start below a worktree's root. Null when this tab shows no session, or
    // one that works somewhere else.
    const pinnedKey = (() => {
      if (!sessionPath) return null;
      let best = null;
      for (const w of worktrees) {
        const root = (w.path || "").replace(/\/+$/, "");
        if (!root) continue;
        if (sessionPath !== root && !sessionPath.startsWith(`${root}/`)) {
          continue;
        }
        if (!best || root.length > best.length) {
          best = { length: root.length, key: rowKey(w) };
        }
      }
      return best ? best.key : null;
    })();
    const pinned =
      (pinnedKey && worktrees.find((w) => rowKey(w) === pinnedKey)) || null;

    const filtered = worktrees
      .filter((w) => {
        if (pinned && rowKey(w) === pinnedKey) return false;
        if (!needle) return true;
        const fields = [
          `${w.name}@${w.repo}`,
          `${w.name} @ ${w.repo}`,
          w.name,
          w.repo,
          w.path || "",
          w.upstream || "",
          w.clean ? "clean" : "dirty",
          w.merged ? "merged" : "",
          w.statusError ? "status error" : "",
          `ahead ${w.ahead ?? 0}`,
          `behind ${w.behind ?? 0}`,
          w.todoTotal !== undefined
            ? `todo ${w.todoDone ?? 0}/${w.todoTotal}`
            : "",
          w.pullRequest || "",
        ];
        return fields.some((f) => f.toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        if (sort === "repo")
          return a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name);
        if (sort === "name")
          return a.name.localeCompare(b.name) || a.repo.localeCompare(b.repo);
        return 0;
      });

    // The session's worktree stays in view and first, whatever the search and
    // the sort say, so the row a person is working in does not move away.
    const rows = pinned ? [pinned, ...filtered] : filtered;

    const safeToRemove = (w) =>
      w.clean &&
      !w.statusError &&
      (w.merged || ((w.ahead ?? 0) === 0 && (w.behind ?? 0) === 0));

    if (!data && !error) {
      return html`<${Loader} label="Reading Timber" />`;
    }

    return html`<section
      style=${{
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        height: "100%",
        padding: "12px 12px 0",
        fontSize: "13px",
      }}
    >
      <div
        style=${{ display: "grid", gridTemplateColumns: "auto minmax(0,1fr) auto", gap: "8px" }}
      >
        <div
          ref=${(el) => {
            menuAnchors.current.add = el;
          }}
          style=${{ position: "relative", display: "inline-flex", flex: "none" }}
        >
          <div
            style=${{ display: "inline-flex", alignItems: "stretch", border: "1px solid var(--line)", borderRadius: "4px", overflow: "hidden" }}
          >
            <button
              type="button"
              class="button small"
              disabled=${toolbarBusy || !data || data.repositories.length === 0}
              title="New worktree"
              aria-label="New worktree"
              onClick=${() => {
                setOpenMenu(null);
                setCreating((v) => !v);
              }}
              style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 10px", border: "none", borderRadius: "0", background: "transparent" }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                style=${{ flexShrink: 0 }}
              >
                <path
                  d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.25 1.25 0 0 1 0-2.162ZM8.125 1.69a.25.25 0 0 0-.25 0L3.244 4.375 7.875 7.06a.25.25 0 0 0 .25 0l4.63-2.685ZM1.602 7.789a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296L1.874 8.813a.75.75 0 0 1-.272-1.024m0 3.5a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296l-5.248-3.044a.75.75 0 0 1-.272-1.024M11.75 15.25v-2h-2a.75.75 0 0 1 0-1.5h2v-2a.75.75 0 0 1 1.5 0v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0"
                />
              </svg>
            </button>
            <span
              aria-hidden="true"
              style=${{ width: "1px", background: "var(--line)" }}
            ></span>
            <button
              type="button"
              class="button small"
              disabled=${toolbarBusy}
              title="More ways to add"
              aria-label="More ways to add"
              aria-haspopup="menu"
              aria-expanded=${openMenu === "add"}
              onClick=${() => setOpenMenu(openMenu === "add" ? null : "add")}
              style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 8px", border: "none", borderRadius: "0", background: "transparent" }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"
                />
              </svg>
            </button>
          </div>
          ${
            openMenu === "add" &&
            html`<div
              role="menu"
              style=${{ position: "absolute", top: "calc(100% + 4px)", left: "0", zIndex: "5", minWidth: "170px", padding: "4px", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
            >
              <button
                type="button"
                role="menuitem"
                style=${{ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "8px 10px", border: "none", borderRadius: "4px", background: "transparent", color: "var(--text)", textAlign: "left", whiteSpace: "nowrap", cursor: "pointer" }}
                onClick=${() => {
                  setOpenMenu(null);
                  setAdding(true);
                }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                  aria-hidden="true"
                  style=${{ flexShrink: 0 }}
                >
                  <path
                    d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75V6a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 3.5 9h3a.75.75 0 0 1 0 1.5h-3a1 1 0 0 0 0 2h3a.75.75 0 0 1 0 1.5h-3A2.5 2.5 0 0 1 1 11.5v-9Z"
                  />
                  <path
                    d="M12.21 13.479a.75.75 0 1 0 1.061 1.061l2.504-2.505a.75.75 0 0 0 0-1.061L13.271 8.47a.75.75 0 0 0-1.061 1.06l1.224 1.225H8.75a.75.75 0 1 0 0 1.5h4.685l-1.225 1.224Z"
                  />
                </svg>
                <span>Import repo</span>
              </button>
            </div>`
          }
        </div>
        <input
          type="search"
          aria-label="Find worktrees"
          value=${search}
          placeholder="Search worktrees"
          onInput=${(e) => setSearch(e.target.value)}
        />
        <div
          ref=${(el) => {
            menuAnchors.current.sort = el;
          }}
          style=${{ position: "relative", display: "inline-flex", flex: "none" }}
        >
          <div
            style=${{ display: "inline-flex", alignItems: "stretch", border: "1px solid var(--line)", borderRadius: "4px", overflow: "hidden" }}
          >
            <button
              type="button"
              class="button small"
              title="Choose how to sort"
              aria-label="Choose how to sort"
              aria-haspopup="menu"
              aria-expanded=${openMenu === "sort"}
              onClick=${() => setOpenMenu(openMenu === "sort" ? null : "sort")}
              style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 8px", border: "none", borderRadius: "0", background: "transparent" }}
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"
                />
              </svg>
            </button>
            <span
              aria-hidden="true"
              style=${{ width: "1px", background: "var(--line)" }}
            ></span>
            <button
              type="button"
              class="button small"
              title=${`Sort: ${currentSort.label}. Click to change the order.`}
              aria-label=${`Sort: ${currentSort.label}`}
              onClick=${cycleSort}
              style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 10px", border: "none", borderRadius: "0", background: "transparent" }}
            >
              ${sortIcon(currentSort)}
            </button>
          </div>
          ${
            openMenu === "sort" &&
            html`<div
              role="menu"
              style=${{ position: "absolute", top: "calc(100% + 4px)", right: "0", zIndex: "5", minWidth: "170px", padding: "4px", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "6px", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}
            >
              ${SORT_MODES.map(
                (mode) =>
                  html`<button
                    key=${mode.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked=${mode.id === sort}
                    style=${{ display: "flex", alignItems: "center", gap: "8px", width: "100%", padding: "8px 10px", border: "none", borderRadius: "4px", background: mode.id === sort ? "var(--line)" : "transparent", color: "var(--text)", textAlign: "left", whiteSpace: "nowrap", cursor: "pointer" }}
                    onClick=${() => {
                      setSort(mode.id);
                      setOpenMenu(null);
                    }}
                  >
                    ${sortIcon(mode)}
                    <span>${mode.label}</span>
                  </button>`,
              )}
            </div>`
          }
        </div>
      </div>
      <div
        style=${{ flex: "1", minHeight: "0", overflowY: "auto", display: "flex", flexDirection: "column", gap: "10px" }}
      >
        ${error && html`<div class="error-box">${error}</div>`}
        ${notice && html`<div class="small" role="status">${notice}</div>`}
        ${
          data &&
          data.warnings &&
          data.warnings.length > 0 &&
          html`<div class="small muted">
            ${data.warnings.map((w, i) => html`<p key=${i}>${w}</p>`)}
          </div>`
        }
        ${
          adding &&
          html`<form
            onSubmit=${doAdd}
            style=${{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              border: "1px solid var(--line)",
              borderRadius: "4px",
              padding: "10px",
            }}
          >
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Repository URL or path</span>
              <input
                value=${source}
                disabled=${toolbarBusy}
                onInput=${(e) => setSource(e.target.value)}
                placeholder="git@github.com:org/repo or /path/to/repo"
              />
            </label>
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Repository name (optional)</span>
              <input
                value=${repoName}
                disabled=${toolbarBusy}
                onInput=${(e) => setRepoName(e.target.value)}
              />
            </label>
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Alias (optional)</span>
              <input
                value=${alias}
                disabled=${toolbarBusy}
                onInput=${(e) => setAlias(e.target.value)}
              />
            </label>
            <div style=${{ display: "flex", gap: "6px" }}>
              <button
                class="button primary"
                type="submit"
                disabled=${toolbarBusy || !source.trim()}
              >
                ${inFlight("add", "Add repo", "Add repo")}
              </button>
              <button
                type="button"
                class="button"
                disabled=${toolbarBusy}
                onClick=${() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          </form>`
        }
        ${
          creating &&
          html`<form
            onSubmit=${doCreate}
            style=${{
              display: "flex",
              flexDirection: "column",
              gap: "8px",
              border: "1px solid var(--line)",
              borderRadius: "4px",
              padding: "10px",
            }}
          >
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Repository</span>
              <select
                value=${createRepo || (data && data.repositories[0]) || ""}
                disabled=${toolbarBusy}
                onChange=${(e) => setCreateRepo(e.target.value)}
              >
                ${(data ? data.repositories : []).map(
                  (r) => html`<option key=${r} value=${r}>${r}</option>`,
                )}
              </select>
            </label>
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small"
                >Branch name (optional — Timber chooses when empty)</span
              >
              <input
                value=${name}
                disabled=${toolbarBusy}
                placeholder="Let Timber choose"
                onInput=${(e) => setName(e.target.value)}
              />
            </label>
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Upstream (optional)</span>
              <input
                value=${upstream}
                disabled=${toolbarBusy}
                placeholder="Repository default"
                onInput=${(e) => setUpstream(e.target.value)}
              />
            </label>
            <div style=${{ display: "flex", gap: "6px" }}>
              <button
                class="button primary"
                type="submit"
                disabled=${toolbarBusy}
              >
                ${inFlight("create", "Create worktree", "Create worktree")}
              </button>
              <button
                type="button"
                class="button"
                disabled=${toolbarBusy}
                onClick=${() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>`
        }
        ${
          data &&
          rows.length === 0 &&
          html`<p>
            ${worktrees.length ? "No matching worktrees." : "No worktrees yet. Create one above."}
          </p>`
        }

        <ul
          style=${{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
        >
          ${rows.map((w) => {
            const key = rowKey(w);
            const armed = confirmKey === key;
            const cachePr = data && data.prs ? data.prs[key] : null;
            // The open PR comes from the server's own `gh pr view` read in the
            // worktree's folder, so it also finds PRs made outside this page,
            // in a session or on GitHub itself.
            const prUrl = (cachePr && cachePr.url) || null;
            const repoUrl =
              cachePr && cachePr.repo
                ? `https://github.com/${cachePr.repo}`
                : null;
            const prLabel =
              cachePr && cachePr.number !== undefined
                ? `PR #${cachePr.number}`
                : w.pullRequest
                  ? `PR ${w.pullRequest}`
                  : null;
            // Compare with origin/<branch> when it exists. For a new remote
            // branch, compare with the upstream to find commits to publish.
            const canUpload = Boolean(
              cachePr && cachePr.unpushed > 0 && cachePr.ff && !w.statusError,
            );
            // origin/<branch> has commits this branch lacks, so a PR would
            // publish the wrong history. Block it until the branch is synced.
            const behindRemote = Boolean(
              cachePr && cachePr.destExists && !cachePr.ff && !w.statusError,
            );
            // The merge button needs an open PR. Its reason is null when ready.
            const openPr = Boolean(prUrl);
            const mergeReason = openPr ? (cachePr.mergeBlocker ?? null) : null;
            const mergeArmed = mergeKey === key;
            // A removal needs a worktree that is merged or fully in sync and
            // clean; otherwise the worktree is not going anywhere.
            const removable = safeToRemove(w);
            // Exactly one action button per row, and only when it can act. A
            // removal or a merge that cannot happen is not drawn; the row's
            // note and the PR link carry the rest.
            const action = w.merged
              ? removable
                ? "delete"
                : null
              : removable
                ? "delete"
                : canUpload
                  ? "push"
                  : openPr
                    ? mergeReason === null
                      ? "merge"
                      : "open-pr"
                    : behindRemote
                      ? "blocked"
                      : w.statusError
                        ? null
                        : "create-pr";

            // The color says what the one button will do, and whether it can.
            const actionStyle = {
              color: actionColor(action, w, cachePr && cachePr.checks),
            };
            // The row of the worktree this session works in: a pill in a gutter
            // says why it sits above the rows the sort put there. Every row
            // keeps that gutter, so their text and buttons line up.
            const current = pinned !== null && rowKey(w) === pinnedKey;
            return html`<li
              key=${`${w.repo}/${w.name}`}
              title=${current ? "This session works here" : undefined}
              style=${{
                position: "relative",
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                borderTop: "1px solid var(--line)",
                paddingTop: "10px",
                paddingBottom: "10px",
                paddingLeft: "10px",
                paddingRight: "10px",
              }}
            >
              ${
                current &&
                html`<span
                  aria-hidden="true"
                  style=${{ position: "absolute", left: "2px", top: "9px", bottom: "9px", width: "3px", borderRadius: "2px", background: "var(--accent)", opacity: "0.85" }}
                ></span>`
              }
              <div
                style=${{ display: "flex", alignItems: "baseline", gap: "8px" }}
              >
                <span style=${{ minWidth: "0", overflowWrap: "anywhere" }}>
                  <span title=${w.path}>${w.name}</span>
                  <span class="muted"> @ </span>
                  ${
                    repoUrl
                      ? html`<a
                          class="muted"
                          href=${repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          title=${repoUrl}
                          >${w.repo}</a
                        >`
                      : html`<span
                          class="muted"
                          title=${w.upstream ? `Upstream: ${w.upstream}` : "No upstream"}
                          >${w.repo}</span
                        >`
                  }
                </span>
                ${
                  // Right-aligned, so the link sits in the same place on every
                  // row and leaves the name as much room as it needs.
                  prLabel &&
                  (prUrl
                    ? html`<a
                        class="muted"
                        href=${prUrl}
                        target="_blank"
                        rel="noreferrer"
                        title=${prUrl}
                        style=${{ marginLeft: "auto", flex: "none", whiteSpace: "nowrap" }}
                        >${prLabel}</a
                      >`
                    : html`<span
                        class="muted"
                        title="The extension has no link for this number yet. Refresh to read it."
                        style=${{ marginLeft: "auto", flex: "none", whiteSpace: "nowrap" }}
                        >${prLabel}</span
                      >`)
                }
              </div>
              <div style=${{ display: "flex", alignItems: "center" }}>
                <button
                  class="button small"
                  disabled=${toolbarBusy || rowBusy(w)}
                  title=${`Open session in ${w.path}`}
                  aria-label=${`Open session in ${w.name}@${w.repo}`}
                  aria-disabled=${listingBusy || undefined}
                  onClick=${() => {
                    if (!listingBusy) doOpen(w);
                  }}
                  style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                >
                  ${inFlight(rowAction("open", w), `Open session in ${w.name}@${w.repo}`, html`<${Icon} name="chat" size=${16} />`)}
                </button>
                <span
                  class="muted"
                  title=${
                    w.todoTotal === undefined
                      ? "No TODOs"
                      : `TODO ${w.todoDone ?? 0} of ${w.todoTotal} done`
                  }
                  style=${{ ...ROW_ITEM, width: "52px", marginLeft: "20px", gap: "4px", flex: "none", overflow: "hidden" }}
                >
                  ${w.todoTotal === undefined ? "" : html`<${Icon} name="check" size=${14} />`}
                  ${w.todoTotal === undefined ? "" : `${w.todoDone ?? 0}/${w.todoTotal}`}
                </span>
                <span
                  class="muted"
                  title=${
                    w.review
                      ? `Review ${w.review.approved} of ${w.review.total} approved`
                      : "Review status unknown"
                  }
                  style=${{ ...ROW_ITEM, width: "48px", marginLeft: "8px", gap: "4px", flex: "none", overflow: "hidden" }}
                >
                  <${Icon} name="eye" size=${14} />
                  ${w.review ? `${w.review.approved}/${w.review.total}` : "?"}
                </span>
                <div
                  style=${{ display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }}
                >
                  <span
                    class="muted mono"
                    style=${{ ...ROW_ITEM, width: showBehind ? "64px" : "46px", flex: "none", justifyContent: "flex-end" }}
                  >
                    ${
                      (w.ahead ?? 0) > 0 &&
                      html`<span
                        title=${`${w.ahead} commit${w.ahead === 1 ? "" : "s"} ahead`}
                        >↑${w.ahead}</span
                      >`
                    }
                    ${
                      showBehind &&
                      (w.behind ?? 0) > 0 &&
                      html`<span
                        title=${`${w.behind} commit${w.behind === 1 ? "" : "s"} behind`}
                        >↓${w.behind}</span
                      >`
                    }
                  </span>
                  ${
                    action === "delete" &&
                    html`<button
                      class="button small"
                      disabled=${toolbarBusy || rowBusy(w)}
                      aria-disabled=${listingBusy || undefined}
                      title=${
                        armed
                          ? `Click again to delete ${w.name}@${w.repo} within 5s`
                          : `Remove ${w.name}@${w.repo}`
                      }
                      aria-label=${armed ? `Confirm delete ${w.name}@${w.repo}` : `Remove ${w.name}@${w.repo}`}
                      onClick=${() => {
                        if (!listingBusy) doRemove(w);
                      }}
                      style=${armed ? { position: "absolute", right: "0", top: "50%", transform: "translateY(-50%)", zIndex: "1", display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", boxShadow: "0 2px 12px rgba(0,0,0,0.45)", maxWidth: "100%", color: "var(--err)", fontWeight: "700" } : { ...actionStyle, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                    >
                      ${inFlight(rowAction("remove", w), `Remove ${w.name}@${w.repo}`, armed ? html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} /><span style=${{ marginLeft: "4px" }}>?</span>` : html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} />`)}
                    </button>`
                  }
                  ${
                    action === "push" &&
                    html`<button
                      class="button small"
                      disabled=${toolbarBusy || rowBusy(w)}
                      aria-disabled=${listingBusy || undefined}
                      title=${`Push ${cachePr.unpushed} commit${cachePr.unpushed === 1 ? "" : "s"} to origin/${w.name} for ${w.name}@${w.repo}`}
                      aria-label=${`Push unpushed commits for ${w.name}@${w.repo}`}
                      onClick=${() => {
                        if (!listingBusy) doPush(w);
                      }}
                      style=${{ ...actionStyle, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                    >
                      ${inFlight(
                        rowAction("push", w),
                        `Push unpushed commits for ${w.name}@${w.repo}`,
                        html`<svg
                          width="16"
                          height="16"
                          viewBox="0 0 16 16"
                          fill="currentColor"
                          aria-hidden="true"
                          style=${{ flexShrink: 0 }}
                        >
                          <path
                            d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"
                          />
                          <path
                            d="M11.78 4.72a.749.749 0 1 1-1.06 1.06L8.75 3.811V9.5a.75.75 0 0 1-1.5 0V3.811L5.28 5.78a.749.749 0 1 1-1.06-1.06l3.25-3.25a.749.749 0 0 1 1.06 0l3.25 3.25Z"
                          />
                        </svg>`,
                      )}
                    </button>`
                  }
                  ${
                    action === "merge" &&
                    html`<button
                      class="button small"
                      disabled=${toolbarBusy || rowBusy(w)}
                      aria-disabled=${listingBusy || undefined}
                      title=${
                        mergeReason
                          ? `Cannot merge: ${mergeReason}`
                          : mergeArmed
                            ? `Click again to merge PR #${cachePr.number} within 5s`
                            : `Merge PR #${cachePr.number}`
                      }
                      aria-label=${
                        mergeArmed
                          ? `Confirm merge of PR #${cachePr.number} for ${w.name}@${w.repo}`
                          : `Merge PR #${cachePr.number} for ${w.name}@${w.repo}`
                      }
                      onClick=${() => {
                        if (!listingBusy) doMerge(w);
                      }}
                      style=${{ ...actionStyle, ...(mergeArmed ? { color: "var(--accent)" } : {}), display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                    >
                      ${inFlight(
                        rowAction("merge", w),
                        `Merge PR #${cachePr.number} for ${w.name}@${w.repo}`,
                        html`<svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden="true"
                          style=${{ flexShrink: 0 }}
                        >
                          <path
                            d="M15 13.25a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm-12.5 6a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0Zm0-14.5a3.25 3.25 0 1 1 6.5 0 3.25 3.25 0 0 1-6.5 0ZM5.75 6.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 6.5Zm0 14.5a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 5.75 21Zm12.5-6a1.75 1.75 0 1 0-.001-3.501A1.75 1.75 0 0 0 18.25 15Z"
                          />
                          <path
                            d="M6.5 7.25c0 2.9 2.35 5.25 5.25 5.25h4.5V14h-4.5A6.75 6.75 0 0 1 5 7.25Z"
                          />
                          <path
                            d="M5.75 16.75A.75.75 0 0 1 5 16V8a.75.75 0 0 1 1.5 0v8a.75.75 0 0 1-.75.75Z"
                          />
                        </svg>`,
                      )}
                    </button>`
                  }
                  ${
                    (action === "create-pr" || action === "open-pr") &&
                    html`<button
                      class="button small"
                      disabled=${toolbarBusy || rowBusy(w) || (!openPr && w.statusError)}
                      title=${
                        openPr
                          ? mergeReason
                            ? `Cannot merge yet (${mergeReason}); open PR #${cachePr.number}`
                            : `Open PR #${cachePr.number} for ${w.name}@${w.repo}`
                          : w.statusError
                            ? "Git status unknown"
                            : `Open or create a PR for ${w.name}@${w.repo}`
                      }
                      aria-label=${
                        openPr
                          ? `Open PR #${cachePr.number} for ${w.name}@${w.repo}`
                          : `Open or create a PR for ${w.name}@${w.repo}`
                      }
                      aria-disabled=${listingBusy || undefined}
                      onClick=${() => {
                        if (listingBusy) return;
                        if (prUrl) {
                          window.open(prUrl, "_blank", "noopener");
                          return;
                        }
                        draftRun.current += 1;
                        setDrafting(false);
                        setPrTitle("");
                        setPrBody("");
                        setError(null);
                        setPrWorktree(w);
                      }}
                      style=${{ ...actionStyle, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        aria-hidden="true"
                        style=${{ flexShrink: 0 }}
                      >
                        <path
                          d="M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z"
                        />
                      </svg>
                    </button>`
                  }
                  ${
                    action === "blocked" &&
                    html`<button
                      class="button small"
                      disabled
                      title=${`origin/${w.name} has commits ${w.name}@${w.repo} lacks. Pull or rebase to sync before opening or updating a PR.`}
                      aria-label=${`Blocked: origin/${w.name} is ahead of ${w.name}@${w.repo}`}
                      style=${{ ...actionStyle, display: "inline-flex", alignItems: "center", justifyContent: "center", width: "28px", height: "28px", padding: "0", flexShrink: 0 }}
                    >
                      <${Icon}
                        path="M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5"
                        size=${16}
                      />
                    </button>`
                  }
                </div>
              </div>
              ${
                prWorktree &&
                prWorktree.repo === w.repo &&
                prWorktree.name === w.name &&
                html`<form
                  onSubmit=${(event) => {
                    event.preventDefault();
                    if (toolbarBusy || rowBusy(w) || drafting) return;
                    if (!prTitle.trim() && prBody.trim()) {
                      setError(
                        "A PR subject is required when a body is provided.",
                      );
                      return;
                    }
                    void doPr(prWorktree, prTitle, prBody);
                  }}
                  style=${{ display: "flex", flexDirection: "column", gap: "8px", border: "1px solid var(--line)", borderRadius: "4px", padding: "10px" }}
                >
                  <strong
                    >Create PR for ${prWorktree.name}@${prWorktree.repo}</strong
                  >
                  <span class="small muted"
                    >Leave both fields empty to use commit information. A draft
                    session continues if you cancel.</span
                  >
                  <label
                    style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
                  >
                    <span class="small">Subject</span>
                    <input
                      value=${prTitle}
                      disabled=${toolbarBusy || rowBusy(w) || drafting}
                      onInput=${(e) => setPrTitle(e.target.value)}
                    />
                  </label>
                  <label
                    style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
                  >
                    <span class="small">Body</span>
                    <textarea
                      value=${prBody}
                      disabled=${toolbarBusy || rowBusy(w) || drafting}
                      rows="5"
                      onInput=${(e) => setPrBody(e.target.value)}
                    ></textarea>
                  </label>
                  <div
                    style=${{ display: "flex", gap: "6px", flexWrap: "wrap" }}
                  >
                    <button
                      class="button"
                      type="button"
                      disabled=${toolbarBusy || rowBusy(w) || drafting || Boolean(prTitle.trim() || prBody.trim())}
                      title=${prTitle.trim() || prBody.trim() ? "Clear the subject and body to generate a draft" : "Generate a draft using the conversation model"}
                      onClick=${() => doDraft(prWorktree)}
                    >
                      ${drafting ? html`<${Spinner} label="Generating PR draft" />` : "Generate draft"}
                    </button>
                    <button
                      class="button primary"
                      type="submit"
                      disabled=${toolbarBusy || rowBusy(w) || drafting}
                    >
                      ${inFlight(rowAction("pr", prWorktree), `Create PR for ${prWorktree.name}@${prWorktree.repo}`, "Create PR")}
                    </button>
                    <button
                      class="button"
                      type="button"
                      disabled=${toolbarBusy || rowBusy(w)}
                      onClick=${() => {
                        draftRun.current += 1;
                        setDrafting(false);
                        setPrWorktree(null);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </form>`
              }
              ${
                (w.statusError || (w.merged && !removable)) &&
                html`<p class="small muted" role="status">
                  ${
                    w.statusError
                      ? "Git status could not be read. Removal is disabled."
                      : "Merged, but has uncommitted changes. Commit or discard them to remove."
                  }
                </p>`
              }
            </li>`;
          })}
        </ul>
      </div>

      <div
        style=${{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          flex: "none",
          borderTop: "1px solid var(--line)",
          paddingTop: "10px",
        }}
      >
        <span
          class="small muted"
          aria-live="polite"
          style=${{ marginRight: "auto" }}
          >${data ? `${rows.length} of ${worktrees.length} worktrees` : ""}</span
        >
        ${
          data
            ? html`<span
                class="small muted"
                title=${data.fetchError ? data.fetchError : "Worktrees and remotes refreshed"}
                style=${{ display: "inline-block", minWidth: "8ch", paddingRight: "6px", textAlign: "right", whiteSpace: "nowrap" }}
                >${timeAgo(data.fetchedAt)}</span
              >`
            : html`<span
                class="small"
                style=${{ display: "inline-block", minWidth: "8ch", paddingRight: "6px", textAlign: "right" }}
                >Stale</span
              >`
        }
        <button
          class="button small"
          disabled=${toolbarBusy}
          title="Refresh: list worktrees and fetch their remotes"
          aria-label="Refresh"
          onClick=${doRefresh}
          style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
        >
          ${inFlight("refresh", "Refresh", html`<${Icon} name="reload" size=${16} />`)}
        </button>
      </div>
    </section>`;
  }

  pocket.page({
    id: "timber",
    title: "Worktrees",
    component: TimberPage,
  });
  pocket.rail({
    id: "timber",
    title: "Timber",
    iconPath: TIMBER_ICON,
    page: "timber",
  });
  pocket.launcher({
    id: "timber",
    label: "Timber worktrees",
    detail: "list, create, remove",
    keywords: ["worktree", "repository", "branch", "timber"],
    page: "timber",
  });

  // The panel is a second surface for a wide screen: a button in the top bar
  // and one in the places. The rail button and the launcher use the page
  // instead, because a panel shows only in a session: on a phone's session
  // list, its rail button opened nothing.
  if (typeof pocket.panel === "function") {
    pocket.panel({
      id: "timber",
      title: "Worktrees",
      iconPath: TIMBER_ICON,
      component: TimberPage,
    });
  }
}
