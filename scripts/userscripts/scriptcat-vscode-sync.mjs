import { createHash, randomBytes } from "node:crypto";
import { readFileSync, unwatchFile, watchFile } from "node:fs";
import { createServer } from "node:http";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const VSCODE_SYNC_ACTIONS = Object.freeze({
  hello: "hello",
  onchange: "onchange",
});

const WEBSOCKET_ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frameText(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const header = [0x81];

  if (data.length < 126) {
    header.push(data.length);
  } else if (data.length < 65_536) {
    header.push(126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    const high = Math.floor(data.length / 2 ** 32);
    const low = data.length >>> 0;
    header.push(
      127,
      (high >> 24) & 0xff,
      (high >> 16) & 0xff,
      (high >> 8) & 0xff,
      high & 0xff,
      (low >> 24) & 0xff,
      (low >> 16) & 0xff,
      (low >> 8) & 0xff,
      low & 0xff
    );
  }

  return Buffer.concat([Buffer.from(header), data]);
}

function send(socket, message) {
  socket.write(frameText(message));
}

function acceptWebSocket(request, socket) {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return false;
  }

  const accept = createHash("sha1")
    .update(`${key}${WEBSOCKET_ACCEPT_GUID}`)
    .digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n")
  );
  return true;
}

function createPublisher(scriptPath, log) {
  const scriptUri = pathToFileURL(scriptPath).toString();

  return socket => {
    const script = readFileSync(scriptPath, "utf8");
    send(socket, {
      action: VSCODE_SYNC_ACTIONS.onchange,
      data: { script, uri: scriptUri },
    });
    log(`Published ${basename(scriptPath)} to ScriptCat via ${scriptUri}`);
  };
}

/**
 * Start the loopback WebSocket endpoint used by ScriptCat's VSCode sync feature.
 * The returned completion promise resolves only after the listening socket, clients,
 * file watcher, and one-shot timeout have all been released.
 */
export async function startVSCodeSync({ port, scriptPath, timeoutMs, watch, log = console.log }) {
  const clients = new Set();
  const server = createServer((request, response) => {
    response.writeHead(404);
    response.end();
  });
  const publish = createPublisher(scriptPath, log);
  let connectionTimeout;
  let closing = false;
  let rejectCompletion;
  let resolveCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const close = async error => {
    if (closing) {
      return completion;
    }
    closing = true;
    clearTimeout(connectionTimeout);
    unwatchFile(scriptPath);

    for (const socket of clients) {
      if (!socket.destroyed) {
        socket.end(Buffer.from([0x88, 0x00]));
      }
    }

    await new Promise(resolve => server.close(resolve));
    if (error) {
      rejectCompletion(error);
    } else {
      resolveCompletion();
    }
    return completion;
  };

  server.on("error", error => {
    void close(error);
  });

  server.on("upgrade", (request, socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    if (!acceptWebSocket(request, socket)) {
      return;
    }

    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
    socket.on("data", () => {});

    try {
      send(socket, {
        action: VSCODE_SYNC_ACTIONS.hello,
        nonce: randomBytes(4).toString("hex"),
      });
      publish(socket);
    } catch (error) {
      socket.destroy();
      void close(error);
      return;
    }

    if (!watch) {
      void close();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

  if (watch) {
    watchFile(scriptPath, { interval: 500 }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) {
        return;
      }
      for (const socket of clients) {
        try {
          publish(socket);
        } catch (error) {
          log(`Unable to publish ${scriptPath}: ${error.message}`);
        }
      }
    });
  } else if (timeoutMs > 0) {
    connectionTimeout = setTimeout(() => {
      void close(new Error(`Timed out waiting for ScriptCat after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return { close, completion };
}
