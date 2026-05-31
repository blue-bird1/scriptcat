/* global GM_addStyle */

export const ISBN_MISSING_STYLE = `
        z-bookcard.isbn-missing-highlight {
            outline: 3px solid rgba(255,0,0,0.85);
            box-shadow: 0 0 10px rgba(255,0,0,0.35);
            position: relative;
        }
        z-bookcard.isbn-missing-highlight::after {
            content: "缺失 ISBN";
            color: #fff;
            background: rgba(255,0,0,0.85);
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 3px;
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 9999;
        }
    `;

export function startZlibIsbnHighlight() {
  GM_addStyle(ISBN_MISSING_STYLE);

  function isIsbnMissing(el) {
    if (!el) {
      return false;
    }
    const v = el.getAttribute("isbn");
    return v === null || String(v).trim().length === 0;
  }

  function checkAndHighlight(node) {
    if (!node) {
      return;
    }
    if (node.nodeType === 1 && node.tagName.toLowerCase() === "z-bookcard") {
      if (isIsbnMissing(node)) {
        node.classList.add("isbn-missing-highlight");
        node.setAttribute("data-isbn-missing", "1");
      } else {
        node.classList.remove("isbn-missing-highlight");
        node.removeAttribute("data-isbn-missing");
      }
    }
  }

  function scanExisting() {
    document.querySelectorAll("z-bookcard").forEach(checkAndHighlight);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "childList" && m.addedNodes.length) {
        m.addedNodes.forEach((node) => checkAndHighlight(node));
      } else if (m.type === "attributes" && m.attributeName === "isbn") {
        checkAndHighlight(m.target);
      }
    }
  });

  observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["isbn"] });

  scanExisting();
}
