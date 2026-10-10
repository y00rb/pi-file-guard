import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { globalConfigPath, projectConfigPath } from "../src/config.ts";
import { registerFileGuard } from "../src/extension.ts";
import { makeFixture, SENTINEL, writeConfig, type Fixture } from "./helpers.ts";

type Handler = (e: { toolName: string; input: unknown }, ctx: { cwd: string }) => Promise<{ block?: boolean; reason?: string } | undefined>;

let fx: Fixture;
let handler: Handler;
beforeEach(() => {
  fx = makeFixture();
  mkdirSync(join(fx.cwd, "src"));
  writeFileSync(join(fx.cwd, "src/app.ts"), "x");
  writeFileSync(join(fx.cwd, ".env"), `SECRET=${SENTINEL}`);
  const pi = {
    on: (name: string, h: Handler) => {
      if (name === "tool_call") handler = h;
    },
  };
  registerFileGuard(pi as never, fx.agentDir);
});
afterEach(() => fx.cleanup());

const run = (toolName: string, input: unknown) => handler({ toolName, input }, { cwd: fx.cwd });

test("registration creates the default config", () => {
  expect(existsSync(globalConfigPath(fx.agentDir))).toBe(true);
});

test("read/write/edit on protected files are blocked; normal ones allowed", async () => {
  for (const tool of ["read", "write", "edit"]) {
    const r = await run(tool, { path: ".env" });
    expect(r?.block).toBe(true);
    expect(r?.reason).toStartWith("Blocked by pi-file-guard:");
    expect(r?.reason).not.toContain(SENTINEL);
    expect(await run(tool, { path: "src/app.ts" })).toBeUndefined();
  }
});

test("grep: file ok, protected file blocked, directory (incl. default) blocked", async () => {
  expect(await run("grep", { pattern: "x", path: "src/app.ts" })).toBeUndefined();
  expect((await run("grep", { pattern: "x", path: ".env" }))?.block).toBe(true);
  expect((await run("grep", { pattern: "x", path: "src" }))?.reason).toContain("directory grep is disabled");
  expect((await run("grep", { pattern: "x" }))?.reason).toContain("directory grep is disabled");
  expect(await run("grep", { pattern: "x", path: "missing.txt" })).toBeUndefined();
});

test("find/ls check explicit and default path", async () => {
  expect(await run("find", { pattern: "*" })).toBeUndefined();
  expect(await run("ls", {})).toBeUndefined();
  expect((await run("ls", { path: ".env" }))?.block).toBe(true);
  expect((await run("find", { pattern: "*", path: "a.key" }))?.block).toBe(true);
});

test("bash/powershell", async () => {
  expect((await run("bash", { command: "cat .env" }))?.block).toBe(true);
  expect((await run("powershell", { command: "Get-Content '.env'" }))?.block).toBe(true);
  expect(await run("bash", { command: "git status" })).toBeUndefined();
  expect((await run("bash", { command: "  " }))?.reason).toContain("could not be analyzed");
  expect((await run("bash", {}))?.reason).toContain("could not be analyzed");
  expect((await run("bash", { command: "cat ${bad name}" }))?.block).toBe(true);
});

test("unknown tools pass; malformed input blocked", async () => {
  expect(await run("mcp_thing", { path: ".env" })).toBeUndefined();
  for (const bad of [{}, { path: "" }, { path: 5 }, null, undefined]) {
    expect((await run("read", bad))?.reason).toContain("invalid tool input");
  }
});

test("config file is write-protected (and aliases), readable via read, even with deny:[]", async () => {
  writeConfig(globalConfigPath(fx.agentDir), []);
  const g = globalConfigPath(fx.agentDir);
  expect(await run("read", { path: g })).toBeUndefined();
  for (const tool of ["write", "edit"]) {
    expect((await run(tool, { path: g }))?.reason).toContain("guard configuration cannot be modified");
  }
  symlinkSync(g, join(fx.cwd, "alias.txt"));
  expect((await run("write", { path: "alias.txt" }))?.reason).toContain("guard configuration cannot be modified");
  expect((await run("write", { path: ".pi/file-guard.yaml" }))?.reason).toContain("guard configuration cannot be modified");
  expect((await run("bash", { command: `cat ${g}` }))?.reason).toContain("guard configuration cannot be modified");
  expect(await run("read", { path: ".env" })).toBeUndefined(); // deny:[] globally and no project rules
});

test("broken config blocks everything, no leak, recovers after repair", async () => {
  writeFileSync(globalConfigPath(fx.agentDir), `version: 1\ndeny: [${SENTINEL}\n`);
  const r = await run("read", { path: "src/app.ts" });
  expect(r?.block).toBe(true);
  expect(r?.reason).toContain("invalid configuration");
  expect(r?.reason).not.toContain(SENTINEL);
  writeConfig(globalConfigPath(fx.agentDir), ["**/.env"]);
  expect(await run("read", { path: "src/app.ts" })).toBeUndefined();
});

test("init failure keeps hook installed, blocks, then recovers", async () => {
  const fx2 = makeFixture();
  writeFileSync(fx2.agentDir, "file, not dir");
  let h!: Handler;
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    registerFileGuard({ on: (_: string, f: Handler) => (h = f) } as never, fx2.agentDir);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]![0])).toContain("cannot access configuration");
    const r = await h({ toolName: "read", input: { path: "a" } }, { cwd: fx2.cwd });
    expect(r?.block).toBe(true);
    rmSync(fx2.agentDir);
    expect(await h({ toolName: "read", input: { path: "a" } }, { cwd: fx2.cwd })).toBeUndefined();
  } finally {
    err.mockRestore();
    fx2.cleanup();
  }
});

test("project rules apply on top; stdout/stderr stay clean", async () => {
  const out = spyOn(process.stdout, "write");
  const errw = spyOn(process.stderr, "write");
  try {
    writeConfig(projectConfigPath(fx.cwd), ["**/credentials"]);
    expect((await run("read", { path: "credentials" }))?.block).toBe(true);
    expect(out).not.toHaveBeenCalled();
    expect(errw).not.toHaveBeenCalled();
  } finally {
    out.mockRestore();
    errw.mockRestore();
  }
  chmodSync(fx.cwd, 0o755);
});
