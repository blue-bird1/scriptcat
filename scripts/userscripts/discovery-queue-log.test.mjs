import assert from "node:assert/strict";
import test from "node:test";

import { createDiscoveryQueueLogger } from "../../src/lib/steam/discovery-queue-log.js";

function createConsoleRecorder() {
  const calls = [];
  return {
    calls,
    consoleTarget: Object.fromEntries(
      ["debug", "info", "warn", "error"].map((level) => [
        level,
        (...args) => calls.push({ args, level }),
      ]),
    ),
  };
}

test("discovery queue logger writes ordered structured records directly to console", () => {
  const { calls, consoleTarget } = createConsoleRecorder();
  const data = { retained: [42] };
  const failure = new Error("ignore failed", { cause: { eresult: 8 } });
  let elapsedMs = 0;
  const logger = createDiscoveryQueueLogger({
    consoleTarget,
    elapsed: () => (elapsedMs += 5),
    now: () => "2026-08-16T08:00:00.000Z",
    scriptVersion: "0.3.19",
  });
  const child = logger
    .child("prefilter", { batchId: "batch-1", queueType: 0 })
    .child("ignore", { appId: 42 });

  child.debug("started", data);
  child.info("selected", data);
  child.warn("delayed", data);
  child.error("failed", failure, data);

  assert.deepEqual(calls.map(({ level }) => level), [
    "debug",
    "info",
    "warn",
    "error",
  ]);
  for (const [index, { args }] of calls.entries()) {
    assert.match(args[0], /^\[Steam Discovery Queue\]/);
    assert.match(args[0], new RegExp(`\\[${logger.sessionId}\\]`));
    assert.match(args[0], new RegExp(`\\[#${index + 1}\\]`));
    assert.match(
      args[0],
      /\[prefilter\.ignore\.(started|selected|delayed|failed)\]$/,
    );
    assert.deepEqual(args[1], {
      appId: 42,
      batchId: "batch-1",
      elapsedMs: (index + 1) * 5,
      queueType: 0,
      scriptVersion: "0.3.19",
      timestamp: "2026-08-16T08:00:00.000Z",
    });
  }
  assert.strictEqual(calls[0].args[2], data);
  assert.strictEqual(calls[1].args[2], data);
  assert.strictEqual(calls[2].args[2], data);
  assert.strictEqual(calls[3].args[2], failure);
  assert.strictEqual(calls[3].args[3], data);
});

test("child context is captured and merged without later caller mutation", () => {
  const { calls, consoleTarget } = createConsoleRecorder();
  const parentContext = { batchId: "batch-1", queueType: 0 };
  const childContext = { appId: 42, queueType: 1 };
  const logger = createDiscoveryQueueLogger({
    consoleTarget,
    elapsed: () => 10,
    now: () => "now",
    scriptVersion: "test",
  });
  const child = logger
    .child("prefilter", parentContext)
    .child("rule", childContext);

  parentContext.batchId = "changed";
  childContext.appId = 99;
  child.info("matched");

  assert.deepEqual(calls[0].args[1], {
    appId: 42,
    batchId: "batch-1",
    elapsedMs: 10,
    queueType: 1,
    scriptVersion: "test",
    timestamp: "now",
  });
});

test("logger failures never escape into discovery queue behavior", () => {
  const throwingConsole = Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      () => {
        throw new Error(`${level} unavailable`);
      },
    ]),
  );
  const logger = createDiscoveryQueueLogger({
    consoleTarget: throwingConsole,
    elapsed: () => {
      throw new Error("timer unavailable");
    },
    now: () => {
      throw new Error("clock unavailable");
    },
    scriptVersion: "test",
  });

  assert.doesNotThrow(() => logger.nextId("batch"));
  assert.doesNotThrow(() => logger.child("prefilter", { batchId: "batch-1" }));
  assert.doesNotThrow(() => logger.debug("started", { appIds: [42] }));
  assert.doesNotThrow(() => logger.info("ready"));
  assert.doesNotThrow(() => logger.warn("delayed"));
  assert.doesNotThrow(() => logger.error("failed", new Error("failure")));
});
