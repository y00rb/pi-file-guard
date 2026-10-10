export interface GuardConfig {
  readonly deny: readonly string[];
  readonly configPaths: readonly string[];
}

export type Decision = { block: false } | { block: true; reason: string };

/** Error whose message is safe to show to the model. */
export class GuardError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "GuardError";
  }
}

export const PREFIX = "Blocked by pi-file-guard:";
