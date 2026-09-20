# 検索結果の共有（LINE / 画像）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ランキングの上位3件を、LINEに送れるテキストと1枚の画像として共有できるようにし、共有リンクから同じ検索結果を再現できるようにする。

**Architecture:** 共有用の文字列組み立てとカード描画を `share.js` に新設する。共有テキスト・共有画像・画面のカードが必ず同じ文字列を出すよう、ラベルの整形（方位・風・波・日付・時間帯）を `share.js` に集め、`app.js` はそこから借りる。画像は外部ライブラリを使わず `<canvas>` の2Dコンテキストに直接描く。検索条件は `?region=&date=&slot=` で持ち回り、読み込み時に復元する。

**Tech Stack:** 素のHTML / CSS / JavaScript（ビルド手順なし）、Canvas 2D API、Web Share API、`node --test`

**Spec:** `docs/superpowers/specs/2026-09-20-share-results-design.md`

## Global Constraints

- 新しいパッケージは入れない。外部スクリプトも読み込まない。
- ランキングの取得・採点・カード描画の挙動は変更しない。共有ボタンの行以外、`#results` と `#weekly` の描画HTMLに差が出ないこと。
- 画面に出す文字列は `escapeHtml` を通す。canvas に描く文字列はHTMLではないためエスケープ不要。
- 本番コードにテスト用の分岐を入れない。
- スマホ幅 375px でページが横スクロールしないこと。
- 共有カードは 1080 × 1080 px、PNG。
- 色は既存の CSS 変数と同じ値を使う: `--ink #17212b` / `--muted #687481` / `--line #dce5eb` / `--bg #edf3f5` / `--panel #ffffff` / `--sea #007f8f` / `--deep #124559`。
- フォント指定は画面と同じ `system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif`。
- CSS / JS を変更したら `index.html` の `?v=` の日付を上げる。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` を付ける。

## ファイル構成

| ファイル | 役割 | 変更 |
| --- | --- | --- |
| `share.js` | 表示ラベルの整形・共有テキスト・共有URL・URLパラメータ検証・カード描画。`forecast.js` と同じ UMD 形式 | 新規 |
| `share.test.js` | `share.js` の純粋関数のテスト | 新規 |
| `app.js` | 共有ボタンの描画とイベント、URLの復元と反映。ラベル整形は `share.js` に委譲 | 変更 |
| `index.html` | `share.js` の読み込み、`?v=` の更新 | 変更 |
| `style.css` | 共有ボタンの見た目 | 変更 |
| `README.md` | 共有機能の説明 | 変更 |

責任の線引き: `share.js` は「値を人が読む文字列にする」ところまで。データ取得・採点は `forecast.js` / `scoring.js`、画面の組み立ては `app.js` のままにする。同じラベルを2か所で定義しない（定義が2つあると、画面の文言を直したときに共有テキストだけ古いまま残る）。

**開始前のベースライン**: `node --test` は現在 29件すべて成功する。

---

### Task 1: share.js にラベル整形を集める

`jpDirection` / `windConditionLabel` / `WEEKDAYS_JA` / `dateParts` / `mdLabel` / `SLOT_SHORT` は現在 `app.js` にあり、画面のカードと週間表が使っている。共有テキストと共有画像も同じ文字列を出す必要があるため、`share.js` に移して両方から使えるようにする。この時点では画面の表示は1文字も変わらない。

**Files:**
- Create: `share.js`
- Create: `share.test.js`
- Modify: `app.js:11-12`（`SLOT_SHORT` と `WEEKDAYS_JA` を削除）、`app.js:41-50`（`dateParts` と `mdLabel` を削除）、`app.js:52-56`（`dayColumnLabel` を `Share.dateParts` 経由に）、`app.js:133-142`（`jpDirection` を削除）、`app.js:150-159`（`windConditionLabel` を削除）、`app.js:299-320`（`conditionMetrics` の3か所）、`app.js:433` / `app.js:442` / `app.js:453` / `app.js:475` / `app.js:487`（呼び出しを `Share.` 付きに）
- Modify: `index.html:71-73`（`share.js` の読み込みを追加）

**Interfaces:**
- Consumes: `Scoring.waveSizeLabel(heightM) -> string`（`scoring.js`）
- Produces:
  - `Share.SLOT_SHORT` — `{ morning: "朝", afternoon: "昼", evening: "夕" }`
  - `Share.dateParts(date) -> { month, day, weekday }`
  - `Share.mdLabel(date) -> string` — `"2026-09-20"` → `"9/20(日)"`
  - `Share.jpDirection(deg) -> string` — `0` → `"北"`、`45` → `"北東"`
  - `Share.windConditionLabel(windDir, windSpeed, bearing) -> string` — `"オフ弱" | "オフショア" | "サイドオフ" | "サイド" | "サイドオン" | "オンショア"`
  - `Share.cardRows(results) -> { rank, name, score, wave, wind }[]` — 先頭3件まで

- [ ] **Step 1: 失敗するテストを書く**

`share.test.js` を新規作成する。

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test share.test.js`
Expected: FAIL（`Cannot find module './share.js'`）

