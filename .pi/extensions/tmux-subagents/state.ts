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

export interface SubagentSessionEntry {
  type: string;
  customType?: string;
  data?: {
    version?: number;
    record?: SpawnedSubagentRecord;
    killedId?: string;
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
