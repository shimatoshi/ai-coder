// ====== Character Width ======
export function displayWidth(str) {
  let w = 0;
  for (const ch of str) w += isWideChar(ch) ? 2 : 1;
  return w;
}

export function isWideChar(char) {
  if (!char) return false;
  const c = char.codePointAt(0);
  return (
    (c >= 0x1100 && c <= 0x115F) ||
    (c >= 0x11A3 && c <= 0x11A7) ||
    (c >= 0x11FA && c <= 0x11FF) ||
    (c >= 0x2E80 && c <= 0x2FFF) ||
    (c >= 0x3000 && c <= 0x303E) ||
    (c >= 0x3040 && c <= 0x33BF) ||
    (c >= 0x3400 && c <= 0x4DBF) ||
    (c >= 0x4E00 && c <= 0xD7FF) ||
    (c >= 0xF900 && c <= 0xFAFF) ||
    (c >= 0xFE10 && c <= 0xFE6F) ||
    (c >= 0xFF01 && c <= 0xFF60) ||
    (c >= 0xFFE0 && c <= 0xFFE6) ||
    (c >= 0x1F000 && c <= 0x1F9FF) ||
    (c >= 0x20000 && c <= 0x3FFFF)
  );
}

// ====== Confirm Action ======
export function confirmAction(message) {
  return new Promise((resolve) => {
    process.stdout.write(`\x1b[33m  ! ${message}\x1b[0m\n`);
    process.stdout.write(`\x1b[33m  実行する？ (Y/n): \x1b[0m`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      const ch = data.toString();
      const isYes = ch === "\r" || ch === "\n" || ch.toLowerCase() === "y";
      process.stdout.write(isYes ? "y\n" : "n\n");
      resolve(isYes);
    });
  });
}

// ====== Simple Line Input ======
export function readSimpleLine(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    function onData(data) {
      const ch = data.toString();
      if (ch === "\r" || ch === "\n") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(buf);
      } else if (ch === "\x03") {
        process.stdin.removeListener("data", onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        resolve(null);
      } else if (ch === "\x7f" || ch === "\b") {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (ch >= " ") {
        buf += ch;
        process.stdout.write("*");
      }
    }
    process.stdin.on("data", onData);
  });
}

