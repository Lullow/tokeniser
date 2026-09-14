import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseStatusline, type EventRecord } from "../../src/collector/record.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`../fixtures/statusline/${name}`, import.meta.url), "utf8");

/** 2026-09-14 13:08 UTC, 15:08 in Sweden. */
const NOW = 1_789_391_280_000;

function parsed(name: string): EventRecord {
  const result = parseStatusline(fixture(name), NOW);
  assert.ok(result.ok, `${name} ska gå att tolka`);
  return result.record;
}

test("full data ger gränser, kontext, cache och projekt", () => {
  const record = parsed("full.json");
  assert.equal(record.v, 1);
  assert.equal(record.received_at, NOW);
  assert.equal(record.session_id, "3f9a2c1e-7b4d-4e0a-9c55-1d2e8f6a7b90");
  assert.deepEqual(record.rate_limits, {
    five_hour: { used_percentage: 64.2, resets_at: 1789398000 },
    seven_day: { used_percentage: 31, resets_at: 1789628400 },
  });
  assert.deepEqual(record.context_window?.current_usage, {
    input_tokens: 2140,
    output_tokens: 1830,
    cache_creation_input_tokens: 16400,
    cache_read_input_tokens: 196260,
  });
  assert.equal(record.context_window?.used_percentage, 21);
  assert.deepEqual(record.workspace, {
    project_dir: "/home/lullo/projects/tokeniser",
    repo: { host: "github.com", owner: "Lullow", name: "tokeniser" },
  });
  assert.deepEqual(record.prompt_cache?.last_miss_cause, { causes: ["ttl_expired_5m"] });
  assert.equal(record.effort, "xhigh");
  assert.equal(record.cost?.total_cost_usd, 4.1834);
  assert.equal(record.invalid, undefined);
});

test("sparar aldrig sessionsnamn, transkript, prompt-id eller annat utanför listan", () => {
  const text = JSON.stringify(parsed("full.json"));
  for (const forbidden of ["session_name", "Bygg insamlaren", "transcript_path", ".jsonl", "prompt_id", "550e8400", "vim", "thinking", "added_dirs", "current_dir"]) {
    assert.ok(!text.includes(forbidden), `${forbidden} får inte sparas`);
  }
});

test("ny session: saknade fält förblir saknade, aldrig 0", () => {
  const record = parsed("new-session.json");
  assert.equal(record.rate_limits, undefined);
  assert.equal(record.prompt_cache, undefined);
  assert.equal(record.context_window?.used_percentage, undefined);
  assert.equal(record.context_window?.current_usage, null);
  assert.equal(record.workspace?.repo, undefined);
  assert.equal(record.invalid, undefined);
});

test("ett borttaget gränsfönster är inte ett fel", () => {
  const record = parsed("window-dropped.json");
  assert.equal(record.rate_limits?.five_hour, undefined);
  assert.deepEqual(record.rate_limits?.seven_day, { used_percentage: 31, resets_at: 1789628400 });
  assert.equal(record.workspace?.git_worktree, "one-rag-to-rule-them-all");
  assert.equal(record.invalid, undefined);
});

test("felaktiga värden tas bort och märks, resten sparas", () => {
  const record = parsed("invalid-values.json");
  assert.equal(record.model, undefined);
  assert.equal(record.rate_limits, undefined);
  assert.equal(record.context_window?.used_percentage, undefined);
  assert.equal(record.context_window?.current_usage, undefined);
  assert.equal(record.context_window?.context_window_size, 1000000);
  assert.equal(record.workspace?.repo, undefined);
  assert.equal(record.workspace?.project_dir, "/home/lullo/projects/tokeniser");
  assert.deepEqual(record.invalid, [
    "model",
    "workspace.repo.owner",
    "workspace.repo",
    "context_window.used_percentage",
    "context_window.current_usage",
    "rate_limits.five_hour.used_percentage",
    "rate_limits.seven_day.resets_at",
  ]);
  assert.ok(!JSON.stringify(record).includes("Ska aldrig sparas"));
});

test("indata som inte går att använda avvisas med orsak", () => {
  assert.deepEqual(parseStatusline(fixture("broken.txt"), NOW), { ok: false, reason: "not_json" });
  assert.deepEqual(parseStatusline("", NOW), { ok: false, reason: "empty" });
  assert.deepEqual(parseStatusline("[1, 2]", NOW), { ok: false, reason: "not_object" });
  assert.deepEqual(parseStatusline("{}", NOW), { ok: false, reason: "session_id" });
  assert.deepEqual(parseStatusline('{"session_id": "../../etc/passwd"}', NOW), { ok: false, reason: "session_id" });
  assert.deepEqual(parseStatusline(" ".repeat(1_000_001) + "{}", NOW), { ok: false, reason: "too_large" });
});
