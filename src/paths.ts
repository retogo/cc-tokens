import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code の設定ディレクトリ（CLAUDE_CONFIG_DIR があれば優先）。 */
export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** トランスクリプトのルート（~/.claude/projects）。 */
export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

/** cctok 自身の設定ファイルパス（XDG_CONFIG_HOME を尊重）。 */
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "cctok", "config.json");
}
