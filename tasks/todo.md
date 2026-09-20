# 週間予報の共有（LINE・画像）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 週間予報タブの結果を、ランキングと同じように LINE のテキストと 1080×1080 の画像カードで共有できるようにする。

**Architecture:** 共有の単位は「各日のベスト（ポイント＋時間帯＋点数）を7行」。`share.js` に週間用の純関数（行の組み立て・テキスト・URL・カード描画）を足し、`app.js` は共有の導線を `payload` 駆動に一本化して、ランキングと週間の両方が同じ `wireShareRow` を通るようにする。共有URLは `?region=...&mode=weekly` で、`mode` が無いURLは従来どおりランキングとして動く。

**Tech Stack:** 素の HTML / CSS / JavaScript（ビルド無し・依存無し）。テストは `node --test`。キャンバス描画は `canvas.getContext("2d")`。

**Spec:** このプランに先立つ設計はチャットで承認済みで、下の「設計（承認済み）」節がその内容。親となる仕様書は `docs/superpowers/specs/2026-09-20-share-results-design.md`（ランキングの共有）で、共有ボタンの文言・エラーメッセージ・`navigator.share` の扱いはそちらを踏襲する。

## Global Constraints

- 依存パッケージを増やさない。`npm install` も CDN の読み込みも行わない。ビルド手順は無いまま維持する。
- 本番コードに `if (testMode)` のようなテスト用の分岐や、テスト専用のマジックナンバーを入れない。
- テストは実際の入出力を検証する。`assert.ok(true)` のような無意味なアサーションを書かない。
- `share.js` は表示ラベルの整形と共有用の値の組み立てだけを持つ。データ取得と採点は `scoring.js` / `forecast.js`、DOM の組み立ては `app.js`。
- `share.js` の pure な部分（描画を含む）は `node --test` から呼べる状態を保つ。`document` や `window` を参照しない。
- 既存のエクスポート `SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows, shareLines, shareText, shareUrl, drawShareCard, parseParams` は名前も引数も変えない。既存の55件のテストは1件も書き換えない。
- 既に共有済みのランキングURL（`?region=...&date=...&slot=...`）は `mode` が無くても従来どおり動く。
- カードの寸法と色は既存のものを使う。`CARD_SIZE = 1080` / `CARD_PAD = 64` / 地色 `#edf3f5` / 見出し `#124559` / 補助文字 `#687481` / アクセント `#007f8f` / 本文 `#17212b`。
- スコア帯の色は画面（`style.css`）と揃える。good `#1d9a72` / ok `#b7791f` / bad `#b84a3c`。帯の判定は `Forecast.scoreBand`（50以上 good、30以上 ok、それ未満 bad）を使い、しきい値を `share.js` に書き写さない。
- コミットメッセージの末尾に次の2行目を付ける（1行空けてから）。

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

- 秘密情報（APIキー・認証情報・個人情報）をコード・テスト・ドキュメントに書かない。本プロジェクトに秘密情報は存在しない（Open-Meteo は APIキー不要）。

---

## 設計（承認済み）

### 共有するもの

週間予報は「エリア × 7日 × 3時間帯 × 最大10ポイント（全域なら32）」なので、ランキングの「1日1時間帯のTOP3」はそのまま移せない。共有の単位は **各日のベスト** とする。7日それぞれについて、そのエリアの全ポイント・全時間帯の中で最も点数の高い1件を選び、7行にする。

### 共有テキスト

```
千葉北 9/20(日)〜9/26(土)の週間予報
9/20(日) 朝 志田下 48点
9/21(月) 夕 志田下 41点
9/22(火) データなし
★9/23(水) 朝 志田下 62点
9/24(木) 朝 一宮 36点
9/25(金) 昼 志田下 52点
9/26(土) 夕 志田下 26点

https://tk0407.github.io/surf-check/?region=%E5%8D%83%E8%91%89%E5%8C%97&mode=weekly
```

`★` は週で最も点数の高い1行だけに付く。本文と URL は空行1つで挟む（ランキングの `shareText` と同じ）。

### 共有画像（1080×1080）

上から「SURF CHECK」→「千葉北 / 週間予報」→「9月20日(日) 〜 9月26日(土)」→ 区切り線 → 7行 → 左下「全10ポイント」・右下サイトURL。1行は `★`（週ベストのみ）／日付／時間帯／ポイント名／点数。点数はスコア帯の色で描く。

ヘッダ（kicker・見出し・副見出し・区切り線）とフッタはランキングカードと共通なので `drawCardFrame` / `drawCardFooter` に切り出して両方から呼ぶ。`drawShareCard` は実機確認済みの出荷コードでテストが1件も無いため、切り出しの前に偽の2Dコンテキストによる特性テストを入れて回帰を止める。

### 共有URL

