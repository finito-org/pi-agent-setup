# pi-agent-setup

Project-local setup for Pi coding-agent extensions and development guardrails.

## What's included

- `.pi/extensions/tmux-subagents/` — spawn independent Pi RPC subagents in visible tmux panes, communicate with them, forward clarification questions back to the main agent, and automatically summarize task/runtime/cost/result metadata when they finish.
- `.pi/extensions/bash-guard.ts` — blocks unsafe shell patterns, discourages ad hoc Python/dev servers, rewrites common search commands to `rg`, and rejects unsupported `find` rewrites instead of silently changing semantics.
- `.pi/extensions/read-many-files-lines.ts` — adds a multi-file line-range reader and blocks bash file readers such as `cat`, `sed`, `head`, `tail`, and `wc`.
- `.pi/extensions/post-edit-checks.ts` — runs affected formatting/typechecking checks after edits to JS/TS files and reports failures inline.
- `.pi/extensions/pr-link-status.ts` — shows a clickable GitHub PR status item in the Pi UI when the current branch has an open PR.

## Setup

```bash
bun install
```

Run Pi from this repository (or from a project containing this `.pi/extensions` directory) so the extensions are auto-discovered. After editing extensions inside a running Pi session, use `/reload`.

## Tmux subagents

The subagent extension requires running Pi inside tmux (`TMUX` and `TMUX_PANE` must be set).

User commands:

```text
/subagent investigate the auth flow and report risks
/subagent {"name":"reviewer","model":"sonnet:high","prompt":"Review the extension code."}
/subagents list
/subagents capture <id|name|%pane> [lines]
/subagents send <id|name|%pane> <message>
/subagents abort <id|name|%pane>
/subagents kill <id|name|%pane>
```

Agent tools:

- `spawn_subagents` — spawn one or more Pi RPC subagents.
- `subagent_panes` — list, capture, send, abort, or kill subagent panes.
- `ask_main_agent` — lets a spawned subagent ask the main agent or user a question with context.

See `.pi/extensions/tmux-subagents/README.md` for the full command and tool reference.

## Development

```bash
bun run check
bun test ./.pi/extensions/tmux-subagents/index.test.ts
```

`bun run check` runs `oxlint` over the extensions and `tsgo --noEmit` for typechecking.