- [ ] **Step 3: share.js を作る**

`forecast.js` と同じ UMD の書き方に合わせる。`jpDirection` と `windConditionLabel` の中身は `app.js` から一字一句そのまま持ってくる（挙動を変えないため）。

```js
// 表示ラベルの整形と、共有用のテキスト・カード。画面・共有テキスト・共有
// 画像が同じ文字列を出せるよう、ラベルはここにだけ置く。pure な部分は
// node --test で動く。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Share = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  const SLOT_SHORT = { morning: "朝", afternoon: "昼", evening: "夕" };
  const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

  function dateParts(date) {
    const d = new Date(`${date}T00:00:00`);
    return { month: d.getMonth() + 1, day: d.getDate(), weekday: WEEKDAYS_JA[d.getDay()] };
  }

  // "9/19(土)"
  function mdLabel(date) {
    const p = dateParts(date);
    return `${p.month}/${p.day}(${p.weekday})`;
  }

  function jpDirection(deg) {
    const names = [
      [0, 22.5, "北"], [22.5, 67.5, "北東"], [67.5, 112.5, "東"],
      [112.5, 157.5, "南東"], [157.5, 202.5, "南"], [202.5, 247.5, "南西"],
      [247.5, 292.5, "西"], [292.5, 337.5, "北西"], [337.5, 360, "北"],
    ];
    const normalized = ((deg % 360) + 360) % 360;
    const found = names.find(([lo, hi]) => lo <= normalized && normalized < hi);
    return found ? found[2] : "北";
  }

  function windConditionLabel(windDir, windSpeed, bearing) {
    const offshoreFrom = (bearing + 180) % 360;
    let diff = Math.abs(windDir - offshoreFrom) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff < 45) return windSpeed <= 3 ? "オフ弱" : "オフショア";
    if (diff <= 75) return "サイドオフ";
    if (diff <= 105) return "サイド";
    if (diff <= 135) return "サイドオン";
    return "オンショア";
  }

  // 共有テキストと共有カードが参照する唯一の整形。results は
  // scores.total の降順に並んでいる前提。
  function cardRows(results) {
    return results.slice(0, 3).map((r, i) => ({
      rank: i + 1,
      name: r.spot.name,
      score: r.scores.total,
      wave: `${r.data.wave_height.toFixed(1)}m ${Scoring.waveSizeLabel(r.data.wave_height)}`,
      wind: `${jpDirection(r.data.wind_dir)} ${r.data.wind_speed.toFixed(1)}m/s `
        + `${windConditionLabel(r.data.wind_dir, r.data.wind_speed, r.spot.bearing)}`,
    }));
  }

  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
  };
});
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test share.test.js`
Expected: PASS（11件）

- [ ] **Step 5: app.js から移設した定義を削除する**

次の6つを `app.js` からまるごと削除する。関数の本体は Step 3 で `share.js` に入っている。

- `const SLOT_SHORT = ...`（11行目）
- `const WEEKDAYS_JA = ...`（12行目）
- `function dateParts(date) { ... }`（41-44行目）
- `// "9/19(土)"` のコメントと `function mdLabel(date) { ... }`（46-50行目）
- `function jpDirection(deg) { ... }`（133-142行目）
- `function windConditionLabel(...) { ... }`（150-159行目）

