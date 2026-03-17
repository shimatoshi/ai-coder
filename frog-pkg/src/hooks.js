import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import state from "./state.js";

const GEMINI_SETTINGS_FILE = join(homedir(), ".gemini", "settings.json");
const FROG_HOOKS_FILE = join(homedir(), ".frog", "hooks.json");

export function loadHooks() {
  try {
    if (existsSync(GEMINI_SETTINGS_FILE)) {
      const settings = JSON.parse(readFileSync(GEMINI_SETTINGS_FILE, "utf-8"));
      if (settings.hooks && Object.keys(settings.hooks).length > 0) {
        state.hooksConfig = settings.hooks;
        return;
      }
    }
  } catch {}
  try {
    if (existsSync(FROG_HOOKS_FILE)) {
      state.hooksConfig = JSON.parse(readFileSync(FROG_HOOKS_FILE, "utf-8"));
    }
  } catch {}
}

function matchesHook(matcher, toolName) {
  return matcher.split("|").some(m => m.trim() === toolName);
}

export async function runHooks(phase, toolName, input) {
  if (!state.hooksConfig?.[phase]) return null;

  const results = [];
  for (const group of state.hooksConfig[phase]) {
    if (group.matcher && !matchesHook(group.matcher, toolName)) continue;
    for (const hook of group.hooks || []) {
      if (hook.type !== "command") continue;
      try {
        const timeout = hook.timeout || 5000;
        const payload = JSON.stringify(
          input?._raw ? input._raw : { tool_name: toolName, tool_input: input }
        );
        const result = spawnSync("bash", ["-c", hook.command], {
          input: payload,
          encoding: "utf-8",
          timeout,
          cwd: state.CWD,
        });
        const out = (result.stdout || "").trim();
        if (!out) continue;
        const parsed = JSON.parse(out);
        if (parsed.decision === "deny") {
          return { denied: true, reason: parsed.reason || "Blocked by hook" };
        }
        if (parsed.hookSpecificOutput || parsed.systemMessage) {
          results.push(parsed);
        }
      } catch {}
    }
  }
  return results.length > 0 ? { outputs: results } : null;
}

export async function runSessionStartHooks() {
  const result = await runHooks("SessionStart", null, {});
  if (result?.outputs) {
    const contexts = result.outputs
      .map(o => o.hookSpecificOutput?.additionalContext)
      .filter(Boolean);
    if (contexts.length > 0) {
      state.sessionStartContext = contexts.join("\n");
    }
  }
}
