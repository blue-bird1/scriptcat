const PRODUCT_NAME = "Steam Discovery Queue";

let sessionSequence = 0;

function defaultNow() {
  return new Date().toISOString();
}

function createDefaultElapsed() {
  const start = globalThis.performance?.now?.() ?? Date.now();
  return () => (globalThis.performance?.now?.() ?? Date.now()) - start;
}

function copyContext(context) {
  try {
    return context && typeof context === "object" ? { ...context } : {};
  } catch {
    return {};
  }
}

function safeCall(source) {
  try {
    return source();
  } catch {
    return null;
  }
}

function safeText(value, fallback) {
  try {
    const text = String(value);
    return text || fallback;
  } catch {
    return fallback;
  }
}

export function createDiscoveryQueueLogger({
  scriptVersion,
  consoleTarget = globalThis.console,
  now = defaultNow,
  elapsed = createDefaultElapsed(),
} = {}) {
  const sessionId = `dq-${Date.now().toString(36)}-${++sessionSequence}`;
  const state = {
    consoleTarget,
    elapsed,
    idSequence: 0,
    logSequence: 0,
    now,
    scriptVersion,
    sessionId,
  };

  function nextId(prefix = "operation") {
    try {
      state.idSequence += 1;
      return `${state.sessionId}:${safeText(prefix, "operation")}:${state.idSequence}`;
    } catch {
      return `${state.sessionId}:operation`;
    }
  }

  function createChild(scope, context) {
    const stableScope = safeText(scope, "root");
    const stableContext = copyContext(context);

    function write(level, event, data, error, hasData) {
      try {
        state.logSequence += 1;
        const eventName = safeText(event, "unknown");
        const prefix = [
          `[${PRODUCT_NAME}]`,
          `[${state.sessionId}]`,
          `[#${state.logSequence}]`,
          `[${stableScope}.${eventName}]`,
        ].join("");
        const metadata = {
          ...stableContext,
          scriptVersion: state.scriptVersion,
          timestamp: safeCall(state.now),
          elapsedMs: safeCall(state.elapsed),
        };
        const args = error === undefined
          ? [prefix, metadata]
          : [prefix, metadata, error];
        if (hasData) {
          args.push(data);
        }
        const method = state.consoleTarget?.[level];
        if (typeof method === "function") {
          Reflect.apply(method, state.consoleTarget, args);
        }
      } catch {
        // Observability must never alter discovery queue behavior.
      }
    }

    return {
      sessionId: state.sessionId,
      nextId,
      child(childScope, childContext) {
        try {
          const nestedScope = stableScope === "root"
            ? safeText(childScope, "child")
            : `${stableScope}.${safeText(childScope, "child")}`;
          return createChild(
            nestedScope,
            { ...stableContext, ...copyContext(childContext) },
          );
        } catch {
          return createChild(stableScope, stableContext);
        }
      },
      debug(event, data) {
        write("debug", event, data, undefined, arguments.length >= 2);
      },
      info(event, data) {
        write("info", event, data, undefined, arguments.length >= 2);
      },
      warn(event, data) {
        write("warn", event, data, undefined, arguments.length >= 2);
      },
      error(event, error, data) {
        write("error", event, data, error, arguments.length >= 3);
      },
    };
  }

  return createChild("root");
}
