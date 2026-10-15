import { startSteamKeyToolbar } from "../userscript/steam-key-toolbar.js";

export function collectPlanetPlayKeys(root = document) {
  return Array.from(root.querySelectorAll("li")).flatMap(node => {
    const titleNode = node.querySelector("h2.notranslate");
    // 同一订单可包含多份 Key；只读取商品卡片自带的复制按钮。
    if (!titleNode) return [];
    return Array.from(node.querySelectorAll("button > span.truncate"), span => ({
      title: titleNode.textContent.trim(), key: span.textContent.trim(), node, titleNode,
    }));
  });
}

export function startPlanetPlayOrderKeys() {
  startSteamKeyToolbar({
    collectItems: collectPlanetPlayKeys,
    getAnchor: () => Array.from(document.querySelectorAll("h2")).find(h => h.textContent.trim() === "My Orders")?.parentElement,
  });
}
