# pi-file-guard

[中文](docs/README.zh-CN.md)

Sensitive-file guard extension for [pi](https://github.com/earendil-works/pi). It blocks the model's tool calls (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`, `powershell`) from touching files that match a deny list, via a `tool_call` pre-hook. File permissions on disk are never changed.

> Targets pi 1.0.2. Developed and tested with Bun only; no Node/npm needed.

## Install

```bash
pi install github:y00rb/pi-file-guard                          # from GitHub
pi install /path/to/pi-file-guard                              # local checkout
```

Start pi (or run `/reload` in a running session). On first load the extension writes a default config to `~/.pi/agent/file-guard.yaml` (or `$PI_CODING_AGENT_DIR/file-guard.yaml`). An existing file is never overwritten.

## Configure

Two YAML files, merged as a union of `deny` (a project can add rules, never remove global ones):

- Global: `~/.pi/agent/file-guard.yaml` (created automatically)
- Project: `<cwd>/.pi/file-guard.yaml` (optional, not created, no upward search)

Default:

```yaml
version: 1
deny:
  - "**/.env{,.*}"   # .env, .env.local, .env.example, ...
  - "**/*.key"
  - "**/*.pem"
```

Add more, e.g. `"**/credentials"`, `"**/credentials.*"`, `"**/config.yaml"`, `"**/config.yml"`.

Rules:

- Schema is exactly `version: 1` plus `deny: string[]` (`deny: []` is valid). Unknown keys, empty strings and `!` negations are rejected.
- Patterns are [minimatch](https://github.com/isaacs/minimatch) globs: absolute, `~/…`, or relative to the session cwd. Case-insensitive on macOS/Windows.
- Config is re-read on every tool call; edits apply immediately.
- **Fail-closed:** if a config is invalid or unreadable, all managed tool calls are blocked until it is fixed. Error messages never include file contents or YAML text.
- The config files themselves cannot be modified by `write`/`edit`, nor mentioned in shell commands. `read` is allowed.

## What is checked

| Tool | Behaviour |
| --- | --- |
| `read`, `write`, `edit` | `path` is resolved (`@`, `file://`, `~`, symlinks, macOS name variants for `read`) and matched against `deny`. |
| `find`, `ls` | Same, using `path` (default `.`). File names in unprotected directories remain listable. |
| `grep` | Protected files blocked; with any deny rule active, directory grep (including default `.`) is blocked. Pass a file path. |
| `bash`, `powershell` | Commands are tokenized; every literal token (and the part after `=`) is resolved and matched. `cat .env`, `> .env`, `--file=x.pem` are blocked. |

Symlinks are resolved: a link to a protected file, a protected-looking link name, and dangling links are all blocked.

## Limitations

The shell check is a static heuristic, **not a sandbox**. It does not expand globs (`cat *`), variables, or `$(…)`, does not interpret `sh -c` / `python -c` / scripts, and does not follow `cd`. Dynamic paths and directory-wide commands can bypass it. It does not cover user-pasted text, `@file` attachments, manual `!` commands, existing context, or custom/MCP tools.

## Development

```bash
bun install
bun test
bun run typecheck
bun pm pack --dry-run --ignore-scripts
```

Layout: `src/config.ts` (load/validate), `src/paths.ts` (resolution/glob), `src/policy.ts` (decision), `src/shell.ts` (token extraction), `src/extension.ts` (pi hook).
