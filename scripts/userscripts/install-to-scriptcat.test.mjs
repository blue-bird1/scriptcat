import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { VSCODE_SYNC_ACTIONS, startVSCodeSync } from "./scriptcat-vscode-sync.mjs";

const cliPath = fileURLToPath(new URL("./install-to-scriptcat.mjs", import.meta.url));
const websocketAcceptGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", exitCode => resolve({ exitCode, stderr, stdout }));
  });
}

function getUnusedPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const firstByte = buffer[offset];
    const secondByte = buffer[offset + 1];
    let payloadLength = secondByte & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (offset + 4 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    }
    if (offset + headerLength + payloadLength > buffer.length) break;
    frames.push({
      opcode: firstByte & 0x0f,
      payload: buffer.subarray(offset + headerLength, offset + headerLength + payloadLength),
    });
    offset += headerLength + payloadLength;
  }
  return frames;
}

function connectScriptCat(port) {
  return new Promise((resolve, reject) => {
    let response = Buffer.alloc(0);
    const key = randomBytes(16).toString("base64");
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.on("data", data => {
      response = Buffer.concat([response, data]);
    });
    socket.on("end", () => {
      try {
        const headerEnd = response.indexOf("\r\n\r\n");
        const responseHeaders = response.subarray(0, headerEnd).toString();
        const expectedAccept = createHash("sha1")
          .update(`${key}${websocketAcceptGuid}`)
          .digest("base64");
        resolve({
          frames: decodeFrames(response.subarray(headerEnd + 4)),
          responseHeaders,
          expectedAccept,
        });
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n")
      );
    });
  });
}

async function canConnect(port) {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

test("CLI help succeeds and invalid options fail", async () => {
  const help = await runCli(["--", "--help"]);
  const invalid = await runCli(["--port=not-a-port"]);

  assert.equal(help.exitCode, 0);
  assert.equal(help.stderr, "");
  assert.ok(help.stdout.length > 0);
  assert.notEqual(invalid.exitCode, 0);
});

test("one-shot sync completes the ScriptCat WebSocket protocol and releases its port", async () => {
  const directory = await mkdtemp(join(tmpdir(), "scriptcat-vscode-sync-"));
  const scriptPath = join(directory, "fixture.user.js");
  const script = "// ==UserScript==\n// ==/UserScript==\n";
  await writeFile(scriptPath, script);
  const port = await getUnusedPort();

  const sync = await startVSCodeSync({
    port,
    scriptPath,
    timeoutMs: 500,
    watch: false,
    log() {},
  });
  const connection = await connectScriptCat(port);
  await sync.completion;

  assert.match(connection.responseHeaders, /^HTTP\/1\.1 101 /);
  assert.ok(
    connection.responseHeaders
      .split("\r\n")
      .includes(`Sec-WebSocket-Accept: ${connection.expectedAccept}`)
  );
  const messages = connection.frames
    .filter(frame => frame.opcode === 1)
    .map(frame => JSON.parse(frame.payload.toString()));
  assert.equal(messages[0].action, VSCODE_SYNC_ACTIONS.hello);
  assert.deepEqual(messages[1], {
    action: VSCODE_SYNC_ACTIONS.onchange,
    data: { script, uri: pathToFileURL(scriptPath).toString() },
  });
  assert.equal(connection.frames.at(-1).opcode, 8);
  assert.equal(await canConnect(port), false);
});
