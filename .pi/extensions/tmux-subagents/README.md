# tmux-subagents Pi extension

Project-local Pi extension that spawns independent Pi agents in visible tmux panes.

## What `/subagent` does

1. Creates a new tmux pane on the right side of the current Pi pane at 40% width.
2. If a subagent pane already exists, creates the next subagent by splitting the latest subagent pane vertically.
3. Starts a small bridge script in that pane.
4. The bridge starts `pi --mode rpc`.
5. The bridge renders the RPC event stream as readable conversation output.
6. The main Pi agent can send messages to the subagent through the control file, and you can also type directly in the subagent pane.

## Requirements

- Run `pi` from inside tmux (`TMUX` and `TMUX_PANE` must be set).
- The extension is auto-discovered from `.pi/extensions/tmux-subagents/index.ts`; run `/reload` after adding or editing it.

## User commands

Spawn one subagent:

```text
/subagent investigate the auth flow and report risks
```

Spawn with JSON config:

```text
/subagent {"name":"reviewer","model":"sonnet:high","systemPrompt":"You are a strict reviewer.","prompt":"Review the extension code.","focus":true}
```

Spawn multiple panes:

```text
/subagent {"agents":[{"name":"reviewer","prompt":"Review for bugs"},{"name":"tester","prompt":"Find a test plan"}]}
```

Manage and communicate:

```text
/subagents list
/subagents capture <id|name|%pane> [lines]
/subagents send <id|name|%pane> <message>
/subagents abort <id|name|%pane>
/subagents kill <id|name|%pane>
```

Inside a subagent pane, you can type directly:

```text
hello, summarize your current task
/steer focus on tests
/follow after that, summarize findings
/abort
/quit
```

## Agent tools

The LLM gets two tools:

- `spawn_subagents` — spawn one or more Pi RPC subagents in tmux panes.
- `subagent_panes` — list, capture, send messages, abort, or kill panes.

Each spawned subagent supports its own:

- `prompt`
- `systemPrompt` (`--append-system-prompt` by default)
- `replaceSystemPrompt` (`--system-prompt` when true)
- `model`, `provider`, `thinking`
- `tools`, `noTools`, `noBuiltinTools`
- `cwd` inside the current project
- `noSession`
- `split`, `size`, `focus`, `stayOpen`

By default subagent sessions are saved in normal Pi session history and the bridge stays active so the subagent can receive later messages.

Subagents are scoped to the current tmux window. The footer count and `/subagents list` only include panes created for the tmux window running the current Pi pane; stale legacy records without a tmux window id are ignored after `/reload`.
