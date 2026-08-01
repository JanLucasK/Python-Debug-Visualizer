import type { ExtensionToWebview, WebviewToExtension } from "@python-debug-visualizer/protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// `acquireVsCodeApi` may only be called once per webview, so the handle is
// captured here and shared.
const api = acquireVsCodeApi();

export function post(message: WebviewToExtension): void {
  api.postMessage(message);
}

export function onMessage(handler: (message: ExtensionToWebview) => void): () => void {
  const listener = (event: MessageEvent<ExtensionToWebview>) => handler(event.data);
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}
