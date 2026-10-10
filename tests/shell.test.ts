import { afterEach, beforeEach, expect, test } from "bun:test";
import { resolveCandidates } from "../src/paths.ts";
import { decide } from "../src/policy.ts";
import { extractShellPaths } from "../src/shell.ts";
import type { GuardConfig } from "../src/types.ts";
import { makeFixture, type Fixture } from "./helpers.ts";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const cfg: GuardConfig = { deny: ["**/.env{,.*}", "**/*.key", "**/*.pem"], configPaths: [] };
const blocked = (cmd: string, shell: "bash" | "powershell" = "bash") =>
  decide(
    extractShellPaths(cmd, shell).flatMap((t) => resolveCandidates(t, fx.cwd, "shell")),
    fx.cwd,
    cfg,
  ).block;

test("static sensitive paths are blocked", () => {
  for (const c of [
    "cat .env",
    "cat '.env.local'",
    "cat < .env.dev",
    "echo value > .env",
    "cat x | tee private.key",
    "tool --file=private.pem",
    "FILE=.env run",
    "cat .env.*",
    "cat .env;",
    "cat ${HOME}/.env",
  ]) {
    expect(blocked(c)).toBe(true);
  }
  expect(blocked("Get-Content '.env'", "powershell")).toBe(true);
});

test("ordinary commands pass; heuristic limits are pinned", () => {
  for (const c of ["bun test", "git status", "cat src/app.ts", "cat *", "python script.py"]) {
    expect(blocked(c)).toBe(false);
  }
});

test("comments ignored; variables stay literal", () => {
  expect(blocked("ls # .env")).toBe(false);
  expect(extractShellPaths("echo $HOME", "bash")).toEqual(["echo", "${HOME}"]);
});

test("unparseable substitution is rejected", () => {
  expect(() => extractShellPaths("cat ${bad name}", "bash")).toThrow("could not be analyzed");
});
