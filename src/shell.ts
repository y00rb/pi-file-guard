import { parse, type ParseEntry } from "shell-quote";
import { GuardError, PREFIX } from "./types.ts";

export const SHELL_UNANALYZABLE = `${PREFIX} shell command could not be analyzed.`;

/**
 * Statically visible path-like tokens of a command. Variables stay literal
 * (`${NAME}`); nothing is expanded or executed. PowerShell is a literal heuristic only.
 */
export function extractShellPaths(command: string, shell: "bash" | "powershell"): string[] {
  let entries: ParseEntry[];
  try {
    entries = parse(command, (name) => `\${${name}}`, shell === "powershell" ? { escape: "`" } : undefined);
  } catch {
    throw new GuardError(SHELL_UNANALYZABLE);
  }
  const out = new Set<string>();
  for (const entry of entries) {
    const token =
      typeof entry === "string" ? entry : "op" in entry && entry.op === "glob" ? entry.pattern : undefined;
    if (!token) continue;
    out.add(token);
    const eq = token.indexOf("=");
    if (eq >= 0 && eq < token.length - 1) out.add(token.slice(eq + 1));
  }
  return [...out];
}
