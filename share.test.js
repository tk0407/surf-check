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

// 週間1ポイント分。app.js の weeklySpot が返す形のうち、共有に使う部分だけ。
// totals は7日分で、1日は [朝, 昼, 夕] の点数。null はデータの無いセル。
const WEEK_DATES = ["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23",
  "2026-09-24", "2026-09-25", "2026-09-26"];

function weekResult(name, totals) {
  return {
    spot: { name, region: "千葉北", bearing: 90 },
    days: totals.map((day, i) => ({
      date: WEEK_DATES[i],
      slots: {
        morning: day[0] === null ? null : { data: {}, scores: { total: day[0] } },
        afternoon: day[1] === null ? null : { data: {}, scores: { total: day[1] } },
        evening: day[2] === null ? null : { data: {}, scores: { total: day[2] } },
      },
      maxWaveHeight: 1.4,
      tide: [],
    })),
  };
}

// 2026-09-20 は日曜。9/22 は両ポイントともデータ無し、9/21 の夕は同点
// （並び順の先勝ちを見る）、9/24 の朝は一宮のほうが高い。
const SHIDA = weekResult("志田下",
  [[48, 30, 22], [20, 25, 41], [null, null, null], [62, 50, 44],
   [35, 33, 30], [28, 52, 40], [18, 20, 26]]);
const ICHINOMIYA = weekResult("一宮",
  [[40, 30, 20], [20, 25, 41], [null, null, null], [55, 50, 44],
   [36, 33, 30], [28, 49, 40], [24, 20, 26]]);

test("weeklyRows は各日のベストを1行ずつ返す", () => {
  const rows = Sh.weeklyRows(WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { date: "2026-09-20", slot: "morning", name: "志田下", score: 48, best: false });
  assert.deepEqual(rows[3], { date: "2026-09-23", slot: "morning", name: "志田下", score: 62, best: true });
  assert.deepEqual(rows[5], { date: "2026-09-25", slot: "afternoon", name: "志田下", score: 52, best: false });
});