`?region=千葉北&mode=weekly`。`parseParams` に `mode` を足し、`options.modes` に載っている値だけを通す。`mode` の無いURLはランキング扱いのままで、既に共有されたリンクは壊れない。`shareUrl` の引数は変えず、週間用に `weeklyUrl(base, region)` を別に足す。

### app.js の共有導線

ランキングと週間の両パネルは CSS で隠しているだけで同時に DOM に存在するため、`shareRow()` が `id` を出すと重複し、`shareError` の `document.querySelector(".share-row")` が別パネルを掴む。`id` をやめて class にし、`wireShareRow(root, payload)` が `root.querySelector` で閉じる。`payload` は `share.js` が組み立てる `{ text, headline, url, filename, draw }`。

---

## File Structure

| ファイル | 責務 | この計画での変更 |
|---|---|---|
| `share.js` | 表示ラベルの整形、共有テキスト・URL・カードの組み立て | 週間用の純関数とカード描画、カードの共通部分の切り出し、`parseParams` の `mode`、payload の組み立て |
| `share.test.js` | `share.js` の検証 | 週間用の関数とカード描画のテストを追加 |
| `app.js` | DOM の組み立てと配線 | 共有導線の payload 化、週間側への配線、`mode` の復元 |
| `index.html` | 画面の骨格と読み込み | `?v=` の日付を上げる（5か所） |
| `style.css` | 見た目 | 変更なしの見込み（`.share-row` をそのまま再利用） |
| `README.md` | 説明 | 共有機能の節に週間予報を足す、テスト件数を直す |

`forecast.js` と `scoring.js` は変更しない。

---

### Task 1: 週間共有の純関数（行・テキスト・URL・mode）

**Files:**
- Modify: `share.js`
- Test: `share.test.js`

**Interfaces:**
- Consumes: `Forecast.SLOT_ORDER`（`["morning", "afternoon", "evening"]`）、`Forecast.scoreBand(total)`。`share.js` は今まで `Scoring` だけを受け取っていたので、ファクトリの引数に `Forecast` を足す。
- Produces:
  - `Share.weeklyRows(dates, results)` → 7要素の配列。各要素は `{ date, slot, name, score, best }`。データが1つも無い日は `{ date, slot: null, name: null, score: null, best: false }`。
  - `Share.weeklyShareLines(region, dates, results)` → 文字列の配列（見出し1行 + 日ごとに1行）。
  - `Share.weeklyText(region, dates, results, url)` → 本文と URL を空行で挟んだ文字列。
  - `Share.weeklyUrl(base, region)` → `?region=...&mode=weekly` の URL 文字列。
  - `Share.parseParams(search, options)` が `options.modes` を見て `out.mode` を足す。
- `results` の形（`app.js` の `weeklySpot` が返すもの）: `{ spot: { name, region, bearing }, days, best }`。`days[i]` は `dates[i]` に対応し、`{ date, slots: { morning, afternoon, evening }, maxWaveHeight, tide }`。各 `slots[slot]` は `{ data, scores }` または `null`。

- [ ] **Step 1: テスト用のフィクスチャを足す**

`share.test.js` の末尾に追記する。既存の `result()` ヘルパーとテストは触らない。

```js
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
```

- [ ] **Step 2: 失敗するテストを書く**

`share.test.js` の末尾に追記する。

```js
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
```

- [ ] **Step 3: テストが失敗することを確認する**

Run: `node --test`
Expected: FAIL。`Sh.weeklyRows is not a function` などで新しい16件が落ち、既存の55件は通る。

- [ ] **Step 4: share.js のファクトリに Forecast を足す**

`share.js` の先頭（UMD の部分）を書き換える。`index.html` の読み込み順は `scoring.js` → `forecast.js` → `share.js` → `app.js` なので、`root.Forecast` は `share.js` の実行時に既に存在する。

```js
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./scoring.js"), require("./forecast.js"));
  } else {
    root.Share = factory(root.Scoring, root.Forecast);
  }
})(typeof self !== "undefined" ? self : this, function (Scoring, Forecast) {
```

- [ ] **Step 5: 週間用の関数を書く**

`share.js` の `parseParams` の直前に足す。

