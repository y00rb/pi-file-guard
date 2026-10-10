import { CASE_INSENSITIVE, matches, resolveCandidates } from "./paths.ts";
import { PREFIX, type Decision, type GuardConfig } from "./types.ts";

export function decide(paths: readonly string[], cwd: string, cfg: GuardConfig): Decision {
  for (const path of paths) {
    for (const pattern of cfg.deny) {
      if (matches(pattern, path, cwd)) {
        return {
          block: true,
          reason: `${PREFIX} path "${path}" matches deny rule "${pattern}".`,
        };
      }
    }
  }
  return { block: false };
}

export const CONFIG_PROTECTED_REASON = `${PREFIX} guard configuration cannot be modified by agent tools.`;

/** True when any candidate equals one of the guard config files (or their real paths). */
export function touchesConfig(paths: readonly string[], cwd: string, cfg: GuardConfig): boolean {
  const fold = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);
  const protectedPaths = new Set(
    cfg.configPaths.flatMap((p) => resolveCandidates(p, cwd, "tool")).map(fold),
  );
  return paths.some((p) => protectedPaths.has(fold(p)));
}
