import assert from "node:assert/strict";
import test from "node:test";

class FakeElement {
  constructor(rect = { left: 0, right: 0, width: 0 }) {
    this.rect = rect;
    this.parentElement = undefined;
    this.children = [];
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getClientRects() {
    return [this.rect];
  }
}

class FakeHTMLElement extends FakeElement {}
class FakeHTMLAnchorElement extends FakeHTMLElement {}

globalThis.Element = FakeElement;
globalThis.HTMLElement = FakeHTMLElement;
globalThis.HTMLAnchorElement = FakeHTMLAnchorElement;
globalThis.getComputedStyle = () => ({ visibility: "visible" });

const { getModalContinueButton } = await import(
  "../../src/lib/steam/discovery-queue-auto-filter.js"
);

function createModalFixture(summaryRect) {
  const dialog = new FakeHTMLElement({ left: 0, right: 1000, width: 1000 });
  const wishlistLink = new FakeHTMLAnchorElement();
  const ignoredLink = new FakeHTMLAnchorElement();
  const wishlistStatistic = new FakeHTMLElement();
  const ignoredStatistic = new FakeHTMLElement();
  const statisticsRoot = new FakeHTMLElement();
  const summaryContent = new FakeHTMLElement();
  const summaryCard = new FakeHTMLElement(summaryRect);
  const actionParent = new FakeHTMLElement();
  const doneButton = new FakeHTMLElement();
  const continueButton = new FakeHTMLElement();

  wishlistLink.parentElement = wishlistStatistic;
  ignoredLink.parentElement = ignoredStatistic;
  wishlistStatistic.parentElement = statisticsRoot;
  ignoredStatistic.parentElement = statisticsRoot;
  statisticsRoot.parentElement = summaryContent;
  statisticsRoot.nextElementSibling = actionParent;
  summaryContent.parentElement = summaryCard;
  actionParent.parentElement = summaryContent;
  actionParent.children = [doneButton, continueButton];
  summaryCard.matches = (selector) => selector === '[role="button"][tabindex="0"]';
  dialog.querySelector = (selector) => {
    if (selector.includes("/wishlist")) {
      return wishlistLink;
    }
    if (selector.includes("/account/notinterested")) {
      return ignoredLink;
    }
    return undefined;
  };
  globalThis.document = {
    querySelector: () => dialog,
  };

  return { continueButton };
}

test("does not continue from an offscreen pre-rendered summary card", () => {
  createModalFixture({ left: 1000, right: 1800, width: 800 });

  assert.equal(getModalContinueButton(), undefined);
});

test("continues when the summary card is the centered carousel item", () => {
  const { continueButton } = createModalFixture({ left: 100, right: 900, width: 800 });

  assert.equal(getModalContinueButton(), continueButton);
});
