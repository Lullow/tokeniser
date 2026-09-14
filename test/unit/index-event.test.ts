import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEventLine } from "../../src/index/event.ts";
import { identityOf } from "../../src/index/identity.ts";
import { eventLine } from "../helpers/events.ts";

const T0 = 1_789_391_280_000;

test("en rad från insamlaren blir en händelse för indexet", () => {
  const repo = { host: "github.com", owner: "Example", name: "alpha" };
  const event = parseEventLine(eventLine({ at: T0, session: "s1", dir: "/p/alpha", repo, gitWorktree: "wt" }));
  assert.ok(event);
  assert.equal(event.receivedAt, T0);
  assert.equal(event.sessionId, "s1");
  assert.equal(event.projectDir, "/p/alpha");
  assert.deepEqual(event.repo, repo);
  assert.equal(event.gitWorktree, "wt");
  assert.equal(event.fiveUsed, 17);
  assert.equal(event.fiveResets, 1_789_428_600);
  assert.equal(event.weekUsed, 5);
  assert.equal(event.contextSize, 1_000_000);
  assert.deepEqual(event.usage, { input: 10, output: 1_500, cacheCreation: 2_000, cacheRead: 197_990 });
  assert.equal(event.costUsd, 1.5);
  assert.deepEqual(event.invalid, []);
});

test("rader som inte går att använda ger null", () => {
  const lines = [
    "",
    "inte json",
    "[]",
    "{}",
    JSON.stringify({ v: 2, received_at: T0, session_id: "s" }),
    JSON.stringify({ v: 1, received_at: 5, session_id: "s" }),
    JSON.stringify({ v: 1, received_at: T0, session_id: "../x" }),
  ];
  for (const line of lines) assert.equal(parseEventLine(line), null, line);
});

test("fält med fel form eller kontrolltecken blir null och märks, aldrig 0", () => {
  const event = parseEventLine(
    JSON.stringify({
      v: 1,
      received_at: T0,
      session_id: "s",
      invalid: ["model", "evil path/../"],
      workspace: { project_dir: "/p/[31mred", repo: { host: "github.com", owner: "o", name: "‮evil" } },
      context_window: { total_input_tokens: 1.5, current_usage: null },
      rate_limits: { five_hour: { used_percentage: 101, resets_at: 1_789_428_600 } },
      prompt_cache: { last_miss_cause: { causes: ["Tools Changed"] } },
    }),
  );
  assert.ok(event);
  assert.equal(event.projectDir, null);
  assert.equal(event.repo, null);
  assert.equal(event.totalInput, null);
  assert.equal(event.usage, null);
  assert.equal(event.fiveUsed, null);
  assert.equal(event.fiveResets, null);
  assert.equal(event.cacheLastMissCauses, null);
  assert.deepEqual(event.invalid, [
    "insamlaren:model",
    "rate_limits.five_hour.used_percentage",
    "workspace.project_dir",
    "workspace.repo.name",
    "context_window.total_input_tokens",
    "prompt_cache.last_miss_cause.causes",
  ]);
});

test("projektidentitet: repo före mapp, skiftlägesokänsligt på github.com", () => {
  const repo = { host: "GitHub.com", owner: "Lullow", name: "Tokeniser" };
  assert.deepEqual(identityOf(repo, "/p/t"), { key: "repo:github.com/lullow/tokeniser", kind: "repo", label: "Lullow/Tokeniser", repo, dir: "/p/t" });
  assert.equal(identityOf({ host: "git.example.org", owner: "Team", name: "App" }, null)?.key, "repo:git.example.org/Team/App");
  assert.deepEqual(identityOf(null, "/home/user/projects/alpha"), {
    key: "dir:/home/user/projects/alpha",
    kind: "dir",
    label: "alpha",
    repo: null,
    dir: "/home/user/projects/alpha",
  });
  assert.equal(identityOf(null, null), null);
});
