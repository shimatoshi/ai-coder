import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import state from "./state.js";
import {
  OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_REDIRECT_URI, OAUTH_SCOPES,
  saveAuth,
} from "./config.js";
import { fetchWithTimeout } from "./net.js";
import { readSimpleLine } from "./input.js";

// ====== PKCE ======
export function generatePKCE() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ====== API Key Configuration ======
export async function configureApiKey(rootDir) {
  console.log(`\x1b[36m\nGemini APIキー設定\x1b[0m`);
  if (state.API_KEY) {
    console.log(`\x1b[90m現在: ${state.API_KEY.substring(0, 8)}...(設定済み)\x1b[0m`);
  } else {
    console.log(`\x1b[90m現在: 未設定\x1b[0m`);
  }
  console.log(`\x1b[90mhttps://aistudio.google.com/apikey で取得できます\x1b[0m`);
  console.log(`\x1b[90mCtrl+C でキャンセル\x1b[0m\n`);

  const key = await readSimpleLine("\x1b[33mAPIキー: \x1b[0m");
  if (key === null) {
    console.log("\x1b[90mキャンセルしました\x1b[0m");
    return;
  }
  const trimmed = key.trim();
  if (!trimmed) {
    console.log("\x1b[90m空のキーは無視されました\x1b[0m");
    return;
  }

  const envPath = join(rootDir, ".env");
  let envContent = "";
  try { envContent = readFileSync(envPath, "utf-8"); } catch {}

  if (envContent.match(/^GEMINI_API_KEY=/m)) {
    envContent = envContent.replace(/^GEMINI_API_KEY=.*/m, `GEMINI_API_KEY=${trimmed}`);
  } else {
    envContent += `${envContent && !envContent.endsWith("\n") ? "\n" : ""}GEMINI_API_KEY=${trimmed}\n`;
  }
  writeFileSync(envPath, envContent, "utf-8");

  state.API_KEY = trimmed;
  process.env.GEMINI_API_KEY = trimmed;
  console.log(`\x1b[32m\nAPIキーを保存しました (.env)\x1b[0m\n`);
}

// ====== OAuth Login ======
export async function startOAuthLogin() {
  const { verifier, challenge } = generatePKCE();
  const oauthState = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: oauthState,
    access_type: "offline",
    prompt: "consent",
  });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  console.log("\x1b[36m\nブラウザで以下のURLを開いてGoogleログインしてください:\x1b[0m\n");
  console.log(authUrl + "\n");

  try {
    execSync(`termux-open-url "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
    console.log("\x1b[90mブラウザを開きました...\x1b[0m");
  } catch {
    try {
      execSync(`xdg-open "${authUrl}"`, { stdio: "ignore", timeout: 3000 });
    } catch {
      console.log("\x1b[90mURLをコピーしてブラウザで開いてください。\x1b[0m");
    }
  }

  const code = await waitForOAuthCallback(oauthState);
  const tokens = await exchangeCodeForTokens(code, verifier);
  state.authTokens = tokens;
  saveAuth(tokens);

  console.log(`\x1b[32m\n認証成功！\x1b[0m`);
  if (tokens.email) console.log(`\x1b[90mAccount: ${tokens.email}\x1b[0m`);
  console.log("");
}

function waitForOAuthCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:8085");

      if (url.pathname !== "/oauth2callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const callbackState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<h1>認証エラー: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (callbackState !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("OAuth state mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body style='text-align:center;padding:50px;font-family:sans-serif'>" +
          "<h1>認証完了！</h1><p>ターミナルに戻ってください。</p></body></html>"
      );
      server.close();
      resolve(code);
    });

    server.listen(8085, () => {
      console.log("\x1b[90m認証待機中 (port 8085)...\x1b[0m");
    });

    server.on("error", (e) => {
      if (e.code === "EADDRINUSE") {
        reject(new Error("Port 8085 is already in use. Close other instances first."));
      } else {
        reject(e);
      }
    });

    setTimeout(() => {
      server.close();
      reject(new Error("認証タイムアウト（3分）"));
    }, 180000);
  });
}

async function exchangeCodeForTokens(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OAUTH_REDIRECT_URI,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
    code_verifier: verifier,
  });

  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  }, 15000);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token exchange failed: ${err}`);
  }

  const data = await res.json();

  let email = null;
  try {
    const userRes = await fetchWithTimeout(
      "https://www.googleapis.com/oauth2/v1/userinfo",
      { headers: { Authorization: `Bearer ${data.access_token}` } },
      10000
    );
    if (userRes.ok) {
      const user = await userRes.json();
      email = user.email;
    }
  } catch {}

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    email,
  };
}

export async function refreshAccessToken() {
  if (!state.authTokens?.refresh_token) return false;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: state.authTokens.refresh_token,
    client_id: OAUTH_CLIENT_ID,
    client_secret: OAUTH_CLIENT_SECRET,
  });

  try {
    const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }, 15000);

    if (!res.ok) return false;

    const data = await res.json();
    state.authTokens.access_token = data.access_token;
    state.authTokens.expires_at = Date.now() + data.expires_in * 1000;
    if (data.refresh_token) state.authTokens.refresh_token = data.refresh_token;
    saveAuth(state.authTokens);
    return true;
  } catch {
    return false;
  }
}

export async function ensureValidToken() {
  if (!state.authTokens) return false;
  if (Date.now() > state.authTokens.expires_at - 60000) {
    process.stdout.write("\x1b[90m  (refreshing token...)\x1b[0m\n");
    return await refreshAccessToken();
  }
  return true;
}

export function isOAuthEnabled() {
  return state.authTokens?.access_token && state.authTokens?.refresh_token;
}
