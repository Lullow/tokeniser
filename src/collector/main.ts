import { parseStatusline } from "./record.ts";
import { formatLine } from "./statusline.ts";
import { logProblem, tokeniserHome, writeRecord } from "./store.ts";

const STDIN_TIMEOUT_MS = 2000;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main(): Promise<void> {
  const home = tokeniserHome();
  const showLine = !process.argv.includes("--no-line");
  const text = await readStdin();
  const now = Date.now();

  const parsed = parseStatusline(text, now);
  if (!parsed.ok) {
    logProblem(home, parsed.reason, now);
    return;
  }

  // Print first: Claude Code cancels a slow run, and the line matters more than the write.
  if (showLine) process.stdout.write(formatLine(parsed.record, now) + "\n");

  try {
    writeRecord(home, parsed.record);
  } catch {
    logProblem(home, "write_failed", now);
  }
}

const guard = setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS);

main()
  .catch(() => undefined)
  .finally(() => {
    clearTimeout(guard);
    process.exitCode = 0;
  });
