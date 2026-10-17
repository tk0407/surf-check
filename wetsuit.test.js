const test = require("node:test");
const assert = require("node:assert/strict");
const Wetsuit = require("./wetsuit.js");

const DRY = { key: "dry", name: "ドライ", note: "＋ブーツ・グローブ・キャップ" };
const SEMIDRY = { key: "semidry", name: "セミドライ", note: "＋ブーツ・グローブ" };
const FULL_CHILLY = { key: "full", name: "フルスーツ", note: "寒がりなら5/3セミドライ" };
const FULL = { key: "full", name: "フルスーツ", note: "" };
const SEAGULL = { key: "seagull", name: "シーガル", note: "" };
const SPRING = { key: "spring", name: "スプリング", note: "" };
const TRUNKS = { key: "trunks", name: "海パン", note: "" };

test("each band of the table switches suit at its boundary temperature", () => {
  const cases = [
    [11, DRY], [12, SEMIDRY],
    [15, SEMIDRY], [16, FULL_CHILLY],
    [18, FULL_CHILLY], [19, FULL],
    [21, FULL], [22, SEAGULL],
    [23, SEAGULL], [24, SPRING],
    [25, SPRING], [26, TRUNKS],
  ];
  for (const [temp, suit] of cases) {
    assert.deepEqual(Wetsuit.recommend(temp), { temp, ...suit }, `${temp}℃`);
  }
});

test("the temperature is rounded first, and the rounded value is what gets shown", () => {
  assert.deepEqual(Wetsuit.recommend(21.49), { temp: 21, ...FULL });
  assert.deepEqual(Wetsuit.recommend(21.5), { temp: 22, ...SEAGULL });
  assert.deepEqual(Wetsuit.recommend(15.5), { temp: 16, ...FULL_CHILLY });
  assert.deepEqual(Wetsuit.recommend(25.5), { temp: 26, ...TRUNKS });
  assert.deepEqual(Wetsuit.recommend(11.4), { temp: 11, ...DRY });
});

test("temperatures far outside Japan's range still land in the end bands", () => {
  assert.deepEqual(Wetsuit.recommend(-1.2), { temp: -1, ...DRY });
  assert.deepEqual(Wetsuit.recommend(0), { temp: 0, ...DRY });
  assert.deepEqual(Wetsuit.recommend(34.6), { temp: 35, ...TRUNKS });
});

test("a missing or non-numeric temperature gives no recommendation", () => {
  for (const temp of [null, undefined, NaN, Infinity, -Infinity, "23", {}]) {
    assert.equal(Wetsuit.recommend(temp), null, String(temp));
  }
});
