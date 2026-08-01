import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const webviewDist = resolve(here, "..", "webview", "dist");
const outputDir = resolve(here, "dist");
const watch = process.argv.includes("--watch");

/**
 * The webview is built by its own package and copied in here, because
 * `localResourceRoots` has to point inside the extension directory for the
 * assets to be reachable from the webview at runtime.
 */
function copyWebview() {
  if (!existsSync(webviewDist)) {
    console.warn("esbuild: packages/webview/dist is missing — build the webview package first");
    return;
  }
  mkdirSync(outputDir, { recursive: true });
  cpSync(webviewDist, resolve(outputDir, "webview"), { recursive: true });
}

const options = {
  entryPoints: [resolve(here, "src", "extension.ts")],
  bundle: true,
  outfile: resolve(outputDir, "extension.js"),
  platform: "node",
  format: "cjs",
  target: "node20",
  // Provided by the VS Code runtime, never bundled.
  external: ["vscode"],
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

copyWebview();

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild: watching");
} else {
  await esbuild.build(options);
}
