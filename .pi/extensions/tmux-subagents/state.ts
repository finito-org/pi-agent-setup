export const CUSTOM_ENTRY_TYPE = "tmux-subagent";

export type SplitDirection = "right" | "below";

export interface SpawnedSubagentRecord {
  id: string;
  name: string;
  paneId: string;
  windowId?: string;
  cwd: string;
  promptPreview: string;
  model?: string;
  provider?: string;
  thinking?: string;
  tools?: string[];
  bridgePath: string;
  configPath: string;
  controlPath: string;
  outboxPath?: string;
  runScriptPath: string;
  promptPath?: string;
  systemPromptPath?: string;
  replaceSystemPrompt: boolean;
  noSession: boolean;
  createdAt: number;
}

export interface SubagentPlacementPlan {
  split: SplitDirection;
  target: "main" | "stack";
  size?: string;
}

export type QuestionAudience = "main_agent" | "user" | "unsure";

export interface SubagentQuestion {
  id: string;
  type: "question";
  addressedTo: QuestionAudience;
  question: string;
  context?: string;
  whatDone?: string;
  options?: string[];
  timestamp?: number;
}

export interface SubagentUsageStats {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number;
  turns?: number;
}

export interface SubagentDoneEvent {
  type: "done";
  subagentId?: string;
  subagentName?: string;
  timestamp?: number;
  task?: string;
  result?: string;
  status?: "success" | "error" | "aborted" | "unknown";
  stopReason?: string;
  errorMessage?: string;
  runtimeMs?: number;
  agentRuntimeMs?: number;
  usage?: SubagentUsageStats;
  model?: string;
  provider?: string;
}

export interface SubagentSessionEntry {
  type: string;
  customType?: string;
  data?: {
    version?: number;
    record?: SpawnedSubagentRecord;
    killedId?: string;
    completion?: SubagentDoneEvent;
  };
}

export function planSubagentPlacement(
  hasStackTarget: boolean,
  explicitSplit: SplitDirection | undefined,
  requestedSize: string | undefined
): SubagentPlacementPlan {
  const split: SplitDirection = explicitSplit ?? (hasStackTarget ? "below" : "right");
  const target = explicitSplit === "right" || !hasStackTarget ? "main" : "stack";
  const size = requestedSize ?? (!explicitSplit && split === "right" ? "40%" : undefined);
  return size ? { split, target, size } : { split, target };
}

export function restoreRecordsForWindow(entries: SubagentSessionEntry[], windowId: string): Map<string, SpawnedSubagentRecord> {
  const restored = new Map<string, SpawnedSubagentRecord>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CUSTOM_ENTRY_TYPE) continue;
    const data = entry.data;
    if (data?.killedId) {
      restored.delete(data.killedId);
      continue;
    }
    if (!data?.record?.id) continue;
    if (data.record.windowId !== windowId) continue;
    restored.set(data.record.id, data.record);
  }
  return restored;
}

export function questionNeedsUserPrompt(question: SubagentQuestion): boolean {
  return question.addressedTo === "user" || question.addressedTo === "unsure";
}

export function formatQuestionForMainAgent(
  record: SpawnedSubagentRecord,
  question: SubagentQuestion,
  recentPaneOutput: string
): string {
  const audienceLine = questionNeedsUserPrompt(question)
    ? "The subagent says this is for the user, or it is unsure. Prompt the user in this main conversation before answering."
    : "The subagent says this is for the main agent. Answer it if you can without asking the user.";
  const options = question.options?.length ? `\nOptions:\n${question.options.map((option) => `- ${option}`).join("\n")}` : "";
  const context = question.context?.trim() ? `\nContext from subagent:\n${question.context.trim()}\n` : "";
  const whatDone = question.whatDone?.trim() ? `\nWhat the subagent says it did so far:\n${question.whatDone.trim()}\n` : "";
  const recent = recentPaneOutput.trim() ? `\nRecent pane output:\n${recentPaneOutput.trim()}\n` : "";

  return [
    `Subagent "${record.name}" (${record.paneId}) has a question.`,
    audienceLine,
    `Task: ${record.promptPreview}`,
    `Question: ${question.question.trim()}${options}`,
    context.trimEnd(),
    whatDone.trimEnd(),
    recent.trimEnd(),
    `After you have the answer, send it back with subagent_panes action="send" id="${record.id}".`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 28))}\n…(truncated ${text.length - maxLength} chars)`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatSubagentDuration(ms: number | undefined): string {
  const value = finiteNumber(ms);
  if (value === undefined || value < 0) return "unknown";
  if (value < 1000) return `${Math.round(value)}ms`;

  const totalSeconds = Math.round(value / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const parts: string[] = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatSubagentCost(usage: SubagentUsageStats | undefined): string {
  const cost = finiteNumber(usage?.cost);
  return cost === undefined ? "unknown" : `$${cost.toFixed(4)}`;
}

export function formatSubagentUsage(usage: SubagentUsageStats | undefined): string {
  if (!usage) return "unknown";
  const parts: string[] = [];
  const turns = finiteNumber(usage.turns);
  const input = finiteNumber(usage.input);
  const output = finiteNumber(usage.output);
  const cacheRead = finiteNumber(usage.cacheRead);
  const cacheWrite = finiteNumber(usage.cacheWrite);
  const totalTokens = finiteNumber(usage.totalTokens);
  if (turns) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  if (input) parts.push(`↑${formatTokens(input)}`);
  if (output) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
  if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
  if (totalTokens) parts.push(`total:${formatTokens(totalTokens)}`);
  const cost = formatSubagentCost(usage);
  if (cost !== "unknown") parts.push(cost);
  return parts.length ? parts.join(" ") : "unknown";
}

export function formatSubagentCompletionForMainAgent(record: SpawnedSubagentRecord, completion: SubagentDoneEvent): string {
  const runtimeMs = finiteNumber(completion.runtimeMs) ?? finiteNumber(completion.timestamp ? completion.timestamp - record.createdAt : undefined);
  const task = completion.task?.trim() || record.promptPreview || "(unknown task)";
  const status = completion.status || completion.stopReason || (completion.errorMessage ? "error" : "success");
  const model = completion.model || record.model;
  const provider = completion.provider || record.provider;
  const result = completion.result?.trim() || completion.errorMessage?.trim() || "(no result captured)";
  const usage = formatSubagentUsage(completion.usage);

  return [
    `Subagent "${record.name}" (${record.paneId}) finished.`,
    "Summarize this subagent completion for the user. Include the task, runtime, cost, and result. Keep it concise. Do not call tools; if a field is missing, say unknown.",
    `Task:\n${truncateText(task, 4000)}`,
    `Runtime: ${formatSubagentDuration(runtimeMs)}`,
    `Cost: ${formatSubagentCost(completion.usage)}`,
    usage !== "unknown" ? `Usage: ${usage}` : "",
    `Status: ${status}`,
    model || provider ? `Model: ${[provider, model].filter(Boolean).join("/")}` : "",
    completion.stopReason ? `Stop reason: ${completion.stopReason}` : "",
    completion.errorMessage ? `Error: ${truncateText(completion.errorMessage, 2000)}` : "",
    `Result:\n${truncateText(result, 12_000)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
