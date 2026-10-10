import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SENTINEL = "FAKE_SECRET_SENTINEL_9f3a";

export interface Fixture {
  root: string;
  cwd: string;
  agentDir: string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-file-guard-")));
  const cwd = join(root, "work");
  const agentDir = join(root, "agent");
  mkdirSync(cwd);
  return { root, cwd, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeConfig(path: string, deny: string[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `version: 1\ndeny:\n${deny.map((d) => `  - "${d}"`).join("\n") || "  []"}\n`.replace("deny:\n  []", "deny: []"));
}
