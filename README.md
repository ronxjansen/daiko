# Daiko

[![npm version](https://img.shields.io/npm/v/@ronxjansen/daiko.svg)](https://www.npmjs.com/package/@ronxjansen/daiko)
[![CI](https://github.com/ronxjansen/daiko/actions/workflows/ci.yml/badge.svg)](https://github.com/ronxjansen/daiko/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@ronxjansen/daiko.svg)](https://github.com/ronxjansen/daiko/blob/master/LICENSE)

Sync your MCP servers, skills, AGENT.md and more across agents and projects. Harness agnostic, versioned, local-first and secure. Configure a hook into your agent harness (`dai hook`) and it will automatically sync skills and MCP servers files into your project. 

## Getting started

```bash
npm i -g @ronxjansen/daiko
dai add .           # upload all skills, MCP servers, agent files for the repo (uses repo dir name as project name) into Daiko
dai hook            # configure a hook into one or more agent harnesses to keep skills and MCP configuration in sync
dai webui --daemon  # start the web app (http://localhost:4680)
```

## Features
- sync MCP servers, skills and AGENT.md files, including global harness configurations
- one stored artifact per skill, instruction doc or MCP server — rendered into every harness you target
- skills are stored whole: SKILL.md plus its scripts, references and binary assets, executable bits included
- each skill or MCP configuration is versioned
- share any skill or MCP server into any other repo
- pin any skill or MCP server to a specific version
- capture full session transcript capture
- web UI to browse projects, edit artifacts, inspect version history, pin and restore

## How it works
Daiko registers hooks into any indentified agent harness. Using these hooks it:
a) syncs skills and MCP configuration each new session, automatically. 
b) captures the agent session transcript

## One artifact, many harnesses

A skill is a skill whether it sits in `.claude/skills`, `.codex/skills` or `.agents/skills`;
your project instructions are one document whether the file is called `CLAUDE.md`, `AGENTS.md`
or `GEMINI.md`. Daiko stores each of those once, with a single version history, and *renders*
it into the layout of every harness you target:

```bash
dai target my-skill                          # show targets and the files they produce
dai target my-skill claude codex cursor      # deploy it to three harnesses
dai target my-skill --all                    # ...or every harness that can hold it
dai sync .                                   # write it into all of them
```

Scanning fills the targets in for you: find the same skill in `.claude/skills` and
`.codex/skills` and it becomes one artifact deployed to both. Scanning only ever adds targets —
to stop deploying somewhere, say so with `dai target`, or sync will just write the file back. Edit either copy and the change
propagates to the rest on the next sync. Edit *both* differently and Daiko refuses to guess:
it keeps the stored version and tells you which copies disagree.

### What each harness can hold

| Harness | Instructions | Skills | MCP servers |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE.md` | `.claude/skills` | `.mcp.json` |
| Codex | `AGENTS.md` | `.codex/skills` | — (global `~/.codex/config.toml` only) |
| Cursor | `.cursorrules` | `.cursor/skills` | `.cursor/mcp.json` |
| Gemini | `GEMINI.md` | — | — |
| Goose | `AGENTS.md` (reads `.goosehints`) | `.agents/skills` | — (global `~/.config/goose/config.yaml` only) |
| Kilo Code | `AGENTS.md` | `.kilocode/skills` | `.kilocode/mcp.json` |
| opencode | `AGENTS.md` | `.opencode/skills` | — (`opencode.json` uses its own shape) |
| Pi | `AGENTS.md` | `.pi/skills` | — (no MCP by design) |
| Hermes | `AGENTS.md` (reads `HERMES.md`) | — (global `~/.hermes/skills` only) | — (global `~/.hermes/config.yaml` only) |
| Generic | `AGENTS.md` | `.agents/skills` | — |

A dash means Daiko has nowhere to put that artifact type for that harness. It says so when
you sync rather than writing it into some other harness's config file.

## Why not X?
- Github or symlinks do not allow for granular configurations; when using a single Git repo or symlinked directory either a MCP server or skills is configured or not. In my experience you want some projects to use some of the MCP configurations.
- Obsidian Sync does not support versioning or pinning
- Skillshare does not cover MCP

## CLI Reference

```bash
npm i -g daiko
dai init          # onboard this machine: detect installed harnesses, import all sessions, discover every
                  # repo they were used in (from harness global state — no disk crawl), scan + upload each
                  # repo's config, and optionally install hooks. Interactive with sensible defaults; rerun-safe.
dai init -y       # same, accepting the defaults (import + scan everything, no hooks)
dai init --hooks global --no-sessions --harness claude codex  # flag-driven, for scripts
dai add .         # upload all skills, MCP servers, agent files for the repo (uses repo dir name as project name)
dai sync          # write skills, MCP servers and agent files from the central store back into the repo
                  # (local edits that were never added are reported and left alone)
dai sync --force  # ... and overwrite those local edits with the stored version
dai search <q>    # search all stored skills, MCP servers, and agent files by name
dai attach <name> # share a stored skill/MCP server into this repo and write it to disk
dai target <name> [harnesses...]  # show or set which harnesses an artifact is rendered into
dai detach <name> # remove a shared skill/MCP server from this repo (unlink + delete from disk)
dai hook          # install hooks for every detected harness (Claude Code, Codex, Cursor, Gemini): auto "dai sync" on session start + transcript capture
dai hook -g       # same, globally (~/.claude, ~/.codex, ~/.cursor, ~/.gemini): every new session in a registered repo auto-syncs
dai hook --harness codex  # limit to specific harnesses
dai import        # import locally stored sessions from Claude Code, Codex, Gemini CLI, Goose, Pi, and Hermes
dai sessions      # list captured sessions
dai list          # list registered projects and artifacts
dai webui         # manage everything in a web app (http://localhost:4680)
dai webui -d      # same, but as a background daemon (logs: ~/.daiko/webui.log)
dai webui status  # show whether the daemon is running
dai webui stop    # stop the background daemon
```
