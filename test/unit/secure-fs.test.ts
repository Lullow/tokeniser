import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  appendPrivateFile,
  assertOwnedFile,
  assertPrivateDir,
  assertTrustedAncestors,
  ChangedSinceReviewError,
  currentUid,
  ensurePrivateDir,
  readFileChecked,
  readRegularFile,
  RemovedWhileOpenError,
  removeFileChecked,
  replaceFileAtomic,
  sha256,
  UnsafePathError,
  writeNewPrivateFile,
} from "../../src/secure/fs.ts";

const PRIVATE = { private: true, maxBytes: 1024 };
const sandbox = (): string => mkdtempSync(join(tmpdir(), "tokeniser-fs-"));
const mode = (path: string): number => statSync(path).mode & 0o7777;

test("privat mapp godkänns; symlänk, fel rättigheter och fil avvisas", () => {
  const root = sandbox();
  const dir = join(root, "dir");
  ensurePrivateDir(dir);
  assert.equal(mode(dir), 0o700);
  assert.doesNotThrow(() => assertPrivateDir(dir));

  const link = join(root, "link");
  symlinkSync(dir, link);
  assert.throws(() => assertPrivateDir(link), /symbolisk länk/);
  assert.throws(() => ensurePrivateDir(link), UnsafePathError);

  const open = join(root, "open");
  mkdirSync(open);
  chmodSync(open, 0o750);
  assert.throws(() => assertPrivateDir(open), /0750/);

  const file = join(root, "file");
  writeFileSync(file, "x");
  assert.throws(() => assertPrivateDir(file), /inte en mapp/);
});

test("mappkedjan avvisar mappar som andra kan skriva i och symlänkar", () => {
  const root = sandbox();
  mkdirSync(join(root, "a"));
  assert.doesNotThrow(() => assertTrustedAncestors(join(root, "a", "b")));

  const shared = join(root, "shared");
  mkdirSync(shared);
  chmodSync(shared, 0o777);
  mkdirSync(join(shared, "x"));
  assert.throws(() => assertTrustedAncestors(join(shared, "x", "file")), /skrivbar för andra/);

  const via = join(root, "via");
  symlinkSync(join(root, "a"), via);
  assert.throws(() => assertTrustedAncestors(join(via, "b")), /symbolisk länk/);
});

test("filkontroll avvisar symlänk, hård länk och för öppna rättigheter", () => {
  const root = sandbox();
  const file = join(root, "file");
  writeFileSync(file, "hej", { mode: 0o600 });
  assert.equal(readFileChecked(file, PRIVATE)?.bytes.toString(), "hej");
  assert.equal(readFileChecked(join(root, "missing"), PRIVATE), null);

  symlinkSync(file, join(root, "link"));
  assert.throws(() => readFileChecked(join(root, "link"), PRIVATE), /symbolisk länk/);

  linkSync(file, join(root, "hard"));
  assert.throws(() => readFileChecked(file, PRIVATE), /2 hårda länkar/);

  const open = join(root, "open");
  writeFileSync(open, "x", { mode: 0o644 });
  chmodSync(open, 0o644);
  assert.throws(() => readFileChecked(open, PRIVATE), /0644/);
  assert.equal(readFileChecked(open, { private: false, maxBytes: 10 })?.mode, 0o644);
  assert.throws(() => readFileChecked(open, { private: false, maxBytes: 0 }), /större än/);
});

