export function log(level, event, runId, details = {}) {
  console[level](JSON.stringify({
    timestamp: new Date().toISOString(), level, event, runId, ...details,
  }));
}

export function logError(event, runId, error, details = {}) {
  log("error", event, runId, {
    ...details,
    message: error.message,
    stack: error.stack,
    requestId: error.requestId,
    status: error.status,
    response: error.response,
  });
}
