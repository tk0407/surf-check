const test = require("node:test");
const assert = require("node:assert/strict");
const Sh = require("./share.js");

// ランキング1件分。app.js の rankSpot が返す形のうち、共有に使う部分だけ。
// bearing 90 (東向きの浜) に対し wind_dir 225 (南西) はサイドオフになる。
function result(name, total, over) {
  return {
    spot: { name, region: "千葉北", bearing: 90, ...(over && over.spot) },
    scores: { total },
    data: {
      wave_height: 1.4, swell_period: 8.0, wind_dir: 225,
      wind_speed: 5.5, swell_dir: 135, ...(over && over.data),
    },
  };
}

test("jpDirection は8方位の日本語を返す", () => {
  assert.equal(Sh.jpDirection(0), "北");
  assert.equal(Sh.jpDirection(45), "北東");
  assert.equal(Sh.jpDirection(180), "南");
  assert.equal(Sh.jpDirection(315), "北西");
});

test("jpDirection は境界の角度を次の方位に入れる", () => {
  assert.equal(Sh.jpDirection(22.4), "北");
  assert.equal(Sh.jpDirection(22.5), "北東");
  assert.equal(Sh.jpDirection(337.5), "北");
});

test("jpDirection は360度を超える値と負の値を正規化する", () => {
  assert.equal(Sh.jpDirection(405), "北東");
  assert.equal(Sh.jpDirection(-45), "北西");
});

test("windConditionLabel は岸の向きに対する風の角度で決まる", () => {
  // bearing 90 (東向きの浜) の沖向きは西風 (270)
  assert.equal(Sh.windConditionLabel(270, 5, 90), "オフショア");
  assert.equal(Sh.windConditionLabel(225, 5, 90), "サイドオフ");
  assert.equal(Sh.windConditionLabel(180, 5, 90), "サイド");
  assert.equal(Sh.windConditionLabel(135, 5, 90), "サイドオン");
  assert.equal(Sh.windConditionLabel(90, 5, 90), "オンショア");
});

test("windConditionLabel は弱いオフショアを区別する", () => {
  assert.equal(Sh.windConditionLabel(270, 3, 90), "オフ弱");
  assert.equal(Sh.windConditionLabel(270, 3.1, 90), "オフショア");
});

test("mdLabel は月日と曜日を返す", () => {
  assert.equal(Sh.mdLabel("2026-09-20"), "9/20(日)");
  assert.equal(Sh.mdLabel("2026-01-01"), "1/1(木)");
});

test("dateParts は月・日・曜日に分ける", () => {
  assert.deepEqual(Sh.dateParts("2026-09-20"), { month: 9, day: 20, weekday: "日" });
});

test("cardRows は上位3件までに切る", () => {
  const rows = Sh.cardRows([
    result("飯岡", 54), result("一宮", 51), result("木戸", 47), result("太東", 44),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.name), ["飯岡", "一宮", "木戸"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3]);
});

test("cardRows は件数が3件未満ならその数だけ返す", () => {
  assert.equal(Sh.cardRows([result("飯岡", 54)]).length, 1);
  assert.equal(Sh.cardRows([]).length, 0);
});

test("cardRows は波と風を画面と同じ文字列に整える", () => {
  const rows = Sh.cardRows([result("飯岡", 54)]);
  assert.equal(rows[0].score, 54);
  assert.equal(rows[0].wave, "1.4m カタ〜アタマ");
  assert.equal(rows[0].wind, "南西 5.5m/s サイドオフ");
});

test("cardRows は小数を1桁に丸める", () => {
  const rows = Sh.cardRows([
    result("飯岡", 54, { data: { wave_height: 2.06, wind_speed: 4.98 } }),
  ]);
  assert.equal(rows[0].wave, "2.1m オーバーヘッド");
  assert.equal(rows[0].wind, "南西 5.0m/s サイドオフ");
});
