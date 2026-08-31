# Daiko

Sync your MCP servers, skills, AGENT.md and more across agents and projects. Harness agnostic, versioned, self hosted and secure. It works either locally, or on a remote VPS.

Features
- works with Claude Code, Codex, Cursor (CLAUDE.md, AGENTS.md, AGENT.md, .cursorrules, `.mcp.json`, `.cursor/mcp.json`, `.claude/skills/*`)
- picks up MCP servers from harness configs too: Claude Code local scope (`~/.claude.json`, matched to the project path) and the global configs of Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`), and Cursor (`~/.cursor/mcp.json`) — global servers are stored once and available to every project
- versioning of skills, agent files, and MCP server configs — every change is a new content-addressed version
- share any skill or MCP server into any other repo: `dai attach`/`dai detach` on the CLI, or search-and-add / one-click remove in the web UI (adding writes it to disk, removing deletes it from the repo)
- shared artifacts stay one lineage: re-running `dai add` in a repo that received a shared skill versions the shared artifact instead of forking a copy, so every attached repo picks up the change on its next sync
- pin any artifact to a specific version; `dai sync` writes the pinned version back
- full session capture: hooks store every Claude Code transcript (user inputs, tool calls, tool outputs, thinking traces, responses) in SQLite as it happens
- session import from the default local stores of Claude Code, Codex CLI, and Gemini CLI
- web UI to browse projects, edit artifacts, inspect version history, pin and restore

## Getting started

```bash
npm i -g daiko
dai init          # initialize the global store (~/.daiko)
dai add .         # upload all skills, MCP servers, agent files for the repo (uses repo dir name as project name)
dai sync          # write skills, MCP servers and agent files from the central store back into the repo
dai search <q>    # search all stored skills, MCP servers, and agent files by name
dai attach <name> # share a stored skill/MCP server into this repo and write it to disk
dai detach <name> # remove a shared skill/MCP server from this repo (unlink + delete from disk)
dai hook          # install Claude Code hooks: auto "dai sync" on session start + full transcript capture
dai hook -g       # same, globally (~/.claude/settings.json): every new session in a registered repo auto-syncs
dai import        # import locally stored sessions from Claude Code, Codex, and Gemini CLI
dai sessions      # list captured sessions
dai list          # list registered projects and artifacts
dai webui         # manage everything in a web app (http://localhost:4680)
```

## How it works

Everything lives in a single SQLite database at `~/.daiko/daiko.db` (override the location with `DAIKO_HOME`).

- `dai add` scans a repo for agent files (`CLAUDE.md`, `AGENTS.md`, `AGENT.md`, `.cursorrules`), Claude skills (`.claude/skills/*/SKILL.md`), and MCP server entries (`.mcp.json`, `.cursor/mcp.json`). It also picks up Claude Code local-scope servers from `~/.claude.json` whose registered path matches the repo (stored against the project, synced back as `.mcp.json` entries — i.e. promoted to shareable project scope), plus globally registered servers from `~/.claude.json`, `~/.codex/config.toml`, and `~/.cursor/mcp.json` (stored with no project, available to all). Each artifact is stored with a sha256-hashed version; re-running `add` only creates a new version when content changed.
- `dai sync` writes the current (or pinned) version of every artifact — owned and shared — back to its path in the repo. MCP servers are merged into their config file, preserving unmanaged servers and unrelated keys. Shared MCP servers whose origin is a harness-global config are written to the project-level file (`.mcp.json`, or `.cursor/mcp.json` for Cursor).
- `dai attach <name> [path]` links a stored artifact into a repo (registering the repo first if needed) and syncs it to disk; `dai detach` removes the link and deletes the skill directory / MCP entry / file from the repo. The same operations are available in the web UI: a project page has a search box over the whole library ("Add from Library"), and an artifact page has a per-project Add/Remove list.
- `dai hook` installs Claude Code hooks in `.claude/settings.json` (or `~/.claude/settings.json` with `-g`): `SessionStart` runs `dai sync` — so a new session always starts with the latest synced skills, MCP servers, and agent files — and `Stop`/`SessionEnd` run `dai capture`, which stores the session's full transcript after every assistant turn. The global sync hook is safe: `dai sync --quiet` exits 0 and does nothing in unregistered directories. Capture hooks are registered async with a timeout and always exit 0, so they can never delay or break a session. If the hook payload lacks `transcript_path`, capture derives it from `~/.claude/projects/<mangled-cwd>/<session_id>.jsonl`.
- `dai import` scans the default local session stores — `~/.claude/projects/**/*.jsonl` (Claude Code), `~/.codex/sessions/**/*.jsonl` (Codex CLI rollouts), `~/.gemini/tmp/*/chats/*.json` (Gemini CLI) — and imports every session. Re-runs are incremental: unchanged files (mtime + size) are skipped, changed ones are re-imported in place.
- Sessions are normalized into `sessions` and `messages` tables: each user input, assistant response, thinking trace, tool call, and tool result is its own row (`role` + `kind`), with the original JSON entry preserved in a `raw` column for full fidelity. Codex encrypts its reasoning; only its readable summaries are captured.
- `dai webui` serves a REST API plus a static React app (TanStack Router + Query) for browsing, editing (each save is a new version), pinning, restoring, and triggering syncs. The Sessions section lists every captured session (filterable by harness) and renders full transcripts — user inputs, thinking traces, tool calls with inputs, tool results, and responses — with long blocks collapsed and paged loading for big sessions.

## Adding a harness

All harness-specific knowledge lives in `src/core/harnesses/` — one adapter file per harness implementing `HarnessAdapter` (`src/core/harnesses/types.ts`). An adapter declares an `id` and `label` and optionally: where its session transcripts live (`discoverSessionFiles`), how to parse one into the normalized message shape (`parseSession`), which project files it contributes (`scanProjectArtifacts`), which harness-global configs hold MCP servers (`scanGlobalArtifacts`), and where a shared global MCP server should land on sync (`projectMcpConfigPath`).

To support a new harness, add an adapter file and register it in the `HARNESSES` array in `src/core/harnesses/index.ts`. Nothing else changes: scan/import/sync, the CLI (`--harness` validation and help text), the REST API (`/api/harnesses`), and the web UI (filter buttons and badges) all derive from the registry, and the `harness` columns are plain TEXT so no database migration is needed.

## Development

```bash
npm install
npm run build        # tsc (CLI + server) + vite (web UI)
node bin/dai.js --help

npm run dev:web      # vite dev server with /api proxied to localhost:4680
```

Why not X?
- Github; you don't want a repo per config set, and cross-repo sync is manual
- Obsidian Sync; does not support versioning
- Symlinks; break across machines and can't pin versions