- [ ] **Step 6: app.js の呼び出しを Share. 付きに直す**

`dayColumnLabel`（52-56行目付近）:

```js
// "土19" — weekly grid column header
function dayColumnLabel(date) {
  const p = Share.dateParts(date);
  return `${p.weekday}${p.day}`;
}
```

`conditionMetrics` の3か所:

```js
  const windCondition = Share.windConditionLabel(data.wind_dir, data.wind_speed, bearing);
```

```js
        <span><strong>${escapeHtml(windCondition)}</strong><span class="metric-sub">${escapeHtml(Share.jpDirection(data.wind_dir))}風 ${data.wind_speed.toFixed(1)}m/s</span></span>
```

```js
        <span><strong>${escapeHtml(Share.jpDirection(data.swell_dir))}うねり</strong></span>
```

週間予報側の5か所（433 / 442 / 453 / 475 / 487行目付近）は `mdLabel(` → `Share.mdLabel(`、`SLOT_SHORT[` → `Share.SLOT_SHORT[` に置き換える。

Run: `grep -n "jpDirection\|windConditionLabel\|mdLabel\|SLOT_SHORT\|dateParts\|WEEKDAYS_JA" app.js`
Expected: 表示されるすべての行に `Share.` が付いている（定義の残りが無い）

- [ ] **Step 7: index.html に share.js を足す**

`app.js` より前、`forecast.js` の次に読み込む。

```html
  <script src="scoring.js?v=20260920"></script>
  <script src="forecast.js?v=20260920"></script>
  <script src="share.js?v=20260920"></script>
  <script src="app.js?v=20260920"></script>
```

- [ ] **Step 8: テスト全体を流す**

Run: `node --test`
Expected: `tests 40` / `pass 40` / `fail 0`（既存29件 + 新規11件）

- [ ] **Step 9: 画面が変わっていないことを確認する**

ローカルサーバー（`python3 -m http.server 8000`）でランキングと週間予報の両方を表示し、方位・風・日付・時間帯の文字列が移設前と同じであることを確認する。

- [ ] **Step 10: コミット**

```bash
git add share.js share.test.js app.js index.html
git commit -m "$(printf 'refactor: move display labels into share.js\n\nThe share text and the share card have to render the same strings as the\nranking card, so the label formatters move to a module both sides can\nreach. Keeping one definition each stops the share output from drifting\nwhen the on-screen wording changes. No visible change.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 2: LINEで送るボタン

共有テキストと共有URLを組み立て、結果ヘッダーの下に「LINEで送る」ボタンを出す。

**Files:**
- Modify: `share.js`（`shareLines` / `shareText` / `shareUrl` を追加）
- Modify: `share.test.js`（テストを追加）
- Modify: `app.js`（`shareRow` / `openLineShare` / `shareError` を追加し、`renderResults` から呼ぶ）
- Modify: `style.css`（末尾に共有ボタンのスタイル）

**Interfaces:**
- Consumes: `Share.cardRows(results)`、`Share.mdLabel(date)`、`Share.SLOT_SHORT`（Task 1）
- Produces:
  - `Share.shareLines(region, date, slot, results) -> string[]`
  - `Share.shareText(region, date, slot, results, url) -> string`
  - `Share.shareUrl(base, region, date, slot) -> string`
  - `app.js` の `shareRow() -> string`（HTML断片）、`shareError(message) -> void`

- [ ] **Step 1: 失敗するテストを書く**

`share.test.js` の末尾に追加する。`result` ヘルパーは Task 1 で定義済みのものを使う。

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test share.test.js`
Expected: FAIL（`Sh.shareLines is not a function`）

- [ ] **Step 3: share.js に3つの関数を足す**

`cardRows` の下、`return` の前に置く。`wave` は `"1.4m カタ〜アタマ"` なので先頭の数値だけを取り、`wind` は `"南西 5.5m/s サイドオフ"` の最初の空白1つだけを詰めて `"南西5.5m/s サイドオフ"` にする（`replace` は第1引数が文字列なら最初の1つしか置き換えない）。

