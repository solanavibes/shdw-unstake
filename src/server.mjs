// SHDW Unstake — local web GUI.
// Starts a server on 127.0.0.1 only and opens it in your default browser.
// Private keys are processed in memory on this computer and are never saved.
//
// Runs two ways:
//   1. From source:       node src/server.mjs   (or start.bat / start.command)
//   2. As a single file:  the Windows/macOS builds from GitHub Releases (Node.js SEA)

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const REPO_URL = "https://github.com/solanavibes/shdw-unstake";
const PUBLIC_RPC = "https://api.mainnet-beta.solana.com";
const COMPROMISED_WEB3 = ["1.95.6", "1.95.7"]; // Dec 2024 supply-chain attack

// Source mode: project root is one level above src/. Single-file mode: folder of the executable.
const SOURCE_ROOT = (() => {
  try { return path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."); } catch { return null; }
})();

async function detectSea() {
  try { const sea = await import("node:sea"); return sea.isSea() ? sea : null; } catch { return null; }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

async function main() {
  const sea = await detectSea();
  const DATA_DIR = sea ? path.dirname(process.execPath) : SOURCE_ROOT;
  const CONFIG_FILE = path.join(DATA_DIR, "shdw-unstake-config.json");

  // Versions: injected at build time in single-file mode, read from disk in source mode
  const appVersion = typeof __APP_VERSION__ !== "undefined"
    ? __APP_VERSION__ : readJsonFile(path.join(SOURCE_ROOT, "package.json"))?.version ?? "dev";
  const libVersion = typeof __WEB3_VERSION__ !== "undefined"
    ? __WEB3_VERSION__ : readJsonFile(path.join(SOURCE_ROOT, "node_modules/@solana/web3.js/package.json"))?.version ?? "?";
  if (COMPROMISED_WEB3.includes(libVersion)) {
    console.error(`DANGER: compromised @solana/web3.js ${libVersion} is installed. Delete node_modules and run the launcher again.`);
    process.exit(1);
  }

  // Load the Solana code only after the version check
  const { createClient } = await import("./stake.mjs");

  const indexHtml = sea
    ? sea.getAsset("index.html", "utf8")
    : fs.readFileSync(path.join(SOURCE_ROOT, "public/index.html"), "utf8");

  // ---------- settings
  const config = readJsonFile(CONFIG_FILE) ?? {};
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

  function readBody(req) {
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
      if (url.searchParams.get("t") !== TOKEN) {
        return send(res, 403, "Open the app with its launcher or executable.", "text/plain; charset=utf-8");
      }
      return send(res, 200, indexHtml.replace("__SESSION_TOKEN__", TOKEN), "text/html; charset=utf-8");
    }

    // API: token in a custom header (a cross-site page cannot set it without a CORS preflight, which we never allow)
    if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "Not found" });
    if (req.headers["x-session-token"] !== TOKEN || req.method !== "POST") return send(res, 403, { error: "Forbidden" });

    try {
      const body = await readBody(req);
      switch (url.pathname) {
        case "/api/config":
          if (typeof body.rpc === "string") {
            const rpc = body.rpc.trim();
            if (rpc && !/^https:\/\//i.test(rpc)) return send(res, 400, { error: "The RPC URL must start with https://" });
            config.rpc = rpc || undefined;
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
            client = createClient(config.rpc || PUBLIC_RPC);
          }
          return send(res, 200, {
            rpc: maskRpc(config.rpc || PUBLIC_RPC), custom: !!config.rpc,
            version: appVersion, lib: libVersion, repo: REPO_URL,
          });
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
    console.log(`SHDW Unstake v${appVersion} is running.`);
    console.log(`Open source: ${REPO_URL}`);
    console.log(`RPC: ${maskRpc(config.rpc || PUBLIC_RPC)}   @solana/web3.js ${libVersion}`);
    console.log("\nIf the browser did not open, copy this link into it:");
    console.log(link);
    console.log("\nKeep this window open while you use the app. Close it (or press Ctrl+C) to stop.");
    openBrowser(link);
  });
}

main().catch(e => {
  console.error("Failed to start:", e?.message ?? e);
  process.exitCode = 1;
});
