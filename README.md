# Daiko

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
- works with any agent harness, including Claude Code, Codex, Cursor, Pi and OpenCode
- each skill or MCP configuration is versioned
- share any skill or MCP server into any other repo
- pin any skill or MCP server to a specific version
- capture full session transcript capture
- web UI to browse projects, edit artifacts, inspect version history, pin and restore

## How it works
Daiko registers hooks into any indentified agent harness. Using these hooks it:
a) syncs skills and MCP configuration each new session, automatically. 
b) captures the agent session transcript

## Why not X?
- Github or symlinks do not allow for granular configurations; when using a single Git repo or symlinked directory either a MCP server or skills is configured or not. In my experience you want some projects to use some of the MCP configurations.
- Obsidian Sync does not support versioning or pinning
- Skillshare does not cover MCP

## CLI Reference

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
dai webui -d      # same, but as a background daemon (logs: ~/.daiko/webui.log)
dai webui status  # show whether the daemon is running
dai webui stop    # stop the background daemon
```
