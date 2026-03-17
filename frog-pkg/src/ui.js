import state from "./state.js";

// ====== Terminal Title ======
export function setTitle(text) {
  process.stdout.write(`\x1b]0;${text}\x07`);
}

export function titleIdle() {
  setTitle(`🐸 frog [${state.MODEL}] ${state.CWD}`);
}

export function titleThinking() {
  setTitle(`🐸 frog ⟳ thinking...`);
}

export function titleToolCall(name) {
  setTitle(`🐸 frog ⚡ ${name}`);
}

export function titleDone() {
  setTitle(`🐸 frog ✓ done`);
}

// ====== Spinner ======
const SPIN = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];

export function startSpin(msg) {
  state.spinIdx = 0;
  state.spinTimer = setInterval(() => {
    process.stdout.write(`\r\x1b[90m${SPIN[state.spinIdx++ % SPIN.length]} ${msg}\x1b[0m`);
  }, 80);
}

export function stopSpin() {
  if (state.spinTimer) {
    clearInterval(state.spinTimer);
    state.spinTimer = null;
    process.stdout.write("\r\x1b[K");
  }
}

// ====== Format tool args ======
export function fmtArgs(args) {
  if (!args) return "";
  return Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > 60 ? `${k}:"${s.substring(0, 57)}..."` : `${k}:${s}`;
    })
    .join(" ");
}
