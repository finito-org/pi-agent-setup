import { describe, expect, test } from "bun:test";
import {
  formatQuestionForMainAgent,
  formatSubagentCompletionForMainAgent,
  formatSubagentDuration,
  formatSubagentUsage,
  planSubagentPlacement,
  questionNeedsUserPrompt,
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

describe("question forwarding", () => {
  test("prompts the user when the subagent is unsure", () => {
    expect(
      questionNeedsUserPrompt({ id: "q1", type: "question", addressedTo: "unsure", question: "Which path should I take?" })
    ).toBe(true);
  });

  test("formats subagent question with task and recent pane context", () => {
    const text = formatQuestionForMainAgent(
      record("worker", "%7", "@current"),
      {
        id: "q1",
        type: "question",
        addressedTo: "main_agent",
        question: "Should I run tests now?",
        whatDone: "Read the extension files.",
      },
      "assistant> I inspected the files"
    );

    expect(text).toContain('Subagent "worker" (%7) has a question.');
    expect(text).toContain("Question: Should I run tests now?");
    expect(text).toContain("Read the extension files.");
    expect(text).toContain("assistant> I inspected the files");
  });
});

describe("completion summaries", () => {
  test("formats duration and usage", () => {
    expect(formatSubagentDuration(123_400)).toBe("2m 3s");
    expect(formatSubagentUsage({ input: 1200, output: 345, cacheRead: 0, cacheWrite: 0, totalTokens: 1545, cost: 0.01234, turns: 1 })).toBe(
      "1 turn ↑1.2k ↓345 total:1.5k $0.0123"
    );
  });

  test("asks the main agent to summarize completion details", () => {
    const text = formatSubagentCompletionForMainAgent(record("worker", "%7", "@current"), {
      type: "done",
      task: "Review the tmux subagent extension.",
      result: "Found no blocking issues; recommended one test update.",
      runtimeMs: 65_000,
      usage: { input: 1000, output: 250, totalTokens: 1250, cost: 0.0042, turns: 1 },
      status: "success",
      model: "claude-test",
    });

    expect(text).toContain('Subagent "worker" (%7) finished.');
    expect(text).toContain("Task:\nReview the tmux subagent extension.");
    expect(text).toContain("Runtime: 1m 5s");
    expect(text).toContain("Cost: $0.0042");
    expect(text).toContain("Result:\nFound no blocking issues");
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
