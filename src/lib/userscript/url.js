export function isValidHostname(hostname) {
  const host = (hostname || "").trim().toLowerCase();
  if (!host || host.includes("://") || host.includes("/") || host.includes(":")) {
    return false;
  }
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);
}

export function normalizeHostname(hostname) {
  const host = (hostname || "").trim().toLowerCase();
  return isValidHostname(host) ? host : "";
}
