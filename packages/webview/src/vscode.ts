import type { ExtensionToWebview, WebviewToExtension } from "@python-debug-visualizer/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

let api: VsCodeApi | undefined;

/**
 * The host handle, acquired on first use.
 *
 * `acquireVsCodeApi` may only be called once per webview, so the result is
 * cached. Acquiring it lazily rather than at module scope matters as well:
 * anything importing this file transitively -- which is most of the UI -- would
 * otherwise fail to load outside a webview, and take every test with it.
 *
 * Outside one there is no host, and posting is a no-op rather than an error.
 */
function host(): VsCodeApi | undefined {
  if (api) return api;
  if (typeof acquireVsCodeApi !== "function") return undefined;
  api = acquireVsCodeApi();
  return api;
}

export function post(message: WebviewToExtension): void {
  host()?.postMessage(message);
}

export function onMessage(handler: (message: ExtensionToWebview) => void): () => void {
  const listener = (event: MessageEvent<ExtensionToWebview>) => handler(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
