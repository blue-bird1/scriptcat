import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { parseHTML } from "linkedom";

// 集成正确性：DOM 结构来自 2026-10-15 的真实 PlanetPlay 订单页。
// 仅将真实 Key 替换为测试值；不连接站点或 Steam，不消费 Key。
const planetHtml = `<!doctype html><html><body>
  <div><h2>My Orders</h2><button>Refresh</button></div>
  <ul>
    <li><div><h2 class="notranslate text-t2">Assetto Corsa Competizione</h2>
      <div><div><button><svg></svg><span class="ml-3 w-full truncate">ABCDE-12345-FGHIJ</span></button>
      <a href="/cn/store/games/6ac4f673b028f9a1ac02c469/?redeem=true">How to redeem</a></div></div>
    </div></li>
    <li><div><h2 class="notranslate text-t2">Blue Prince</h2>
      <div><div><button><svg></svg><span class="ml-3 w-full truncate">KLMNO-67890-PQRST</span></button>
      <a href="/cn/store/games/6ac4d645b028f9a1ac02c3f6/?redeem=true">How to redeem</a></div></div>
    </div></li>
  </ul>
</body></html>`;

async function harness(script, html) {
  const { window, document } = parseHTML(html);
  const copies = [];
  const confirmations = [];
  const requests = [];
  window.confirm = message => { confirmations.push(message); return false; };
  const source = await readFile(new URL(`../../${script}`, import.meta.url), "utf8");
  runInNewContext(source, {
    window, document, MutationObserver: window.MutationObserver, crypto: webcrypto,
    location: { href: "https://planetplay.com/cn/orders/" },
    console: { info() {}, error() {} }, setTimeout,
    GM_addStyle() {},
    GM_setClipboard: (text, type) => copies.push({ text, type }),
    GM_xmlhttpRequest: options => requests.push(options),
  });
  await setImmediate();
  const toolbar = () => document.querySelector("#scriptcat-steam-key-toolbar");
  const status = () => toolbar().querySelector('[role="status"]').textContent;
  const click = text => [...toolbar().querySelectorAll("button")].find(b => b.textContent === text).click();
  return { document, copies, confirmations, requests, toolbar, status, click };
}

test("PlanetPlay copies displayed keys with matching titles and requires activation confirmation", async () => {
  const page = await harness("planetplay-order-keys.user.js", planetHtml);
  assert.equal(page.status(), "检测到 2 个 Steam Key");
  page.click("复制全部 Key");
  page.click("复制标题 + Key");
  assert.deepEqual(page.copies, [
    { text: "ABCDE-12345-FGHIJ\nKLMNO-67890-PQRST", type: "text" },
    { text: "Assetto Corsa Competizione\tABCDE-12345-FGHIJ\nBlue Prince\tKLMNO-67890-PQRST", type: "text" },
  ]);
  page.click("激活全部");
  assert.deepEqual(page.confirmations, ["将向当前登录的 Steam 账号提交 2 个 Key。确认激活？"]);
  assert.deepEqual(page.requests, []);
});

test("PlanetPlay observes asynchronous order loading and refresh without duplicating its toolbar", async () => {
  const page = await harness("planetplay-order-keys.user.js", "<!doctype html><html><body></body></html>");
  assert.equal(page.toolbar(), null);
  page.document.body.innerHTML = parseHTML(planetHtml).document.body.innerHTML;
  await setImmediate();
  assert.equal(page.status(), "检测到 2 个 Steam Key");
  page.document.querySelector("body > ul").replaceChildren();
  await setImmediate();
  assert.equal(page.status(), "检测到 0 个 Steam Key");
  page.click("复制全部 Key");
  assert.deepEqual(page.copies, []);
  assert.equal(page.status(), "没有找到已显示的 Steam Key，请先在站点展开或领取 Key");
  assert.equal(page.document.querySelectorAll("#scriptcat-steam-key-toolbar").length, 1);
});

test("GMG adapter preserves key and title copying through the shared toolbar", async () => {
  const page = await harness("greenmangaming-bundle-claim.user.js", `<!doctype html><html><body>
    <section id="keys-section"><div class="item-list-wrapper">
      <div class="item-list"><div class="title"><h3>Blue Prince</h3></div>
        <button class="copy-key-btn" data-key="KLMNO-67890-PQRST">Copy</button>
      </div>
    </div></section>
  </body></html>`);
  page.click("复制标题 + Key");
  assert.deepEqual(page.copies, [{ text: "Blue Prince\tKLMNO-67890-PQRST", type: "text" }]);
  assert.deepEqual(page.requests, []);
});
