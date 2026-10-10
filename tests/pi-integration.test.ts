import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { makeFixture } from "./helpers.ts";

const packageRoot = join(import.meta.dir, "..");

test.serial("real pi loads the package and the runner short-circuits blocked tool calls", async () => {
  expect(process.versions.bun).toBeTruthy();
  const fx = makeFixture();
  const prevDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fx.agentDir;
  try {
    // Dynamic: host must load after PI_CODING_AGENT_DIR is set (module-loading boundary under test).
    const { discoverAndLoadExtensions, ExtensionRunner, SessionManager } = await import(
      "@earendil-works/pi-coding-agent"
    );
    const result = await discoverAndLoadExtensions([packageRoot], fx.cwd, fx.agentDir);
    expect(result.errors).toEqual([]);
    expect(result.extensions).toHaveLength(1);
    const cfgPath = join(fx.agentDir, "file-guard.yaml");
    expect(existsSync(cfgPath)).toBe(true);

    // second load preserves manual edits
    const custom = 'version: 1\ndeny:\n  - "**/.env{,.*}"\n  - "**/*.key"\n  - "**/*.pem"\n# mine\n';
    writeFileSync(cfgPath, custom);
    const again = await discoverAndLoadExtensions([packageRoot], fx.cwd, fx.agentDir);
    expect(again.errors).toEqual([]);
    expect(readFileSync(cfgPath, "utf8")).toBe(custom);

    const registry = new Proxy({}, {
      get() {
        throw new Error("model registry must not be touched");
      },
    }) as ModelRegistry;
    const runner = new ExtensionRunner(result.extensions, result.runtime, fx.cwd, SessionManager.inMemory(fx.cwd), registry);

    let later = 0;
    result.extensions[0]!.handlers.get("tool_call")!.push(async () => {
      later++;
      return undefined;
    });
    const emit = (toolName: string, input: Record<string, unknown>) =>
      runner.emitToolCall({ type: "tool_call", toolCallId: "guard-test-1", toolName, input } as never);

    const r = await emit("read", { path: ".env" });
    expect(r?.block).toBe(true);
    expect(r?.reason).toStartWith("Blocked by pi-file-guard:");
    expect(later).toBe(0);

    expect(await emit("read", { path: "src/app.ts" })).toBeUndefined();
    expect(later).toBe(1);

    for (const [tool, input] of [
      ["write", { path: ".env", content: "changed" }],
      ["edit", { path: ".env", edits: [{ oldText: "SECRET=fake", newText: "SECRET=changed" }] }],
      ["bash", { command: "cat .env" }],
    ] as const) {
      expect((await emit(tool, { ...input }))?.block).toBe(true);
    }
    expect(later).toBe(1);
    expect(existsSync(join(fx.cwd, ".env"))).toBe(false);

    // added rules take effect immediately
    expect(await emit("read", { path: "config.yaml" })).toBeUndefined();
    writeFileSync(cfgPath, 'version: 1\ndeny:\n  - "**/credentials"\n  - "**/config.yaml"\n  - "**/config.yml"\n');
    for (const p of ["config.yaml", "config.yml", "credentials"]) {
      expect((await emit("read", { path: p }))?.block).toBe(true);
    }

    // broken config -> everything blocked, no YAML text leaked
    writeFileSync(cfgPath, "version: 1\ndeny: [LEAKME\n");
    const broken = await emit("read", { path: "src/app.ts" });
    expect(broken?.block).toBe(true);
    expect(broken?.reason).not.toContain("LEAKME");
    writeFileSync(cfgPath, custom);
    expect(await emit("read", { path: "src/app.ts" })).toBeUndefined();
  } finally {
    if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevDir;
    fx.cleanup();
  }
});
