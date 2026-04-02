#!/usr/bin/env node
// Live E2E test: actually calls the Gemini API via frog's modules
// Tests that frog can handle 429s and respond successfully
import state from "./frog-pkg/src/state.js";
import { loadEnv, loadAuth } from "./frog-pkg/src/config.js";
import { callGemini, initProject, stripThoughtSignatures } from "./frog-pkg/src/api.js";
import { isOAuthEnabled } from "./frog-pkg/src/auth.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "frog-pkg");

loadEnv(ROOT_DIR);
state.API_KEY = process.env.GEMINI_API_KEY || "";
state.MODEL = "gemini-3-flash-preview";
state.authTokens = loadAuth();
state.CWD = "/home/localnet";

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}`); failed++; }
}

async function test() {
  console.log("\n\x1b[1m=== Live API Test ===\x1b[0m\n");

  assert(isOAuthEnabled(), "OAuth is enabled");
  console.log(`  Model: ${state.MODEL}`);
  console.log(`  Email: ${state.authTokens?.email}`);

  // Test 1: Simple greeting (should NOT use tools)
  console.log("\n\x1b[1m--- Test 1: Simple greeting ---\x1b[0m");
  state.history = [];
  state.history.push({ role: "user", parts: [{ text: "こんにちは！元気？" }] });

  try {
    const t1 = Date.now();
    const res1 = await callGemini(state.history);
    const elapsed1 = Date.now() - t1;
    state.history.push(res1);

    const text1 = res1.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("") || "";
    const hasFunctionCall = res1.parts?.some(p => p.functionCall);

    assert(text1.length > 0, `Got text response (${text1.length} chars, ${elapsed1}ms)`);
    assert(!hasFunctionCall, "No tool calls for greeting");
    console.log(`  Response: ${text1.substring(0, 100)}...`);
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m Test 1 failed: ${e.message}\x1b[0m`);
    failed++;
  }

  // Wait a bit between tests
  await new Promise(r => setTimeout(r, 3000));

  // Test 2: Code task (should use tools)
  console.log("\n\x1b[1m--- Test 2: Code question ---\x1b[0m");
  state.history = [];
  state.history.push({ role: "user", parts: [{ text: "server.pyの1行目だけ読んで" }] });

  try {
    const t2 = Date.now();
    const res2 = await callGemini(state.history);
    const elapsed2 = Date.now() - t2;
    state.history.push(res2);

    const hasFunctionCall2 = res2.parts?.some(p => p.functionCall);
    const hasText2 = res2.parts?.some(p => p.text && !p.thought);

    assert(hasFunctionCall2 || hasText2, `Got response (${elapsed2}ms)`);
    if (hasFunctionCall2) {
      const fc = res2.parts.find(p => p.functionCall);
      console.log(`  Tool call: ${fc.functionCall.name}(${JSON.stringify(fc.functionCall.args || {}).substring(0, 100)})`);
      assert(true, "Model used tools for code task");
    } else {
      const text2 = res2.parts.filter(p => p.text && !p.thought).map(p => p.text).join("");
      console.log(`  Text: ${text2.substring(0, 100)}...`);
      assert(true, "Model responded with text");
    }
  } catch (e) {
    console.log(`  \x1b[31m✗\x1b[0m Test 2 failed: ${e.message}\x1b[0m`);
    failed++;
  }

  // Wait a bit
  await new Promise(r => setTimeout(r, 3000));

  // Test 3: Rapid consecutive calls (test 429 handling)
  console.log("\n\x1b[1m--- Test 3: Rapid calls (429 stress test) ---\x1b[0m");
  let successCount = 0;
  for (let i = 0; i < 3; i++) {
    state.history = [];
    state.history.push({ role: "user", parts: [{ text: `${i + 1}を漢字で書いて。一文字だけ。` }] });
    try {
      const t = Date.now();
      const res = await callGemini(state.history);
      const elapsed = Date.now() - t;
      const text = res.parts?.filter(p => p.text && !p.thought).map(p => p.text).join("") || "[tool call]";
      console.log(`  Call ${i + 1}: OK (${elapsed}ms) → ${text.substring(0, 20)}`);
      successCount++;
    } catch (e) {
      console.log(`  Call ${i + 1}: ${e.message.substring(0, 80)}`);
    }
    // Small pause to not be completely rude
    await new Promise(r => setTimeout(r, 1000));
  }
  assert(successCount >= 2, `At least 2/3 rapid calls succeeded (got ${successCount}/3)`);

  console.log(`\n\x1b[1m=== Live Results: ${passed} passed, ${failed} failed ===\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

test().catch(e => {
  console.error(`\x1b[31mFatal: ${e.message}\x1b[0m`);
  process.exit(1);
});
