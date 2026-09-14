import { isAbsolute } from "node:path";
import { UnsafePathError } from "../secure/fs.ts";
import { parseStatusline } from "./record.ts";
import { formatLine } from "./statusline.ts";
import { defaultHome, logProblem, writeRecord } from "./store.ts";

const STDIN_TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

/** The store location comes from argv, never from the environment. */
function homeFromArgs(args: readonly string[]): string | undefined {
  const arg = args.find((a) => a.startsWith("--home="));
  if (arg === undefined) return defaultHome();
  const home = arg.slice("--home=".length);
  return isAbsolute(home) ? home : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const home = homeFromArgs(args);
  const text = await readStdin();
  const now = Date.now();

  const parsed = parseStatusline(text, now);
  if (!parsed.ok) {
    if (home !== undefined) logProblem(home, parsed.reason, now);
    return;
  }

  // Print first: Claude Code cancels a slow run, and the line matters more than the write.
  if (!args.includes("--no-line")) process.stdout.write(formatLine(parsed.record, now) + "\n");
  if (home === undefined) return;

  try {
    writeRecord(home, parsed.record);
  } catch (error) {
    logProblem(home, error instanceof UnsafePathError ? "unsafe_path" : "write_failed", now);
  }
}

const guard = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);

main()
  .catch(() => undefined)
  .finally(() => {
    clearTimeout(guard);
    process.exitCode = 0;
  });
