/**
 * Stand-in for the `vscode` module under vitest.
 *
 * The real one is injected by the editor at runtime and simply does not exist
 * outside it. Anything that genuinely depends on editor behaviour belongs in an
 * integration test against a real VS Code; this exists so that modules which
 * merely *import* the API -- the logger, most of all -- can be unit tested.
 *
 * Deliberately minimal. A rich fake would start encoding assumptions about how
 * VS Code behaves, and tests would then pass against the fake rather than
 * against the editor.
 */

const noop = () => undefined;

export const window = {
  createOutputChannel: () => ({
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    show: noop,
    dispose: noop,
  }),
};

export const workspace = {
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
};

export const debug = {
  get activeDebugSession() {
    return undefined;
  },
  get activeStackItem() {
    return undefined;
  },
};

export class EventEmitter<T> {
  private readonly listeners: ((value: T) => void)[] = [];
  readonly event = (listener: (value: T) => void) => {
    this.listeners.push(listener);
    return { dispose: noop };
  };
  fire(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
  dispose(): void {
    this.listeners.length = 0;
  }
}

export class DebugStackFrame {}
