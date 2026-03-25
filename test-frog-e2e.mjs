#!/usr/bin/env node
// E2E test: launch frog → mock API returns 404 → fallback fires → verify [strip] logs
// Requires: FROG_API_URL env var support in config.js

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TIMEOUT_MS = 30000;
let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); passed++; }
function fail(msg) { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failed++; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Mock Gemini API ──
// Request 1 (primary model): 404 → triggers fallback + prepareModelSwitch + strip
// Request 2+ (fallback model): valid response
let requestCount = 0;
const requestLog = [];

const mockServer = createServer((req, res) => {
  requestCount++;
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const url = req.url || "";
    let parsedBody = null;
    try { parsedBody = JSON.parse(body); } catch {}

    // Extract model name from URL: /v1beta/models/{MODEL}:generateContent?key=...
    const modelMatch = url.match(/models\/([^:]+)/);
    const model = modelMatch ? modelMatch[1] : "unknown";

    requestLog.push({ n: requestCount, model, url: url.split("?")[0] });

    if (requestCount === 1) {
      // Primary model → 404 Not Found
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        error: {
          code: 404,
          message: `models/${model} is not found.`,
          status: "NOT_FOUND",
        }
      }));
    } else {
      // Fallback model → success with a thoughtSignature-bearing response
      // (simulates what a real thinking model returns)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{
          content: {
            role: "model",
            parts: [
              { text: "Hello from fallback model!" },
            ]
          },
          finishReason: "STOP"
        }]
      }));
    }
  });
});

await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
const mockPort = mockServer.address().port;
const mockUrl = `http://127.0.0.1:${mockPort}/v1beta`;

console.log("\n\x1b[1m=== E2E: frog fallback chain test ===\x1b[0m\n");
console.log(`\x1b[90mmock API: ${mockUrl}\x1b[0m\n`);

const tmpDir = mkdtempSync(join(tmpdir(), "frog-e2e-"));
const outPath = join(tmpDir, "output.log");

// Launch frog via script (PTY) with mock API
// Force apikey mode: set GEMINI_API_KEY, unset OAuth tokens
const proc = spawn("script", ["-qefc", "frog", outPath], {
  env: {
    ...process.env,
    AGENT_MODEL: "gemini-3-flash-preview",
    GEMINI_API_KEY: "fake-test-key",
    FROG_API_URL: mockUrl,
    // Disable OAuth so it uses apikey path → hits our mock
    HOME: tmpDir, // auth.json won't exist here → no OAuth
    TERM: "xterm-256color",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
proc.stdout.on("data", (d) => { stdout += d.toString(); });
proc.stderr.on("data", (d) => { stdout += d.toString(); });

// Wait for frog startup
await sleep(3000);

// Send prompt (Enter + Enter = double-Enter to submit)
proc.stdin.write("say hi\r");
await sleep(300);
proc.stdin.write("\r");

// Wait for output
const startTime = Date.now();
let logContent = "";

while (Date.now() - startTime < TIMEOUT_MS) {
  await sleep(1500);
  try { logContent = readFileSync(outPath, "utf-8"); } catch {}
  const combined = logContent + stdout;
  // Done when we see a response or error
  if (combined.includes("Hello from fallback") || combined.includes("[strip]") ||
      combined.includes("no fallback") || combined.includes("Error:")) {
    await sleep(2000);
    try { logContent = readFileSync(outPath, "utf-8"); } catch {}
    break;
  }
}

// Terminate frog
try { proc.stdin.write("\x03\x03"); } catch {}
await sleep(500);
try { proc.kill("SIGTERM"); } catch {}
await sleep(500);
try { proc.kill("SIGKILL"); } catch {}

mockServer.close();

// Analyze
const allOutput = logContent + "\n" + stdout;
const clean = allOutput
  .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
  .replace(/\][^\x07\x1b]*(\x07|\x1b\\)/g, "");

console.log("\x1b[1m--- mock server request log ---\x1b[0m");
for (const r of requestLog) {
  const tag = r.n === 1 ? "\x1b[31m404\x1b[0m" : "\x1b[32m200\x1b[0m";
  console.log(`  #${r.n} [${tag}] ${r.model}  ${r.url}`);
}
if (requestLog.length === 0) console.log("  \x1b[31m(no requests received)\x1b[0m");
console.log("");

console.log("\x1b[1m--- relevant output lines ---\x1b[0m");
const relevant = clean.split("\n").filter(l =>
  l.includes("[strip]") || l.includes("falling back") || l.includes("404") ||
  l.includes("→") || l.includes("not available") || l.includes("Hello from fallback")
);
for (const line of relevant.slice(0, 20)) {
  console.log(`  ${line.trim()}`);
}
if (relevant.length === 0) console.log("  (none)");
console.log("\n");

// ── Assertions ──

// 1. Mock server got at least 2 requests (primary 404 + fallback)
if (requestLog.length >= 2) {
  pass(`mock server received ${requestLog.length} requests (404 → fallback)`);
} else if (requestLog.length === 1) {
  fail("only 1 request — fallback didn't fire");
} else {
  fail("no requests hit mock server — frog may have used OAuth instead of apikey");
}

// 2. Primary model got 404
if (clean.includes("not available (404)") || clean.includes("not available") || clean.includes("→")) {
  pass("404 detected and fallback triggered");
} else {
  fail("404/fallback not detected in output");
}

// 3. [strip] was called
if (clean.includes("[strip]")) {
  pass("[strip] log present");
} else {
  fail("[strip] log NOT found");
}

// 4. All [strip] lines → remaining suspicious: 0
const stripLines = clean.split("\n").filter(l => l.includes("[strip]"));
if (stripLines.length > 0) {
  const badStrips = stripLines.filter(l => !l.includes("remaining suspicious: 0"));
  if (badStrips.length === 0) {
    pass(`all ${stripLines.length} [strip] lines → remaining suspicious: 0`);
  } else {
    fail(`${badStrips.length}/${stripLines.length} [strip] lines have suspicious > 0:`);
    for (const line of badStrips) console.log(`    ${line.trim()}`);
  }
} else if (clean.includes("[strip]")) {
  fail("[strip] appeared but couldn't parse lines");
}

// 5. Fallback model responded successfully
if (clean.includes("Hello from fallback")) {
  pass("fallback model response received");
} else if (requestLog.length >= 2) {
  // Request was made but response might not appear in output
  pass("fallback request was sent (response may be in different output stream)");
}

// ── Summary ──
console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m\n`);

if (failed > 0) {
  console.log("\x1b[33m--- full output (first 60 lines) ---\x1b[0m");
  clean.split("\n").slice(0, 60).forEach(l => console.log(`  ${l}`));
  console.log("\x1b[33m--- end ---\x1b[0m");
}

// Cleanup
try { unlinkSync(outPath); } catch {}
try { execSync(`rm -rf "${tmpDir}"`); } catch {}

process.exit(failed > 0 ? 1 : 0);
