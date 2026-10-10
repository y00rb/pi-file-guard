import { lstatSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { compilePattern } from "./paths.ts";
import { GuardError, PREFIX, type GuardConfig } from "./types.ts";

const CONFIG_NAME = "file-guard.yaml";
const TEMPLATE_URL = new URL("../file-guard.example.yaml", import.meta.url);

const invalid = (path: string) => new GuardError(`${PREFIX} invalid configuration "${path}".`);
const inaccessible = (path: string) =>
  new GuardError(`${PREFIX} cannot access configuration "${path}".`);

export const globalConfigPath = (agentDir: string) => join(agentDir, CONFIG_NAME);
export const projectConfigPath = (cwd: string) => join(cwd, ".pi", CONFIG_NAME);

/** Create the default global config once; never overwrite or chmod existing files. */
export function ensureDefaultConfig(agentDir: string): void {
  const path = globalConfigPath(agentDir);
  try {
    mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  } catch {
    throw inaccessible(path);
  }
  try {
    writeFileSync(path, readFileSync(TEMPLATE_URL, "utf8"), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw inaccessible(path);
  }
}

/**
 * Returns file text, or undefined when the file is genuinely absent under a healthy
 * directory chain (only allowed when !required). Everything else is an access error.
 */
function readConfigFile(path: string, required: boolean): string | undefined {
  try {
    if (!statSync(path).isFile()) throw inaccessible(path);
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof GuardError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT" || required) throw inaccessible(path);
  }
  let probe = path;
  for (;;) {
    let present = true;
    try {
      lstatSync(probe);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw inaccessible(path);
      present = false;
    }
    if (present) {
      try {
        if (probe === path || !statSync(probe).isDirectory()) throw inaccessible(path);
      } catch {
        throw inaccessible(path);
      }
      return undefined;
    }
    const parent = dirname(probe);
    if (parent === probe) throw inaccessible(path);
    probe = parent;
  }
}

function parseRules(text: string, path: string): string[] {
  let doc: unknown;
  try {
    doc = YAML.parse(text, { prettyErrors: false, logLevel: "error" });
  } catch {
    throw invalid(path);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw invalid(path);
  const keys = Object.keys(doc);
  const { version, deny } = doc as Record<string, unknown>;
  if (keys.length !== 2 || version !== 1 || !Array.isArray(deny)) throw invalid(path);
  for (const rule of deny) {
    if (typeof rule !== "string" || rule === "" || rule.includes("\0") || rule.startsWith("!")) {
      throw invalid(path);
    }
    try {
      compilePattern(rule);
    } catch {
      throw invalid(path);
    }
  }
  return deny as string[];
}

/** Reads both config layers on every call so manual edits apply immediately. */
export function loadConfig(cwd: string, agentDir: string): GuardConfig {
  ensureDefaultConfig(agentDir);
  const globalPath = globalConfigPath(agentDir);
  const projectPath = projectConfigPath(cwd);
  const deny: string[] = [];
  for (const [path, required] of [[globalPath, true], [projectPath, false]] as const) {
    const text = readConfigFile(path, required);
    if (text !== undefined) deny.push(...parseRules(text, path));
  }
  return { deny: [...new Set(deny)], configPaths: [globalPath, projectPath] };
}
