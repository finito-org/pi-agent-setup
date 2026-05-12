import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static } from "typebox";
import { Type } from "typebox";
import {
  CUSTOM_ENTRY_TYPE,
  planSubagentPlacement,
  restoreRecordsForWindow,
  type SpawnedSubagentRecord,
  type SplitDirection,
  type SubagentSessionEntry,
} from "./state";

const EXTENSION_NAME = "tmux-subagents";
const SPAWN_TOOL_NAME = "spawn_subagents";
const PANES_TOOL_NAME = "subagent_panes";
const MAX_SUBAGENTS_PER_CALL = 8;
const DEFAULT_CAPTURE_LINES = 120;
const MAX_CAPTURE_LINES = 1000;
const TMP_ROOT = path.join(".pi", "tmp", "subagents");

type LayoutMode = "none" | "tiled" | "even-horizontal" | "even-vertical";
type PaneAction = "list" | "capture" | "kill" | "send" | "abort";
type MessageDelivery = "prompt" | "steer" | "follow_up";

interface PaneStatus {
  exists: boolean;
  dead?: boolean;
  currentCommand?: string;
  title?: string;
  windowId?: string;
  error?: string;
}

interface TmuxContext {
  paneId: string;
  windowId: string;
}

const BRIDGE_SCRIPT = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import readline from "node:readline";

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node bridge.mjs <config.json>");
  process.exit(1);
}

const config = JSON.parse(await fsp.readFile(configPath, "utf8"));
const controlPath = config.controlPath;
await fsp.writeFile(controlPath, "", { flag: "a" });

let controlOffset = 0;
let busy = false;
let sawAssistantText = false;
let closed = false;
let pendingUiRequest = null;

function stamp() {
  return new Date().toLocaleTimeString();
}

function line(text = "") {
  process.stdout.write(text + "\\n");
}

function banner() {
  line("── pi rpc subagent ─────────────────────────────────────");
  line("name: " + config.name);
  line("id: " + config.id);
  line("cwd: " + config.cwd);
  line("control: " + config.controlPath);
  line("Type a message here and press Enter to talk directly.");
  line("Commands: /steer <msg>, /follow <msg>, /abort, /quit");
  line("────────────────────────────────────────────────────────");
  line();
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\\n");
}

function truncate(text, max = 1800) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "…" : text;
}

const piArgs = ["--mode", "rpc", ...config.piArgs];
if (config.systemPromptPath) {
  const systemPrompt = await fsp.readFile(config.systemPromptPath, "utf8");
  piArgs.push(config.replaceSystemPrompt ? "--system-prompt" : "--append-system-prompt", systemPrompt);
}

banner();
line("+ " + (process.env.PI_SUBAGENT_PI_BIN || "pi") + " " + piArgs.map((arg) => JSON.stringify(arg)).join(" "));
line();

const child = spawn(process.env.PI_SUBAGENT_PI_BIN || "pi", piArgs, {
  cwd: config.cwd,
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

function send(command) {
  if (closed || child.stdin.destroyed) {
    line("[" + stamp() + "] cannot send: rpc process is closed");
    return;
  }
  child.stdin.write(JSON.stringify(command) + "\\n");
}

function sendMessage(message, delivery = "prompt") {
  const text = String(message || "").trim();
  if (!text) return;

  line();
  line("[main → " + config.name + "] " + text);

  if (delivery === "steer") {
    send({ type: "steer", message: text });
    return;
  }
  if (delivery === "follow_up") {
    send({ type: "follow_up", message: text });
    return;
  }

  const command = { type: "prompt", message: text };
  if (busy) command.streamingBehavior = "followUp";
  send(command);
}

function handleControl(item) {
  if (!item || typeof item !== "object") return;
  if (item.type === "send") {
    sendMessage(item.message, item.delivery || "prompt");
    return;
  }
  if (item.type === "abort") {
    line();
    line("[main → " + config.name + "] /abort");
    send({ type: "abort" });
    return;
  }
  if (item.type === "quit") {
    child.kill("SIGTERM");
  }
}

async function pollControl() {
  try {
    const stat = await fsp.stat(controlPath);
    if (stat.size < controlOffset) controlOffset = 0;
    if (stat.size === controlOffset) return;

    const fd = await fsp.open(controlPath, "r");
    try {
      const length = stat.size - controlOffset;
      const buffer = Buffer.alloc(length);
      await fd.read(buffer, 0, length, controlOffset);
      controlOffset = stat.size;
      for (const rawLine of buffer.toString("utf8").split("\\n")) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          handleControl(JSON.parse(trimmed));
        } catch (error) {
          line("[control parse error] " + (error instanceof Error ? error.message : String(error)));
        }
      }
    } finally {
      await fd.close();
    }
  } catch (error) {
    line("[control error] " + (error instanceof Error ? error.message : String(error)));
  }
}