// ====== Multiline Input (raw stdin) ======
export function readUserInput() {
  return new Promise((resolve) => {
    process.stdout.write("\x1b[32m> \x1b[0m");
    const lines = [""];
    let cursorPos = 0;
    let partialBytes = null;
    let lastCtrlC = 0;

    process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    function getPrefix() {
      return lines.length > 1 ? "\x1b[90m│\x1b[0m " : "\x1b[32m> \x1b[0m";
    }

    let prevWrappedLines = 1;

    function redrawLine() {
      const prefix = getPrefix();
      const text = lines[lines.length - 1];
      const cols = process.stdout.columns || 80;
      const prefixLen = prefix.replace(/\x1b\[[^m]*m/g, "").length;
      const textWidth = displayWidth(text);
      const rendered = prefixLen + textWidth;
      const wrappedLines = Math.ceil(rendered / cols) || 1;
      const linesToClear = Math.max(wrappedLines, prevWrappedLines);
      if (linesToClear > 1) {
        process.stdout.write(`\x1b[${linesToClear - 1}A`);
      }
      process.stdout.write(`\r\x1b[J` + prefix + text);
      prevWrappedLines = wrappedLines;
      const chars = [...text];
      const afterCursor = chars.slice(cursorPos);
      const afterWidth = afterCursor.reduce((w, ch) => w + (isWideChar(ch) ? 2 : 1), 0);
      if (afterWidth > 0) {
        process.stdout.write(`\x1b[${afterWidth}D`);
      }
    }

    function onData(data) {
      if (partialBytes) {
        data = Buffer.concat([partialBytes, data]);
        partialBytes = null;
      }

      for (let i = 0; i < data.length; i++) {
        const byte = data[i];

        if (byte === 3) {
          const now = Date.now();
          if (now - lastCtrlC < 500) {
            cleanup();
            console.log("\n\x1b[90mBye.\x1b[0m");
            process.exit(0);
          }
          lastCtrlC = now;
          process.stdout.write(`\n\x1b[90m(Ctrl+C again to exit)\x1b[0m\n`);
          process.stdout.write(getPrefix());
          continue;
        }

        if (byte === 4) {
          cleanup();
          process.stdout.write("\n");
          resolve(lines.join("\n"));
          return;
        }

        if (byte === 1) { cursorPos = 0; redrawLine(); continue; }
        if (byte === 5) { cursorPos = [...lines[lines.length - 1]].length; redrawLine(); continue; }

        if (byte === 21) {
          const chars = [...lines[lines.length - 1]];
          lines[lines.length - 1] = chars.slice(cursorPos).join("");
          cursorPos = 0;
          redrawLine();
          continue;
        }

        if (byte === 13) {
          if (lines.length > 0 && lines[lines.length - 1] === "") {
            lines.pop();
            cleanup();
            process.stdout.write("\n");
            resolve(lines.join("\n"));
            return;
          }
          lines.push("");
          cursorPos = 0;
          prevWrappedLines = 1;
          process.stdout.write("\n\x1b[90m│\x1b[0m ");
          continue;
        }

        if (byte === 127 || byte === 8) {
          if (cursorPos > 0) {
            const chars = [...lines[lines.length - 1]];
            chars.splice(cursorPos - 1, 1);
            lines[lines.length - 1] = chars.join("");
            cursorPos--;
            redrawLine();
          } else if (lines.length > 1) {
            lines.pop();
            const prevChars = [...lines[lines.length - 1]];
            cursorPos = prevChars.length;
            prevWrappedLines = 1;
            process.stdout.write("\x1b[2K\x1b[A");
            redrawLine();
          }
          continue;
        }

        if (byte === 27) {
          if (i + 2 < data.length && data[i + 1] === 91) {
            const code = data[i + 2];
            if (code === 68) { if (cursorPos > 0) { cursorPos--; process.stdout.write("\x1b[D"); } i += 2; continue; }
            if (code === 67) { const chars = [...lines[lines.length - 1]]; if (cursorPos < chars.length) { cursorPos++; process.stdout.write("\x1b[C"); } i += 2; continue; }
            if (code === 51 && i + 3 < data.length && data[i + 3] === 126) {
              const chars = [...lines[lines.length - 1]];
              if (cursorPos < chars.length) { chars.splice(cursorPos, 1); lines[lines.length - 1] = chars.join(""); redrawLine(); }
              i += 3; continue;
            }
            if (code === 72) { cursorPos = 0; redrawLine(); i += 2; continue; }
            if (code === 70) { cursorPos = [...lines[lines.length - 1]].length; redrawLine(); i += 2; continue; }
            i += 2;
            while (i < data.length && data[i] < 64) i++;
            continue;
          }
          if (i + 1 < data.length) i++;
          continue;
        }

        let charBytes = 1;
        if (byte >= 0xc0 && byte < 0xe0) charBytes = 2;
        else if (byte >= 0xe0 && byte < 0xf0) charBytes = 3;
        else if (byte >= 0xf0) charBytes = 4;
        else if (byte < 0x20) continue;

        if (i + charBytes > data.length) { partialBytes = data.slice(i); break; }

        const char = data.slice(i, i + charBytes).toString("utf-8");
        i += charBytes - 1;

        const chars = [...lines[lines.length - 1]];
        chars.splice(cursorPos, 0, char);
        lines[lines.length - 1] = chars.join("");
        cursorPos++;

        if (cursorPos === chars.length) {
          process.stdout.write(char);
        } else {
          redrawLine();
        }
      }
    }

    process.stdin.on("data", onData);
  });
}
