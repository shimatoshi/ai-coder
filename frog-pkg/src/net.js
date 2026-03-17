import state from "./state.js";

export const MIN_INTERVAL = 1500;

export function sleep(ms) {
  return new Promise((r, rej) => {
    const timer = setTimeout(r, ms);
    const check = setInterval(() => {
      if (state.aborted) { clearTimeout(timer); clearInterval(check); rej(new Error("Aborted by user")); }
    }, 200);
    setTimeout(() => clearInterval(check), ms);
  });
}

export function fetchWithTimeout(url, options, timeoutMs = 60000) {
  const controller = new AbortController();
  state.currentAbortController = controller;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (state.currentAbortController === controller) state.currentAbortController = null;
  });
}

export async function rateLimitWait() {
  const elapsed = Date.now() - state.lastApiCall;
  if (elapsed < MIN_INTERVAL) {
    const waitMs = MIN_INTERVAL - elapsed;
    if (waitMs > 3000) {
      process.stdout.write(`\x1b[90m  (cooldown ${Math.ceil(waitMs / 1000)}s...)\x1b[0m\n`);
    }
    await sleep(waitMs);
  }
}
