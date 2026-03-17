import {
  readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import state from "./state.js";
import { frogLog, isDangerous } from "./config.js";
import { confirmAction } from "./input.js";

// ====== Tool Definitions ======
export const tools = [
  {
    functionDeclarations: [
      {
        name: "read_file",
        description: "Read file contents. Use this before editing. Returns the full content with line numbers.",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "File path (absolute or relative to cwd)" } }, required: ["path"] },
      },
      {
        name: "write_file",
        description: "Create a new file or completely overwrite an existing file. Creates parent directories automatically.",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "File path" }, content: { type: "STRING", description: "Complete file content" } }, required: ["path", "content"] },
      },
      {
        name: "write_files",
        description: "Create/overwrite MULTIPLE files at once. Use this when creating a project or writing more than one file.",
        parameters: { type: "OBJECT", properties: { files: { type: "ARRAY", description: "Array of files to write", items: { type: "OBJECT", properties: { path: { type: "STRING", description: "File path" }, content: { type: "STRING", description: "Complete file content" } }, required: ["path", "content"] } } }, required: ["files"] },
      },
      {
        name: "edit_file",
        description: "Edit a file by replacing exact text. old_text must match exactly and uniquely in the file.",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "File path" }, old_text: { type: "STRING", description: "Exact text to find (must be unique in file)" }, new_text: { type: "STRING", description: "Replacement text" } }, required: ["path", "old_text", "new_text"] },
      },
      {
        name: "list_directory",
        description: "List files and directories. Shows type (file/dir) for each entry.",
        parameters: { type: "OBJECT", properties: { path: { type: "STRING", description: "Directory path (default: cwd)" }, recursive: { type: "BOOLEAN", description: "List recursively up to 3 levels deep (default: false)" } } },
      },
      {
        name: "execute_command",
        description: "Run a shell command and return stdout/stderr. Use for builds, tests, git, etc.",
        parameters: { type: "OBJECT", properties: { command: { type: "STRING", description: "Shell command to run" }, timeout: { type: "NUMBER", description: "Timeout in seconds (default: 30, max: 120)" } }, required: ["command"] },
      },
      {
        name: "find_files",
        description: 'Find files by name pattern (glob). Ignores node_modules and .git.',
        parameters: { type: "OBJECT", properties: { pattern: { type: "STRING", description: 'Filename pattern, e.g. "*.tsx", "package.json"' }, path: { type: "STRING", description: "Search root directory (default: cwd)" } }, required: ["pattern"] },
      },
      {
        name: "search_text",
        description: "Search for text/regex in files (like grep -rn). Returns matching lines with paths and line numbers.",
        parameters: { type: "OBJECT", properties: { pattern: { type: "STRING", description: "Text or regex pattern to search for" }, path: { type: "STRING", description: "File or directory to search in (default: cwd)" }, file_pattern: { type: "STRING", description: 'Only search files matching this glob, e.g. "*.py"' } }, required: ["pattern"] },
      },
      {
        name: "spawn_agent",
        description: "Spawn a sub-agent to perform a research/investigation task. The agent has its own context and can read files, search, and run commands. Use this for tasks that require exploring many files without polluting your main context. Sub-agents CANNOT write or edit files.",
        parameters: { type: "OBJECT", properties: { task: { type: "STRING", description: "Clear description of what to investigate or research" } }, required: ["task"] },
      },
    ],
  },
];

// ====== Tool Implementations ======
export function resolvePath(p) {
  if (!p) return state.CWD;
  return resolve(state.CWD, p);
}