```js
  function shareLines(region, date, slot, results) {
    const head = `${region} ${mdLabel(date)} ${SLOT_SHORT[slot]}のサーフチェック`;
    const rows = cardRows(results).map(
      (r) => `${r.rank}位 ${r.name} ${r.score}点（${r.wave.split(" ")[0]} / ${r.wind.replace(" ", "")}）`
    );
    return [head, ...rows];
  }

  function shareText(region, date, slot, results, url) {
    return `${shareLines(region, date, slot, results).join("\n")}\n\n${url}`;
  }

  function shareUrl(base, region, date, slot) {
    const u = new URL(base);
    u.search = new URLSearchParams({ region, date, slot }).toString();
    return u.toString();
  }
```

`return` に3つを足す。

```js
  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl,
  };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test share.test.js`
Expected: PASS（18件）

- [ ] **Step 5: app.js に共有ボタンの行と処理を足す**

`renderResults`（373行目付近）のすぐ上に置く。

```js
// 共有ボタンの行。結果が1件以上あるときだけ描く。
function shareRow() {
  return `<div class="share-row">
      <button type="button" id="shareLine" class="share-btn line">LINEで送る</button>
      <button type="button" id="shareImage" class="share-btn">画像で共有</button>
    </div>`;
}

// LINEはURLスキームでテキストしか受け取れないので、画像とは別の導線になる。
function openLineShare(region, date, slot, results) {
  const url = Share.shareUrl(location.origin + location.pathname, region, date, slot);
  const text = Share.shareText(region, date, slot, results, url);
  const win = window.open(`https://line.me/R/msg/text/?${encodeURIComponent(text)}`, "_blank", "noopener");
  if (!win) shareError("LINEを開けませんでした");
}

