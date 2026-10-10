import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDefaultConfig, globalConfigPath, loadConfig, projectConfigPath } from "../src/config.ts";
import { GuardError } from "../src/types.ts";
import { makeFixture, SENTINEL, writeConfig, type Fixture } from "./helpers.ts";

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());

const template = readFileSync(new URL("../file-guard.example.yaml", import.meta.url), "utf8");

test("first load writes template with exactly the three default rules, 0600/0700", () => {
  const cfg = loadConfig(fx.cwd, fx.agentDir);
  expect(cfg.deny).toEqual(["**/.env{,.*}", "**/*.key", "**/*.pem"]);
  expect(readFileSync(globalConfigPath(fx.agentDir), "utf8")).toBe(template);
  if (process.platform !== "win32") {
    expect(statSync(globalConfigPath(fx.agentDir)).mode & 0o777).toBe(0o600);
    expect(statSync(fx.agentDir).mode & 0o777).toBe(0o700);
  }
});

test("existing config and directory permissions are never touched", () => {
  mkdirSync(fx.agentDir, { mode: 0o755 });
  chmodSync(fx.agentDir, 0o755);
  writeConfig(globalConfigPath(fx.agentDir), ["**/custom"]);
  chmodSync(globalConfigPath(fx.agentDir), 0o644);
  const before = readFileSync(globalConfigPath(fx.agentDir), "utf8");
  ensureDefaultConfig(fx.agentDir);
  expect(readFileSync(globalConfigPath(fx.agentDir), "utf8")).toBe(before);
  expect(statSync(globalConfigPath(fx.agentDir)).mode & 0o777).toBe(0o644);
  expect(statSync(fx.agentDir).mode & 0o777).toBe(0o755);
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toEqual(["**/custom"]);
});

const bad: Record<string, string> = {
  blank: "   \n",
  null: "null\n",
  array: "- a\n",
  syntax: `deny: [${SENTINEL}\n`,
  version: "version: 2\ndeny: []\n",
  denyNotArray: "version: 1\ndeny: x\n",
  unknownKey: "version: 1\ndeny: []\nenabled: false\n",
  missingDeny: "version: 1\n",
  emptyRule: 'version: 1\ndeny: [""]\n',
  negation: 'version: 1\ndeny: ["!x"]\n',
  nonString: "version: 1\ndeny: [1]\n",
};

for (const [name, content] of Object.entries(bad)) {
  test(`invalid global config rejected: ${name}`, () => {
    mkdirSync(fx.agentDir, { recursive: true });
    writeFileSync(globalConfigPath(fx.agentDir), content);
    try {
      loadConfig(fx.cwd, fx.agentDir);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(GuardError);
      expect((e as Error).message).toContain("invalid configuration");
      expect((e as Error).message).not.toContain(SENTINEL);
    }
  });
}

test("project config is optional, unions with global, deny:[] cannot cancel global", () => {
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toHaveLength(3);
  writeConfig(projectConfigPath(fx.cwd), []);
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toHaveLength(3);
  writeConfig(projectConfigPath(fx.cwd), ["**/credentials", "**/*.key"]);
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toEqual(["**/.env{,.*}", "**/*.key", "**/*.pem", "**/credentials"]);
});

test("edits are visible on the next load", () => {
  loadConfig(fx.cwd, fx.agentDir);
  writeConfig(globalConfigPath(fx.agentDir), ["**/only"]);
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toEqual(["**/only"]);
});

test("project config path problems are errors, not 'missing'", () => {
  const p = projectConfigPath(fx.cwd);
  mkdirSync(p, { recursive: true }); // directory
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});

test("dangling project config link rejected; healthy link works", () => {
  mkdirSync(join(fx.cwd, ".pi"));
  symlinkSync(join(fx.root, "nope.yaml"), projectConfigPath(fx.cwd));
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});

test("healthy project config symlink works", () => {
  mkdirSync(join(fx.cwd, ".pi"));
  writeConfig(join(fx.root, "real.yaml"), ["**/linked"]);
  symlinkSync(join(fx.root, "real.yaml"), projectConfigPath(fx.cwd));
  expect(loadConfig(fx.cwd, fx.agentDir).deny).toContain("**/linked");
});

test("dangling ancestor link and non-directory ancestor rejected", () => {
  symlinkSync(join(fx.root, "gone"), join(fx.cwd, ".pi"));
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});

test("non-directory ancestor rejected", () => {
  writeFileSync(join(fx.cwd, ".pi"), "x");
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});

test("FIFO config is rejected without reading", () => {
  const p = projectConfigPath(fx.cwd);
  mkdirSync(join(fx.cwd, ".pi"));
  const r = Bun.spawnSync(["mkfifo", p]);
  if (r.exitCode !== 0) return;
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});

test("agentDir that is a file -> access error", () => {
  writeFileSync(fx.agentDir, "x");
  expect(() => loadConfig(fx.cwd, fx.agentDir)).toThrow("cannot access configuration");
});
