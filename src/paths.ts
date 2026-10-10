import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Minimatch } from "minimatch";
import { GuardError, PREFIX } from "./types.ts";

export type PathMode = "tool" | "read" | "shell";

// Same set as pi v1.0.2 utils/paths.ts.
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

export function cannotResolve(path: string): GuardError {
  return new GuardError(`${PREFIX} cannot resolve path "${path}".`);
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function absolutize(input: string, cwd: string, mode: PathMode): string {
  let p = input;
  if (mode !== "shell") {
    p = p.replace(UNICODE_SPACES, " ");
    if (p.startsWith("@")) p = p.slice(1);
  }
  p = expandHome(p);
  if (mode !== "shell" && /^file:\/\//.test(p)) {
    try {
      p = fileURLToPath(p);
    } catch {
      throw cannotResolve(input);
    }
  }
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Existence probe that only treats ENOENT/ENOTDIR as "absent". */
function exists(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch (e) {
    if (isMissing(e)) return false;
    throw cannotResolve(p);
  }
}

/**
 * Real path of the deepest resolvable ancestor + the missing tail.
 * Any symlink that cannot be resolved (dangling, loop) is rejected rather than
 * re-attached by name, so `public.txt -> missing/.env` cannot slip through.
 */
function realResolve(abs: string): string {
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length ? join(real, ...tail) : real;
    } catch (e) {
      if (!isMissing(e)) throw cannotResolve(abs);
    }
    try {
      lstatSync(probe);
      throw cannotResolve(abs); // entry exists but cannot be resolved
    } catch (e) {
      if (e instanceof GuardError) throw e;
      if (!isMissing(e)) throw cannotResolve(abs);
    }
    const parent = dirname(probe);
    if (parent === probe) throw cannotResolve(abs);
    tail.unshift(basename(probe));
    probe = parent;
  }
}

function readVariants(abs: string): string[] {
  const nfd = abs.normalize("NFD");
  const curly = (s: string) => s.replace(/'/g, "\u2019");
  const all = [abs.replace(/ (AM|PM)\./gi, "\u202F$1."), nfd, curly(abs), curly(nfd)];
  return [...new Set(all)].filter((v) => v !== abs && exists(v));
}

/** Logical and real absolute candidates for a tool-supplied path. Any hit must block. */
export function resolveCandidates(input: string, cwd: string, mode: PathMode): string[] {
  if (input.includes("\0")) throw cannotResolve(input);
  const abs = absolutize(input, cwd, mode);
  const bases = mode === "read" ? [abs, ...readVariants(abs)] : [abs];
  const out = new Set<string>();
  for (const b of bases) {
    out.add(b);
    out.add(realResolve(b));
  }
  return [...out];
}

const compiled = new Map<string, Minimatch>();

function prepare(pattern: string): string {
  let p = pattern;
  if (p.startsWith("./")) p = p.slice(2);
  p = expandHome(p);
  if (sep !== "/") p = p.split(sep).join("/");
  return p;
}

export function compilePattern(pattern: string): Minimatch {
  let mm = compiled.get(pattern);
  if (mm) return mm;
  try {
    mm = new Minimatch(prepare(pattern), {
      dot: true,
      nonegate: true,
      nocomment: true,
      nocase: CASE_INSENSITIVE,
    });
    if (!mm.makeRe()) throw new Error("invalid");
  } catch {
    throw new Error("invalid pattern");
  }
  compiled.set(pattern, mm);
  return mm;
}

/** Match a glob against an absolute path and its cwd-relative forms. */
export function matches(pattern: string, path: string, cwd: string): boolean {
  const mm = compilePattern(pattern);
  if (mm.match(sep === "/" ? path : path.split(sep).join("/"))) return true;
  let realCwd = cwd;
  try {
    realCwd = realpathSync(cwd);
  } catch {}
  for (const root of new Set([cwd, realCwd])) {
    const rel = relative(root, path);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    if (mm.match(sep === "/" ? rel : rel.split(sep).join("/"))) return true;
  }
  return false;
}
