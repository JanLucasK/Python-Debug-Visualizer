import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [resolve(here, "src", "main.tsx")],
  bundle: true,
  outfile: resolve(here, "dist", "main.js"),
  // IIFE rather than ESM: the webview loads a plain <script> under a strict
  // CSP, where module loading and dynamic imports would need extra allowances.
  format: "iife",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
  loader: { ".css": "css" },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild: watching webview");
} else {
  await esbuild.build(options);
}
