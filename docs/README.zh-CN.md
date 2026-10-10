# pi-file-guard

[English](../README.md)

[pi](https://github.com/earendil-works/pi) 的敏感文件保护扩展。通过 `tool_call` 预执行钩子，阻止模型的工具调用（`read`、`write`、`edit`、`grep`、`find`、`ls`、`bash`、`powershell`）访问命中拒绝列表的文件。不会修改磁盘上的文件权限。

> 目标版本 pi 1.0.2。仅使用 Bun 开发和测试，无需 Node/npm。

## 安装

```bash
pi install github:y00rb/pi-file-guard                          # 从 GitHub 安装
pi install /path/to/pi-file-guard                              # 本地目录
```

启动 pi（或在现有会话中执行 `/reload`）。首次加载时扩展会生成默认配置 `~/.pi/agent/file-guard.yaml`（若设置了 `PI_CODING_AGENT_DIR` 则在该目录下）。已存在的文件绝不会被覆盖。

## 配置

两个 YAML 文件，`deny` 取并集（项目只能追加规则，不能取消全局规则）：

- 全局：`~/.pi/agent/file-guard.yaml`（自动创建）
- 项目：`<cwd>/.pi/file-guard.yaml`（可选，不自动创建，不向上查找）

默认内容：

```yaml
version: 1
deny:
  - "**/.env{,.*}"   # .env、.env.local、.env.example 等
  - "**/*.key"
  - "**/*.pem"
```

可自行追加，例如 `"**/credentials"`、`"**/credentials.*"`、`"**/config.yaml"`、`"**/config.yml"`。

规则：

- 结构只能是 `version: 1` 加 `deny: string[]`（`deny: []` 合法）。未知字段、空字符串、以 `!` 开头的否定规则均会被拒绝。
- 模式为 [minimatch](https://github.com/isaacs/minimatch) glob：绝对路径、`~/…`，或相对于会话 cwd 的路径。macOS/Windows 上不区分大小写。
- 每次工具调用都会重新读取配置，修改后立即生效。
- **失败即拒绝：** 配置无效或无法读取时，所有受管工具调用都会被阻止，直到修复为止。错误信息不会包含文件内容或 YAML 原文。
- 配置文件本身不能被 `write`/`edit` 修改，也不能出现在 shell 命令中；`read` 允许。

## 检查范围

| 工具 | 行为 |
| --- | --- |
| `read`、`write`、`edit` | 解析 `path`（`@`、`file://`、`~`、符号链接，`read` 还包括 macOS 文件名变体）后与 `deny` 匹配。 |
| `find`、`ls` | 同上，使用 `path`（默认 `.`）。未受保护目录中的文件名仍可列出。 |
| `grep` | 受保护文件被拒绝；存在任何 deny 规则时，目录级 grep（含默认 `.`）被拒绝，请指定文件路径。 |
| `bash`、`powershell` | 命令被分词；每个字面量 token（及 `=` 之后的部分）都会被解析并匹配。`cat .env`、`> .env`、`--file=x.pem` 均被拒绝。 |

符号链接会被解析：指向受保护文件的链接、名字敏感的链接、悬空链接都会被拒绝。

## 局限

shell 检查是静态启发式，**不是沙箱**。它不展开 glob（`cat *`）、变量或 `$(…)`，不解释 `sh -c` / `python -c` / 脚本，也不跟踪 `cd`。动态路径和整目录命令可绕过。不覆盖用户手动粘贴的内容、`@file` 附件、手动 `!` 命令、已有上下文以及自定义/MCP 工具。

## 开发

```bash
bun install
bun test
bun run typecheck
bun pm pack --dry-run --ignore-scripts
```

结构：`src/config.ts`（加载/校验）、`src/paths.ts`（路径解析/glob）、`src/policy.ts`（决策）、`src/shell.ts`（token 提取）、`src/extension.ts`（pi 钩子）。