```js
  // 週間予報の共有。7日それぞれについて、エリア内の全ポイント・全時間帯の
  // 中で最も点数の高い1件を選ぶ。同点は時間帯順（朝→昼→夕）、次に results
  // の並び順で先に見つけたほうを採る（strict ">" で先勝ち）。
  // results は app.js の weeklySpot が返す { spot, days, best } の配列で、
  // days[i] が dates[i] に対応する。
  function weeklyRows(dates, results) {
    const rows = dates.map((date, dayIndex) => {
      let found = null;
      for (const slot of Forecast.SLOT_ORDER) {
        for (const r of results) {
          const day = r.days[dayIndex];
          const cell = day && day.slots[slot];
          if (cell && (!found || cell.scores.total > found.score)) {
            found = { slot, name: r.spot.name, score: cell.scores.total };
          }
        }
      }
      return found
        ? { date, slot: found.slot, name: found.name, score: found.score, best: false }
        : { date, slot: null, name: null, score: null, best: false };
    });
    // 週で最も高い1行にだけ印を付ける。同点なら早い日。
    let bestIndex = -1;
    rows.forEach((row, i) => {
      if (row.score !== null && (bestIndex === -1 || row.score > rows[bestIndex].score)) bestIndex = i;
    });
    if (bestIndex !== -1) rows[bestIndex].best = true;
    return rows;
  }

  function weeklyShareLines(region, dates, results) {
    const head = `${region} ${mdLabel(dates[0])}〜${mdLabel(dates[dates.length - 1])}の週間予報`;
    const rows = weeklyRows(dates, results).map((row) => (
      row.score === null
        ? `${mdLabel(row.date)} データなし`
        : `${row.best ? "★" : ""}${mdLabel(row.date)} ${SLOT_SHORT[row.slot]} ${row.name} ${row.score}点`
    ));
    return [head, ...rows];
  }

  function weeklyText(region, dates, results, url) {
    return `${weeklyShareLines(region, dates, results).join("\n")}\n\n${url}`;
  }

  // 週間には日付も時間帯も無いので、エリアと mode だけを載せる。
  function weeklyUrl(base, region) {
    const u = new URL(base);
    u.search = new URLSearchParams({ region, mode: "weekly" }).toString();
    return u.toString();
  }
```

- [ ] **Step 6: parseParams に mode を足す**

`parseParams` の中を書き換える。`options.modes` を渡さない呼び出し（既存のテスト）でも落ちないように `|| []` で受ける。

```js
  function parseParams(search, options) {
    const q = new URLSearchParams(search);
    const out = {};
    const region = q.get("region");
    const date = q.get("date");
    const slot = q.get("slot");
    const mode = q.get("mode");
    if (region && options.regions.includes(region)) out.region = region;
    if (date && isRealDate(date)) out.date = date;
    if (slot && options.slots.includes(slot)) out.slot = slot;
    if (mode && (options.modes || []).includes(mode)) out.mode = mode;
    return out;
  }
```

- [ ] **Step 7: エクスポートに足す**

`share.js` 末尾の `return { ... }` を書き換える。

```js
  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl, drawShareCard, parseParams,
    weeklyRows, weeklyShareLines, weeklyText, weeklyUrl,
  };
```

- [ ] **Step 8: テストが通ることを確認する**

Run: `node --test`
Expected: PASS。`tests 71` / `pass 71` / `fail 0`（既存55 + 追加16）。

- [ ] **Step 9: コミット**

