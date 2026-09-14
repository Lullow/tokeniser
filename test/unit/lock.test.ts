import assert from "node:assert/strict";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STALE_AFTER_MS, tryAcquireLock } from "../../src/index/lock.ts";
import { UnsafePathError } from "../../src/secure/fs.ts";

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), "tokeniser-lock-")), "index.lock");

test("bara en innehavare åt gången", () => {
  const path = lockPath();
  const first = tryAcquireLock(path);
  assert.ok(first);
  assert.equal(tryAcquireLock(path), null);
  first.release();
  assert.ok(!existsSync(path));
  const second = tryAcquireLock(path);
  assert.ok(second);
  second.release();
});

test("ett lås från en process som inte lever tas över", () => {
  const path = lockPath();
  assert.ok(tryAcquireLock(path, { now: 1_000 }));
  assert.ok(tryAcquireLock(path, { now: 2_000, isAlive: () => false }));
});

test("ett lås som inte förnyats på länge tas över", () => {
  const path = lockPath();
  const now = Date.now();
  assert.ok(tryAcquireLock(path, { now }));
  assert.equal(tryAcquireLock(path, { now: now + STALE_AFTER_MS - 1 }), null);
  assert.ok(tryAcquireLock(path, { now: now + STALE_AFTER_MS + 1 }));
});

test("en övertagen innehavare märker det och tar inte bort det nya låset", () => {
  const path = lockPath();
  const old = tryAcquireLock(path, { now: 1_000 });
  assert.ok(old);
  const current = tryAcquireLock(path, { now: 2_000, isAlive: () => false });
  assert.ok(current);
  assert.equal(old.refresh(3_000), false);
  old.release();
  assert.ok(existsSync(path));
  assert.equal(current.refresh(3_000), true);
  current.release();
  assert.ok(!existsSync(path));
});

test("ett symlänkat lås avvisas", () => {
  const path = lockPath();
  symlinkSync(join(path, "..", "annat"), path);
  assert.throws(() => tryAcquireLock(path), UnsafePathError);
});