// 共有ボタンの下に1行だけ出すエラー。次の共有でメッセージを差し替える。
function shareError(message) {
  const row = document.querySelector(".share-row");
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

- [ ] **Step 6: renderResults にボタンを差し込む**

`.results-head` の直後に `shareRow()` を置く。

```js
  el.innerHTML = `
    <div class="results-head">
      <h2>${escapeHtml(region)}の${escapeHtml(SLOT_LABELS[slot])}ランキング</h2>
      <span>${escapeHtml(date)} / ${results.length}件</span>
    </div>
    ${shareRow()}
    <div class="ranking-cards">
      ${results.map(resultCard).join("")}
    </div>
    ${failedNote}`;
```

`drawTideCurves(el, results, date, slot);` の直前にクリックを配線する。`innerHTML` を入れ替えた直後なのでボタンは毎回新しく、リスナーの重複は起きない。

```js
  const lineBtn = el.querySelector("#shareLine");
  if (lineBtn) lineBtn.addEventListener("click", () => openLineShare(region, date, slot, results));
```

- [ ] **Step 7: style.css に見た目を足す**

ファイル末尾に追加する。

```css
/* --- Share buttons --- */

.share-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 12px;
}

.share-btn {
  min-height: 44px;
  border: 1px solid rgba(18, 69, 89, 0.16);
  border-radius: 8px;
  background: var(--panel);
  color: var(--deep);
  font: inherit;
  font-size: 0.86rem;
  font-weight: 800;
  cursor: pointer;
}

.share-btn.line {
  border-color: transparent;
  background: #06c755;
  color: #fff;
}

.share-note {
  grid-column: 1 / -1;
  margin: 0;
}
```

- [ ] **Step 8: 画面で確認する**

ローカルサーバーでランキングを実行し、次を確認する。

- ヘッダーの下に2つのボタンが横に並ぶ
- 375px 幅で横スクロールが出ない、ボタンの高さが44px以上ある
- 「LINEで送る」を押すと `line.me` が新しいタブで開き、本文に3件と URL が入っている
- 結果が0件のとき（例: 対応範囲外の日付）はボタンが出ない

- [ ] **Step 9: テスト全体を流してコミット**

Run: `node --test`
Expected: `tests 47` / `pass 47` / `fail 0`

```bash
git add share.js share.test.js app.js style.css
git commit -m "$(printf 'feat: add a LINE share button to the ranking\n\nThe button hands LINE a plain-text summary of the top three spots plus a\nlink that restores the search. LINE URL schemes only carry text, so the\nimage gets its own button in the next commit.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 3: 共有カードの画像

1080×1080 のPNGを作り、スマホでは共有シート、PCではダウンロードに渡す。

**Files:**
- Modify: `share.js`（`drawShareCard` を追加）
- Modify: `app.js`（`shareImage` を追加し、ボタンに配線）

**Interfaces:**
- Consumes: `Share.cardRows(results)`、`Share.shareLines(...)`、`Share.shareUrl(...)`、`Share.dateParts(date)`（Task 1・2）
- Produces: `Share.drawShareCard(canvas, { region, date, slot, rows, count }) -> void`

- [ ] **Step 1: share.js に描画関数を足す**

DOM（canvas）に触るため Node のテスト対象にはしない。目視で確認する。`shareUrl` の下に置く。

```js
  const CARD_SIZE = 1080;
  const CARD_PAD = 64;
  const CARD_FONT = 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif';
  const SLOT_LONG = { morning: "朝 07-10時", afternoon: "昼 12-15時", evening: "夕 16-19時" };

  // "9月20日(日)"
  function longDateLabel(date) {
    const p = dateParts(date);
    return `${p.month}月${p.day}日(${p.weekday})`;
  }

  // 幅に収まらない名前は末尾を … にする。
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  function drawShareCard(canvas, info) {
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#edf3f5";
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.fillStyle = "#007f8f";
    ctx.font = `800 30px ${CARD_FONT}`;
    ctx.fillText("SURF CHECK", CARD_PAD, CARD_PAD + 30);

    ctx.fillStyle = "#124559";
    ctx.font = `800 54px ${CARD_FONT}`;
    ctx.fillText(`${info.region} / ${longDateLabel(info.date)}`, CARD_PAD, CARD_PAD + 104);
    ctx.fillStyle = "#687481";
    ctx.font = `700 38px ${CARD_FONT}`;
    ctx.fillText(SLOT_LONG[info.slot], CARD_PAD, CARD_PAD + 160);

    ctx.strokeStyle = "#dce5eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CARD_PAD, CARD_PAD + 200);
    ctx.lineTo(CARD_SIZE - CARD_PAD, CARD_PAD + 200);
    ctx.stroke();

    info.rows.forEach((row, i) => {
      const top = CARD_PAD + 250 + i * 200;

      // 順位バッジ
      ctx.beginPath();
      ctx.arc(CARD_PAD + 34, top + 24, 34, 0, Math.PI * 2);
      ctx.fillStyle = row.rank === 1 ? "#124559" : "#ffffff";
      ctx.fill();
      if (row.rank !== 1) {
        ctx.strokeStyle = "#124559";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = row.rank === 1 ? "#ffffff" : "#124559";
      ctx.font = `900 38px ${CARD_FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(String(row.rank), CARD_PAD + 34, top + 38);
      ctx.textAlign = "left";

      // 点数は右端から逆算して置く
      ctx.font = `900 56px ${CARD_FONT}`;
      const scoreText = String(row.score);
      const scoreWidth = ctx.measureText(scoreText).width;
      ctx.font = `700 30px ${CARD_FONT}`;
      const suffixWidth = ctx.measureText("/85").width;
      const scoreLeft = CARD_SIZE - CARD_PAD - scoreWidth - suffixWidth;
      ctx.fillStyle = "#007f8f";
      ctx.font = `900 56px ${CARD_FONT}`;
      ctx.fillText(scoreText, scoreLeft, top + 44);
      ctx.fillStyle = "#687481";
      ctx.font = `700 30px ${CARD_FONT}`;
      ctx.fillText("/85", scoreLeft + scoreWidth, top + 44);

      // ポイント名は点数の手前まで
      ctx.fillStyle = "#17212b";
      ctx.font = `800 48px ${CARD_FONT}`;
      const nameMax = scoreLeft - (CARD_PAD + 90) - 24;
      ctx.fillText(fitText(ctx, row.name, nameMax), CARD_PAD + 90, top + 40);

      ctx.fillStyle = "#687481";
      ctx.font = `600 32px ${CARD_FONT}`;
      ctx.fillText(`${row.wave} ・ ${row.wind}`, CARD_PAD + 90, top + 92);
    });

    const rest = info.count - info.rows.length;
    ctx.fillStyle = "#687481";
    ctx.font = `700 30px ${CARD_FONT}`;
    if (rest > 0) ctx.fillText(`ほか${rest}件`, CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "right";
    ctx.fillText("tk0407.github.io/surf-check", CARD_SIZE - CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "left";
  }
```

`return` に `drawShareCard` を足す。

```js
  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl, drawShareCard,
  };
```

- [ ] **Step 2: app.js に画像の共有処理を足す**

`shareError` の下に置く。`navigator.share` に `url` を渡すと、LINEなど一部のアプリが画像を捨ててURLだけを送るため、URLは `text` に入れる。

```js
// canvas -> PNG。ファイル共有ができる端末は共有シート、それ以外は保存。
async function shareImage(region, date, slot, results) {
  const canvas = document.createElement("canvas");
  Share.drawShareCard(canvas, {
    region, date, slot,
    rows: Share.cardRows(results),
    count: results.length,
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) { shareError("画像を作れませんでした"); return; }
  const file = new File([blob], `surf-check-${region}-${date}-${slot}.png`, { type: "image/png" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const url = Share.shareUrl(location.origin + location.pathname, region, date, slot);
    const lines = Share.shareLines(region, date, slot, results);
    try {
      await navigator.share({ files: [file], text: `${lines[0]}\n${url}` });
    } catch (e) {
      // 共有シートを閉じただけなので何も出さない。
      if (e.name !== "AbortError") shareError("画像を共有できませんでした");
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

- [ ] **Step 3: ボタンに配線してラベルを環境で変える**

Task 2 で足した `lineBtn` の配線のすぐ下に追加する。

```js
  const imageBtn = el.querySelector("#shareImage");
  if (imageBtn) {
    // ファイル共有ができない環境では、押す前に「保存」だと分かるようにする。
    if (!navigator.canShare) imageBtn.textContent = "画像を保存";
    imageBtn.addEventListener("click", () => shareImage(region, date, slot, results));
  }
```

- [ ] **Step 4: 生成した画像を確認する**

ブラウザでランキング（エリア「千葉北」など4件以上出るもの）を実行し、「画像で共有」／「画像を保存」を押す。保存されたPNGを開いて確認する。

Run: `sips -g pixelWidth -g pixelHeight ~/Downloads/surf-check-*.png`
Expected: `pixelWidth: 1080` / `pixelHeight: 1080`

目視で確認する項目:

- 上位3件の順位・名前・点数・波・風がすべて読める
- 長い名前（`釣ヶ崎（志田下）` `波崎シーサイドパーク` `パイプライン（茅ヶ崎）`）が点数に重ならず、はみ出す場合は `…` で切れている
- 左下に「ほかN件」、右下にURLが出ている
- 1位のバッジだけ塗りつぶしになっている

- [ ] **Step 5: 3件未満のときを確認する**

ブラウザのコンソールで1件の絵を作り、余白に描き残しが出ないことを確認する。

```js
const c = document.createElement("canvas");
Share.drawShareCard(c, {
  region: "千葉北", date: "2026-09-20", slot: "morning",
  rows: Share.cardRows([{ spot: { name: "飯岡", bearing: 90 }, scores: { total: 54 },
    data: { wave_height: 1.4, wind_dir: 225, wind_speed: 5.5 } }]),
  count: 1,
});
c.style.width = "300px";
document.body.appendChild(c);
```

Expected: 1行だけ描かれ、2行目以降の位置に何も残らない。`count` と行数が同じなので「ほかN件」は出ない。

- [ ] **Step 6: コミット**

```bash
git add share.js app.js
git commit -m "$(printf 'feat: share the ranking as a 1080px card image\n\nThe card is drawn on a 2D canvas rather than screenshotting the DOM, so\nit needs no library and looks the same in every browser. Phones get the\nshare sheet; everywhere else downloads the PNG.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 4: 共有URLの復元

`?region=&date=&slot=` を検証して選択欄に入れ、ランキングを自動実行する。実行後は現在の条件をURLに書き戻す。

**Files:**
- Modify: `share.js`（`parseParams` を追加）
- Modify: `share.test.js`（テストを追加）
- Modify: `app.js`（`applyParams` を追加、`DOMContentLoaded` から呼ぶ。`renderResults` で `replaceState`）

**Interfaces:**
- Consumes: `Share.shareUrl(...)`（Task 2）
- Produces: `Share.parseParams(search, { regions, slots }) -> { region?, date?, slot? }`

- [ ] **Step 1: 失敗するテストを書く**

`share.test.js` の末尾に追加する。

```js
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
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test share.test.js`
Expected: FAIL（`Sh.parseParams is not a function`）

- [ ] **Step 3: share.js に parseParams を足す**

`shareUrl` の下に置く。

```js
  // "2026-02-30" のような存在しない日付は Date が繰り上げてしまうので、
  // 組み立て直して元の文字列と突き合わせる。
  function isRealDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(`${value}T00:00:00`);
    if (Number.isNaN(d.getTime())) return false;
    const back = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
      + `-${String(d.getDate()).padStart(2, "0")}`;
    return back === value;
  }

  // 検証を通ったキーだけを含むオブジェクトを返す。日付は過去・未来を問わ
  // ず通す（共有された日の結果をそのまま見せるため。取得できない範囲かは
  // API の応答で決まる）。
  function parseParams(search, options) {
    const q = new URLSearchParams(search);
    const out = {};
    const region = q.get("region");
    const date = q.get("date");
    const slot = q.get("slot");
    if (region && options.regions.includes(region)) out.region = region;
    if (date && isRealDate(date)) out.date = date;
    if (slot && options.slots.includes(slot)) out.slot = slot;
    return out;
  }
```

`return` に `parseParams` を足す。

```js
  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl, drawShareCard, parseParams,
  };
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test share.test.js`
Expected: PASS（26件）

- [ ] **Step 5: app.js で復元を配線する**

`initDate` の下に置く。

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
  });
  if (params.region) regionEl.value = params.region;
  if (params.slot) slotEl.value = params.slot;
  if (params.date) {
    if (params.date < dateEl.min) dateEl.min = params.date;
    if (params.date > dateEl.max) dateEl.max = params.date;
    dateEl.value = params.date;
  }
  return Boolean(params.region || params.date || params.slot);
}
```

- [ ] **Step 6: DOMContentLoaded から自動実行する**

`spots.json` を読んだあとでないとランキングを実行できないので、`check` の配線の直後に置く。

```js
  document.getElementById("check").addEventListener("click", check);
  document.getElementById("checkTop").addEventListener("click", check);
  if (applyParams()) check();
```

- [ ] **Step 7: 実行後のURL反映を足す**

`renderResults` の末尾、`drawTideCurves(el, results, date, slot);` の直後に置く。履歴は増やさない（戻るボタンで直前のページに戻れるようにするため）。

```js
  history.replaceState(null, "", Share.shareUrl(location.origin + location.pathname, region, date, slot));
```

- [ ] **Step 8: 画面で確認する**

ローカルサーバーで次を順に開く（`<今日>` は実行日、`<3日前>` はその3日前）。

| URL | 期待 |
| --- | --- |
| `http://localhost:8000/?region=茨城&date=<今日>&slot=evening` | エリア茨城・夕が選ばれ、自動でランキングが出る |
| `http://localhost:8000/?region=ハワイ&slot=morning` | エリアは既定のまま、朝だけが選ばれて自動実行 |
| `http://localhost:8000/?date=2026-13-45` | 何も起きない（空状態のまま） |
| `http://localhost:8000/?region=茨城&date=<3日前>&slot=morning` | その過去日のランキングが出て、日付欄もその日を表示 |
| `http://localhost:8000/` | 従来どおり空状態で、自動実行しない |

チェックを押したあと、URL欄に `?region=...&date=...&slot=...` が入っていること、戻るボタンで履歴が増えていないことを確認する。

- [ ] **Step 9: 共有リンクの往復を確認する**

ランキングを出して「LINEで送る」を押し、本文のURLをコピーして新しいタブに貼る。同じエリア・日付・時間帯のランキングが再現されることを確認する。

- [ ] **Step 10: テスト全体を流してコミット**

Run: `node --test`
Expected: `tests 55` / `pass 55` / `fail 0`

```bash
git add share.js share.test.js app.js
git commit -m "$(printf 'feat: restore a search from the shared link\n\nA shared link carries region, date and slot, so whoever opens it sees the\nsame ranking. Past dates are kept as sent rather than snapped to today;\nOpen-Meteo serves them for about 92 days back.\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

### Task 5: ドキュメントと仕上げ

**Files:**
- Modify: `README.md`
- Modify: `index.html`（`?v=` の日付を上げる）
- Modify: `tasks/todo.md`（レビュー欄）

- [ ] **Step 1: README を更新する**

構成のファイル一覧に `share.js` と `share.test.js` を足し、共有機能（LINE・画像・共有リンク）の説明を1段落足す。テスト件数に触れている箇所があれば実際の数に直す。

- [ ] **Step 2: index.html の ?v= を上げる**

4か所すべてを同じ値にする。

```html
  <link rel="stylesheet" href="style.css?v=20260921" />
  ...
  <script src="scoring.js?v=20260921"></script>
  <script src="forecast.js?v=20260921"></script>
  <script src="share.js?v=20260921"></script>
  <script src="app.js?v=20260921"></script>
```

- [ ] **Step 3: 全体を通しで確認する**

- `node --test` が全件成功する
- ランキングの表示が Task 1 の前と同じ（共有ボタンの行以外）
- 週間予報タブの日付・時間帯の表示が変わっていない
- 375px で横スクロールが出ない
- 共有リンクを開くと結果が再現される
- 保存した画像が 1080×1080 である

- [ ] **Step 4: レビュー欄を書いてコミット**

`tasks/todo.md` の末尾に `## レビュー` を足し、確認した内容・変更したファイル・残っている懸念を書く（秘密情報は書かない）。

```bash
git add README.md index.html tasks/todo.md
git commit -m "$(printf 'docs: describe the share buttons and bump the asset version\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>')"
```

---

## プラン自己レビュー

- **仕様の網羅**: UI・導線 → Task 2 Step 5-7、Task 3 Step 3。共有カード → Task 3 Step 1。画像の共有と保存 → Task 3 Step 2。LINEで送る → Task 2 Step 5。共有URL（生成）→ Task 2 Step 3、（検証と復元）→ Task 4、（`history.replaceState`）→ Task 4 Step 7。モジュール構成 → Task 1〜4。エラー処理 → Task 2 の `shareError`、Task 3 の `AbortError` 無視、Task 4 の不正値切り捨て。テスト → 各タスクの Step 1。確認方法の7項目 → Task 2 Step 8、Task 3 Step 4-5、Task 4 Step 8-9、Task 5 Step 3。
- **名前の一致**: `cardRows` の返り値 `{ rank, name, score, wave, wind }` を Task 2 の `shareLines` と Task 3 の `drawShareCard` が同じ形で使う。`drawShareCard(canvas, { region, date, slot, rows, count })` は Task 3 Step 2 の呼び出しと一致。`Share.dateParts` / `Share.mdLabel` / `Share.SLOT_SHORT` は Task 1 で定義し、Task 2 の `shareLines` と Task 3 の `longDateLabel` が使う。`share.js` の `return` は Task 1 → 2 → 3 → 4 で積み増し、最終形は10個。
- **検算した値**: `2026-09-20` は日曜（`9/20(日)`）、`2026-01-01` は木曜。`bearing 90` に対し `wind_dir 225` は差45度で `サイドオフ`、`wind_dir 45` なら差135度で `サイドオン`（テスト用の値は225を使う）。`wave_height 1.4` → `カタ〜アタマ`、`2.06` → `オーバーヘッド`（`Scoring.waveSizeLabel` の閾値より）。
- **テスト件数**: 既存29 + Task 1 で11 + Task 2 で7 + Task 4 で8 = 55。