```bash
git add share.js share.test.js
git commit -m "$(printf 'feat: build the weekly share lines, text and url\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 2: カード描画のテスト土台と共通部分の切り出し

**Files:**
- Modify: `share.js`
- Test: `share.test.js`

**Interfaces:**
- Consumes: 既存の `drawShareCard(canvas, info)`。
- Produces: `share.js` 内部（エクスポートしない）の `drawCardFrame(ctx, title, subtitle)` と `drawCardFooter(ctx, note)`。Task 3 の `drawWeeklyCard` がこの2つを呼ぶ。`drawShareCard` の外から見える振る舞いは一切変えない。

**このタスクのテストについて:** ここで足すのは「いま出ている絵を固定する」特性テスト（characterization test）であり、最初から通る。失敗から始める Red-Green-Refactor は新しい振る舞いを足すとき（Task 1・3・5）の規則で、既存の出荷コードを壊さずに切り出すこのタスクには当てはまらない。もし Step 3 でテストが落ちたら、それは `drawShareCard` のバグではなく偽コンテキストの作りが間違っている。

- [ ] **Step 1: 偽の2Dコンテキストを書く**

`share.test.js` の末尾に追記する。

```js
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
    stroke() { calls.push({ op: "stroke", strokeStyle: this.strokeStyle }); },
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
```

- [ ] **Step 2: 既存カードの特性テストを書く**

`share.test.js` の末尾に追記する。

```js
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
```

- [ ] **Step 3: テストが通ることを確認する（切り出し前の基準）**

Run: `node --test`
Expected: PASS。`tests 79` / `pass 79` / `fail 0`（Task 1 の71 + 追加8）。落ちた場合は偽コンテキストの作りを直す。`share.js` は触らない。

- [ ] **Step 4: 共通部分を切り出す**

`share.js` の `drawShareCard` の直前に足す。中身は `drawShareCard` の先頭と末尾から動かしたもので、文も順番も変えない。

```js
  // ランキングカードと週間カードで共通の、上の見出しと区切り線。
  function drawCardFrame(ctx, title, subtitle) {
    ctx.fillStyle = "#edf3f5";
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.fillStyle = "#007f8f";
    ctx.font = `800 30px ${CARD_FONT}`;
    ctx.fillText("SURF CHECK", CARD_PAD, CARD_PAD + 30);

    ctx.fillStyle = "#124559";
    ctx.font = `800 54px ${CARD_FONT}`;
    ctx.fillText(title, CARD_PAD, CARD_PAD + 104);
    ctx.fillStyle = "#687481";
    ctx.font = `700 38px ${CARD_FONT}`;
    ctx.fillText(subtitle, CARD_PAD, CARD_PAD + 160);

    ctx.strokeStyle = "#dce5eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CARD_PAD, CARD_PAD + 200);
    ctx.lineTo(CARD_SIZE - CARD_PAD, CARD_PAD + 200);
    ctx.stroke();
  }

  // 左下の補足（空文字なら描かない）と、右下のサイトURL。
  function drawCardFooter(ctx, note) {
    ctx.fillStyle = "#687481";
    ctx.font = `700 30px ${CARD_FONT}`;
    if (note) ctx.fillText(note, CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "right";
    ctx.fillText("tk0407.github.io/surf-check", CARD_SIZE - CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "left";
  }
```

- [ ] **Step 5: drawShareCard を切り出した関数で書き直す**

`drawShareCard` の先頭（`canvas.width` から区切り線の `ctx.stroke()` まで）と末尾（`const rest` から最後の `ctx.textAlign = "left"` まで）を差し替える。`info.rows.forEach(...)` の中身は1文字も変えない。

```js
  function drawShareCard(canvas, info) {
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const ctx = canvas.getContext("2d");
    drawCardFrame(ctx, `${info.region} / ${longDateLabel(info.date)}`, SLOT_LONG[info.slot]);

    info.rows.forEach((row, i) => {
      // ...（既存のまま。順位バッジ・点数・ポイント名・波と風）
    });

    const rest = info.count - info.rows.length;
    drawCardFooter(ctx, rest > 0 ? `ほか${rest}件` : "");
  }
```

- [ ] **Step 6: 切り出しで絵が変わっていないことを確認する**

Run: `node --test`
Expected: PASS。`tests 79` / `pass 79` / `fail 0`。Step 3 と同じ結果になること。1件でも落ちたら切り出しで振る舞いが変わっている。

- [ ] **Step 7: コミット**

```bash
git add share.js share.test.js
git commit -m "$(printf 'refactor: pull the shared card frame out of drawShareCard\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: 週間カードの描画と共有 payload

**Files:**
- Modify: `share.js`
- Test: `share.test.js`

**Interfaces:**
- Consumes: Task 1 の `weeklyRows` / `weeklyShareLines` / `weeklyText` / `weeklyUrl`、Task 2 の `drawCardFrame(ctx, title, subtitle)` / `drawCardFooter(ctx, note)`、既存の `mdLabel` / `longDateLabel` / `fitText` / `cardRows` / `shareLines` / `shareText` / `shareUrl` / `drawShareCard`、`Forecast.scoreBand(total)`。Task 2 の `fakeCanvas()` ヘルパーがテストにある。
- Produces:
  - `Share.drawWeeklyCard(canvas, info)`。`info` は `{ region, dates, rows, count }`。`rows` は `weeklyRows` の返り値、`count` はポイント数。
  - `Share.rankingShare(base, region, date, slot, results)` → `{ text, headline, url, filename, draw }`。
  - `Share.weeklyShare(base, region, dates, results)` → 同じ形。
  - `draw` は `(canvas) => void` で、渡された canvas に対応するカードを描く。`app.js` はこの5つのキーだけを見る。

- [ ] **Step 1: 失敗するテストを書く**

`share.test.js` の末尾に追記する。

```js
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
  // 1行96pxずつ下がり、最後の行はフッタ（y=1016）にかからない
  assert.deepEqual(dates.map((c) => c.y), [350, 446, 542, 638, 734, 830, 926]);
});

test("drawWeeklyCard は週ベストの行にだけ★を描く", () => {
  const f = drawWeekly(WEEK_ROWS, 10);
  const stars = f.calls.filter((c) => c.op === "fillText" && c.text === "★");
  assert.equal(stars.length, 1);
  // 4行目（9/23）と同じ高さ
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test`
Expected: FAIL。`Sh.drawWeeklyCard is not a function` などで新しい13件が落ち、既存の81件は通る。

- [ ] **Step 3: 週間カードを描く**

`share.js` の `drawShareCard` の直後に足す。`BAND_COLORS` と行の座標は `SLOT_LONG` の近くの定数と並べて置く。

```js
  // 画面（style.css の .wk-cell）と同じスコア帯の色。帯の判定そのものは
  // Forecast.scoreBand に任せ、しきい値をここに書き写さない。
  const BAND_COLORS = { good: "#1d9a72", ok: "#b7791f", bad: "#b84a3c" };
  // 行は上から96pxおき。左の44pxは週ベストの★のために空けてある。
  const WEEK_ROW_TOP = CARD_PAD + 250;
  const WEEK_ROW_STEP = 96;
  const WEEK_DATE_LEFT = CARD_PAD + 44;
  const WEEK_SLOT_LEFT = CARD_PAD + 230;
  const WEEK_NAME_LEFT = CARD_PAD + 290;

  function drawWeeklyCard(canvas, info) {
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const ctx = canvas.getContext("2d");
    const last = info.dates[info.dates.length - 1];
    drawCardFrame(ctx, `${info.region} / 週間予報`,
      `${longDateLabel(info.dates[0])} 〜 ${longDateLabel(last)}`);

    info.rows.forEach((row, i) => {
      const top = WEEK_ROW_TOP + i * WEEK_ROW_STEP;

      if (row.best) {
        ctx.fillStyle = "#007f8f";
        ctx.font = `900 34px ${CARD_FONT}`;
        ctx.fillText("★", CARD_PAD, top + 36);
      }

      ctx.fillStyle = "#124559";
      ctx.font = `700 34px ${CARD_FONT}`;
      ctx.fillText(mdLabel(row.date), WEEK_DATE_LEFT, top + 36);

      if (row.score === null) {
        ctx.fillStyle = "#687481";
        ctx.font = `600 32px ${CARD_FONT}`;
        ctx.fillText("データなし", WEEK_SLOT_LEFT, top + 36);
        return;
      }

      // 点数は右端から逆算して置く（ランキングカードと同じ）
      ctx.font = `900 48px ${CARD_FONT}`;
      const scoreText = String(row.score);
      const scoreWidth = ctx.measureText(scoreText).width;
      ctx.font = `700 26px ${CARD_FONT}`;
      const suffixWidth = ctx.measureText("/85").width;
      const scoreLeft = CARD_SIZE - CARD_PAD - scoreWidth - suffixWidth;
      ctx.fillStyle = BAND_COLORS[Forecast.scoreBand(row.score)];
      ctx.font = `900 48px ${CARD_FONT}`;
      ctx.fillText(scoreText, scoreLeft, top + 40);
      ctx.fillStyle = "#687481";
      ctx.font = `700 26px ${CARD_FONT}`;
      ctx.fillText("/85", scoreLeft + scoreWidth, top + 40);

      ctx.fillStyle = "#687481";
      ctx.font = `700 34px ${CARD_FONT}`;
      ctx.fillText(SLOT_SHORT[row.slot], WEEK_SLOT_LEFT, top + 36);

      // ポイント名は点数の手前まで
      ctx.fillStyle = "#17212b";
      ctx.font = `800 40px ${CARD_FONT}`;
      ctx.fillText(fitText(ctx, row.name, scoreLeft - WEEK_NAME_LEFT - 24), WEEK_NAME_LEFT, top + 38);
    });

    drawCardFooter(ctx, `全${info.count}ポイント`);
  }
```

- [ ] **Step 4: 共有 payload の組み立てを書く**

`share.js` の `drawWeeklyCard` の直後に足す。`app.js` がこの2つだけを呼べば済むようにする。

```js
  // app.js が共有に必要とする値を1か所で組み立てる。draw は canvas を受け
  // 取って対応するカードを描く。
  function rankingShare(base, region, date, slot, results) {
    const url = shareUrl(base, region, date, slot);
    return {
      text: shareText(region, date, slot, results, url),
      headline: shareLines(region, date, slot, results)[0],
      url,
      filename: `surf-check-${region}-${date}-${slot}.png`,
      draw: (canvas) => drawShareCard(canvas, {
        region, date, slot, rows: cardRows(results), count: results.length,
      }),
    };
  }

  function weeklyShare(base, region, dates, results) {
    const url = weeklyUrl(base, region);
    return {
      text: weeklyText(region, dates, results, url),
      headline: weeklyShareLines(region, dates, results)[0],
      url,
      filename: `surf-check-${region}-weekly-${dates[0]}.png`,
      draw: (canvas) => drawWeeklyCard(canvas, {
        region, dates, rows: weeklyRows(dates, results), count: results.length,
      }),
    };
  }
```

- [ ] **Step 5: エクスポートに足す**

```js
  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl, drawShareCard, parseParams,
    weeklyRows, weeklyShareLines, weeklyText, weeklyUrl,
    drawWeeklyCard, rankingShare, weeklyShare,
  };
```

- [ ] **Step 6: テストが通ることを確認する**

Run: `node --test`
Expected: PASS。`tests 94` / `pass 94` / `fail 0`（Task 2 の81 + 追加13）。

- [ ] **Step 7: コミット**

```bash
git add share.js share.test.js
git commit -m "$(printf 'feat: draw the weekly share card and assemble share payloads\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: 共有導線を payload 駆動にする（ランキングの挙動は不変）

**Files:**
- Modify: `app.js:339-440`（`shareRow` から `renderResults` まで）

**Interfaces:**
- Consumes: Task 3 の `Share.rankingShare(base, region, date, slot, results)`。
- Produces: `app.js` 内部の `shareRow()`（class を出す）、`shareError(root, message)`、`canShareImageFile()`（変更なし）、`openLineShare(root, payload)`、`shareImage(root, payload)`、`wireShareRow(root, payload)`。Task 5 の `renderWeekly` が `wireShareRow` を呼ぶ。

**なぜ id をやめるか:** ランキングと週間の両パネルは CSS（`.app-shell[data-mode=...]`）で隠しているだけで、同時に DOM に存在する。両方が `id="shareLine"` を出すと id が重複し、`shareError` の `document.querySelector(".share-row")` は常に先に現れるランキング側を掴んで、週間側のエラーが出ない・別パネルに出る。`root.querySelector` に閉じることでこれを防ぐ。

**このタスクの検証:** `app.js` は DOM を触るので `node --test` の対象外（jsdom を入れない＝依存を増やさない方針）。構文チェックと文字列検査で機械的に確認し、目視確認は Task 5 の通し確認でまとめて行う。

- [ ] **Step 1: shareRow を class に変える**

`app.js` の `shareRow()` を書き換える。

```js
function shareRow() {
  return `<div class="share-row">
      <button type="button" class="share-btn line share-line">LINEで送る</button>
      <button type="button" class="share-btn share-image">画像で共有</button>
    </div>`;
}
```

- [ ] **Step 2: shareError が親要素の中だけを見るようにする**

```js
// 共有ボタンの下に1行だけ出すエラー。次の共有でメッセージを差し替える。
// root はそのパネル（#results / #weekly）。ランキングと週間の共有行が同時に
// DOM にあるので、document 全体から探すと別パネルを掴んでしまう。
function shareError(root, message) {
  const row = root.querySelector(".share-row");
  if (!row) return;
  let note = row.querySelector(".share-note");
  if (!note) {
    note = document.createElement("p");
    note.className = "failed share-note";
    row.appendChild(note);
  }
  note.textContent = message;
}
```

- [ ] **Step 3: openLineShare と shareImage を payload 駆動にする**

`canShareImageFile()` はそのまま（コメントも含め1文字も変えない）。その前後を書き換える。

```js
// LINEはURLスキームでテキストしか受け取れないので、画像とは別の導線になる。
function openLineShare(root, payload) {
  const win = window.open(`https://line.me/R/msg/text/?${encodeURIComponent(payload.text)}`, "_blank", "noopener");
  if (!win) shareError(root, "LINEを開けませんでした");
}
```

```js
// canvas -> PNG。ファイル共有ができる端末は共有シート、それ以外は保存。
async function shareImage(root, payload) {
  const canvas = document.createElement("canvas");
  payload.draw(canvas);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) { shareError(root, "画像を作れませんでした"); return; }
  const file = new File([blob], payload.filename, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: `${payload.headline}\n${payload.url}` });
    } catch (e) {
      // 共有シートを閉じただけなので何も出さない。
      if (e.name !== "AbortError") shareError(root, "画像を共有できませんでした");
    }
    return;
  }
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(href);
}
```

- [ ] **Step 4: wireShareRow を足す**

`shareImage` の直後に足す。

```js
// 共有行のボタンを payload につなぐ。ランキングと週間で共通。
function wireShareRow(root, payload) {
  const lineBtn = root.querySelector(".share-line");
  if (lineBtn) lineBtn.addEventListener("click", () => openLineShare(root, payload));
  const imageBtn = root.querySelector(".share-image");
  if (imageBtn) {
    // ファイル共有ができない環境では、押す前に「保存」だと分かるようにする。
    if (!canShareImageFile()) imageBtn.textContent = "画像を保存";
    imageBtn.addEventListener("click", () => shareImage(root, payload));
  }
}
```

- [ ] **Step 5: renderResults を wireShareRow に寄せる**

`renderResults` の `el.innerHTML = ...` より後ろ、`drawTideCurves` の手前の部分を書き換える。`el.innerHTML` の組み立て（`shareRow()` を挟む位置を含む）は変えない。

```js
  const share = Share.rankingShare(location.origin + location.pathname, region, date, slot, results);
  wireShareRow(el, share);
  drawTideCurves(el, results, date, slot);
  history.replaceState(null, "", share.url);
