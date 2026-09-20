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

test("shareLines の1行目はエリア・日付・時間帯", () => {
  const lines = Sh.shareLines("千葉北", "2026-09-20", "morning", [result("飯岡", 54)]);
  assert.equal(lines[0], "千葉北 9/20(日) 朝のサーフチェック");
});

test("shareLines は時間帯を朝・昼・夕で書き分ける", () => {
  const r = [result("飯岡", 54)];
  assert.ok(Sh.shareLines("千葉北", "2026-09-20", "afternoon", r)[0].includes("昼のサーフチェック"));
  assert.ok(Sh.shareLines("千葉北", "2026-09-20", "evening", r)[0].includes("夕のサーフチェック"));
});

test("shareLines は上位3件を順位付きで並べる", () => {
  const lines = Sh.shareLines("千葉北", "2026-09-20", "morning", [
    result("飯岡", 54), result("一宮", 51), result("木戸", 47), result("太東", 44),
  ]);
  assert.equal(lines.length, 4);
  assert.equal(lines[1], "1位 飯岡 54点（1.4m / 南西5.5m/s サイドオフ）");
  assert.equal(lines[3], "3位 木戸 47点（1.4m / 南西5.5m/s サイドオフ）");
});

test("shareLines は1件だけでも成立する", () => {
  const lines = Sh.shareLines("茨城", "2026-09-20", "morning", [result("飯岡", 54)]);
  assert.equal(lines.length, 2);
});

test("shareText は本文とURLを空行で挟んでつなぐ", () => {
  const text = Sh.shareText("千葉北", "2026-09-20", "morning", [result("飯岡", 54)], "https://example.test/?x=1");
  assert.equal(
    text,
    "千葉北 9/20(日) 朝のサーフチェック\n1位 飯岡 54点（1.4m / 南西5.5m/s サイドオフ）\n\nhttps://example.test/?x=1"
  );
});

test("shareUrl は3つの条件をクエリにする", () => {
  const url = Sh.shareUrl("https://example.test/surf/", "千葉北", "2026-09-20", "morning");
  assert.equal(url, "https://example.test/surf/?region=%E5%8D%83%E8%91%89%E5%8C%97&date=2026-09-20&slot=morning");
});

test("shareUrl は base に付いていた既存のクエリを捨てる", () => {
  const url = Sh.shareUrl("https://example.test/surf/?old=1", "茨城", "2026-09-21", "evening");
  assert.ok(!url.includes("old=1"));
  assert.ok(url.includes("region=%E8%8C%A8%E5%9F%8E"));
  assert.ok(url.includes("slot=evening"));
});

const OPTS = {
  regions: ["千葉北", "千葉南", "千葉", "湘南", "茨城", "全域"],
  slots: ["morning", "afternoon", "evening"],
};

test("parseParams は3つ揃ったクエリをそのまま返す", () => {
  const got = Sh.parseParams("?region=%E5%8D%83%E8%91%89%E5%8C%97&date=2026-09-20&slot=morning", OPTS);
  assert.deepEqual(got, { region: "千葉北", date: "2026-09-20", slot: "morning" });
});

test("parseParams は一覧に無いエリアだけを捨てて残りは通す", () => {
  const got = Sh.parseParams("?region=%E3%83%8F%E3%83%AF%E3%82%A4&date=2026-09-20&slot=morning", OPTS);
  assert.deepEqual(got, { date: "2026-09-20", slot: "morning" });
});

test("parseParams は過去の日付をそのまま通す", () => {
  assert.equal(Sh.parseParams("?date=2020-01-01", OPTS).date, "2020-01-01");
});

test("parseParams は未来の日付をそのまま通す", () => {
  assert.equal(Sh.parseParams("?date=2030-12-31", OPTS).date, "2030-12-31");
});

test("parseParams は形式の違う日付を捨てる", () => {
  assert.deepEqual(Sh.parseParams("?date=2026-9-1", OPTS), {});
  assert.deepEqual(Sh.parseParams("?date=20260920", OPTS), {});
  assert.deepEqual(Sh.parseParams("?date=hello", OPTS), {});
});

test("parseParams は実在しない日付を捨てる", () => {
  assert.deepEqual(Sh.parseParams("?date=2026-13-45", OPTS), {});
  assert.deepEqual(Sh.parseParams("?date=2026-02-30", OPTS), {});
});

test("parseParams は不正な時間帯を捨てる", () => {
  assert.deepEqual(Sh.parseParams("?slot=midnight", OPTS), {});
});

test("parseParams はクエリが無ければ空オブジェクトを返す", () => {
  assert.deepEqual(Sh.parseParams("", OPTS), {});
  assert.deepEqual(Sh.parseParams("?", OPTS), {});
});
