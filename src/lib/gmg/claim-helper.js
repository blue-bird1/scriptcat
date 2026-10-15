import { startSteamKeyToolbar } from "../userscript/steam-key-toolbar.js";

export function startGmgBundleClaimHelper() {
  startSteamKeyToolbar({
    collectItems: () => Array.from(document.querySelectorAll("#keys-section .item-list")).map(node => {
      const titleNode = node.querySelector("h3");
      return { node, titleNode, title: titleNode?.textContent.trim() || "", key: node.querySelector(".copy-key-btn[data-key]")?.dataset.key || "" };
    }),
    getAnchor: () => document.querySelector("#keys-section .item-list-wrapper") || document.querySelector("#keys-section > :first-child"),
  });
}