test("fil för inspektion: symlänk, FIFO och för stor fil avvisas, saknad fil ger null", () => {
  const root = sandbox();
  const file = join(root, "settings.json");
  writeFileSync(file, "{}", { mode: 0o644 });
  assert.equal(readRegularFile(file, 16)?.toString(), "{}");
  assert.equal(readRegularFile(join(root, "saknas.json"), 16), null);
  assert.equal(readRegularFile(join(file, "under-en-fil.json"), 16), null);
  assert.throws(() => readRegularFile(file, 1), /större än 1 byte/);

  symlinkSync(file, join(root, "link"));
  assert.throws(() => readRegularFile(join(root, "link"), 16), /symbolisk länk/);

  const fifo = join(root, "fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => readRegularFile(fifo, 16), /inte en vanlig fil/);
  assert.throws(() => readRegularFile(root, 16), /inte en vanlig fil/);
});

test("en fil som tas bort medan den är öppen räknas som borttagen, men en hård länk avvisas fortfarande", () => {
  const root = sandbox();
  const removed = join(root, "index.sqlite-wal");
  writeFileSync(removed, "wal", { mode: 0o600 });
  const fd = openSync(removed, "r");
  try {
    unlinkSync(removed);
    assert.throws(() => assertOwnedFile(fd, removed, currentUid(), true), RemovedWhileOpenError);
  } finally {
    closeSync(fd);
  }

  const linked = join(root, "linked");
  writeFileSync(linked, "x", { mode: 0o600 });
  linkSync(linked, join(root, "other-name"));
  const linkedFd = openSync(linked, "r");
  try {
    assert.throws(
      () => assertOwnedFile(linkedFd, linked, currentUid(), true),
      (error: unknown) => error instanceof UnsafePathError && !(error instanceof RemovedWhileOpenError) && /2 hårda länkar/.test(error.message),
    );
  } finally {
    closeSync(linkedFd);
  }
});

test("tillägg genom en hård länk avvisas och målet lämnas orört", () => {
  const root = sandbox();
  const outside = join(root, "bashrc");
  writeFileSync(outside, "original\n", { mode: 0o600 });
  const inside = join(root, "events.jsonl");
  linkSync(outside, inside);
  assert.throws(() => appendPrivateFile(inside, "{}\n"), /hårda länkar/);
  assert.equal(readFileSync(outside, "utf8"), "original\n");
});

test("atomär ersättning avbryts om filen har ändrats och lämnar inga temporära filer", () => {
  const root = sandbox();
  const file = join(root, "settings.json");
  writeFileSync(file, "före", { mode: 0o644 });
  chmodSync(file, 0o644);
  const policy = { private: false, maxBytes: 1024 };

  assert.throws(
    () => replaceFileAtomic(file, Buffer.from("efter"), { mode: 0o644, exactMode: true, expectedSha256: sha256("något annat"), currentPolicy: policy }),
    ChangedSinceReviewError,
  );
  assert.equal(readFileSync(file, "utf8"), "före");
  assert.deepEqual(readdirSync(root), ["settings.json"]);

  replaceFileAtomic(file, Buffer.from("efter"), { mode: 0o644, exactMode: true, expectedSha256: sha256("före"), currentPolicy: policy });
  assert.equal(readFileSync(file, "utf8"), "efter");
  assert.equal(mode(file), 0o644);

  assert.throws(() => replaceFileAtomic(file, Buffer.from("x"), { mode: 0o600, expectedSha256: null, currentPolicy: policy }), ChangedSinceReviewError);
});

test("atomär ersättning följer aldrig en symlänk", () => {
  const root = sandbox();
  const target = join(root, "target");
  writeFileSync(target, "orört", { mode: 0o600 });
  const link = join(root, "link");
  symlinkSync(target, link);
  assert.throws(() => replaceFileAtomic(link, Buffer.from("x"), { mode: 0o600, expectedSha256: sha256("orört") }), /symbolisk länk/);
  assert.equal(readFileSync(target, "utf8"), "orört");
});

test("ny privat fil: skapas med 0600, identisk godtas, annat innehåll avvisas", () => {
  const root = sandbox();
  const file = join(root, "backup.json");
  assert.equal(writeNewPrivateFile(file, Buffer.from("a")), "created");
  assert.equal(mode(file), 0o600);
  assert.equal(writeNewPrivateFile(file, Buffer.from("a")), "identical");
  assert.throws(() => writeNewPrivateFile(file, Buffer.from("b")), /annat innehåll/);
});

test("borttagning kräver förväntad hash", () => {
  const root = sandbox();
  const file = join(root, "collector.cjs");
  writeFileSync(file, "kod", { mode: 0o600 });
  assert.throws(() => removeFileChecked(file, sha256("annan kod"), PRIVATE), ChangedSinceReviewError);
  assert.ok(existsSync(file));
  removeFileChecked(file, sha256("kod"), PRIVATE);
  assert.ok(!existsSync(file));
});