setInterval(pollControl, 200).unref();

function answerUiRequest(request, value) {
  if (!request) return;
  if (request.method === "confirm") {
    send({ type: "extension_ui_response", id: request.id, confirmed: value === "yes" || value === "true" || value === "y" });
  } else if (value) {
    send({ type: "extension_ui_response", id: request.id, value });
  } else {
    send({ type: "extension_ui_response", id: request.id, cancelled: true });
  }
  pendingUiRequest = null;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
rl.on("line", (input) => {
  const text = input.trim();
  if (!text) return;

  if (pendingUiRequest) {
    answerUiRequest(pendingUiRequest, text);
    return;
  }

  if (text === "/quit" || text === "/exit") {
    child.kill("SIGTERM");
    return;
  }
  if (text === "/abort") {
    send({ type: "abort" });
    return;
  }
  if (text.startsWith("/steer ")) {
    send({ type: "steer", message: text.slice(7) });
    return;
  }
  if (text.startsWith("/follow ")) {
    send({ type: "follow_up", message: text.slice(8) });
    return;
  }

  const command = { type: "prompt", message: text };
  if (busy) command.streamingBehavior = "followUp";
  send(command);
});

function handleRpcEvent(event) {
  if (!event || typeof event !== "object") return;

  if (event.type === "response") {
    if (event.success === false) line("\\n[rpc error] " + (event.error || event.command || "unknown error"));
    return;
  }

  if (event.type === "extension_ui_request") {
    if (["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"].includes(event.method)) {
      if (event.method === "notify") line("\\n[notify] " + (event.message || ""));
      return;
    }
    pendingUiRequest = event;
    line("\\n[ui request] " + event.method + ": " + (event.title || ""));
    if (event.message) line(event.message);
    if (Array.isArray(event.options)) line("options: " + event.options.join(" | "));
    line("Type an answer, or just press Enter to cancel.");
    return;
  }

  if (event.type === "agent_start") {
    busy = true;
    sawAssistantText = false;
    line("\\n[" + stamp() + "] agent started");
    return;
  }

  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent;
    if (!delta) return;
    if (delta.type === "text_start") {
      if (!sawAssistantText) process.stdout.write("assistant> ");
      sawAssistantText = true;
      return;
    }
    if (delta.type === "text_delta") {
      process.stdout.write(delta.delta || "");
      return;
    }
    if (delta.type === "toolcall_end") {
      const call = delta.toolCall || delta.partial;
      if (call && call.name) line("\\n→ tool " + call.name + " " + truncate(JSON.stringify(call.arguments || {}), 500));
      return;
    }
    if (delta.type === "error") {
      line("\\n[assistant error] " + (delta.errorMessage || delta.reason || "error"));
    }
    return;
  }

  if (event.type === "tool_execution_start") {
    line("\\n🔧 " + event.toolName + " " + truncate(JSON.stringify(event.args || {}), 500));
    return;
  }

  if (event.type === "tool_execution_end") {
    const output = textFromParts(event.result && event.result.content);
    line((event.isError ? "✗ " : "✓ ") + event.toolName);
    if (output) line(truncate(output));
    return;
  }

  if (event.type === "agent_end") {
    busy = false;
    line("\\n[" + stamp() + "] agent ended");
    return;
  }

  if (event.type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    if (steering || followUp) line("\\n[queue] steering=" + steering + " followUp=" + followUp);
    return;
  }

  if (event.type === "extension_error") {
    line("\\n[extension error] " + (event.error || "unknown"));
  }
}

let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
  stdoutBuffer += chunk.toString("utf8");
  while (true) {
    const index = stdoutBuffer.indexOf("\\n");
    if (index === -1) break;
    let rawLine = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (rawLine.endsWith("\\r")) rawLine = rawLine.slice(0, -1);
    if (!rawLine.trim()) continue;
    try {
      handleRpcEvent(JSON.parse(rawLine));
    } catch {
      line("[rpc raw] " + rawLine);
    }
  }
});

child.stderr.on("data", (chunk) => {
  process.stdout.write(chunk.toString("utf8"));
});

child.on("error", (error) => {
  line("[rpc spawn error] " + error.message);
});

