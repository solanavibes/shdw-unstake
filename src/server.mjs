// SHDW Unstake — local web GUI.
// Starts a server on 127.0.0.1 only and opens it in your default browser.
// Private keys are processed in memory on this computer and are never saved.

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_FILE = path.join(ROOT, "config.json");
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";

// ---------- refuse to run with the compromised @solana/web3.js releases (Dec 2024 supply-chain attack)
let libVersion = "?";
try {
  libVersion = JSON.parse(fs.readFileSync(path.join(ROOT, "node_modules/@solana/web3.js/package.json"), "utf8")).version;
} catch {}
if (["1.95.6", "1.95.7"].includes(libVersion)) {
  console.error(`DANGER: compromised @solana/web3.js ${libVersion} is installed. Delete node_modules and run the launcher again.`);
  process.exit(1);
}
const { createClient } = await import("./stake.mjs");

// ---------- settings
const loadConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return {}; } };
let config = loadConfig();
let client = createClient(config.rpc || PUBLIC_RPC);
const maskRpc = url => url.replace(/(api-key=)[^&]+/i, "$1***");

// ---------- security: random session token + Host check (blocks other websites and DNS rebinding)
const TOKEN = crypto.randomBytes(24).toString("hex");
let PORT = 0;

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 20000) { reject(new Error("Request too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Bad JSON")); } });
  });
}

const friendly = e => {
  const m = String(e?.message ?? e);
  if (/429|Too Many Requests/i.test(m)) return "The public RPC is rate-limiting you. Add a free Helius RPC URL in Settings.";
  if (/401|403|Unauthorized|forbidden/i.test(m)) return "The RPC rejected the request. Check the RPC URL in Settings.";
  if (/getProgramAccounts|excluded from account secondary indexes/i.test(m)) return "This RPC does not allow stake search. Add a free Helius RPC URL in Settings.";
  if (/Invalid public key|Non-base58/i.test(m)) return "That is not a valid Solana wallet address.";
  return m;
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.headers.host !== `127.0.0.1:${PORT}`) return send(res, 403, { error: "Forbidden" });

  // Main page: only served with the correct session token in the URL
  if (req.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("t") !== TOKEN) return send(res, 403, "Open the app with the launcher (start.bat / start.command).", "text/plain; charset=utf-8");
    const html = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8").replace("__SESSION_TOKEN__", TOKEN);
    return send(res, 200, html, "text/html; charset=utf-8");
  }

  // API: token in a custom header (a cross-site page cannot set it without a CORS preflight, which we never allow)
  if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
  if (req.headers["x-session-token"] !== TOKEN || req.method !== "POST") return send(res, 403, { error: "Forbidden" });

  try {
    const body = await readJson(req);
    switch (url.pathname) {
      case "/api/config":
        if (typeof body.rpc === "string") {
          const rpc = body.rpc.trim();
          if (rpc && !/^https:\/\//i.test(rpc)) return send(res, 400, { error: "The RPC URL must start with https://" });
          config.rpc = rpc || undefined;
          fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
          client = createClient(config.rpc || PUBLIC_RPC);
        }
        return send(res, 200, { rpc: maskRpc(config.rpc || PUBLIC_RPC), custom: !!config.rpc, lib: libVersion });
      case "/api/info":
        return send(res, 200, await client.info(body.wallet));
      case "/api/simulate":
        return send(res, 200, await client.simulate(body.wallet, body.step));
      case "/api/send":
        return send(res, 200, await client.send(body.wallet, body.step, body.key));
      case "/api/quit":
        send(res, 200, { ok: true });
        console.log("Stopped from the app window.");
        setTimeout(() => process.exit(0), 200);
        return;
      default:
        return send(res, 404, { error: "Not found" });
    }
  } catch (e) {
    return send(res, 200, { ok: false, error: friendly(e) });
  }
});

function openBrowser(link) {
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", link]] :
    process.platform === "darwin" ? ["open", [link]] :
    ["xdg-open", [link]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
}

server.listen(0, "127.0.0.1", () => {
  PORT = server.address().port;
  const link = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log("SHDW Unstake is running.");
  console.log(`RPC: ${maskRpc(config.rpc || PUBLIC_RPC)}   @solana/web3.js ${libVersion}`);
  console.log("\nIf the browser did not open, copy this link into it:");
  console.log(link);
  console.log("\nKeep this window open while you use the app. Close it (or press Ctrl+C) to stop.");
  openBrowser(link);
});
