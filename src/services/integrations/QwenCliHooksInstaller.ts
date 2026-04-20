/**
 * QwenCliHooksInstaller - Qwen CLI integration for claude-mem
 *
 * Installs hooks into ~/.qwen/settings.json using the unified CLI:
 *   bun worker-service.cjs hook qwen-cli <event>
 *
 * This routes through the hook-command.ts framework:
 *   readJsonFromStdin() → qwen-cli adapter → event handler → POST to worker
 *
 * Qwen CLI supports 11 lifecycle hooks; we register 8 that map to
 * useful memory events. See src/cli/adapters/qwen-cli.ts for the
 * adapter that normalizes Qwen's stdin JSON to NormalizedHookInput.
 *
 * Hook config format (verified against Qwen CLI source):
 *   {
 *     "hooks": {
 *       "AfterTool": [{
 *         "matcher": "*",
 *         "hooks": [{ "name": "claude-mem", "type": "command", "command": "...", "timeout": 5000 }]
 *       }]
 *     }
 *   }
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { logger } from '../../utils/logger.js';
import { findWorkerServicePath, findBunPath } from './CursorHooksInstaller.js';

// ============================================================================
// Types
// ============================================================================

/** A single hook entry in a Qwen CLI hook group */
interface QwenHookEntry {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
}

/** A hook group — matcher selects which tools/events this applies to */
interface QwenHookGroup {
  matcher: string;
  hooks: QwenHookEntry[];
}

/** The hooks section in ~/.qwen/settings.json */
interface QwenHooksConfig {
  [eventName: string]: QwenHookGroup[];
}

/** Full ~/.qwen/settings.json structure (partial — we only care about hooks) */
interface QwenSettingsJson {
  hooks?: QwenHooksConfig;
  [key: string]: unknown;
}

// ============================================================================
// Constants
// ============================================================================

const QWEN_CONFIG_DIR = path.join(homedir(), '.qwen');
const QWEN_SETTINGS_PATH = path.join(QWEN_CONFIG_DIR, 'settings.json');
const QWEN_MD_PATH = path.join(QWEN_CONFIG_DIR, 'QWEN.md');

const HOOK_NAME = 'claude-mem';
const HOOK_TIMEOUT_MS = 10000;

/**
 * Mapping from Qwen CLI hook events to internal claude-mem event types.
 *
 * These events are processed by hookCommand() in src/cli/hook-command.ts,
 * which reads stdin via readJsonFromStdin(), normalizes through the
 * qwen-cli adapter, and dispatches to the matching event handler.
 *
 * Events NOT mapped (too chatty for memory capture):
 *   BeforeModel, AfterModel, BeforeToolSelection
 */
const QWEN_EVENT_TO_INTERNAL_EVENT: Record<string, string> = {
  'SessionStart': 'context',
  'BeforeAgent': 'session-init',
  'AfterAgent': 'observation',
  'BeforeTool': 'observation',
  'AfterTool': 'observation',
  'PreCompress': 'summarize',
  'Notification': 'observation',
  'SessionEnd': 'session-complete',
};

// ============================================================================
// Hook Command Builder
// ============================================================================

/**
 * Build the hook command string for a given Qwen CLI event.
 *
 * The command invokes worker-service.cjs with the `hook` subcommand,
 * which delegates to hookCommand('qwen-cli', event) — the same
 * framework used by Claude Code and Cursor hooks.
 *
 * Pipeline: bun worker-service.cjs hook qwen-cli <event>
 *   → worker-service.ts parses args, ensures worker daemon is running
 *   → hookCommand('qwen-cli', '<event>')
 *   → readJsonFromStdin() reads Qwen's JSON payload
 *   → qwenCliAdapter.normalizeInput() → NormalizedHookInput
 *   → eventHandler.execute(input)
 *   → qwenCliAdapter.formatOutput(result)
 *   → JSON.stringify to stdout
 */
function buildHookCommand(
  bunPath: string,
  workerServicePath: string,
  qwenEventName: string,
): string {
  const internalEvent = QWEN_EVENT_TO_INTERNAL_EVENT[qwenEventName];
  if (!internalEvent) {
    throw new Error(`Unknown Qwen CLI event: ${qwenEventName}`);
  }

  // Double-escape backslashes intentionally: this command string is embedded inside
  // a JSON value, so `\\` in the source becomes `\` when the JSON is parsed by the
  // IDE. Without double-escaping, Windows paths like C:\Users would lose their
  // backslashes and break when the IDE deserializes the hook configuration.
  const escapedBunPath = bunPath.replace(/\\/g, '\\\\');
  const escapedWorkerPath = workerServicePath.replace(/\\/g, '\\\\');

  return `"${escapedBunPath}" "${escapedWorkerPath}" hook qwen-cli ${internalEvent}`;
}

