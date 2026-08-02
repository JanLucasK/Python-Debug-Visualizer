import * as vscode from "vscode";

let channel: vscode.LogOutputChannel | undefined;

export function initLogging(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel("Python Debug Plots", { log: true });
  return channel;
}

export const log = {
  debug: (message: string, ...args: unknown[]) => channel?.debug(message, ...args),
  info: (message: string, ...args: unknown[]) => channel?.info(message, ...args),
  warn: (message: string, ...args: unknown[]) => channel?.warn(message, ...args),
  error: (message: string, ...args: unknown[]) => channel?.error(message, ...args),
  show: () => channel?.show(),
};
