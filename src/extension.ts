import { statSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureDefaultConfig, loadConfig } from "./config.ts";
import { cannotResolve, resolveCandidates } from "./paths.ts";
import { CONFIG_PROTECTED_REASON, decide, touchesConfig } from "./policy.ts";
import { extractShellPaths, SHELL_UNANALYZABLE } from "./shell.ts";
import { GuardError, PREFIX } from "./types.ts";

const INVALID_INPUT = `${PREFIX} invalid tool input.`;
const EVAL_FAILED = `${PREFIX} guard evaluation failed.`;
const DIR_GREP = `${PREFIX} directory grep is disabled while deny rules are active; use an unprotected file path.`;

const MANAGED: Record<string, true> = {
  read: true,
  write: true,
  edit: true,
  grep: true,
  find: true,
  ls: true,
  bash: true,
  powershell: true,
};

/** Throws GuardError to block; returns normally to allow. */
function evaluate(toolName: string, rawInput: unknown, cwd: string, agentDir: string): void {
  const cfg = loadConfig(cwd, agentDir);
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;

  if (toolName === "bash" || toolName === "powershell") {
    const command = input.command;
    if (typeof command !== "string" || command.trim() === "") throw new GuardError(SHELL_UNANALYZABLE);
    const candidates = extractShellPaths(command, toolName === "bash" ? "bash" : "powershell").flatMap(
      (token) => resolveCandidates(token, cwd, "shell"),
    );
    const decision = decide(candidates, cwd, cfg);
    if (decision.block) throw new GuardError(decision.reason);
    if (touchesConfig(candidates, cwd, cfg)) throw new GuardError(CONFIG_PROTECTED_REASON);
    return;
  }

  const path = input.path === undefined && ["grep", "find", "ls"].includes(toolName) ? "." : input.path;
  if (typeof path !== "string" || path === "") throw new GuardError(INVALID_INPUT);
  const candidates = resolveCandidates(path, cwd, toolName === "read" ? "read" : "tool");
  const decision = decide(candidates, cwd, cfg);
  if (decision.block) throw new GuardError(decision.reason);
  if ((toolName === "write" || toolName === "edit") && touchesConfig(candidates, cwd, cfg)) {
    throw new GuardError(CONFIG_PROTECTED_REASON);
  }
  if (toolName === "grep" && cfg.deny.length > 0) {
    try {
      if (statSync(candidates[candidates.length - 1]!).isDirectory()) throw new GuardError(DIR_GREP);
    } catch (e) {
      if (e instanceof GuardError) throw e;
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw cannotResolve(path);
    }
  }
}

export function registerFileGuard(pi: ExtensionAPI, agentDir: string): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!MANAGED[event.toolName]) return undefined;
    try {
      evaluate(event.toolName, event.input, ctx.cwd, agentDir);
      return undefined;
    } catch (e) {
      return { block: true, reason: e instanceof GuardError ? e.message : EVAL_FAILED };
    }
  });

  try {
    ensureDefaultConfig(agentDir);
  } catch (e) {
    console.error(e instanceof GuardError ? e.message : EVAL_FAILED);
  }
}

export default function fileGuard(pi: ExtensionAPI): void {
  registerFileGuard(pi, getAgentDir());
}
