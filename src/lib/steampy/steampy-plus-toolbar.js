const TOOLBAR_ATTRIBUTE = "data-steam-py-plus-buyer-toolbar";
const TOOLBAR_SELECTOR = `[${TOOLBAR_ATTRIBUTE}]`;
const STYLE_ID = "steamPyPlusBuyerToolbarStyle";
const TOOLBAR_STYLE = `
  ${TOOLBAR_SELECTOR} {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    column-gap: .12rem;
    align-items: center;
  }

  ${TOOLBAR_SELECTOR} > .tag {
    position: static;
    grid-area: 1 / 1;
    margin-left: .2rem;
  }

  ${TOOLBAR_SELECTOR} > .title {
    grid-area: 1 / 1 / 2 / 3;
    pointer-events: none;
  }

  ${TOOLBAR_SELECTOR} > .searchCDK {
    position: static;
    grid-area: 1 / 2;
    min-width: 0;
    max-width: 100%;
    justify-self: end;
  }

  ${TOOLBAR_SELECTOR} > .searchCDK > .flex-row {
    max-width: 100%;
  }

  ${TOOLBAR_SELECTOR} > .searchCDK .ivu-input-wrapper {
    min-width: 0;
  }

  ${TOOLBAR_SELECTOR} > .searchCDK > .flex-row > :is(.f12-rem, button) {
    flex-shrink: 0;
    white-space: nowrap;
  }
`;

export function mountSteamPyBuyerToolbar() {
  const toolbar = document.querySelector(".tag.flex-row.align-items-center")?.parentElement;
  if (!toolbar?.querySelector(":scope > .searchCDK")) return;

  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = TOOLBAR_STYLE;
    document.head.appendChild(style);
  }

  if (toolbar.hasAttribute(TOOLBAR_ATTRIBUTE)) return;
  toolbar.setAttribute(TOOLBAR_ATTRIBUTE, "");
  console.info({
    time: new Date().toISOString(),
    level: "info",
    event: "buyer_toolbar_layout_mounted",
    href: location.href,
  });
}