child.on("close", (code, signal) => {
  closed = true;
  busy = false;
  line();
  line("[pi rpc subagent exited code=" + code + " signal=" + signal + "]");
  if (config.stayOpen) {
    line("Pane left open for inspection. Type /quit or close the pane when done.");
  } else {
    process.exit(code || 0);
  }
});

setTimeout(async () => {
  if (config.promptPath) {
    const initialPrompt = await fsp.readFile(config.promptPath, "utf8");
    sendMessage(initialPrompt, "prompt");
  }
}, 250);
`;

const thinkingSchema = StringEnum(["off", "minimal", "low", "medium", "high", "xhigh"] as const, {
  description: "Thinking level for the subagent.",
});

const splitSchema = StringEnum(["right", "below"] as const, {
  description:
    "Override automatic placement. Omit for default behavior: first subagent opens on the right at 40%; later subagents split vertically below the latest subagent pane.",
});

const layoutSchema = StringEnum(["none", "tiled", "even-horizontal", "even-vertical"] as const, {
  description:
    "Optional tmux layout to apply after spawning. Default none preserves the right-side 40% subagent column.",
  default: "none",
});

const deliverySchema = StringEnum(["prompt", "steer", "follow_up"] as const, {
  description: "How to deliver a message to a subagent. prompt is normal; steer/follow_up queue while busy.",
  default: "prompt",
});

const subagentSpecSchema = Type.Object({
  name: Type.Optional(Type.String({ description: "Human-readable subagent name used for the pane title." })),
  prompt: Type.Optional(
    Type.String({
      description: "Initial user prompt/task sent to the subagent RPC session after it starts. Omit to start idle.",
    })
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        "Subagent system instructions. By default these are appended to Pi's normal system prompt so tools still work.",
    })
  ),
  replaceSystemPrompt: Type.Optional(
    Type.Boolean({ description: "Use --system-prompt instead of --append-system-prompt. Default false.", default: false })
  ),
  model: Type.Optional(
    Type.String({ description: "Model pattern/id for --model, e.g. anthropic/claude-sonnet-4-5 or sonnet:high." })
  ),
  provider: Type.Optional(Type.String({ description: "Provider name for --provider, if needed." })),
  thinking: Type.Optional(thinkingSchema),
  tools: Type.Optional(
    Type.Array(Type.String(), { description: "Optional tool allowlist passed to --tools, e.g. [read, grep, find, ls]." })
  ),
  noTools: Type.Optional(Type.Boolean({ description: "Pass --no-tools to the subagent.", default: false })),
  noBuiltinTools: Type.Optional(Type.Boolean({ description: "Pass --no-builtin-tools to the subagent.", default: false })),
  noSession: Type.Optional(
    Type.Boolean({ description: "Pass --no-session. Default false, so subagents are saved in Pi history.", default: false })
  ),
  inheritContext: Type.Optional(
    Type.Boolean({ description: "Load AGENTS.md/CLAUDE.md context files. Default true.", default: true })
  ),
  noExtensions: Type.Optional(Type.Boolean({ description: "Pass --no-extensions to the subagent. Default false.", default: false })),
  noSkills: Type.Optional(Type.Boolean({ description: "Pass --no-skills to the subagent. Default false.", default: false })),
  noPromptTemplates: Type.Optional(
    Type.Boolean({ description: "Pass --no-prompt-templates to the subagent. Default false.", default: false })
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the subagent. Relative paths are resolved inside the current project; outside paths are rejected.",
    })
  ),
  split: Type.Optional(splitSchema),
  size: Type.Optional(
    Type.String({
      description:
        "tmux split size, e.g. 40% or 20. Only digits with optional % are accepted. Default is 40% for the first right-side subagent pane.",
    })
  ),
  focus: Type.Optional(Type.Boolean({ description: "Focus the new pane after spawning. Default false.", default: false })),
  stayOpen: Type.Optional(
    Type.Boolean({ description: "Keep the bridge visible after the RPC child exits. Default true.", default: true })
  ),
});

const spawnSubagentsSchema = Type.Object({
  agents: Type.Array(subagentSpecSchema, {
    minItems: 1,
    maxItems: MAX_SUBAGENTS_PER_CALL,
    description: "Subagents to spawn, each in its own tmux pane running a Pi RPC bridge.",
  }),
  layout: Type.Optional(layoutSchema),
});

type SpawnSubagentsInput = Static<typeof spawnSubagentsSchema>;
type SubagentSpec = Static<typeof subagentSpecSchema>;

const panesSchema = Type.Object({
  action: StringEnum(["list", "capture", "kill", "send", "abort"] as const, {
    description: "list known subagents, capture pane output, kill a pane, or send/abort the RPC subagent.",
  }),
  id: Type.Optional(Type.String({ description: "Subagent id, name, or tmux pane id for capture/kill/send/abort." })),
  lines: Type.Optional(Type.Number({ description: `Number of recent lines to capture. Default ${DEFAULT_CAPTURE_LINES}.` })),
  message: Type.Optional(Type.String({ description: "Message to send when action is send." })),
  delivery: Type.Optional(deliverySchema),
});

type PanesInput = Static<typeof panesSchema>;

let registry = new Map<string, SpawnedSubagentRecord>();

function previewText(text: string | undefined, maxLength = 140): string {
  const compact = (text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "(idle)";
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function sanitizeName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "subagent";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function clampCaptureLines(lines: number | undefined): number {
  if (typeof lines !== "number" || !Number.isFinite(lines)) return DEFAULT_CAPTURE_LINES;
  return Math.max(1, Math.min(MAX_CAPTURE_LINES, Math.floor(lines)));
}

function resolveInsideRoot(root: string, requested: string | undefined): string {
  const resolved = requested ? path.resolve(root, requested) : root;
  const relative = path.relative(root, resolved);
  const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  if (!inside) throw new Error(`Subagent cwd must stay inside ${root}: ${requested}`);
  return resolved;
}

function validateSplitSize(size: string | undefined): string | undefined {
  if (!size) return undefined;
  if (!/^\d+%?$/.test(size)) throw new Error(`Invalid tmux split size: ${size}. Use digits with optional %, e.g. 40%.`);
  return size;
}

function piArgsForSpec(spec: SubagentSpec): string[] {
  const args: string[] = [];
  if (spec.provider) args.push("--provider", spec.provider);
  if (spec.model) args.push("--model", spec.model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.noTools) args.push("--no-tools");
  else if (spec.noBuiltinTools) args.push("--no-builtin-tools");
  if (spec.tools && spec.tools.length > 0) args.push("--tools", spec.tools.join(","));
  if (spec.noSession) args.push("--no-session");
  if (spec.inheritContext === false) args.push("--no-context-files");
  if (spec.noExtensions) args.push("--no-extensions");
  if (spec.noSkills) args.push("--no-skills");
  if (spec.noPromptTemplates) args.push("--no-prompt-templates");
  return args;
}

function buildRunScript(options: { name: string; cwd: string; bridgePath: string; configPath: string }): string {
  return `#!/usr/bin/env bash
