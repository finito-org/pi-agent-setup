import { describe, expect, test } from "bun:test";
import {
  planSubagentPlacement,
  restoreRecordsForWindow,
  type SpawnedSubagentRecord,
} from "./state";

function record(id: string, paneId: string, windowId?: string): SpawnedSubagentRecord {
  return {
    id,
    name: id,
    paneId,
    windowId,
    cwd: ".",
    promptPreview: "test",
    bridgePath: "bridge.mjs",
    configPath: "config.json",
    controlPath: "control.jsonl",
    runScriptPath: "run.sh",
    replaceSystemPrompt: false,
    noSession: true,
    createdAt: 1,
  };
}

describe("planSubagentPlacement", () => {
  test("opens the first automatic subagent on the right at 40%", () => {
    expect(planSubagentPlacement(false, undefined, undefined)).toEqual({
      split: "right",
      target: "main",
      size: "40%",
    });
  });

  test("stacks later automatic subagents below the latest subagent pane", () => {
    expect(planSubagentPlacement(true, undefined, undefined)).toEqual({
      split: "below",
      target: "stack",
    });
  });

  test("honors explicit right split by targeting the main pane", () => {
    expect(planSubagentPlacement(true, "right", undefined)).toEqual({
      split: "right",
      target: "main",
    });
  });

  test("honors requested size", () => {
    expect(planSubagentPlacement(false, undefined, "30%")).toEqual({
      split: "right",
      target: "main",
      size: "30%",
    });
  });
});

describe("restoreRecordsForWindow", () => {
  test("restores only records for the current tmux window", () => {
    const restored = restoreRecordsForWindow(
      [
        { type: "custom", customType: "tmux-subagent", data: { record: record("current", "%1", "@current") } },
        { type: "custom", customType: "tmux-subagent", data: { record: record("other", "%2", "@other") } },
      ],
      "@current"
    );

    expect([...restored.keys()]).toEqual(["current"]);
  });

  test("ignores legacy records without a tmux window id", () => {
    const restored = restoreRecordsForWindow(
      [{ type: "custom", customType: "tmux-subagent", data: { record: record("legacy", "%55") } }],
      "@current"
    );

    expect(restored.size).toBe(0);
  });

  test("applies killed records within the same window", () => {
    const restored = restoreRecordsForWindow(
      [
        { type: "custom", customType: "tmux-subagent", data: { record: record("a", "%1", "@current") } },
        { type: "custom", customType: "tmux-subagent", data: { killedId: "a" } },
      ],
      "@current"
    );

    expect(restored.size).toBe(0);
  });
});
