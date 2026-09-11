const LOG_ID = "steamdb-open-steam-store";
const STEAM_APP_URL = "https://store.steampowered.com/app/";

function logEvent(level, event, fields) {
  console[level]({
    ts: new Date().toISOString(),
    id: LOG_ID,
    level,
    event,
    ...fields,
  });
}

function parseAppId(value) {
  if (typeof value !== "string") {
    return null;
  }
  const appId = value.trim();
  return /^\d+$/.test(appId) ? appId : null;
}

export function resolveSteamAppId(target) {
  if (!(target instanceof Element)) {
    return null;
  }

  const hitItem = target.closest("li.ais-Hits-item");
  if (hitItem) {
    return parseAppId(hitItem.querySelector("a[data-appid]")?.getAttribute("data-appid"));
  }

  const saleRow = target.closest("table.table-sales tr[data-appid]");
  if (saleRow) {
    return parseAppId(saleRow.getAttribute("data-appid"));
  }

  const appLink = target.closest("a.app[data-appid]");
  if (appLink) {
    return parseAppId(appLink.getAttribute("data-appid"));
  }

  return null;
}

function openSteamStore(appId) {
  const url = `${STEAM_APP_URL}${appId}/`;
  const tab = window.open(url, "_blank");
  if (tab) {
    logEvent("info", "steam_store_opened", { appId, url });
    return;
  }
  logEvent("error", "steam_store_popup_blocked", { appId, url });
}

function handlePointerEvent(event) {
  if (event.button !== 1) {
    return;
  }
  if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) {
    return;
  }

  const appId = resolveSteamAppId(event.target);
  if (!appId) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  if (event.type === "mousedown") {
    openSteamStore(appId);
  }
}

export function startSteamdbOpenSteamStore() {
  document.addEventListener("mousedown", handlePointerEvent, true);
  document.addEventListener("auxclick", handlePointerEvent, true);
  logEvent("info", "script_started", { href: location.href });
}
