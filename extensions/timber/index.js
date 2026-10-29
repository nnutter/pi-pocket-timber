// Timber browser module: a rail page that lists Timber worktrees, with create / add / remove.
// The app loads this and calls its default export with `pocket`.

/** The version of `pocket` this module was written for. */
export const pocketApi = 1;

export default function setup(pocket) {
  const { html, useEffect, useState, useRef, Loader, Icon } = pocket;

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

  function TimberPage() {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
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
    const confirmTimer = useRef(null);

    const doRefresh = async () => {
      setBusy(true);
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
        setBusy(false);
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
      },
      [],
    );

    const armRemove = (key) => {
      setConfirmKey(key);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirmKey(null), 5000);
    };

    const doCreate = async (event) => {
      event.preventDefault();
      const repo = (createRepo || (data && data.repositories[0]) || "").trim();
      if (!repo) {
        setError("Select a repository first.");
        return;
      }
      setBusy(true);
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
        setBusy(false);
      }
    };

    const doAdd = async (event) => {
      event.preventDefault();
      if (!source.trim()) {
        setError("Enter a repository URL or path.");
        return;
      }
      setBusy(true);
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
        setBusy(false);
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
      setBusy(true);
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
        setBusy(false);
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
      setBusy(true);
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
        setBusy(false);
      }
    };

    const doPr = async (worktree) => {
      setBusy(true);
      setNotice("");
      try {
        const result = await pocket.api(
          "pr",
          { repo: worktree.repo, name: worktree.name },
          { method: "POST" },
        );
        const key = `${worktree.repo}\0${worktree.name}`;
        setPrLinks((prev) => ({
          ...prev,
          [key]: { url: result.url, number: result.number },
        }));
        if (result.warnings && result.warnings.length) {
          setNotice(`Warning: ${result.warnings.join("; ")}`);
        }
        try {
          window.open(result.url, "_blank", "noopener");
        } catch {
          // Blocked or unavailable: the PR link in the row still gets there.
        }
        setError(null);
      } catch (failure) {
        setError(failure && failure.message ? failure.message : "PR failed");
      } finally {
        setBusy(false);
      }
    };

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
        padding: "12px",
        fontSize: "13px",
      }}
    >
      <div style=${{ display: "flex", gap: "8px", alignItems: "center" }}>
        <button
          class="button small"
          disabled=${busy || !data || data.repositories.length === 0}
          title="New worktree"
          aria-label="New worktree"
          onClick=${() => setCreating((v) => !v)}
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
              d="M7.122.392a1.75 1.75 0 0 1 1.756 0l5.003 2.902c.83.481.83 1.68 0 2.162L8.878 8.358a1.75 1.75 0 0 1-1.756 0L2.119 5.456a1.25 1.25 0 0 1 0-2.162ZM8.125 1.69a.25.25 0 0 0-.25 0L3.244 4.375 7.875 7.06a.25.25 0 0 0 .25 0l4.63-2.685ZM1.602 7.789a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296L1.874 8.813a.75.75 0 0 1-.272-1.024m0 3.5a.75.75 0 0 1 1.024-.272l5.249 3.044a.749.749 0 1 1-.753 1.296l-5.248-3.044a.75.75 0 0 1-.272-1.024M11.75 15.25v-2h-2a.75.75 0 0 1 0-1.5h2v-2a.75.75 0 0 1 1.5 0v2h2a.75.75 0 0 1 0 1.5h-2v2a.75.75 0 0 1-1.5 0"
            />
          </svg>
        </button>
        <button
          class="button small"
          disabled=${busy || !data}
          title="Add repository"
          aria-label="Add repository"
          onClick=${() => setAdding((v) => !v)}
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
              d="M1 2.5A2.5 2.5 0 0 1 3.5 0h8.75a.75.75 0 0 1 .75.75V6a.75.75 0 0 1-1.5 0V1.5h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 3.5 9h3a.75.75 0 0 1 0 1.5h-3a1 1 0 0 0 0 2h3a.75.75 0 0 1 0 1.5h-3A2.5 2.5 0 0 1 1 11.5v-9Z"
            />
            <path
              d="M12.21 13.479a.75.75 0 1 0 1.061 1.061l2.504-2.505a.75.75 0 0 0 0-1.061L13.271 8.47a.75.75 0 0 0-1.061 1.06l1.224 1.225H8.75a.75.75 0 1 0 0 1.5h4.685l-1.225 1.224Z"
            />
          </svg>
        </button>
        <span style=${{ flex: "1" }}></span>
        <button
          class="button small"
          disabled=${busy}
          title="Refresh: list worktrees and fetch all remotes"
          aria-label="Refresh"
          onClick=${doRefresh}
          style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
        >
          <${Icon} name="reload" size=${16} />
        </button>
        ${
          data
            ? html`<span
                class="small muted"
                title=${data.fetchError ? data.fetchError : "Worktrees and remotes refreshed"}
                >${timeAgo(data.fetchedAt)}</span
              >`
            : html`<span class="small">Stale</span>`
        }
      </div>

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
              Add repo
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
              Create worktree
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
        style=${{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 110px", gap: "8px" }}
      >
        <input
          type="search"
          aria-label="Find worktrees"
          value=${search}
          placeholder="Search worktrees"
          onInput=${(e) => setSearch(e.target.value)}
        />
        <select
          aria-label="Sort worktrees"
          value=${sort}
          onChange=${(e) => setSort(e.target.value)}
        >
          <option value="recent">Recent</option>
          <option value="repo">Repository</option>
          <option value="name">Name</option>
        </select>
      </div>

      <div
        class="small muted"
        aria-live="polite"
        style=${{ textAlign: "right" }}
      >
        ${data ? `${filtered.length} of ${worktrees.length} worktrees` : ""}${busy ? " · Working…" : ""}
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
          const hasPr = Boolean(
            w.pullRequest || (prLinks[key] && prLinks[key].url),
          );
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
                overflowX: "auto",
                paddingRight: "2px",
                scrollbarWidth: "thin",
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
                style=${{ display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px" }}
              >
                <${Icon} name="chat" size=${16} />
              </button>
              <span
                class="small"
                style=${{ ...badgeStyle(kind), minWidth: "60px", textAlign: "center", justifyContent: "center" }}
                >${label}</span
              >
              <span
                class="small muted mono"
                style=${{ minWidth: "58px", whiteSpace: "nowrap" }}
                >↑${w.ahead ?? 0} ↓${w.behind ?? 0}</span
              >
              ${
                w.todoTotal !== undefined &&
                html`<span
                  class="small muted"
                  title=${`TODO ${w.todoDone ?? 0} of ${w.todoTotal} done`}
                  style=${{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: "50px" }}
                >
                  <${Icon} name="check" size=${14} />
                  ${w.todoDone ?? 0}/${w.todoTotal}
                </span>`
              }
              <span
                class="small muted"
                title=${
                  w.review
                    ? `Review ${w.review.approved} of ${w.review.total} approved`
                    : "Review status unknown"
                }
                style=${{ display: "inline-flex", alignItems: "center", gap: "4px", minWidth: "50px" }}
              >
                <${Icon} name="eye" size=${14} />
                ${w.review ? `${w.review.approved}/${w.review.total}` : "?"}
              </span>
              ${
                prLinks[key]
                  ? html`<a
                      class="small muted"
                      href=${prLinks[key].url}
                      target="_blank"
                      rel="noreferrer"
                      style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >PR #${prLinks[key].number}</a
                    >`
                  : w.pullRequest &&
                    html`<span
                      class="small muted"
                      style=${{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >PR ${w.pullRequest}</span
                    >`
              }
              <span style=${{ flex: "1", minWidth: "6px" }}></span>
              ${
                safeToRemove(w)
                  ? html`<button
                      class="button small"
                      disabled=${busy}
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
                      style=${armed ? { position: "absolute", right: "0", top: "50%", transform: "translateY(-50%)", zIndex: "1", display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", boxShadow: "0 2px 12px rgba(0,0,0,0.45)", maxWidth: "100%", color: "var(--err)", fontWeight: "700" } : { display: "inline-flex", alignItems: "center", justifyContent: "center", minHeight: "24px", height: "24px", padding: "0 8px", flexShrink: 0 }}
                    >
                      ${armed ? html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} /><span style=${{ marginLeft: "4px" }}>?</span>` : html`<${Icon} path="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2M6.5 7l.9 12.1a2 2 0 002 1.9h5.2a2 2 0 002-1.9L17.5 7M10 11v6M14 11v6" size=${16} />`}
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
                        if (!listingBusy) doPr(w);
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
            ${
              w.statusError &&
              html`<p class="small muted" role="status">
                Git status could not be read. Removal is disabled.
              </p>`
            }
          </li>`;
        })}
      </ul>
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