export function toolReadFile({ path }) {
  try {
    const full = resolvePath(path);
    const content = readFileSync(full, "utf-8");
    const lines = content.split("\n");
    const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`).join("\n");
    if (lines.length > 2000) {
      return { success: true, path: full, total_lines: lines.length, content: numbered.substring(0, 50000), truncated: true };
    }
    return { success: true, path: full, total_lines: lines.length, content: numbered };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function toolWriteFile({ path, content }) {
  frogLog("write_file", { path, lines: content?.split("\n").length });
  try {
    const full = resolvePath(path);
    if (state.safetyMode !== "off") {
      const ok = await confirmAction(`書き込み: ${full} (${content.split("\n").length}行)`);
      if (!ok) return { success: false, error: "User denied write" };
    }
    const dir = dirname(full);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(full, content, "utf-8");
    return { success: true, path: full, lines: content.split("\n").length, bytes: Buffer.byteLength(content) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function toolWriteFiles({ files }) {
  const results = [];
  for (const f of files || []) {
    results.push(await toolWriteFile(f));
  }
  const ok = results.filter(r => r.success).length;
  const fail = results.filter(r => !r.success).length;
  return { success: fail === 0, wrote: ok, failed: fail, results };
}

export async function toolEditFile({ path, old_text, new_text }) {
  frogLog("edit_file", { path });
  try {
    const full = resolvePath(path);
    const content = readFileSync(full, "utf-8");
    if (!content.includes(old_text)) return { success: false, error: "old_text not found in file" };
    const count = content.split(old_text).length - 1;
    if (count > 1) return { success: false, error: `old_text found ${count} times. Provide more context.` };
    if (state.safetyMode !== "off") {
      const ok = await confirmAction(`編集: ${full}`);
      if (!ok) return { success: false, error: "User denied edit" };
    }
    writeFileSync(full, content.replace(old_text, new_text), "utf-8");
    return { success: true, path: full };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function toolListDirectory({ path, recursive }) {
  try {
    const full = resolvePath(path);
    if (recursive) {
      const r = spawnSync("find", [full, "-maxdepth", "3", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/__pycache__/*", "-not", "-path", "*/dist/*", "-not", "-path", "*/.next/*"], { encoding: "utf-8", timeout: 10000 });
      const all = (r.stdout || "").trim().split("\n").filter(Boolean);
      const entries = all.slice(0, 150);
      const result = { success: true, path: full, entries, total: all.length };
      if (all.length > 150) result.note = `Showing 150 of ${all.length} entries. Use search_text or find_files to narrow down.`;
      return result;
    }
    const raw = readdirSync(full, { withFileTypes: true });
    const entries = raw.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
    if (entries.length > 80) {
      const dirs = entries.filter((e) => e.type === "dir");
      const files = entries.filter((e) => e.type === "file").slice(0, 80 - dirs.length);
      return { success: true, path: full, entries: [...dirs, ...files], total: entries.length, note: `Showing ${dirs.length} dirs + ${files.length} files of ${entries.length} total. Use find_files or search_text to narrow down.` };
    }
    return { success: true, path: full, entries };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export async function toolExecuteCommand({ command, timeout }) {
  frogLog("execute_command", { command, cwd: state.CWD });
  const cdMatch = command.match(/^cd\s+(.+)$/);
  if (cdMatch) {
    const target = resolve(state.CWD, cdMatch[1].replace(/^["']|["']$/g, ""));
    if (existsSync(target)) {
      state.CWD = target;
      return { success: true, output: `Changed directory to ${state.CWD}` };
    }
    return { success: false, error: `Directory not found: ${target}` };
  }

  if (state.safetyMode === "confirm" || (state.safetyMode === "blocklist" && isDangerous(command))) {
    const ok = await confirmAction(`コマンド: ${command}`);
    if (!ok) return { success: false, error: "User denied execution" };
  }

  const ms = Math.min((timeout || 30) * 1000, 120000);
  return new Promise((res) => {
    let stdout = "", stderr = "";
    const proc = spawn("sh", ["-c", command], {
      cwd: state.CWD, env: { ...process.env, CI: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdin.write("\n");
    proc.stdin.end();
    proc.stdout.on("data", (d) => { stdout += d; if (stdout.length > 2 * 1024 * 1024) proc.kill(); });
    proc.stderr.on("data", (d) => { stderr += d; if (stderr.length > 2 * 1024 * 1024) proc.kill(); });
    const timer = setTimeout(() => proc.kill(), ms);
    const onSigint = () => { proc.kill(); };
    process.on("SIGINT", onSigint);
    proc.on("close", (code) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", onSigint);
      if (code === 0) {
        res({ success: true, output: stdout.substring(0, 15000) });
      } else {
        res({ success: false, exit_code: code, stdout: stdout.substring(0, 8000), stderr: stderr.substring(0, 8000) });
      }
    });
  });
}

export function toolFindFiles({ pattern, path }) {
  try {
    const full = resolvePath(path);
    const r = spawnSync("find", [full, "-name", pattern, "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*"], { encoding: "utf-8", timeout: 10000 });
    const files = (r.stdout || "").trim().split("\n").filter(Boolean).slice(0, 100);
    return { success: true, files, count: files.length };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

export function toolSearchText({ pattern, path, file_pattern }) {
  try {
    const full = resolvePath(path);
    const args = ["-rn", "--color=never", "-I", "-l"];
    if (file_pattern) args.push("--include=" + file_pattern);
    args.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", "--exclude-dir=.next", pattern, full);
    const fileResult = spawnSync("grep", args, { encoding: "utf-8", timeout: 15000 });
    const matchingFiles = (fileResult.stdout || "").trim().split("\n").filter(Boolean);

    const lineArgs = ["-rn", "--color=never", "-I"];
    if (file_pattern) lineArgs.push("--include=" + file_pattern);
    lineArgs.push("--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=dist", "--exclude-dir=.next", pattern, full);
    const r = spawnSync("grep", lineArgs, { encoding: "utf-8", timeout: 15000 });
    const allLines = (r.stdout || "").trim().split("\n").filter(Boolean);
    const lines = allLines.slice(0, 50);
    const result = { success: true, matches: lines, count: lines.length, total_matches: allLines.length, files_matched: matchingFiles.length };
    if (allLines.length > 50) result.note = `Showing 50 of ${allLines.length} matches across ${matchingFiles.length} files. Use file_pattern to narrow down.`;
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Sub-agent tools (read-only subset)
export const SUB_AGENT_TOOLS = [
  {
    functionDeclarations: [
      { name: "read_file", description: "Read file contents with line numbers.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } },
      { name: "list_directory", description: "List files and directories.", parameters: { type: "OBJECT", properties: { path: { type: "STRING" }, recursive: { type: "BOOLEAN" } } } },
      { name: "execute_command", description: "Run a read-only shell command (git, grep, cat, etc).", parameters: { type: "OBJECT", properties: { command: { type: "STRING" }, timeout: { type: "NUMBER" } }, required: ["command"] } },
      { name: "find_files", description: "Find files by name pattern.", parameters: { type: "OBJECT", properties: { pattern: { type: "STRING" }, path: { type: "STRING" } }, required: ["pattern"] } },
      { name: "search_text", description: "Search for text in files (grep).", parameters: { type: "OBJECT", properties: { pattern: { type: "STRING" }, path: { type: "STRING" }, file_pattern: { type: "STRING" } }, required: ["pattern"] } },
    ],
  },
];

export const SUB_AGENT_TOOL_MAP = {
  read_file: toolReadFile,
  list_directory: toolListDirectory,
  execute_command: toolExecuteCommand,
  find_files: toolFindFiles,
  search_text: toolSearchText,
};

// TOOL_MAP is mutable — bin/frog registers spawn_agent into it at startup
export const TOOL_MAP = {
  read_file: toolReadFile,
  write_file: toolWriteFile,
  write_files: toolWriteFiles,
  edit_file: toolEditFile,
  list_directory: toolListDirectory,
  execute_command: toolExecuteCommand,
  find_files: toolFindFiles,
  search_text: toolSearchText,
  // spawn_agent: registered by agent.js via bin/frog
};
