// Timber browser module: a rail page that lists Timber worktrees, with create / add / remove.
// The app loads this and calls its default export with `pocket`.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

export default function setup(pocket) {
  const { html, useEffect, useState, useRef, Loader, Spinner, Icon } = pocket;

  // Status items in a worktree row share the 24px height of the row buttons.
  const ROW_ITEM = {
    display: "inline-flex",
    alignItems: "center",
    height: "24px",
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

  function badgeStyle(kind) {
    if (kind === "merged")
      return {
        background: "#8957e5",
        color: "var(--text)",
        borderRadius: "4px",
        padding: "2px 8px",
      };
    if (kind === "clean-pr")
      return {
        background: "color-mix(in srgb, var(--ok) 18%, transparent)",
        color: "var(--ok)",
        borderRadius: "4px",
        padding: "2px 8px",
      };
    if (kind === "dirty")
      return {
        background: "color-mix(in srgb, var(--warn) 20%, transparent)",
        color: "var(--warn)",
        borderRadius: "4px",
        padding: "2px 8px",
      };
    return {
      background: "color-mix(in srgb, var(--muted) 18%, transparent)",
      color: "var(--muted)",
      borderRadius: "4px",
      padding: "2px 8px",
    };
  }

  /** The pending-action id for a verb on one worktree row. */
  function rowAction(verb, w) {
    return `${verb}\0${w.repo}\0${w.name}`;
  }

  function TimberPage() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState("");
    // The id of the action in flight, or null when idle. Any action locks the page.
    const [pending, setPending] = useState(null);
    const busy = pending !== null;
    // True while a background list reload is in flight. Row buttons lock
    // so a tap can't land on a row that is about to move.
    const [listingBusy, setListingBusy] = useState(false);
    const listingCount = useRef(0);
    const [search, setSearch] = useState("");
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
    const [prLinks, setPrLinks] = useState({});
    const [prWorktree, setPrWorktree] = useState(null);
    const [prTitle, setPrTitle] = useState("");
    const [prBody, setPrBody] = useState("");
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

    // A button's content, or a spinner in its place while its action runs.
    // The spinner is 0.85em, so 19px makes it 16px, the size of the icons, and
    // the fixed box keeps the button from shifting while it spins.
    const inFlight = (id, label, content) =>
      pending === id
        ? html`<span
            style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none", width: "16px", height: "16px", fontSize: "19px" }}
            ><${Spinner} label=${label}
          /></span>`
        : content;

    const doRefresh = async () => {
      setPending("refresh");
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
        setPending(null);
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

    useEffect(
      () => () => {
        if (confirmTimer.current) clearTimeout(confirmTimer.current);
        if (mergeTimer.current) clearTimeout(mergeTimer.current);
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
      setPending("create");
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
      } catch (failure) {
        setError(
          failure && failure.message ? failure.message : "Create failed",
        );
      } finally {
        setPending(null);
      }
    };

    const doAdd = async (event) => {
      event.preventDefault();
      if (!source.trim()) {
        setError("Enter a repository URL or path.");
        return;
      }
      setPending("add");
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
        setPending(null);
      }
    };

    const doRemove = async (worktree) => {
      const key = `${worktree.repo}\0${worktree.name}`;
      if (confirmKey !== key) {
        armRemove(key);
        return;
      }
      setConfirmKey(null);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      setPending(rowAction("remove", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          "remove",
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        setNotice(`Removed ${result.removed}.`);
        const state = await pocket.api("state");
        setData(state);
        setError(null);
      } catch (failure) {
        setError(
          failure && failure.message ? failure.message : "Remove failed",
        );
      } finally {
        setPending(null);
      }
    };

    const doOpen = async (worktree) => {
      const source = pocket.conversationId();
      if (source === null || source === undefined) {
        setError("Open a session first — panels need one to start from.");
        return;
      }
      const key =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setPending(rowAction("open", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          `open/${source}`,
          { repo: worktree.repo, name: worktree.name, key },
          { method: "POST" },
        );
        const target = result && (result.session ?? result.conversationId);
        if (target === undefined || target === null) {
          throw new Error("Open did not return a session.");
        }
        pocket.openConversation(target);
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "Open failed");
      } finally {
        setPending(null);
      }
    };

    const doPr = async (worktree, title, body, tab) => {
      setPending(rowAction("pr", worktree));
      setNotice("");
      try {
        const result = await pocket.api(
          "pr",
          { repo: worktree.repo, name: worktree.name, title, body },
          { method: "POST" },
        );
        setPrWorktree(null);
        const key = `${worktree.repo}\0${worktree.name}`;
        setPrLinks((prev) => ({
          ...prev,
          [key]: { url: result.url, number: result.number },
        }));
        const notices = result.warnings || [];
        try {
          if (!tab || tab.closed) throw new Error("Tab unavailable");
          tab.location.href = result.url;
        } catch {
          notices.push(
            "The PR tab could not open. Use the PR link in the row.",
          );
        }
        if (notices.length) setNotice(notices.join("; "));
        setError(null);
      } catch (failure) {
        if (tab && !tab.closed) tab.close();
        setError(failure && failure.message ? failure.message : "PR failed");
      } finally {
        setPending(null);
      }
    };

    const doPush = async (worktree) => {
      setPending(rowAction("push", worktree));
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
        setPending(null);
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
      setPending(rowAction("merge", worktree));
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
        setPending(null);
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
    const filtered = worktrees
      .filter((w) => {
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
                disabled=${busy}
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
                disabled=${busy}
                onInput=${(e) => setRepoName(e.target.value)}
              />
            </label>
            <label
              style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
            >
              <span class="small">Alias (optional)</span>
              <input
                value=${alias}
                disabled=${busy}
                onInput=${(e) => setAlias(e.target.value)}
              />
            </label>
            <div style=${{ display: "flex", gap: "6px" }}>
              <button
                class="button primary"
                type="submit"
                disabled=${busy || !source.trim()}
              >
                ${inFlight("add", "Add repo", "Add repo")}
              </button>
              <button
                type="button"
                class="button"
                disabled=${busy}
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
                disabled=${busy}
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
                disabled=${busy}
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
                disabled=${busy}
                placeholder="Repository default"
                onInput=${(e) => setUpstream(e.target.value)}
              />
            </label>
            <div style=${{ display: "flex", gap: "6px" }}>
              <button class="button primary" type="submit" disabled=${busy}>
                ${inFlight("create", "Create worktree", "Create worktree")}
              </button>
              <button
                type="button"
                class="button"
                disabled=${busy}
                onClick=${() => setCreating(false)}
              >
                Cancel
              </button>
            </div>
          </form>`
        }

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
                disabled=${busy || !data || data.repositories.length === 0}
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
                disabled=${busy}
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

        ${
          data &&
          filtered.length === 0 &&
          html`<p>
            ${worktrees.length ? "No matching worktrees." : "No worktrees yet. Create one above."}
          </p>`
        }

        <ul
          style=${{ display: "flex", flexDirection: "column", listStyle: "none", margin: 0, padding: 0 }}
        >
          ${filtered.map((w) => {
            const key = `${w.repo}\0${w.name}`;
            const armed = confirmKey === key;
            const cachePr = data && data.prs ? data.prs[key] : null;
            const hasPr = Boolean(
              w.pullRequest ||
              (prLinks[key] && prLinks[key].url) ||
              (cachePr && cachePr.url),
            );
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
            const openPr = Boolean(cachePr && cachePr.url);
            const mergeReason = openPr ? (cachePr.mergeBlocker ?? null) : null;
            const mergeArmed = mergeKey === key;
            // A merged branch has nothing to publish, so it never offers a PR.
            // Uncommitted work blocks removal, so show the delete button disabled.
            const removable = safeToRemove(w);
            const removeBlocked = w.statusError
              ? "Git status unknown"
              : "Merged, but has uncommitted changes. Commit or discard them to remove.";
            const kind = w.merged
              ? "merged"
              : !w.clean
                ? "dirty"
                : hasPr
                  ? "clean-pr"
                  : "clean";
            const label = w.merged ? "Merged" : !w.clean ? "Dirty" : "Clean";
            return html`<li
              key=${`${w.repo}/${w.name}`}
              style=${{
                display: "flex",
                flexDirection: "column",
                gap: "6px",
                borderTop: "1px solid var(--line)",
                paddingTop: "10px",
                paddingBottom: "10px",
              }}
            >
              <div style=${{ overflowWrap: "anywhere" }}>
                <span title=${w.path}>${w.name}</span>
                <span class="muted"> @ </span>
                <span
                  class="muted"
                  title=${w.upstream ? `Upstream: ${w.upstream}` : "No upstream"}
                >
                  ${w.repo}
                </span>
              </div>
              <div
                style=${{
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  flexWrap: "nowrap",
                  overflow: "hidden",
                  position: "relative",
                }}
              >
                <button
                  class="button small"
                  disabled=${busy}
                  title=${`Open session in ${w.path}`}
                  aria-label=${`Open session in ${w.name}@${w.repo}`}
                  aria-disabled=${listingBusy || undefined}
                  onClick=${() => {
                    if (!listingBusy) doOpen(w);
                  }}
                  style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", marginRight: "10px" }}
                >
                  ${inFlight(rowAction("open", w), `Open session in ${w.name}@${w.repo}`, html`<${Icon} name="chat" size=${16} />`)}
                </button>
                <span
                  class="muted mono"
                  style=${{ ...ROW_ITEM, gap: "6px", flex: "1 1 0" }}
                >
                  <span
                    title=${`${w.ahead ?? 0} commit${w.ahead === 1 ? "" : "s"} ahead`}
                    style=${{ display: "inline-block", width: "4ch" }}
                    >↑${w.ahead ?? 0}</span
                  >
                  <span
                    title=${`${w.behind ?? 0} commit${w.behind === 1 ? "" : "s"} behind`}
                    style=${{ display: "inline-block", width: "4ch" }}
                    >↓${w.behind ?? 0}</span
                  >
                </span>
                ${
                  w.todoTotal !== undefined &&
                  html`<span
                    class="muted"
                    title=${`TODO ${w.todoDone ?? 0} of ${w.todoTotal} done`}
                    style=${{ ...ROW_ITEM, gap: "4px", flex: "1 1 0" }}
                  >
                    <${Icon} name="check" size=${14} />
                    ${w.todoDone ?? 0}/${w.todoTotal}
                  </span>`
                }
                <span
                  class="muted"
                  title=${
                    w.review
                      ? `Review ${w.review.approved} of ${w.review.total} approved`
                      : "Review status unknown"
                  }
                  style=${{ ...ROW_ITEM, gap: "4px", flex: "1 1 0" }}
                >
                  <${Icon} name="eye" size=${14} />
                  ${w.review ? `${w.review.approved}/${w.review.total}` : "?"}
                </span>
                ${
                  prLinks[key]
                    ? html`<a
                        class="muted"
                        href=${prLinks[key].url}
                        target="_blank"
                        rel="noreferrer"
                        style=${{ ...ROW_ITEM, flex: "0 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" }}
                        >PR #${prLinks[key].number}</a
                      >`
                    : w.pullRequest &&
                      html`<span
                        class="muted"
                        style=${{ ...ROW_ITEM, flex: "0 1 auto", minWidth: "0", overflow: "hidden", textOverflow: "ellipsis" }}
                        >PR ${w.pullRequest}</span
                      >`
                }
                <div
                  style=${{ display: "flex", flex: "none", alignItems: "center", gap: "6px", marginLeft: "auto", paddingLeft: "12px" }}
                >
                  <span
                    style=${{ ...badgeStyle(kind), ...ROW_ITEM, padding: "0 8px", minWidth: "60px", justifyContent: "center", fontWeight: "500" }}
                    >${label}</span
                  >
                  ${
                    // Push is the only useful action while commits are
                    // unpushed: merge stays blocked until they are published.
                    openPr &&
                    !canUpload &&
                    html`<button
                      class="button small"
                      disabled=${busy || Boolean(mergeReason)}
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
                      style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0, color: mergeArmed ? "var(--accent)" : undefined }}
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
                    w.merged || removable
                      ? html`<button
                          class="button small"
                          disabled=${busy || !removable}
                          aria-disabled=${listingBusy || undefined}
                          title=${
                            !removable
                              ? removeBlocked
                              : armed
                                ? `Click again to delete ${w.name}@${w.repo} within 5s`
                                : `Remove ${w.name}@${w.repo}`
                          }
                          aria-label=${armed ? `Confirm delete ${w.name}@${w.repo}` : `Remove ${w.name}@${w.repo}`}
                          onClick=${() => {
                            if (!listingBusy) doRemove(w);
                          }}
                          style=${armed ? { position: "absolute", right: "0", top: "50%", transform: "translateY(-50%)", zIndex: "1", display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", boxShadow: "0 2px 12px rgba(0,0,0,0.45)", maxWidth: "100%", color: "var(--err)", fontWeight: "700" } : { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
                        >
                          ${inFlight(rowAction("remove", w), `Remove ${w.name}@${w.repo}`, armed ? html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} /><span style=${{ marginLeft: "4px" }}>?</span>` : html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} />`)}
                        </button>`
                      : canUpload
                        ? html`<button
                            class="button small"
                            disabled=${busy}
                            aria-disabled=${listingBusy || undefined}
                            title=${`Push ${cachePr.unpushed} commit${cachePr.unpushed === 1 ? "" : "s"} to origin/${w.name} for ${w.name}@${w.repo}`}
                            aria-label=${`Push unpushed commits for ${w.name}@${w.repo}`}
                            onClick=${() => {
                              if (!listingBusy) doPush(w);
                            }}
                            style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
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
                        : openPr
                          ? // The merge button and the PR number link cover
                            // this row, so no PR action belongs here.
                            null
                          : behindRemote
                            ? html`<button
                                class="button small"
                                disabled
                                title=${`origin/${w.name} has commits ${w.name}@${w.repo} lacks. Pull or rebase to sync before opening or updating a PR.`}
                                aria-label=${`Blocked: origin/${w.name} is ahead of ${w.name}@${w.repo}`}
                                style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
                              >
                                <${Icon}
                                  path="M12 3l10 18H2L12 3zM12 10v4M12 17.5v.5"
                                  size=${16}
                                />
                              </button>`
                            : html`<button
                                class="button small"
                                disabled=${busy || w.statusError}
                                title=${
                                  w.statusError
                                    ? "Git status unknown"
                                    : `Open or create a PR for ${w.name}@${w.repo}`
                                }
                                aria-label=${`Open or create a PR for ${w.name}@${w.repo}`}
                                aria-disabled=${listingBusy || undefined}
                                onClick=${() => {
                                  if (listingBusy) return;
                                  if (cachePr?.url || prLinks[key]) {
                                    window.open(
                                      (cachePr?.url ? cachePr : prLinks[key])
                                        .url,
                                      "_blank",
                                      "noopener",
                                    );
                                  } else {
                                    setPrTitle("");
                                    setPrBody("");
                                    setError(null);
                                    setPrWorktree(w);
                                  }
                                }}
                                style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
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
                </div>
              </div>
              ${
                prWorktree &&
                prWorktree.repo === w.repo &&
                prWorktree.name === w.name &&
                html`<form
                  onSubmit=${(event) => {
                    event.preventDefault();
                    if (!prTitle.trim() && prBody.trim()) {
                      setError(
                        "A PR subject is required when a body is provided.",
                      );
                      return;
                    }
                    let tab = null;
                    try {
                      tab = window.open("", "_blank");
                      if (tab) tab.opener = null;
                    } catch {
                      // The PR link in the row remains available.
                    }
                    void doPr(prWorktree, prTitle, prBody, tab);
                  }}
                  style=${{ display: "flex", flexDirection: "column", gap: "8px", border: "1px solid var(--line)", borderRadius: "4px", padding: "10px" }}
                >
                  <strong
                    >Create PR for ${prWorktree.name}@${prWorktree.repo}</strong
                  >
                  <span class="small muted"
                    >Leave both fields empty to use commit information.</span
                  >
                  <label
                    style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
                  >
                    <span class="small">Subject</span>
                    <input
                      value=${prTitle}
                      disabled=${busy}
                      onInput=${(e) => setPrTitle(e.target.value)}
                    />
                  </label>
                  <label
                    style=${{ display: "flex", flexDirection: "column", gap: "4px" }}
                  >
                    <span class="small">Body</span>
                    <textarea
                      value=${prBody}
                      disabled=${busy}
                      rows="5"
                      onInput=${(e) => setPrBody(e.target.value)}
                    ></textarea>
                  </label>
                  <div style=${{ display: "flex", gap: "6px" }}>
                    <button
                      class="button primary"
                      type="submit"
                      disabled=${busy}
                    >
                      ${inFlight(rowAction("pr", prWorktree), `Create PR for ${prWorktree.name}@${prWorktree.repo}`, "Create PR")}
                    </button>
                    <button
                      class="button"
                      type="button"
                      disabled=${busy}
                      onClick=${() => setPrWorktree(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>`
              }
              ${
                w.statusError &&
                html`<p class="small muted" role="status">
                  Git status could not be read. Removal is disabled.
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
          >${data ? `${filtered.length} of ${worktrees.length} worktrees` : ""}</span
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
          disabled=${busy}
          title="Refresh: list worktrees and fetch all remotes"
          aria-label="Refresh"
          onClick=${doRefresh}
          style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
        >
          ${inFlight("refresh", "Refresh", html`<${Icon} name="reload" size=${16} />`)}
        </button>
      </div>
    </section>`;
  }

  if (typeof pocket.panel === "function") {
    pocket.panel({
      id: "timber",
      title: "Timber worktrees",
      iconPath:
        "M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v2.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8M12 12v4",
      component: TimberPage,
    });
    pocket.rail({
      id: "timber",
      title: "Timber",
      iconPath:
        "M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v2.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8M12 12v4",
      panel: "timber",
    });
    pocket.launcher({
      id: "timber",
      label: "Timber worktrees",
      detail: "list, create, remove",
      keywords: ["worktree", "repository", "branch", "timber"],
      panel: "timber",
    });
  } else {
    pocket.page({
      id: "timber",
      title: "Timber worktrees",
      component: TimberPage,
    });
    pocket.rail({
      id: "timber",
      title: "Timber",
      iconPath:
        "M5 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M10 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M7 8v2.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V8M12 12v4",
      page: "timber",
    });
    pocket.launcher({
      id: "timber",
      label: "Timber worktrees",
      detail: "list, create, remove",
      keywords: ["worktree", "repository", "branch", "timber"],
      page: "timber",
    });
  }
}
