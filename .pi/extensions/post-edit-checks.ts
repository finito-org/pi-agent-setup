import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CheckFailure {
  title: string;
  result: CommandResult;
}

const CHECKABLE_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const TEMP_DIR = path.join(".pi", "tmp");
const EXIT_CODE_UNKNOWN = "unknown";

function isCheckableFile(filePath: string): boolean {
  return CHECKABLE_EXTENSIONS.has(path.extname(filePath));
}

function resolveAffectedFile(root: string, filePath: string): string | null {
  const absolutePath = path.resolve(root, filePath);
  const relativePath = path.relative(root, absolutePath);
  const insideRoot = relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  return insideRoot ? absolutePath : null;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommand(executable: string, args: string[]): string {
  return [executable, ...args].map(shellQuote).join(" ");
}

function runCommand(executable: string, args: string[], root: string): Promise<CommandResult> {
  const command = formatCommand(executable, args);

  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd: root, env: process.env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      resolve({ command, exitCode: 1, stdout: "", stderr: error.message });
    });
    child.on("close", (exitCode) => {
      resolve({
        command,
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function relativeFiles(root: string, files: string[]): string[] {
  return files.map((file) => path.relative(root, file));
}

function isBiomeIgnoredFileResult(result: CommandResult): boolean {
  return result.exitCode !== 0 && result.stderr.includes("No files were processed in the specified paths");
}

async function runAffectedFormat(root: string, files: string[]): Promise<CheckFailure[]> {
  const relative = relativeFiles(root, files);
  const eslint = await runCommand("bunx", ["eslint", "--fix", ...relative], root);
  const biome = await runCommand("bunx", ["biome", "format", "--write", ...relative], root);
  const failures: CheckFailure[] = [];

  if (eslint.exitCode !== 0) failures.push({ title: "bun format / eslint --fix failed", result: eslint });
  if (biome.exitCode !== 0 && !isBiomeIgnoredFileResult(biome)) {
    failures.push({ title: "bun format / biome format failed", result: biome });
  }

  return failures;
}

async function writeAffectedTsconfig(root: string, files: string[]): Promise<string> {
  const tmpDir = path.join(root, TEMP_DIR);
  await mkdir(tmpDir, { recursive: true });
  const tsconfigPath = path.join(tmpDir, `affected-typecheck-${process.pid}-${randomUUID()}.json`);
  const config = {
    extends: path.join(root, "tsconfig.json"),
    files,
  };
  await writeFile(tsconfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return tsconfigPath;
}

async function runAffectedTypecheck(root: string, files: string[]): Promise<CheckFailure[]> {
  const tsconfigPath = await writeAffectedTsconfig(root, files);
  try {
    const relativeTsconfigPath = path.relative(root, tsconfigPath);
    const result = await runCommand(
      "bun",
      ["typecheck", "--", "--project", relativeTsconfigPath, "--pretty", "false"],
      root
    );
    return result.exitCode === 0 ? [] : [{ title: "bun typecheck failed", result }];
  } finally {
    await rm(tsconfigPath, { force: true });
  }
}

function commandOutput(result: CommandResult): string {
  const parts = [
    `$ ${result.command}`,
    `Exit code: ${result.exitCode ?? EXIT_CODE_UNKNOWN}`,
    result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : "",
    result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

function failureOutput(failures: CheckFailure[]): string {
  return [
    "Post-edit checks failed for affected files.",
    ...failures.map((failure) => `\n## ${failure.title}\n${commandOutput(failure.result)}`),
  ].join("\n");
}

function affectedPathFromEvent(event: Parameters<Parameters<ExtensionAPI["on"]>[1]>[0]): string | null {
  if (!isEditToolResult(event) && !isWriteToolResult(event)) return null;
  if (event.isError) return null;
  const filePath = event.input.path;
  return typeof filePath === "string" ? filePath : null;
}

async function runPostEditChecks(filePath: string): Promise<ToolResultEventResult | undefined> {
  if (!isCheckableFile(filePath)) return undefined;

  const root = process.cwd();
  const affectedFile = resolveAffectedFile(root, filePath);
  if (affectedFile === null) return undefined;

  const formatFailures = await runAffectedFormat(root, [affectedFile]);
  const typecheckFailures = await runAffectedTypecheck(root, [affectedFile]);
  const failures = [...formatFailures, ...typecheckFailures];

  if (failures.length === 0) return undefined;

  return {
    content: [{ type: "text" as const, text: failureOutput(failures) }],
    isError: true,
  };
}

export default function postEditChecks(pi: ExtensionAPI) {
  pi.on("tool_result", async (event) => {
    const filePath = affectedPathFromEvent(event);
    if (filePath === null) return undefined;
    const result = await runPostEditChecks(filePath);
    if (result === undefined) return undefined;
    return {
      ...result,
      content: [...event.content, ...(result.content ?? [])],
    };
  });
}
