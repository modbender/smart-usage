import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's config dir; it holds .credentials.json on Windows and Linux. */
export const claudeConfigDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/**
 * One directory per Claude config dir, shared by every session and every install of the
 * plugin, so all of them share one usage cache and one fetch budget. Deliberately not
 * CLAUDE_PLUGIN_DATA: that differs per install (marketplace vs --plugin-dir) and is not
 * set for the /smart-usage command's shell.
 */
export const dataDir = (): string => process.env.SMART_USAGE_DATA_DIR || join(claudeConfigDir(), "smart-usage");

export const dataFile = (name: string): string => join(dataDir(), name);