/**
 * Create a hook group entry for a Qwen CLI event.
 * Uses matcher "*" to match all tools/contexts for that event.
 */
function createHookGroup(hookCommand: string): QwenHookGroup {
  return {
    matcher: '*',
    hooks: [{
      name: HOOK_NAME,
      type: 'command',
      command: hookCommand,
      timeout: HOOK_TIMEOUT_MS,
    }],
  };
}

// ============================================================================
// Settings JSON Management
// ============================================================================

/**
 * Read ~/.qwen/settings.json, returning empty object if missing.
 * Throws on corrupt JSON to prevent silent data loss.
 */
function readQwenSettings(): QwenSettingsJson {
  if (!existsSync(QWEN_SETTINGS_PATH)) {
    return {};
  }

  const content = readFileSync(QWEN_SETTINGS_PATH, 'utf-8');
  try {
    return JSON.parse(content) as QwenSettingsJson;
  } catch (error) {
    if (error instanceof Error) {
      logger.error('WORKER', 'Corrupt JSON in Qwen settings', { path: QWEN_SETTINGS_PATH }, error);
    } else {
      logger.error('WORKER', 'Corrupt JSON in Qwen settings', { path: QWEN_SETTINGS_PATH }, new Error(String(error)));
    }
    throw new Error(`Corrupt JSON in ${QWEN_SETTINGS_PATH}, refusing to overwrite user settings`);
  }
}

/**
 * Write settings back to ~/.qwen/settings.json.
 * Creates the directory if it doesn't exist.
 */
