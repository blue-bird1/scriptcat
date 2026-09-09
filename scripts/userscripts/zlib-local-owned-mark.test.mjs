import assert from "node:assert/strict";
import test from "node:test";

import {
  authorsMatch,
  bookMatches,
  cleanAuthor,
  parseOwnedLine,
  parseOwnedLines,
} from "../../src/lib/zlib/owned-booklist.js";

test("pipe lines stay 书名 | 作者", () => {
  assert.deepEqual(parseOwnedLine("足球潜规则 | （英）克雷格·麦盖尔"), {
    book: { title: "足球潜规则", author: "克雷格·麦盖尔" },
    reason: null,
  });
});

test("filename lines from the local booklist become title and author", () => {
  const samples = [
    [
      "足球潜规则---（英）克雷格·麦盖尔（Craig McGill）著；谷兴译---哈尔滨出版社---2004---11432193.epub",
      { title: "足球潜规则", author: "克雷格·麦盖尔（Craig McGill）著；谷兴译" },
    ],
    [
      "整合运动与运动营养学：健康促进表现之视角---Integrative Sport and Exercise Nutrition---（英）Ian Craig, Justin Roberts---2026.epub",
      {
        title: "整合运动与运动营养学：健康促进表现之视角",
        foreignTitle: "Integrative Sport and Exercise Nutrition",
        author: "Ian Craig, Justin Roberts",
      },
    ],
    [
      "耐力：循环训练---La resistencia circuitos de entrenamiento---（西）Díaz Infantes etc.---2021.pdf",
      { title: "耐力：循环训练", foreignTitle: "La resistencia circuitos de entrenamiento", author: "Díaz Infantes etc." },
    ],
    [
      "足球与法---李一---中国政法大学出版社---2020---.epub",
      { title: "足球与法", author: "李一" },
    ],
    [
      "角球---Eckball---Donaubauer, Stefan---2013.epub",
      { title: "角球", foreignTitle: "Eckball", author: "Donaubauer, Stefan" },
    ],
    [
      "加林查---Garrincha---Ugo Riccarelli---2013.epub",
      { title: "加林查", foreignTitle: "Garrincha", author: "Ugo Riccarelli" },
    ],
    [
      "少年足球技巧---福西崇史---少年サッカーのテクニック---2013-09---.pdf",
      { title: "少年足球技巧", foreignTitle: "少年サッカーのテクニック", author: "福西崇史" },
    ],
    [
      "外语学习的真实方法及误区分析---漏屋---.epub",
      { title: "外语学习的真实方法及误区分析", author: "漏屋" },
    ],
    [
      "目标与梦想：加拿大女足庆典---Goals and dreams _ a celebration of Canadian women's soccer -- Brødsgaard, Shel, Mackin, Bob---2005.pdf",
      {
        title: "目标与梦想：加拿大女足庆典",
        foreignTitle: "Goals and dreams _ a celebration of Canadian women's soccer",
        author: "Brødsgaard, Shel, Mackin, Bob",
      },
    ],
    [
      "执教蒂基塔卡风格---Coaching the Tiki Taka style of play -- （威尔士）Davies, Jed C---2013.pdf",
      { title: "执教蒂基塔卡风格", foreignTitle: "Coaching the Tiki Taka style of play", author: "Davies, Jed C" },
    ],
    [
      "玛塔---Marta -- David Machajewski -- Rosen Publishing Group---2019.pdf",
      { title: "玛塔", foreignTitle: "Marta", author: "David Machajewski" },
    ],
  ];
  for (const [line, book] of samples) {
    assert.deepEqual(parseOwnedLine(line), { book, reason: null }, line);
  }
});

test("filename lines without an author are skipped", () => {
  assert.equal(parseOwnedLine("西班牙语习字帖.pdf").reason, "missing-author");
  assert.equal(parseOwnedLine("01---射门训练---Torschusstraining---.pdf").reason, "missing-author");
});

test("nationality prefixes and comma order still match card authors", () => {
  assert.equal(authorsMatch("（英）Ian Craig, Justin Roberts", "Ian Craig"), true);
  assert.equal(authorsMatch("Donaubauer, Stefan", "Donaubauer"), true);
  assert.equal(authorsMatch("Brødsgaard, Shel, Mackin, Bob", "Shel"), true);
});

test("parseOwnedLines keeps pipe and filename rows together", () => {
  const text = [
    "足球潜规则 | 克雷格·麦盖尔",
    "足球与法---李一---中国政法大学出版社---2020---.epub",
    "西班牙语习字帖.pdf",
  ].join("\n");
  const parsed = parseOwnedLines(text);
  assert.deepEqual(parsed.books, [
    { title: "足球潜规则", author: "克雷格·麦盖尔" },
    { title: "足球与法", author: "李一" },
  ]);
  assert.equal(parsed.skippedLines.length, 1);
  assert.equal(parsed.skippedLines[0].reason, "missing-author");
});

test("dual titles match either Chinese or foreign card title", () => {
  const parsed = parseOwnedLine("加林查 | Garrincha | Ugo Riccarelli");
  assert.deepEqual(parsed.book, { title: "加林查", foreignTitle: "Garrincha", author: "Ugo Riccarelli" });
  assert.equal(bookMatches({ title: "Garrincha", author: "Ugo Riccarelli" }, parsed.book), true);
  assert.equal(cleanAuthor("（英）Ian Craig"), "Ian Craig");
});
