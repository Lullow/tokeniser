import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";

export class UnsafePathError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`${path} ${reason}.`);
    this.name = "UnsafePathError";
    this.path = path;
  }
}

export class ChangedSinceReviewError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} har ändrats sedan planen gjordes.`);
    this.name = "ChangedSinceReviewError";
    this.path = path;
  }
}

export interface FilePolicy {
  /** Private files may have no group or other bits; others may not be group or other writable. */
  private: boolean;
  maxBytes: number;
}

export interface CheckedFile {
  bytes: Buffer;
  mode: number;
}

export interface AtomicWriteOptions {
  /** Mode for the new file. Without exactMode the process umask can only remove bits. */
  mode: number;
  exactMode?: boolean;
  /** Abort unless the current file still has this hash; null means it must not exist. */
  expectedSha256?: string | null;
  currentPolicy?: FilePolicy;
  /** fsync the file and its directory. */
  durable?: boolean;
}

const errnoCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const octal = (mode: number): string => (mode & 0o7777).toString(8).padStart(4, "0");

export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Tokeniser kräver ett POSIX-system.");
  return uid;
}

/** A real directory, not a symlink, owned by uid, with no group or other bits. */
export function assertPrivateDir(path: string, uid = currentUid()): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw new UnsafePathError(path, "är en symbolisk länk");
  if (!st.isDirectory()) throw new UnsafePathError(path, "är inte en mapp");
  if (st.uid !== uid) throw new UnsafePathError(path, `ägs av uid ${st.uid}, inte ${uid}`);
  if ((st.mode & 0o077) !== 0) throw new UnsafePathError(path, `har rättigheterna ${octal(st.mode)} i stället för 0700`);
}

export function ensurePrivateDir(path: string, uid = currentUid()): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
  }
  assertPrivateDir(path, uid);
}

/** Every directory from the root down to the parent of path. */
export function ancestorsOf(path: string): string[] {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const chain = [root];
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    chain.push(current);
  }
  return chain;
}

/**
 * Each ancestor must be a real directory owned by root or uid that nobody else can
 * write to. A root-owned sticky directory such as /tmp is accepted, since others
 * cannot rename or remove entries they do not own there.
 */
export function assertTrustedAncestors(path: string, uid = currentUid()): void {
  for (const dir of ancestorsOf(path)) {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new UnsafePathError(dir, "är en symbolisk länk");
    if (!st.isDirectory()) throw new UnsafePathError(dir, "är inte en mapp");
    if (st.uid !== 0 && st.uid !== uid) throw new UnsafePathError(dir, `ägs av uid ${st.uid}`);
    const rootSticky = st.uid === 0 && (st.mode & 0o1000) !== 0;
    if ((st.mode & 0o022) !== 0 && !rootSticky) {
      throw new UnsafePathError(dir, `är skrivbar för andra (${octal(st.mode)})`);
    }
  }
}

function openNoFollow(path: string, flags: number, mode?: number): number {
  try {
    return openSync(path, flags | constants.O_NOFOLLOW, mode);
  } catch (error) {
    if (errnoCode(error) === "ELOOP") throw new UnsafePathError(path, "är en symbolisk länk");
    throw error;
  }
}

/** O_NOFOLLOW stops symlinks but not hard links, so the opened file itself is checked. */
function assertOwnedFile(fd: number, path: string, uid: number, privateFile: boolean): Stats {
  const st = fstatSync(fd);
  if (!st.isFile()) throw new UnsafePathError(path, "är inte en vanlig fil");
  if (st.uid !== uid) throw new UnsafePathError(path, `ägs av uid ${st.uid}, inte ${uid}`);
  if (st.nlink !== 1) throw new UnsafePathError(path, `har ${st.nlink} hårda länkar`);
  const forbidden = privateFile ? 0o077 : 0o022;
  if ((st.mode & forbidden) !== 0) throw new UnsafePathError(path, `har rättigheterna ${octal(st.mode)}`);
  return st;
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
}

function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not every file system supports fsync on directories.
  }
}

export function readFileChecked(path: string, policy: FilePolicy, uid = currentUid()): CheckedFile | null {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const st = assertOwnedFile(fd, path, uid, policy.private);
    if (st.size > policy.maxBytes) throw new UnsafePathError(path, `är större än ${policy.maxBytes} byte`);
    const buffer = Buffer.alloc(st.size + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total === buffer.length) throw new UnsafePathError(path, "växte medan den lästes");
    }
    return { bytes: buffer.subarray(0, total), mode: st.mode & 0o7777 };
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads a regular file only to inspect it, whoever owns it: settings from an organization or
 * a repository are read, never trusted. No symlinks, no FIFOs or devices, and a size limit.
 */
export function readRegularFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ENOENT" || errnoCode(error) === "ENOTDIR") return null;
    throw error;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new UnsafePathError(path, "är inte en vanlig fil");
    if (st.size > maxBytes) throw new UnsafePathError(path, `är större än ${maxBytes} byte`);
    const buffer = Buffer.alloc(st.size + 1);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buffer, total, buffer.length - total, null);
      if (read === 0) break;
      total += read;
      if (total === buffer.length) throw new UnsafePathError(path, "växte medan den lästes");
    }
    return buffer.subarray(0, total);
  } finally {
    closeSync(fd);
  }
}

export function appendPrivateFile(path: string, data: string, uid = currentUid()): void {
  const fd = openNoFollow(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
  try {
    assertOwnedFile(fd, path, uid, true);
    writeAll(fd, Buffer.from(data));
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a temporary file next to path and renames it into place. rename replaces
 * the directory entry itself, so a symlink or hard link at path is never followed.
 */
export function replaceFileAtomic(path: string, data: Uint8Array, options: AtomicWriteOptions, uid = currentUid()): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const fd = openNoFollow(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, options.mode);
  let renamed = false;
  try {
    try {
      if (options.exactMode) fchmodSync(fd, options.mode);
      writeAll(fd, data);
      if (options.durable) fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (options.expectedSha256 !== undefined) {
      const current = readFileChecked(path, options.currentPolicy ?? { private: true, maxBytes: 16 * 1024 * 1024 }, uid);
      if ((current === null ? null : sha256(current.bytes)) !== options.expectedSha256) {
        throw new ChangedSinceReviewError(path);
      }
    }
    renameSync(temp, path);
    renamed = true;
    if (options.durable) syncDirectory(dir);
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Already gone.
      }
    }
  }
}

/** Creates a new private file; an existing file is accepted only with identical content. */
export function writeNewPrivateFile(path: string, data: Uint8Array, uid = currentUid()): "created" | "identical" {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    const existing = readFileChecked(path, { private: true, maxBytes: data.length }, uid);
    if (existing !== null && sha256(existing.bytes) === sha256(data)) return "identical";
    throw new UnsafePathError(path, "finns redan med annat innehåll");
  }
  try {
    fchmodSync(fd, 0o600);
    writeAll(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
  return "created";
}

/** Removes path only if it is still the checked file with the expected hash. */
export function removeFileChecked(path: string, expectedSha256: string, policy: FilePolicy, uid = currentUid()): void {
  const current = readFileChecked(path, policy, uid);
  if (current === null || sha256(current.bytes) !== expectedSha256) throw new ChangedSinceReviewError(path);
  unlinkSync(path);
  syncDirectory(dirname(path));
}

export interface CheckedRange {
  bytes: Buffer;
  size: number;
  dev: number;
  ino: number;
}

/** Reads up to maxBytes starting at offset from a checked file; null when it does not exist. */
export function readRangeChecked(path: string, privateFile: boolean, offset: number, maxBytes: number, uid = currentUid()): CheckedRange | null {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
  try {
    const st = assertOwnedFile(fd, path, uid, privateFile);
    const length = Math.max(0, Math.min(st.size - offset, maxBytes));
    const bytes = Buffer.alloc(length);
    let total = 0;
    while (total < length) {
      const read = readSync(fd, bytes, total, length - total, offset + total);
      if (read === 0) break;
      total += read;
    }
    return { bytes: bytes.subarray(0, total), size: st.size, dev: st.dev, ino: st.ino };
  } finally {
    closeSync(fd);
  }
}

/** Creates an empty private file when missing, and checks the file either way. */
export function ensurePrivateFile(path: string, uid = currentUid()): void {
  const fd = openNoFollow(path, constants.O_RDONLY | constants.O_CREAT, 0o600);
  try {
    assertOwnedFile(fd, path, uid, true);
  } finally {
    closeSync(fd);
  }
}

export function assertPrivateFileIfExists(path: string, uid = currentUid()): void {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_RDONLY);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  try {
    assertOwnedFile(fd, path, uid, true);
  } finally {
    closeSync(fd);
  }
}

/** Creates path with data only if nothing exists there. Returns false when something does. */
export function tryCreatePrivateFile(path: string, data: Uint8Array, uid = currentUid()): boolean {
  let fd: number;
  try {
    fd = openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  }
  try {
    assertOwnedFile(fd, path, uid, true);
    writeAll(fd, data);
  } finally {
    closeSync(fd);
  }
  return true;
}