function writeQwenSettings(settings: QwenSettingsJson): void {
  mkdirSync(QWEN_CONFIG_DIR, { recursive: true });
  writeFileSync(QWEN_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

/**
 * Deep-merge claude-mem hooks into existing settings.
 *
 * For each event:
 * - If the event already has a hook group with a claude-mem hook, update it
 * - Otherwise, append a new hook group
 *
 * Preserves all non-claude-mem hooks and all non-hook settings.
 */
function mergeHooksIntoSettings(
  existingSettings: QwenSettingsJson,
  newHooks: QwenHooksConfig,
): QwenSettingsJson {
  const settings = { ...existingSettings };
  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const [eventName, newGroups] of Object.entries(newHooks)) {
    const existingGroups: QwenHookGroup[] = settings.hooks[eventName] ?? [];

    // For each new hook group, check if there's already a group
    // containing a claude-mem hook — update it in place
    for (const newGroup of newGroups) {
      const existingGroupIndex = existingGroups.findIndex((group: QwenHookGroup) =>
        group.hooks.some((hook: QwenHookEntry) => hook.name === HOOK_NAME)
      );

      if (existingGroupIndex >= 0) {
        // Update existing group: replace the claude-mem hook entry
        const existingGroup: QwenHookGroup = existingGroups[existingGroupIndex];
        const hookIndex = existingGroup.hooks.findIndex((hook: QwenHookEntry) => hook.name === HOOK_NAME);
        if (hookIndex >= 0) {
          existingGroup.hooks[hookIndex] = newGroup.hooks[0];
        } else {
          existingGroup.hooks.push(newGroup.hooks[0]);
        }
      } else {
        // No existing claude-mem group — append
        existingGroups.push(newGroup);
      }
    }

    settings.hooks[eventName] = existingGroups;
  }

  return settings;
}

// ============================================================================
// QWEN.md Context Injection
// ============================================================================

/**
 * Append or update the claude-mem context section in ~/.qwen/QWEN.md.
 * Uses the same <claude-mem-context> tag pattern as CLAUDE.md.
 */
function setupQwenMdContextSection(): void {
  const contextTag = '<claude-mem-context>';
  const contextEndTag = '</claude-mem-context>';
  const placeholder = `${contextTag}
# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*
${contextEndTag}`;

  let content = '';
  if (existsSync(QWEN_MD_PATH)) {
    content = readFileSync(QWEN_MD_PATH, 'utf-8');
  }

  if (content.includes(contextTag)) {
    // Already has claude-mem section — leave it alone (may have real context)
    return;
  }

  // Append the section
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n\n' : content.length > 0 ? '\n' : '';
  const newContent = content + separator + placeholder + '\n';

  mkdirSync(QWEN_CONFIG_DIR, { recursive: true });
  writeFileSync(QWEN_MD_PATH, newContent);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Install claude-mem hooks into ~/.qwen/settings.json.
 *
 * Merges hooks non-destructively: existing settings and non-claude-mem
 * hooks are preserved. Existing claude-mem hooks are updated in place.
 *
 * @returns 0 on success, 1 on failure
 */
export async function installQwenCliHooks(): Promise<number> {
  console.log('\nInstalling Claude-Mem Qwen CLI hooks...\n');

  // Find required paths
  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const bunPath = findBunPath();
  console.log(`  Using Bun runtime: ${bunPath}`);
  console.log(`  Worker service: ${workerServicePath}`);

  try {
    // Build hook commands for all mapped events
    const hooksConfig: QwenHooksConfig = {};
    for (const qwenEvent of Object.keys(QWEN_EVENT_TO_INTERNAL_EVENT)) {
      const command = buildHookCommand(bunPath, workerServicePath, qwenEvent);
      hooksConfig[qwenEvent] = [createHookGroup(command)];
    }

    // Read existing settings and merge
    const existingSettings = readQwenSettings();
    const mergedSettings = mergeHooksIntoSettings(existingSettings, hooksConfig);

    writeQwenHooksAndSetupContext(mergedSettings);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nInstallation failed: ${message}`);
    return 1;
  }
}

function writeQwenHooksAndSetupContext(mergedSettings: QwenSettingsJson): void {
  writeQwenSettings(mergedSettings);
  console.log(`  Merged hooks into ${QWEN_SETTINGS_PATH}`);

  setupQwenMdContextSection();
  console.log(`  Setup context injection in ${QWEN_MD_PATH}`);

  const eventNames = Object.keys(QWEN_EVENT_TO_INTERNAL_EVENT);
  console.log(`  Registered ${eventNames.length} hook events:`);
  for (const event of eventNames) {
    const internalEvent = QWEN_EVENT_TO_INTERNAL_EVENT[event];
    console.log(`    ${event} → ${internalEvent}`);
  }

  console.log(`
Installation complete!

Hooks installed to: ${QWEN_SETTINGS_PATH}
Using unified CLI: bun worker-service.cjs hook qwen-cli <event>

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Qwen CLI to load the hooks
  3. Memory will be captured automatically during sessions

Context Injection:
  Context from past sessions is injected via ~/.qwen/QWEN.md
  and automatically included in Qwen CLI conversations.
`);
}

/**
 * Uninstall claude-mem hooks from ~/.qwen/settings.json.
 *
 * Removes only claude-mem hooks — other hooks and settings are preserved.
 *
 * @returns 0 on success, 1 on failure
 */
export function uninstallQwenCliHooks(): number {
  console.log('\nUninstalling Claude-Mem Qwen CLI hooks...\n');

  if (!existsSync(QWEN_SETTINGS_PATH)) {
    console.log('  No Qwen CLI settings found — nothing to uninstall.');
    return 0;
  }

  try {
    const settings = readQwenSettings();
    if (!settings.hooks) {
      console.log('  No hooks found in Qwen CLI settings — nothing to uninstall.');
      return 0;
    }

    let removedCount = 0;

    // Remove claude-mem hooks from within each group, preserving other hooks
    for (const [eventName, groups] of Object.entries(settings.hooks)) {
      const filteredGroups = groups
        .map(group => {
          const remainingHooks = group.hooks.filter(hook => hook.name !== HOOK_NAME);
          removedCount += group.hooks.length - remainingHooks.length;
          return { ...group, hooks: remainingHooks };
        })
        .filter(group => group.hooks.length > 0);

      if (filteredGroups.length > 0) {
        settings.hooks[eventName] = filteredGroups;
      } else {
        delete settings.hooks[eventName];
      }
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeSettingsAndCleanupQwenContext(settings, removedCount);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nUninstallation failed: ${message}`);
    return 1;
  }
}

function writeSettingsAndCleanupQwenContext(
  settings: QwenSettingsJson,
  removedCount: number,
): void {
  writeQwenSettings(settings);
  console.log(`  Removed ${removedCount} claude-mem hook(s) from ${QWEN_SETTINGS_PATH}`);

  if (existsSync(QWEN_MD_PATH)) {
    let mdContent = readFileSync(QWEN_MD_PATH, 'utf-8');
    const contextRegex = /\n?<claude-mem-context>[\s\S]*?<\/claude-mem-context>\n?/;
    if (contextRegex.test(mdContent)) {
      mdContent = mdContent.replace(contextRegex, '');
      writeFileSync(QWEN_MD_PATH, mdContent);
      console.log(`  Removed context section from ${QWEN_MD_PATH}`);
    }
  }

  console.log('\nUninstallation complete!\n');
  console.log('Restart Qwen CLI to apply changes.');
}

/**
 * Check Qwen CLI hooks installation status.
 *
 * @returns 0 always (informational)
 */
export function checkQwenCliHooksStatus(): number {
  console.log('\nClaude-Mem Qwen CLI Hooks Status\n');

  if (!existsSync(QWEN_SETTINGS_PATH)) {
    console.log('Qwen CLI settings: Not found');
    console.log(`  Expected at: ${QWEN_SETTINGS_PATH}\n`);
    console.log('No hooks installed. Run: claude-mem install --ide qwen-cli\n');
    return 0;
  }

  let settings: QwenSettingsJson;
  try {
    settings = readQwenSettings();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error) {
      logger.error('WORKER', 'Failed to read Qwen CLI settings', { path: QWEN_SETTINGS_PATH }, error);
    } else {
      logger.error('WORKER', 'Failed to read Qwen CLI settings', { path: QWEN_SETTINGS_PATH }, new Error(String(error)));
    }
    console.log(`Qwen CLI settings: ${message}\n`);
    return 0;
  }

  if (!settings.hooks) {
    console.log('Qwen CLI settings: Found, but no hooks configured\n');
    console.log('No hooks installed. Run: claude-mem install --ide qwen-cli\n');
    return 0;
  }

  // Check for claude-mem hooks
  const installedEvents: string[] = [];
  for (const [eventName, groups] of Object.entries(settings.hooks)) {
    const hasClaudeMem = groups.some(group =>
      group.hooks.some(hook => hook.name === HOOK_NAME)
    );
    if (hasClaudeMem) {
      installedEvents.push(eventName);
    }
  }

  if (installedEvents.length === 0) {
    console.log('Qwen CLI settings: Found, but no claude-mem hooks\n');
    console.log('Run: claude-mem install --ide qwen-cli\n');
    return 0;
  }

  console.log(`Settings: ${QWEN_SETTINGS_PATH}`);
  console.log(`Mode: Unified CLI (bun worker-service.cjs hook qwen-cli)`);
  console.log(`Events: ${installedEvents.length} of ${Object.keys(QWEN_EVENT_TO_INTERNAL_EVENT).length} mapped`);
  for (const event of installedEvents) {
    const internalEvent = QWEN_EVENT_TO_INTERNAL_EVENT[event] ?? 'unknown';
    console.log(`  ${event} → ${internalEvent}`);
  }

  // Check QWEN.md context
  if (existsSync(QWEN_MD_PATH)) {
    const mdContent = readFileSync(QWEN_MD_PATH, 'utf-8');
    if (mdContent.includes('<claude-mem-context>')) {
      console.log(`Context: Active (${QWEN_MD_PATH})`);
    } else {
      console.log('Context: QWEN.md exists but missing claude-mem section');
    }
  } else {
    console.log('Context: No QWEN.md found');
  }

  console.log('');
  return 0;
}

/**
 * Handle qwen-cli subcommand for hooks management.
 */
export async function handleQwenCliCommand(subcommand: string, _args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install':
      return installQwenCliHooks();

    case 'uninstall':
      return uninstallQwenCliHooks();

    case 'status':
      return checkQwenCliHooksStatus();

    default:
      console.log(`
Claude-Mem Qwen CLI Integration

Usage: claude-mem qwen-cli <command>

Commands:
  install             Install hooks into ~/.qwen/settings.json
  uninstall           Remove claude-mem hooks (preserves other hooks)
  status              Check installation status

Examples:
  claude-mem qwen-cli install     # Install hooks
  claude-mem qwen-cli status      # Check if installed
  claude-mem qwen-cli uninstall   # Remove hooks

For more info: https://docs.claude-mem.ai/usage/qwen-provider
      `);
      return 0;
  }
}