test("weeklyRows は全時間帯のデータが無い日を空の行にする", () => {
  const rows = Sh.weeklyRows(WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.deepEqual(rows[2], { date: "2026-09-22", slot: null, name: null, score: null, best: false });
});

test("weeklyRows は点数が高いポイントを日ごとに選び直す", () => {
  const rows = Sh.weeklyRows(WEEK_DATES, [SHIDA, ICHINOMIYA]);
  // 9/24 の朝は 一宮36 > 志田下35
  assert.equal(rows[4].name, "一宮");
  assert.equal(rows[4].score, 36);
});

test("weeklyRows は同点なら朝・昼・夕の順で先の時間帯を採る", () => {
  const tie = weekResult("同点", [[40, 40, 40], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  const rows = Sh.weeklyRows(WEEK_DATES, [tie]);
  assert.equal(rows[0].slot, "morning");
});

test("weeklyRows は同点なら results の並び順で先のポイントを採る", () => {
  const rows = Sh.weeklyRows(WEEK_DATES, [SHIDA, ICHINOMIYA]);
  // 9/21 の夕は両方 41 点
  assert.equal(rows[1].score, 41);
  assert.equal(rows[1].slot, "evening");
  assert.equal(rows[1].name, "志田下");
});

test("weeklyRows は週で最も高い1行だけに best を立てる", () => {
  const rows = Sh.weeklyRows(WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.deepEqual(rows.map((r) => r.best), [false, false, false, true, false, false, false]);
});

test("weeklyRows は週ベストが同点なら早い日に best を立てる", () => {
  const twice = weekResult("同点", [[0, 0, 0], [70, 0, 0], [0, 0, 0], [70, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
  const rows = Sh.weeklyRows(WEEK_DATES, [twice]);
  assert.equal(rows[1].best, true);
  assert.equal(rows[3].best, false);
});

test("weeklyRows はデータが1つも無ければ best を立てない", () => {
  const empty = weekResult("無", Array.from({ length: 7 }, () => [null, null, null]));
  const rows = Sh.weeklyRows(WEEK_DATES, [empty]);
  assert.equal(rows.filter((r) => r.best).length, 0);
  assert.equal(rows.length, 7);
});

test("weeklyShareLines の1行目はエリアと期間", () => {
  const lines = Sh.weeklyShareLines("千葉北", WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.equal(lines[0], "千葉北 9/20(日)〜9/26(土)の週間予報");
});

test("weeklyShareLines は7日分を順に並べ、週ベストに★を付ける", () => {
  const lines = Sh.weeklyShareLines("千葉北", WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.deepEqual(lines.slice(1), [
    "9/20(日) 朝 志田下 48点",
    "9/21(月) 夕 志田下 41点",
    "9/22(火) データなし",
    "★9/23(水) 朝 志田下 62点",
    "9/24(木) 朝 一宮 36点",
    "9/25(金) 昼 志田下 52点",
    "9/26(土) 夕 志田下 26点",
  ]);
});

test("weeklyText は本文とURLを空行で挟んでつなぐ", () => {
  const text = Sh.weeklyText("千葉北", WEEK_DATES, [SHIDA], "https://example.test/?region=x&mode=weekly");
  const lines = Sh.weeklyShareLines("千葉北", WEEK_DATES, [SHIDA]);
  assert.equal(text, `${lines.join("\n")}\n\nhttps://example.test/?region=x&mode=weekly`);
  assert.ok(text.includes("\n\nhttps://"));
});

test("weeklyUrl は region と mode=weekly をクエリにする", () => {
  assert.equal(
    Sh.weeklyUrl("https://tk0407.github.io/surf-check/", "千葉北"),
    "https://tk0407.github.io/surf-check/?region=%E5%8D%83%E8%91%89%E5%8C%97&mode=weekly"
  );
});

test("weeklyUrl は base に付いていた既存のクエリを捨ててハッシュは残す", () => {
  assert.equal(
    Sh.weeklyUrl("https://tk0407.github.io/surf-check/?region=%E6%B9%98%E5%8D%97&date=2026-09-20&slot=morning#x", "千葉北"),
    "https://tk0407.github.io/surf-check/?region=%E5%8D%83%E8%91%89%E5%8C%97&mode=weekly#x"
  );
});

test("parseParams は modes に載っている mode を通す", () => {
  const opts = { regions: ["千葉北"], slots: ["morning"], modes: ["ranking", "weekly"] };
  assert.deepEqual(Sh.parseParams("?region=千葉北&mode=weekly", opts), { region: "千葉北", mode: "weekly" });
  assert.deepEqual(Sh.parseParams("?mode=ranking", opts), { mode: "ranking" });
});

test("parseParams は modes に無い mode を捨てる", () => {
  const opts = { regions: ["千葉北"], slots: ["morning"], modes: ["ranking", "weekly"] };
  assert.deepEqual(Sh.parseParams("?region=千葉北&mode=admin", opts), { region: "千葉北" });
  assert.deepEqual(Sh.parseParams("?mode=__proto__", opts), {});
});

test("parseParams は modes を渡さなければ mode を捨てる", () => {
  const opts = { regions: ["千葉北"], slots: ["morning"] };
  assert.deepEqual(Sh.parseParams("?region=千葉北&mode=weekly", opts), { region: "千葉北" });
});

// canvas は node に無いので、描画の呼び出しを記録する偽の2Dコンテキストで
// 確認する。measureText は「半角0.5em・全角1em」の近似で、fitText が末尾を
// 切る条件を再現できる程度の精度があればよい（実機の字幅とは一致しない）。
function fakeCanvas() {
  const calls = [];
  const ctx = {
    fillStyle: "", strokeStyle: "", font: "16px sans-serif",
    textAlign: "left", textBaseline: "alphabetic", lineWidth: 0,
    fillRect(...args) { calls.push({ op: "fillRect", args }); },
    fillText(text, x, y) {
      calls.push({ op: "fillText", text, x, y, fillStyle: this.fillStyle, font: this.font, textAlign: this.textAlign });
    },
    beginPath() { calls.push({ op: "beginPath" }); },
    moveTo(...args) { calls.push({ op: "moveTo", args }); },
    lineTo(...args) { calls.push({ op: "lineTo", args }); },
    stroke() { calls.push({ op: "stroke", strokeStyle: this.strokeStyle, lineWidth: this.lineWidth }); },
    arc(...args) { calls.push({ op: "arc", args }); },
    fill() { calls.push({ op: "fill", fillStyle: this.fillStyle }); },
    measureText(text) {
      const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)[1]);
      let width = 0;
      for (const ch of text) width += (ch.codePointAt(0) < 128 ? 0.5 : 1) * size;
      return { width };
    },
  };
  return {
    canvas: { width: 0, height: 0, getContext: () => ctx },
    calls,
    texts: () => calls.filter((c) => c.op === "fillText").map((c) => c.text),
    drawn: (text) => calls.find((c) => c.op === "fillText" && c.text === text),
  };
}

const CARD_RESULTS = [
  result("志田下", 62), result("一宮", 55),
  result("パイプライン（茅ヶ崎）", 48), result("片貝", 40),
];

function drawRanking(results) {
  const f = fakeCanvas();
  Sh.drawShareCard(f.canvas, {
    region: "千葉北", date: "2026-09-20", slot: "morning",
    rows: Sh.cardRows(results), count: results.length,
  });
  return f;
}

test("drawShareCard は1080×1080のcanvasに描く", () => {
  const f = drawRanking(CARD_RESULTS);
  assert.equal(f.canvas.width, 1080);
  assert.equal(f.canvas.height, 1080);
});

test("drawShareCard はエリア・日付・時間帯を見出しにする", () => {
  const f = drawRanking(CARD_RESULTS);
  const texts = f.texts();
  assert.equal(texts[0], "SURF CHECK");
  assert.equal(texts[1], "千葉北 / 9月20日(日)");
  assert.equal(texts[2], "朝 07-10時");
});

test("drawShareCard は上位3件の順位・名前・点数を描く", () => {
  const texts = drawRanking(CARD_RESULTS).texts();
  assert.deepEqual(texts.filter((t) => ["1", "2", "3"].includes(t)), ["1", "2", "3"]);
  assert.ok(texts.includes("志田下"));
  assert.ok(texts.includes("一宮"));
  assert.ok(texts.includes("パイプライン（茅ヶ崎）"));
  assert.ok(texts.includes("62"));
  assert.equal(texts.filter((t) => t === "/85").length, 3);
  // 4件目は載らない
  assert.ok(!texts.includes("片貝"));
});

test("drawShareCard は1位のバッジだけを塗りつぶす", () => {
  const f = drawRanking(CARD_RESULTS);
  assert.equal(f.calls.filter((c) => c.op === "arc").length, 3);
  assert.deepEqual(f.calls.filter((c) => c.op === "fill").map((c) => c.fillStyle),
    ["#124559", "#ffffff", "#ffffff"]);
});

test("drawShareCard は枠に収まらないポイント名を…で切る", () => {
  const long = result("あいうえおかきくけこさしすせそたちつてと", 62);
  const texts = drawRanking([long, result("一宮", 55), result("片貝", 48)]).texts();
  const drawnName = texts.find((t) => t.startsWith("あいうえお"));
  assert.ok(drawnName.endsWith("…"), `末尾が…で切れていない: ${drawnName}`);
  assert.ok(drawnName.length < "あいうえおかきくけこさしすせそたちつてと".length);
});

test("drawShareCard は4件以上なら「ほかN件」を描く", () => {
  assert.ok(drawRanking(CARD_RESULTS).texts().includes("ほか1件"));
});

test("drawShareCard は3件ちょうどなら「ほか」を描かない", () => {
  const texts = drawRanking(CARD_RESULTS.slice(0, 3)).texts();
  assert.equal(texts.filter((t) => t.startsWith("ほか")).length, 0);
});

test("drawShareCard はサイトのURLを右下に描く", () => {
  const f = drawRanking(CARD_RESULTS);
  const url = f.drawn("tk0407.github.io/surf-check");
  assert.equal(url.textAlign, "right");
  assert.equal(url.x, 1016);
  assert.equal(url.y, 1016);
});

test("drawShareCard は見出しの下に区切り線を引く", () => {
  const f = drawRanking(CARD_RESULTS);
  assert.ok(f.calls.some((c) => c.op === "moveTo" && c.args[0] === 64 && c.args[1] === 264));
  assert.ok(f.calls.some((c) => c.op === "lineTo" && c.args[0] === 1016 && c.args[1] === 264));
  const line = f.calls.find((c) => c.op === "stroke");
  assert.equal(line.strokeStyle, "#dce5eb");
  assert.equal(line.lineWidth, 2);
});

test("drawShareCard は見出しの色と太さを描き分ける", () => {
  const f = drawRanking(CARD_RESULTS);
  const kicker = f.drawn("SURF CHECK");
  assert.equal(kicker.fillStyle, "#007f8f");
  assert.ok(kicker.font.startsWith("800 30px"));

  const title = f.drawn("千葉北 / 9月20日(日)");
  assert.equal(title.fillStyle, "#124559");
  assert.ok(title.font.startsWith("800 54px"));

  const subtitle = f.drawn("朝 07-10時");
  assert.equal(subtitle.fillStyle, "#687481");
  assert.ok(subtitle.font.startsWith("700 38px"));
});

const WEEK_ROWS = [
  { date: "2026-09-20", slot: "morning", name: "志田下", score: 48, best: false },
  { date: "2026-09-21", slot: "evening", name: "志田下", score: 41, best: false },
  { date: "2026-09-22", slot: null, name: null, score: null, best: false },
  { date: "2026-09-23", slot: "morning", name: "パイプライン（茅ヶ崎）", score: 62, best: true },
  { date: "2026-09-24", slot: "morning", name: "一宮", score: 36, best: false },
  { date: "2026-09-25", slot: "afternoon", name: "志田下", score: 52, best: false },
  { date: "2026-09-26", slot: "evening", name: "片貝", score: 26, best: false },
];

function drawWeekly(rows, count) {
  const f = fakeCanvas();
  Sh.drawWeeklyCard(f.canvas, { region: "千葉北", dates: WEEK_DATES, rows, count });
  return f;
}

test("drawWeeklyCard は1080×1080のcanvasに描く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  assert.equal(f.canvas.width, 1080);
  assert.equal(f.canvas.height, 1080);
});

test("drawWeeklyCard はエリアと期間を見出しにする", () => {
  const texts = drawWeekly(WEEK_ROWS, 10).texts();
  assert.equal(texts[0], "SURF CHECK");
  assert.equal(texts[1], "千葉北 / 週間予報");
  assert.equal(texts[2], "9月20日(日) 〜 9月26日(土)");
});

test("drawWeeklyCard は7日分の日付を縦に並べる", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  const dates = f.calls.filter((c) => c.op === "fillText" && /^\d+\/\d+\(.\)$/.test(c.text));
  assert.deepEqual(dates.map((c) => c.text), [
    "9/20(日)", "9/21(月)", "9/22(火)", "9/23(水)", "9/24(木)", "9/25(金)", "9/26(土)",
  ]);
  // 1行96pxずつ下がり、最後の行はフッタ(y=1016)にかからない
  assert.deepEqual(dates.map((c) => c.y), [350, 446, 542, 638, 734, 830, 926]);
});

test("drawWeeklyCard は週ベストの行にだけ★を描く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  const stars = f.calls.filter((c) => c.op === "fillText" && c.text === "★");
  assert.equal(stars.length, 1);
  // 4行目(9/23)と同じ高さ
  assert.equal(stars[0].y, 638);
});

test("drawWeeklyCard はデータなしの日に点数を描かない", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  assert.ok(f.texts().includes("データなし"));
  // 点数の「/85」は7行のうちデータのある6行だけ
  assert.equal(f.texts().filter((t) => t === "/85").length, 6);
});

test("drawWeeklyCard は点数をスコア帯の色で描く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  assert.equal(f.drawn("62").fillStyle, "#1d9a72"); // good (50以上)
  assert.equal(f.drawn("48").fillStyle, "#b7791f"); // ok (30以上)
  assert.equal(f.drawn("26").fillStyle, "#b84a3c"); // bad
});

test("drawWeeklyCard は枠に収まらないポイント名を…で切る", () => {
  const rows = WEEK_ROWS.map((r, i) => (
    i === 0 ? { ...r, name: "あいうえおかきくけこさしすせそたちつてと" } : r
  ));
  const drawnName = drawWeekly(rows, 10).texts().find((t) => t.startsWith("あいうえお"));
  assert.ok(drawnName.endsWith("…"), `末尾が…で切れていない: ${drawnName}`);
});

test("drawWeeklyCard はポイント数とサイトのURLを下に描く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  const note = f.drawn("全10ポイント");
  assert.equal(note.x, 64);
  assert.equal(note.y, 1016);
  const url = f.drawn("tk0407.github.io/surf-check");
  assert.equal(url.textAlign, "right");
  assert.equal(url.y, 1016);
});

test("drawWeeklyCard は日付・時間帯・ポイント名を3つの列に分けて置く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);

  // 時間帯はテキストで選ぶ（「データなし」も時間帯列と同じxに描かれるため）。
  const slots = f.calls.filter((c) => c.op === "fillText" && ["朝", "昼", "夕"].includes(c.text));
  assert.deepEqual(slots.map((c) => c.text), ["朝", "夕", "朝", "朝", "昼", "夕"]);
  assert.ok(slots.every((c) => c.x === 294));

  const dates = f.calls.filter((c) => c.op === "fillText" && /^\d+\/\d+\(.\)$/.test(c.text));
  assert.ok(dates.every((c) => c.x === 108));

  const names = f.calls.filter((c) => c.op === "fillText"
    && ["志田下", "パイプライン（茅ヶ崎）", "一宮", "片貝"].includes(c.text));
  assert.equal(names.length, 6);
  assert.ok(names.every((c) => c.x === 354));
});