```

- [ ] **Step 6: 構文と置き換え漏れを確認する**

```bash
node --check app.js
grep -n 'shareLine\|shareImage"' app.js
grep -c 'document.querySelector(".share-row")' app.js
```

Expected:
- `node --check app.js` が何も出力せず終了する（終了コード0）
- 1つ目の grep が何も出さない（`id="shareLine"` / `id="shareImage"` が消えている）
- 2つ目の grep が `0`（`shareError` が `document` 全体を見ていない）

- [ ] **Step 7: 既存テストが影響を受けていないことを確認する**

Run: `node --test`
Expected: PASS。`tests 94` / `pass 94` / `fail 0`。`app.js` はテスト対象外なので件数は Task 3 と同じ。

- [ ] **Step 8: コミット**

```bash
git add app.js
git commit -m "$(printf 'refactor: drive the share row from a payload instead of fixed ids\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: 週間側の配線・mode の復元・ドキュメント

**Files:**
- Modify: `app.js`（`renderWeekly` と `applyParams`）
- Modify: `index.html`（`?v=` を5か所）
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 3 の `Share.weeklyShare(base, region, dates, results)`、Task 4 の `shareRow()` / `wireShareRow(root, payload)`、既存の `setMode(mode)` と `Share.parseParams(search, options)`。
- Produces: 画面から見える最終形。これ以降のタスクは無い。

