import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveCandidates } from "../src/paths.ts";
import { decide } from "../src/policy.ts";
import type { GuardConfig } from "../src/types.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const base: GuardConfig = { deny: ["**/.env{,.*}", "**/*.key", "**/*.pem"], configPaths: [] };
const blocked = (input: string, mode: "tool" | "read" | "shell" = "tool", cfg = base) =>
  decide(resolveCandidates(input, fx.cwd, mode), fx.cwd, cfg).block;

test("default rules block env variants, key, pem; allow normal files", () => {
  for (const p of [".env", ".env.local", ".env.dev", "a/b/.env", "x.key", "d/x.pem", "../work/.env"]) {
    expect(blocked(p)).toBe(true);
  }
  for (const p of ["src/app.ts", "environment.ts", "env", "key.txt", "config.yaml"]) {
    expect(blocked(p)).toBe(false);
  }
});

test("absolute, @, file://, ~ forms", () => {
  expect(blocked(join(fx.cwd, ".env"))).toBe(true);
  expect(blocked("@.env")).toBe(true);
  expect(blocked(`file://${join(fx.cwd, ".env")}`)).toBe(true);
  expect(blocked("~/.env")).toBe(true);
  expect(resolveCandidates("~/x", fx.cwd, "tool")[0]).toBe(join(homedir(), "x"));
  // shell mode does not strip '@'
  expect(blocked("@.env", "shell")).toBe(false);
});

test("unicode spaces normalised in tool mode only", () => {
  const dir = join(fx.cwd, "a b");
  mkdirSync(dir);
  expect(blocked("a\u00A0b/.env")).toBe(true);
  expect(blocked("a\u00A0b/.env", "shell")).toBe(true); // still matches by basename pattern
  expect(resolveCandidates("a\u00A0b/f", fx.cwd, "shell")[0]).toContain("a\u00A0b");
});

test("hidden dirs and nested paths", () => {
  mkdirSync(join(fx.cwd, ".hidden/deep"), { recursive: true });
  expect(blocked(".hidden/deep/.env.prod")).toBe(true);
});

test("symlink to sensitive file in both directions", () => {
  writeFileSync(join(fx.cwd, ".env"), "x");
  symlinkSync(join(fx.cwd, ".env"), join(fx.cwd, "public.txt"));
  expect(blocked("public.txt")).toBe(true);
  writeFileSync(join(fx.cwd, "plain.txt"), "x");
  symlinkSync(join(fx.cwd, "plain.txt"), join(fx.cwd, "alias.key"));
  expect(blocked("alias.key")).toBe(true); // sensitive name that is itself a link
});

test("symlinked parent dir: not-yet-existing *.key resolved", () => {
  mkdirSync(join(fx.root, "real"));
  symlinkSync(join(fx.root, "real"), join(fx.cwd, "lnk"));
  expect(blocked("lnk/new.key")).toBe(true);
  expect(blocked("lnk/new.txt")).toBe(false);
});

test("rules that only match through the real path (cwd is a symlink)", () => {
  const link = join(fx.root, "cwdlink");
  symlinkSync(fx.cwd, link);
  const c = resolveCandidates(".env", link, "tool");
  expect(decide(c, link, { deny: [".env"], configPaths: [] }).block).toBe(true);
});

test("public.txt -> missing .env: rejected and .env not created", () => {
  symlinkSync(join(fx.cwd, ".env"), join(fx.cwd, "public.txt"));
  expect(() => resolveCandidates("public.txt", fx.cwd, "tool")).toThrow("cannot resolve path");
  expect(existsSync(join(fx.cwd, ".env"))).toBe(false);
});

test("dangling directory link rejected for nested writes; loops rejected", () => {
  symlinkSync(join(fx.root, "gone"), join(fx.cwd, "dl"));
  expect(() => resolveCandidates("dl/file.txt", fx.cwd, "tool")).toThrow("cannot resolve path");
  symlinkSync(join(fx.cwd, "l2"), join(fx.cwd, "l1"));
  symlinkSync(join(fx.cwd, "l1"), join(fx.cwd, "l2"));
  expect(() => resolveCandidates("l1", fx.cwd, "tool")).toThrow("cannot resolve path");
});

test("root terminates", () => {
  expect(resolveCandidates("/", fx.cwd, "tool")).toEqual(["/"]);
  expect(resolveCandidates("/definitely/missing/x", fx.cwd, "tool")).toEqual(["/definitely/missing/x"]);
});

test("NUL byte rejected", () => {
  expect(() => resolveCandidates("a\0b", fx.cwd, "tool")).toThrow("cannot resolve path");
});

test("read mode checks existing macOS variants (AM/PM narrow space, NFD)", () => {
  const nfd = "caf\u00e9.pem".normalize("NFD");
  writeFileSync(join(fx.cwd, nfd), "x");
  expect(blocked("caf\u00e9.pem".normalize("NFC"), "read")).toBe(true);
  // only the narrow-space variant exists, and it aliases a protected file
  writeFileSync(join(fx.cwd, ".env"), "x");
  symlinkSync(join(fx.cwd, ".env"), join(fx.cwd, "Shot 1\u202FAM.png"));
  expect(blocked("Shot 1 AM.png", "read")).toBe(true);
  expect(blocked("Shot 1 AM.png", "tool")).toBe(false);
});

test("custom rules: credentials / config.yaml / config.yml", () => {
  const cfg: GuardConfig = { deny: [...base.deny, "**/credentials", "**/credentials.*", "**/config.yaml", "**/config.yml"], configPaths: [] };
  for (const p of ["credentials", "x/credentials.json", "config.yaml", "a/config.yml"]) {
    expect(blocked(p, "tool", cfg)).toBe(true);
  }
  expect(blocked("config.yaml")).toBe(false);
  expect(blocked("src/app.ts", "tool", cfg)).toBe(false);
});

test("block reason names path and rule only", () => {
  const d = decide(resolveCandidates(".env", fx.cwd, "tool"), fx.cwd, base);
  expect(d).toEqual({
    block: true,
    reason: `Blocked by pi-file-guard: path "${join(fx.cwd, ".env")}" matches deny rule "**/.env{,.*}".`,
  });
});