test("rankingShare は共有テキスト・URL・ファイル名をまとめて返す", () => {
  const p = Sh.rankingShare("https://tk0407.github.io/surf-check/", "千葉北", "2026-09-20", "morning", CARD_RESULTS);
  assert.equal(p.url, "https://tk0407.github.io/surf-check/?region=%E5%8D%83%E8%91%89%E5%8C%97&date=2026-09-20&slot=morning");
  assert.equal(p.headline, "千葉北 9/20(日) 朝のサーフチェック");
  assert.equal(p.text, Sh.shareText("千葉北", "2026-09-20", "morning", CARD_RESULTS, p.url));
  assert.equal(p.filename, "surf-check-千葉北-2026-09-20-morning.png");
});

test("rankingShare の draw はランキングカードを描く", () => {
  const p = Sh.rankingShare("https://tk0407.github.io/surf-check/", "千葉北", "2026-09-20", "morning", CARD_RESULTS);
  const f = fakeCanvas();
  p.draw(f.canvas);
  assert.equal(f.canvas.width, 1080);
  assert.equal(f.texts()[1], "千葉北 / 9月20日(日)");
  assert.ok(f.texts().includes("ほか1件"));
});

test("weeklyShare は共有テキスト・URL・ファイル名をまとめて返す", () => {
  const p = Sh.weeklyShare("https://tk0407.github.io/surf-check/", "千葉北", WEEK_DATES, [SHIDA, ICHINOMIYA]);
  assert.equal(p.url, "https://tk0407.github.io/surf-check/?region=%E5%8D%83%E8%91%89%E5%8C%97&mode=weekly");
  assert.equal(p.headline, "千葉北 9/20(日)〜9/26(土)の週間予報");
  assert.equal(p.text, Sh.weeklyText("千葉北", WEEK_DATES, [SHIDA, ICHINOMIYA], p.url));
  assert.equal(p.filename, "surf-check-千葉北-weekly-2026-09-20.png");
});