- [ ] **Step 1: renderWeekly に共有行を足す**

`app.js` の `renderWeekly` を書き換える。`${shareRow()}` を `.results-head` と `.ranking-cards` の間に置く（ランキングと同じ位置）。

```js
function renderWeekly(el, region, dates, results, failed) {
  WEEKLY_RESULTS = results;
  if (results.length === 0) {
    el.innerHTML = `<p class="failed">データを取得できませんでした。</p>`;
    return;
  }
  const failedNote = failed.length ? `<p class="failed">取得失敗: ${escapeHtml(failed.join(", "))}</p>` : "";
  el.innerHTML = `
    <div class="results-head">
      <h2>${escapeHtml(region)}の週間予報</h2>
      <span>${escapeHtml(Share.mdLabel(dates[0]))}〜${escapeHtml(Share.mdLabel(dates[dates.length - 1]))} / ${results.length}件</span>
    </div>
    ${shareRow()}
    <div class="ranking-cards">
      ${results.map(weeklyCard).join("")}
    </div>
    ${failedNote}`;
  const share = Share.weeklyShare(location.origin + location.pathname, region, dates, results);
  wireShareRow(el, share);
  history.replaceState(null, "", share.url);
}
```

- [ ] **Step 2: applyParams が mode を復元するようにする**

