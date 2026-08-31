# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who work with multiple AI coding agents (Claude Code, Codex, Cursor) across many repositories. They accumulate skills, MCP server configs, and agent instruction files (CLAUDE.md, AGENTS.md, .cursorrules) and need them consistent across projects and machines. They are terminal-comfortable, self-hosting inclined, and treat their agent config as real infrastructure worth versioning. The webui user is the same person, sitting at their own machine, browsing `http://localhost:4680` served by `dai webui`.

## Product Purpose

Daiko syncs MCP servers, skills, and agent files across agents and projects. Every change is a new content-addressed (sha256) version; any artifact can be pinned to a specific version and restored. The webui exists to browse projects, read and edit artifacts (each save is a new version), inspect version history, pin/unpin, restore, and trigger syncs — the visual counterpart to the `dai` CLI.

## Positioning

Harness-agnostic, versioned, self-hosted, secure. Unlike a git repo per config set (manual cross-repo sync), Obsidian Sync (no versioning), or symlinks (break across machines, can't pin), Daiko stores everything in one local SQLite database (`~/.daiko/daiko.db`) with git-like content-addressed versioning per artifact.

## Operating Context

- CLI-first workflow: `dai init`, `dai add .`, `dai sync`, `dai hook`, `dai list`, `dai webui`.
- The webui runs locally (localhost:4680), single user, no auth, no cloud.
- Artifacts are markdown (SKILL.md, CLAUDE.md) and JSON (MCP server entries); reading/editing raw file content is a core activity.
- Version identities are shown as truncated sha256 hashes; sources are `add` (CLI scan) or `edit` (webui save).

## Capabilities and Constraints

- Five webui surfaces: Dashboard (stats + recent activity), Projects list, Project detail (artifacts grouped by type, sync/remove), typed artifact lists (Skills, MCP Servers), Artifact detail (content view/edit, version list, pin/restore/delete).
- Artifact types: skill, mcp_server, agent_md. Destructive actions: delete artifact, remove project (both confirm-gated).
- Stack: Vite + React + TanStack Router/Query; plain CSS (src/styles.css); no component library, no Tailwind. Served as static files by the Hono API server.
- Functionality, routes, API, and copy must be preserved in any redesign.

## Brand Commitments

Name: Daiko, CLI command `dai`. No taglines or badges in the UI. No logo asset beyond the "D" mark. Voice: terse, technical, honest (e.g. "Run `dai add .` in a repo to get started").

## Evidence on Hand

README.md at repo root documents features, workflow, and the "Why not X?" positioning. No testimonials, customers, or benchmarks exist — do not invent any.

## Product Principles

- Provenance is the product: versions, hashes, pins, and history deserve first-class visual treatment, like inspecting a ledger of immutable versions.
- Local-first calm: self-hosted, one SQLite file, no cloud — the tool should feel quiet, trustworthy, and utilitarian, never SaaS-flashy.
- The webui is the CLI's visual twin: it complements terminal workflow and references CLI commands in its empty states.
- Content is sacred: the tool never mutates silently; every edit is a new version, sync is explicit.