set -u
printf '\\033]2;%s\\007' ${shellQuote(`pi rpc subagent: ${options.name}`)}
cd ${shellQuote(options.cwd)} || exit 1
if command -v node >/dev/null 2>&1; then
  exec node ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
if command -v bun >/dev/null 2>&1; then
  exec bun ${shellQuote(options.bridgePath)} ${shellQuote(options.configPath)}
fi
echo 'Neither node nor bun was found; cannot run Pi RPC bridge.'
exec /bin/sh
`;
}

async function writeSubagentFiles(ctx: ExtensionContext, spec: SubagentSpec, name: string, cwd: string) {
  const id = randomUUID();
  const dir = path.resolve(ctx.cwd, TMP_ROOT, `${safeFilename(name)}-${id}`);
  await mkdir(dir, { recursive: true });

  const promptPath = spec.prompt !== undefined ? path.join(dir, "prompt.md") : undefined;
  if (promptPath) await writeFile(promptPath, spec.prompt ?? "", { encoding: "utf8", mode: 0o600 });

  const systemPromptPath = spec.systemPrompt?.trim() ? path.join(dir, "system.md") : undefined;
  if (systemPromptPath) await writeFile(systemPromptPath, spec.systemPrompt ?? "", { encoding: "utf8", mode: 0o600 });

  const bridgePath = path.join(dir, "bridge.mjs");
  const configPath = path.join(dir, "config.json");
  const controlPath = path.join(dir, "control.jsonl");
  const runScriptPath = path.join(dir, "run.sh");

  await writeFile(bridgePath, BRIDGE_SCRIPT, { encoding: "utf8", mode: 0o700 });
  await chmod(bridgePath, 0o700);
  await writeFile(controlPath, "", { encoding: "utf8", mode: 0o600 });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        id,
        name,
        cwd,
        piArgs: piArgsForSpec(spec),
        promptPath,
        systemPromptPath,
        replaceSystemPrompt: spec.replaceSystemPrompt ?? false,
        controlPath,
        stayOpen: spec.stayOpen ?? true,
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  await writeFile(runScriptPath, buildRunScript({ name, cwd, bridgePath, configPath }), { encoding: "utf8", mode: 0o700 });
  await chmod(runScriptPath, 0o700);

  return { id, dir, promptPath, systemPromptPath, bridgePath, configPath, controlPath, runScriptPath };
}

async function runTmux(pi: ExtensionAPI, args: string[], signal: AbortSignal | undefined, timeout = 10_000) {
  const result = await pi.exec("tmux", args, { signal, timeout });
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `tmux exited with code ${result.code}`;
    throw new Error(detail);
  }
  return result.stdout.trim();
}

async function ensureTmux(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<TmuxContext> {
  const paneId = process.env.TMUX_PANE;
  if (!process.env.TMUX || !paneId) {
    throw new Error("tmux subagents require running pi inside tmux (TMUX/TMUX_PANE are not set). Start tmux, then run pi again.");
  }
  await runTmux(pi, ["-V"], signal);
  const windowId = await runTmux(pi, ["display-message", "-p", "-t", paneId, "#{window_id}"], signal);
  return { paneId, windowId };
}

async function findLatestLiveSubagentPane(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string
): Promise<string | undefined> {
  const records = Array.from(registry.values()).sort((a, b) => b.createdAt - a.createdAt);
  for (const record of records) {
    if (record.windowId !== windowId) continue;
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) return record.paneId;
  }
  return undefined;
}

async function spawnOneSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  targetPane: string,
  split: SplitDirection,
  size: string | undefined,
  spec: SubagentSpec,
  index: number,
  windowId: string
): Promise<SpawnedSubagentRecord> {
  const name = sanitizeName(spec.name, `subagent-${index + 1}`);
  const cwd = resolveInsideRoot(ctx.cwd, spec.cwd);
  const validatedSize = validateSplitSize(size);
  const files = await writeSubagentFiles(ctx, spec, name, cwd);

  const tmuxArgs = ["split-window", "-P", "-F", "#{pane_id}", "-t", targetPane];
  if (!spec.focus) tmuxArgs.push("-d");
  tmuxArgs.push(split === "right" ? "-h" : "-v");
  if (validatedSize) tmuxArgs.push("-l", validatedSize);
  tmuxArgs.push("-c", cwd, `bash ${shellQuote(files.runScriptPath)}`);

  const paneId = await runTmux(pi, tmuxArgs, ctx.signal);
  await runTmux(pi, ["select-pane", "-t", paneId, "-T", `pi:${name}`], ctx.signal).catch(() => undefined);

  const record: SpawnedSubagentRecord = {
    id: files.id,
    name,
    paneId,
    windowId,
    cwd,
    promptPreview: previewText(spec.prompt),
    model: spec.model,
    provider: spec.provider,
    thinking: spec.thinking,
    tools: spec.tools,
    bridgePath: files.bridgePath,
    configPath: files.configPath,
    controlPath: files.controlPath,
    runScriptPath: files.runScriptPath,
    promptPath: files.promptPath,
    systemPromptPath: files.systemPromptPath,
    replaceSystemPrompt: spec.replaceSystemPrompt ?? false,
    noSession: spec.noSession ?? false,
    createdAt: Date.now(),
  };
  registry.set(record.id, record);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, record });
  return record;
}

async function spawnSubagents(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  input: SpawnSubagentsInput
): Promise<SpawnedSubagentRecord[]> {
  if (input.agents.length > MAX_SUBAGENTS_PER_CALL) {
    throw new Error(`Too many subagents (${input.agents.length}); max is ${MAX_SUBAGENTS_PER_CALL}.`);
  }

  const tmux = await ensureTmux(pi, ctx.signal);
  await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  const records: SpawnedSubagentRecord[] = [];
  let stackTargetPane = await findLatestLiveSubagentPane(pi, ctx.signal, tmux.windowId);

  for (let index = 0; index < input.agents.length; index += 1) {
    const spec = input.agents[index];
    const placement = planSubagentPlacement(Boolean(stackTargetPane), spec.split, spec.size);
    const targetPane = placement.target === "main" ? tmux.paneId : stackTargetPane ?? tmux.paneId;
    const record = await spawnOneSubagent(pi, ctx, targetPane, placement.split, placement.size, spec, index, tmux.windowId);
    records.push(record);
    stackTargetPane = record.paneId;
  }

  const layout: LayoutMode = input.layout ?? "none";
  if (layout !== "none" && records.length > 1) {
    await runTmux(pi, ["select-layout", "-t", tmux.paneId, layout], ctx.signal).catch(() => undefined);
  }

  return records;
}

function restoreRegistry(ctx: ExtensionContext, windowId: string | undefined) {
  registry = windowId ? restoreRecordsForWindow(ctx.sessionManager.getBranch() as SubagentSessionEntry[], windowId) : new Map();
}

function formatRecord(record: SpawnedSubagentRecord, status?: PaneStatus): string {
  const state = status?.exists === false ? "missing" : status?.dead ? "dead" : status?.currentCommand || "running";
  const model = record.model ? ` model=${record.model}` : "";
  const provider = record.provider ? ` provider=${record.provider}` : "";
  return [
    `${record.name} ${record.paneId} [${state}] id=${record.id}`,
    `  cwd: ${record.cwd}`,
    `  task: ${record.promptPreview}`,
    `  control: ${record.controlPath}`,
    `  run: ${record.runScriptPath}${model}${provider}`,
  ].join("\n");
}

function findRecord(idOrName: string | undefined): SpawnedSubagentRecord | undefined {
  if (!idOrName) return undefined;
  for (const record of registry.values()) {
    if (record.id === idOrName || record.paneId === idOrName || record.name === idOrName) return record;
    if (record.id.startsWith(idOrName)) return record;
  }
  return undefined;
}

async function paneStatus(pi: ExtensionAPI, paneId: string, signal: AbortSignal | undefined): Promise<PaneStatus> {
  try {
    const output = await runTmux(
      pi,
      ["display-message", "-p", "-t", paneId, "#{pane_dead}\t#{pane_current_command}\t#{pane_title}\t#{window_id}"],
      signal
    );
    const [dead, currentCommand, title, windowId] = output.split("\t");
    return { exists: true, dead: dead === "1", currentCommand, title, windowId };
  } catch (error) {
    return { exists: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function pruneMissingRecords(
  pi: ExtensionAPI,
  signal: AbortSignal | undefined,
  windowId: string | undefined
): Promise<number> {
  if (!process.env.TMUX || !windowId) return 0;
  let removed = 0;
  for (const record of Array.from(registry.values())) {
    if (record.windowId !== windowId) {
      registry.delete(record.id);
      removed += 1;
      continue;
    }
    const status = await paneStatus(pi, record.paneId, signal);
    if (status.exists && !status.dead && status.windowId === windowId) continue;
    registry.delete(record.id);
    pi.appendEntry(CUSTOM_ENTRY_TYPE, {
      version: 3,
      killedId: record.id,
      killedAt: Date.now(),
      reason: status.dead ? "dead-pane" : status.exists ? "different-window" : "missing-pane",
    });
    removed += 1;
  }
  return removed;
}

function updateSubagentStatus(ctx: ExtensionContext) {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(EXTENSION_NAME, registry.size ? `subagents:${registry.size}` : undefined);
}

async function listRecords(pi: ExtensionAPI, signal: AbortSignal | undefined): Promise<string> {
  if (registry.size === 0) return "No live subagents in this Pi session branch.";
  const chunks: string[] = [];
  for (const record of registry.values()) {
    chunks.push(formatRecord(record, await paneStatus(pi, record.paneId, signal)));
  }
  return chunks.join("\n\n");
}

async function capturePane(pi: ExtensionAPI, paneId: string, lines: number, signal: AbortSignal | undefined): Promise<string> {
  return runTmux(pi, ["capture-pane", "-p", "-t", paneId, "-S", `-${lines}`], signal);
}

async function sendToSubagent(record: SpawnedSubagentRecord, message: string, delivery: MessageDelivery | undefined): Promise<string> {
  if (!message.trim()) throw new Error("Message is required for action=send.");
  if (!record.controlPath) throw new Error(`Subagent ${record.name} has no control path; respawn it with the updated extension.`);
  await appendFile(
    record.controlPath,
    `${JSON.stringify({ type: "send", message, delivery: delivery ?? "prompt", timestamp: Date.now() })}\n`,
    "utf8"
  );
  return `Queued message to ${record.name} ${record.paneId}.`;
}

async function handlePaneAction(pi: ExtensionAPI, ctx: ExtensionContext, input: PanesInput): Promise<string> {
  const tmux = await ensureTmux(pi, ctx.signal);
  const removed = await pruneMissingRecords(pi, ctx.signal, tmux.windowId);
  if (input.action === "list") {
    const text = await listRecords(pi, ctx.signal);
    return removed > 0 ? `Pruned ${removed} stale subagent record${removed === 1 ? "" : "s"}.\n\n${text}` : text;
  }

  const record = findRecord(input.id);
  if (!record) {
    const known = Array.from(registry.values())
      .map((r) => `${r.name} (${r.paneId}, ${r.id.slice(0, 8)})`)
      .join(", ");
    throw new Error(`Unknown subagent: ${input.id ?? "(missing id)"}. Known: ${known || "none"}`);
  }

  if (input.action === "capture") {
    const lines = clampCaptureLines(input.lines);
    const output = await capturePane(pi, record.paneId, lines, ctx.signal);
    return `Captured last ${lines} lines from ${record.name} ${record.paneId}:\n\n${output || "(no pane output)"}`;
  }

  if (input.action === "send") return sendToSubagent(record, input.message ?? "", input.delivery);

  if (input.action === "abort") {
    await appendFile(record.controlPath, `${JSON.stringify({ type: "abort", timestamp: Date.now() })}\n`, "utf8");
    return `Queued abort for ${record.name} ${record.paneId}.`;
  }

  await runTmux(pi, ["kill-pane", "-t", record.paneId], ctx.signal);
  registry.delete(record.id);
  pi.appendEntry(CUSTOM_ENTRY_TYPE, { version: 3, killedId: record.id, killedAt: Date.now() });
  return `Killed subagent ${record.name} ${record.paneId}.`;
}

function spawnResultText(records: SpawnedSubagentRecord[]): string {
  return [
    `Spawned ${records.length} RPC subagent pane${records.length === 1 ? "" : "s"}.`,
    ...records.map(
      (record) =>
        `- ${record.name}: ${record.paneId} (id ${record.id.slice(0, 8)})\n  task: ${record.promptPreview}\n  control: ${record.controlPath}`
    ),
  ].join("\n");
}

function parseSpawnArgs(args: string): SpawnSubagentsInput | null {
  const trimmed = args.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as SpawnSubagentsInput | SubagentSpec[] | SubagentSpec | unknown;
    if (Array.isArray(parsed)) return { agents: parsed as SubagentSpec[] };
    if (!parsed || typeof parsed !== "object") throw new Error("Subagent JSON must be an object or array.");
    if ("agents" in parsed) return parsed as SpawnSubagentsInput;
    return { agents: [parsed as SubagentSpec] };
  }
  return { agents: [{ prompt: trimmed }] };
}

async function promptForSubagent(ctx: ExtensionContext): Promise<SpawnSubagentsInput | null> {
  if (!ctx.hasUI) return null;
  const prompt = await ctx.ui.editor("Subagent prompt/task (optional; blank starts idle)", "");
  const name = (await ctx.ui.input("Subagent name", "subagent")) || "subagent";
  const systemPrompt = await ctx.ui.editor("System instructions to append (optional)", "");
  const model = (await ctx.ui.input("Model (optional)", ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "")) || undefined;
  const toolsText = (await ctx.ui.input("Tool allowlist (optional comma-separated)", "")) || "";
  const splitChoice = (await ctx.ui.select("Split pane", ["auto", "right", "below"])) as
    | "auto"
    | SplitDirection
    | undefined;
  const saveSession = await ctx.ui.confirm("Save subagent session?", "Yes = normal Pi session history. No = --no-session.");
  const focus = await ctx.ui.confirm("Focus new pane?", "No keeps you in the current Pi pane while the subagent runs.");

  return {
    agents: [
      {
        name,
        prompt: prompt?.trim() ? prompt : undefined,
        systemPrompt: systemPrompt?.trim() ? systemPrompt : undefined,
        model: model?.trim() ? model.trim() : undefined,
        tools: toolsText.trim()
          ? toolsText
              .split(",")
              .map((tool) => tool.trim())
              .filter(Boolean)
          : undefined,
        split: splitChoice && splitChoice !== "auto" ? splitChoice : undefined,
        noSession: !saveSession,
        focus,
      },
    ],
  };
}

function parseSubagentsCommand(args: string): PanesInput {
  const trimmed = args.trim();
  if (!trimmed) return { action: "list" };
  const [actionRaw, id, third, ...rest] = trimmed.split(/\s+/);
  const action = (actionRaw || "list") as PaneAction;
  if (!["list", "capture", "kill", "send", "abort"].includes(action)) {
    throw new Error("Usage: /subagents [list|capture <id> [lines]|kill <id>|abort <id>|send <id> <message>]");
  }
  if (action === "send") return { action, id, message: [third, ...rest].filter(Boolean).join(" ") };
  return { action, id, lines: third ? Number(third) : undefined };
}

export default function tmuxSubagents(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const tmux = await ensureTmux(pi, ctx.signal).catch(() => undefined);
    restoreRegistry(ctx, tmux?.windowId);
    await pruneMissingRecords(pi, ctx.signal, tmux?.windowId).catch(() => undefined);
    updateSubagentStatus(ctx);
  });

  pi.registerTool({
    name: SPAWN_TOOL_NAME,
    label: "Spawn tmux RPC subagents",
    description: [
      "Spawn one or more independent Pi subagents in new tmux panes.",
      "Each pane runs a small readable bridge that starts `pi --mode rpc`, displays the conversation, accepts direct typed messages,",
      "and receives messages from the main agent through subagent_panes(action='send').",
      "Each subagent can have its own prompt, appended/replaced system prompt, model, thinking level, tool allowlist, cwd, and session mode.",
    ].join(" "),
    promptSnippet: "Spawn independent Pi RPC subagents in visible tmux panes with custom prompts/models/system instructions",
    promptGuidelines: [
      "Use spawn_subagents when work can be delegated to independent agents that the user should be able to watch in tmux panes.",
      "When using spawn_subagents, give each subagent a clear, bounded prompt and a concise name.",
      "Use subagent_panes with action send to communicate with spawned subagents, and action capture to inspect pane output.",
    ],
    parameters: spawnSubagentsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const records = await spawnSubagents(pi, ctx, params);
      updateSubagentStatus(ctx);
      return { content: [{ type: "text" as const, text: spawnResultText(records) }], details: { records } };
    },
    renderCall(args, theme) {
      const agents = Array.isArray(args.agents) ? args.agents : [];
      let text = theme.fg("toolTitle", theme.bold("spawn_subagents "));
      text += theme.fg("accent", `${agents.length || 0} rpc pane${agents.length === 1 ? "" : "s"}`);
      for (const agent of agents.slice(0, 4)) {
        text += `\n  ${theme.fg("accent", agent.name || "subagent")}: ${theme.fg("dim", previewText(agent.prompt, 72))}`;
      }
      if (agents.length > 4) text += `\n  ${theme.fg("muted", `... +${agents.length - 4} more`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, _options, theme) {
      const records = (result.details as { records?: SpawnedSubagentRecord[] } | undefined)?.records ?? [];
      if (records.length === 0) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "(no subagents)", 0, 0);
      }
      let text = `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("spawned "))}${theme.fg(
        "accent",
        `${records.length} rpc pane${records.length === 1 ? "" : "s"}`
      )}`;
      for (const record of records) {
        text += `\n  ${theme.fg("accent", record.name)} ${theme.fg("muted", record.paneId)} ${theme.fg(
          "dim",
          record.promptPreview
        )}`;
      }
      return new Text(text, 0, 0);
    },
  });

  pi.registerTool({
    name: PANES_TOOL_NAME,
    label: "Manage subagent panes",
    description: "List known tmux subagent panes, capture recent output, send messages to RPC subagents, abort, or kill panes.",
    promptSnippet: "List, capture, send messages to, abort, or kill tmux subagent panes spawned by spawn_subagents",
    parameters: panesSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const text = await handlePaneAction(pi, ctx, params);
      updateSubagentStatus(ctx);
      return { content: [{ type: "text" as const, text }], details: { action: params.action } };
    },
  });

  pi.registerCommand("subagent", {
    description: "Spawn a Pi RPC subagent in a new tmux pane. Args: prompt text or JSON spec.",
    handler: async (args, ctx) => {
      let input: SpawnSubagentsInput | null;
      try {
        const parsed = parseSpawnArgs(args);
        input = parsed ?? (await promptForSubagent(ctx));
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (!input) {
        ctx.ui.notify("No subagent config provided.", "warning");
        return;
      }
      try {
        const records = await spawnSubagents(pi, ctx, input);
        updateSubagentStatus(ctx);
        ctx.ui.notify(spawnResultText(records), "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "List/capture/send/abort/kill spawned subagent panes. Usage: /subagents [list|capture <id> [lines]|send <id> <msg>|abort <id>|kill <id>]",
    handler: async (args, ctx) => {
      let input: PanesInput;
      try {
        input = parseSubagentsCommand(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      try {
        const text = await handlePaneAction(pi, ctx, input);
        updateSubagentStatus(ctx);
        if (input.action === "list" || input.action === "capture") await ctx.ui.editor(`Subagents ${input.action}`, text);
        else ctx.ui.notify(text, "info");
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}
