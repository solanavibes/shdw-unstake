// Bundles the app into one CommonJS file (dist/app.cjs) for a Node.js single executable (SEA).
// Used by the GitHub Actions release workflow; you don't need to run this to use the app.

import { build } from "esbuild";
import fs from "fs";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const web3 = JSON.parse(fs.readFileSync("node_modules/@solana/web3.js/package.json", "utf8"));

// Refuse to ship the compromised @solana/web3.js releases (Dec 2024 supply-chain attack)
if (["1.95.6", "1.95.7"].includes(web3.version)) {
  console.error(`Refusing to build with compromised @solana/web3.js ${web3.version}`);
  process.exit(1);
}

await build({
  entryPoints: ["src/server.mjs"],
  outfile: "dist/app.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  // Optional native speedups of the "ws" package; it works without them
  external: ["bufferutil", "utf-8-validate"],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __WEB3_VERSION__: JSON.stringify(web3.version),
  },
  logLevel: "warning",
});

console.log(`Bundled v${pkg.version} with @solana/web3.js ${web3.version} -> dist/app.cjs`);