`app.js` の `applyParams` を書き換える。`setMode` を先に呼ぶので、戻ったあとの `check()` が正しいほうのビューを走らせる。

```js
// 共有リンクから来た条件を選択欄に入れる。1つでも入ったら true。
// 日付が min/max の外なら、入力欄の表示と制約が食い違わないよう制約を広げる。
function applyParams() {
  const regionEl = document.getElementById("region");
  const dateEl = document.getElementById("date");
  const slotEl = document.getElementById("slot");
  const params = Share.parseParams(location.search, {
    regions: Array.from(regionEl.options).map((o) => o.value),
    slots: Object.keys(TIME_SLOTS),
    modes: ["ranking", "weekly"],
  });
  if (params.mode) setMode(params.mode);
  if (params.region) regionEl.value = params.region;
  if (params.slot) slotEl.value = params.slot;
  if (params.date) {
    if (params.date < dateEl.min) dateEl.min = params.date;
    if (params.date > dateEl.max) dateEl.max = params.date;
    dateEl.value = params.date;
  }
  return Boolean(params.region || params.date || params.slot || params.mode);
}
```

- [ ] **Step 3: 構文と配線を確認する**

```bash
node --check app.js
grep -c 'wireShareRow(el, share)' app.js
grep -n 'modes: \["ranking", "weekly"\]' app.js
```

Expected:
- `node --check app.js` が終了コード0
- 1つ目の grep が `2`（`renderResults` と `renderWeekly` の両方）
- 2つ目の grep が `applyParams` の中の1行を出す

- [ ] **Step 4: index.html の ?v= を上げる**

`style.css` と4つの `.js` の **5か所すべて** を `?v=20260923` に揃える。

```html
  <link rel="stylesheet" href="style.css?v=20260923" />
  ...
  <script src="scoring.js?v=20260923"></script>
  <script src="forecast.js?v=20260923"></script>
  <script src="share.js?v=20260923"></script>
  <script src="app.js?v=20260923"></script>
```

確認:

```bash
grep -c '?v=20260923' index.html
grep -n '?v=' index.html | grep -v 20260923
```

Expected: 1つ目が `5`、2つ目が何も出さない。

- [ ] **Step 5: README を更新する**

`## 共有機能` の節に週間予報の共有を1段落足し、`## テスト` の件数を実際の数に直す。書く内容:

- 週間予報タブでも「LINEで送る」「画像で共有」が使えること
- 共有されるのは各日のベスト（ポイント・時間帯・点数）7行で、週で最も高い日には ★ が付くこと
- 共有URLは `?region=...&mode=weekly` で、開くと週間予報タブが選ばれた状態で再現されること
- ランキングの共有URL（`mode` 無し）は従来どおり動くこと