test("weeklyShare の draw は週間カードを描く", () => {
  const p = Sh.weeklyShare("https://tk0407.github.io/surf-check/", "千葉北", WEEK_DATES, [SHIDA, ICHINOMIYA]);
  const f = fakeCanvas();
  p.draw(f.canvas);
  assert.equal(f.canvas.width, 1080);
  assert.equal(f.texts()[1], "千葉北 / 週間予報");
  assert.ok(f.texts().includes("全2ポイント"));
});

// 0点は実在する（岸向きの強風・短周期・ベタ凪の日は合計0点になる）。
// 欠測を表す null と取り違えると、実際には出ている予報が「データなし」に
// 化けるので、3か所すべての 0 と null の境界を固定しておく。
test("weeklyRows は0点の日を欠測として捨てず、全日0点でも週ベストを1つ立てる", () => {
  const flat = weekResult("ベタ凪", Array.from({ length: 7 }, () => [0, 0, 0]));
  const rows = Sh.weeklyRows(WEEK_DATES, [flat]);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows[0], { date: "2026-09-20", slot: "morning", name: "ベタ凪", score: 0, best: true });
  assert.equal(rows.filter((r) => r.best).length, 1);
});

test("weeklyShareLines は0点の日を「データなし」にせず0点と書く", () => {
  const mixed = weekResult("ベタ凪", [
    [0, 0, 0], [40, 20, 10], [null, null, null],
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0],
  ]);
  const lines = Sh.weeklyShareLines("千葉北", WEEK_DATES, [mixed]);
  assert.equal(lines[1], "9/20(日) 朝 ベタ凪 0点");
  assert.equal(lines[2], "★9/21(月) 朝 ベタ凪 40点");
  assert.equal(lines[3], "9/22(火) データなし");
});

test("drawWeeklyCard は0点の行を「データなし」にせず0点として描く", () => {
  const rows = [
    { date: "2026-09-20", slot: "morning", name: "ベタ凪", score: 0, best: false },
    ...WEEK_ROWS.slice(1),
  ];
  const f = drawWeekly(rows, 1);
  const zero = f.drawn("0");
  assert.ok(zero, "0点が点数として描かれていない");
  assert.equal(zero.fillStyle, "#b84a3c"); // scoreBand(0) は "bad"
  // 「データなし」は欠測の 9/22 の1行だけ。0点の行が混ざってはいけない。
  assert.equal(f.texts().filter((t) => t === "データなし").length, 1);
  // 0点の行も時間帯の列を描く（欠測の分岐に入っていない証拠）。
  assert.equal(f.texts().filter((t) => t === "朝").length, 3);
});
