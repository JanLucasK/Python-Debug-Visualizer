import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `vscode` is provided by the editor at runtime and has no package to
      // resolve; see test/vscode-stub.ts.
      vscode: resolve(__dirname, "test/vscode-stub.ts"),
    },
  },
  test: {
    // These drive real Python subprocesses and a real socket, so they are
    // slower than a unit test and must not race each other for ports.
    testTimeout: 60_000,
  },
});