- [ ] **Step 6: 全体を通しで確認する**

ローカルサーバーを立てて確認する。

```bash
python3 -m http.server 8000
```

- `node --test` が全件成功する（`tests 94` / `fail 0`）
- ランキングの表示と共有が Task 4 の前と変わらない（ボタンを押すと LINE が開く／画像が保存できる）
- 週間予報タブでチェックすると、見出しの下に共有ボタンの行が出る
- 週間の「LINEで送る」でテキストに7行と ★ が入っている
- 週間の「画像で共有」（または「画像を保存」）で 1080×1080 の PNG が得られ、7行と期間の見出しが読める
- 週間の共有URLを別タブで開くと、週間予報タブが選ばれてエリアが入り、同じ内容が再現される
- ランキングの共有URL（`?region=千葉北&date=2026-09-21&slot=morning`）が今までどおり動く
- 375px 幅で横スクロールが出ない

- [ ] **Step 7: レビュー欄を書いてコミット**

`tasks/todo.md` の末尾に `## レビュー` を足し、実際に確認した内容・変更したファイル・確認できていないことを分けて書く（推測でチェックを入れない。秘密情報は書かない）。

```bash
git add app.js index.html README.md tasks/todo.md
git commit -m "$(printf 'feat: share the weekly forecast by line and image\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

## プラン自己レビュー

- **設計の網羅**: 共有の単位（各日のベスト7行）→ Task 1 Step 5 の `weeklyRows`。共有テキスト → Task 1 Step 5 の `weeklyShareLines` / `weeklyText`。共有画像 → Task 3 Step 3 の `drawWeeklyCard`。カードの共通部分の切り出し → Task 2。共有URL（生成）→ Task 1 Step 5 の `weeklyUrl`、（検証と復元）→ Task 1 Step 6 と Task 5 Step 2。ボタンの配置 → Task 5 Step 1。id 重複の回避 → Task 4 Step 1-2。`?v=` と README → Task 5 Step 4-5。
- **名前の一致**: `weeklyRows` の返り値 `{ date, slot, name, score, best }` を Task 1 の `weeklyShareLines`、Task 3 の `drawWeeklyCard` と `WEEK_ROWS` フィクスチャが同じ形で使う。`drawWeeklyCard(canvas, { region, dates, rows, count })` は Task 3 Step 4 の `weeklyShare` の呼び出しと一致。`rankingShare` / `weeklyShare` が返す `{ text, headline, url, filename, draw }` の5つのキーを、Task 4 の `openLineShare`（`text`）・`shareImage`（`draw` / `filename` / `headline` / `url`）と Task 5 の `history.replaceState`（`url`）が使う。`fakeCanvas()` は Task 2 Step 1 で定義し、Task 3 のテストが使う。`WEEK_DATES` は Task 1 Step 1 で定義し、Task 3 のテストが使う。`drawCardFrame` / `drawCardFooter` は Task 2 Step 4 で定義し、Task 3 Step 3 が呼ぶ。
- **検算した値**: `2026-09-20` は日曜（`9/20(日)`）、`2026-09-26` は土曜。`weeklyRows` と `weeklyShareLines` の期待値、`weeklyUrl` の URL エンコード（`千葉北` → `%E5%8D%83%E8%91%89%E5%8C%97`）、`drawWeeklyCard` の日付の y 座標（350 / 446 / 542 / 638 / 734 / 830 / 926）とフッタの位置（1016）、スコア帯の色（62→`#1d9a72` / 48→`#b7791f` / 26→`#b84a3c`）は、実装の試作を `node` で走らせて実測した値。`drawShareCard` の特性テストの期待値も、現在の `share.js` を偽コンテキストで走らせた実測値。
- **レイアウトの余白**: 7行目の日付のベースラインが y=926、フッタが y=1016 で 90px 空く。日付の欄は `WEEK_DATE_LEFT`(108) から `WEEK_SLOT_LEFT`(294) までの 186px で、最も長い `12/31(木)` が 153px（近似計算）。ポイント名は点数の左端から 24px 手前まで。実在する最長の名前 `パイプライン（茅ヶ崎）`（11文字）は 40px で 440px、収まる枠は約 551px。
- **テスト件数**: 既存55 + Task 1 で16 + Task 2 で8 + Task 2 の修正ラウンドで2 + Task 3 で13 = 94。修正ラウンドの2件は、切り出した `drawCardFrame` の区切り線と見出しの色・太さを検証するもの。レビューで「移した当の描画が未検証」と指摘され、変異テスト（区切り線を削除しても緑のまま）で実証されたため追加した。
- **Red-Green の例外**: Task 2 のテストは既存の出荷コードの絵を固定する特性テストなので、最初から通る。これはタスク本文に明記してある。Task 1・3・5 の新しい振る舞いは失敗から始める。
