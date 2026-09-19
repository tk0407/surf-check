# 週間予報タブ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** エリアを選ぶと、そのエリアの各サーフポイントの7日分（朝・昼・夕）の波質スコアをカードで一覧でき、セルをタップすると詳細が開く「週間予報」タブを追加する。

**Architecture:** 1時間ごとの Open-Meteo データを時間帯の平均・採点用の値・7日分の表に変換する処理を、テストできる新しいファイル `forecast.js`（`scoring.js` と同じ UMD 形式）に置く。ランキングと週間予報の両方がこれを使う。画面側（タブ、取得、描画、タップ処理）は `app.js` に追加し、既存の表示部品を使い回す。

**Tech Stack:** 素の HTML / CSS / ブラウザ JavaScript（ビルドなし）、Open-Meteo Marine + Forecast API、`node --test`（Node v23）、確認用にヘッドレス Chrome。

**Spec:** [docs/superpowers/specs/2026-09-19-weekly-forecast-design.md](../docs/superpowers/specs/2026-09-19-weekly-forecast-design.md)

## Global Constraints

- 新しいパッケージは入れない。外部スクリプトも読み込まない。
- ランキングタブは、送信 URL と `#results` の描画 HTML が変更前（`main`）と同一であること。
- 点数帯: 50点以上 `good`、30〜49点 `ok`、30点未満 `bad`（満点85）。
- 週間予報の期間: 今日〜今日+6（7日）。marine の取得は 今日-1〜今日+7、forecast は 今日〜今日+6。
- 時間帯: `morning [7,10)`、`afternoon [12,15)`、`evening [16,19)`（開始時刻以上・終了時刻未満）。
- スマホ幅 375px でページが横スクロールしないこと。
- 画面に出す文字列は `escapeHtml` を通す。
- 本番コードにテスト用の分岐を入れない。
- コミットメッセージの末尾に `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` を付ける。

---

## 確認用ハーネス（リポジトリには入れない）

画面の確認には、スクラッチパッドに置いたハーネスを使う。本物の `index.html` を iframe（既定 375px 幅）に読み込み、タブの切替・エリアの設定・チェックボタンのクリックを行い、描画結果を `<pre id="out">` に書き出す。ヘッドレス Chrome の `--dump-dom` でそれを読み取る。

- スクラッチパッド: `SP=/private/tmp/claude-501/-Users-tkasai-Projects-surf-check-deploy/5b275d7a-6c68-4a61-87e3-d43e9355d31f/scratchpad`
- `$SP/site/` : 作業ツリーのファイルへのシンボリックリンク（`index.html` `app.js` `scoring.js` `forecast.js` `style.css` `spots.json`）と `harness.html`
- `$SP/base/` : `main` を切り出した worktree と `harness.html` のコピー（変更前との比較用）
- `$SP/drive.sh <url>` : レポートを表示。`$SP/drive.sh <url> <out.png> [幅]` : スクリーンショットを保存。
- ハーネスのクエリ: `mode=ranking|weekly`、`region=`（URL エンコード。既定は茨城）、`slot=`、`date=`、`w=`（iframe 幅）、`tap=1|2|3`（1: 最初のセル、2: 最初のセルを2回、3: 最初のセルの次に2番目のセル）、`urls=1`（Open-Meteo の送信 URL を列挙）、`dump=1`（結果の innerHTML を出力）
- エリアの URL エンコード: 茨城 `%E8%8C%A8%E5%9F%8E`、湘南 `%E6%B9%98%E5%8D%97`、千葉南 `%E5%8D%83%E8%91%89%E5%8D%97`、全域 `%E5%85%A8%E5%9F%9F`
- シェルは毎回新しく起動するので、以下のコマンドはすべて先頭で `SP=...`（上記のパス）を設定してから実行する。

ユーザーの未追跡ファイル `snapshot.html` は変更しない（Task 2 以降、`forecast.js` を読み込んでいないため動かなくなる。完了時にユーザーへ伝える）。

---

### Task 1: `forecast.js`（変換ロジック）とテスト

**Files:**
- Create: `forecast.js`
- Test: `forecast.test.js`（新規）

**Interfaces:**
- Consumes: `Scoring.scoreSpot(data, bearing) -> { wind_direction, wind_speed, swell_direction, swell_period, wave_height, total }`、`Scoring.tideEvents(times, heights, date) -> [{ type: "high"|"low", time: "HH:MM", height }]`
- Produces（ブラウザでは `window.Forecast`、Node では `require("./forecast.js")`）:
  - `TIME_SLOTS: { morning: [7, 10], afternoon: [12, 15], evening: [16, 19] }`
  - `SLOT_ORDER: ["morning", "afternoon", "evening"]`
  - `averageForWindow(hourly, slot, date) -> { [key]: number|null } | null`
  - `slotConditions(marine, forecast, slot, date) -> { wind_dir, wind_speed, swell_dir, swell_period, wave_height } | null`
  - `weeklyForecast(marine, forecast, dates, bearing) -> [{ date, slots: { morning, afternoon, evening }, maxWaveHeight, tide }]`（各 slot は `{ data, scores }` または `null`）
  - `bestSlot(days) -> { date, slot, total } | null`
  - `scoreBand(total) -> "good" | "ok" | "bad"`

- [ ] **Step 1: 失敗するテストを書く**

`forecast.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("./forecast.js");
const S = require("./scoring.js");

// Open-Meteo-style hourly series: one sample per hour for each day,
// value = fn(dayIndex, hour).
function hourly(days, fields) {
  const out = { time: [] };
  for (const key of Object.keys(fields)) out[key] = [];
  days.forEach((day, di) => {
    for (let h = 0; h < 24; h++) {
      out.time.push(`${day}T${String(h).padStart(2, "0")}:00`);
      for (const [key, fn] of Object.entries(fields)) out[key].push(fn(di, h));
    }
  });
  return out;
}

// The app fetches marine one day wider on each side than the forecast.
const WEEK = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
const MARINE_DAYS = ["2026-09-18", ...WEEK, "2026-09-26"];

// M2 tide: 12.4h period cosine.
const m2 = (di, h) => 0.5 * Math.cos((2 * Math.PI * (di * 24 + h - 27)) / 12.4);

function marineSeries(overrides = {}) {
  return hourly(MARINE_DAYS, {
    wave_height: () => 1.0,
    wave_period: () => 7,
    wave_direction: () => 100,
    swell_wave_height: () => 1.25,
    swell_wave_period: () => 11,
    swell_wave_direction: () => 90,
    sea_level_height_msl: m2,
    ...overrides,
  });
}

function forecastSeries(overrides = {}) {
  return hourly(WEEK, {
    windspeed_10m: () => 3,
    winddirection_10m: () => 270,
    ...overrides,
  });
}

const BASE_DATA = { wind_dir: 270, wind_speed: 3, swell_dir: 90, swell_period: 11, wave_height: 1.25 };

// --- averageForWindow ---

test("averageForWindow averages the slot hours [start, end) of the given date only", () => {
  const h = hourly(["2026-09-19", "2026-09-20"], { v: (di, hr) => di * 100 + hr });
  // morning on 09-20 = 07,08,09 -> 107,108,109 (10:00 excluded, which would give 108.5)
  assert.deepEqual(F.averageForWindow(h, "morning", "2026-09-20"), { v: 108 });
  // evening on 09-19 = 16,17,18
  assert.deepEqual(F.averageForWindow(h, "evening", "2026-09-19"), { v: 17 });
});

test("averageForWindow skips null samples and yields null for an all-null key", () => {
  const h = hourly(["2026-09-19"], {
    v: (di, hr) => (hr === 8 ? null : hr),
    gone: () => null,
  });
  assert.deepEqual(F.averageForWindow(h, "morning", "2026-09-19"), { v: 8, gone: null });
});

test("averageForWindow returns null when the date has no samples", () => {
  const h = hourly(["2026-09-19"], { v: () => 1 });
  assert.equal(F.averageForWindow(h, "morning", "2026-09-20"), null);
});

// --- slotConditions ---

test("slotConditions prefers swell components and reads wind from the forecast series", () => {
  assert.deepEqual(F.slotConditions(marineSeries(), forecastSeries(), "morning", "2026-09-19"), BASE_DATA);
});

test("slotConditions falls back to combined-wave values when swell is missing", () => {
  const marine = marineSeries({
    swell_wave_height: () => null,
    swell_wave_period: () => null,
    swell_wave_direction: () => null,
  });
  assert.deepEqual(F.slotConditions(marine, forecastSeries(), "afternoon", "2026-09-19"), {
    wind_dir: 270, wind_speed: 3, swell_dir: 100, swell_period: 7, wave_height: 1.0,
  });
});

test("slotConditions returns null when wind is missing", () => {
  const forecast = forecastSeries({ winddirection_10m: () => null });
  assert.equal(F.slotConditions(marineSeries(), forecast, "morning", "2026-09-19"), null);
});

test("slotConditions returns null when the forecast has no samples for the date", () => {
  // marine covers 09-26 but the forecast series stops at 09-25
  assert.equal(F.slotConditions(marineSeries(), forecastSeries(), "morning", "2026-09-26"), null);
});

// --- weeklyForecast ---

test("weeklyForecast builds one entry per date with scored morning/afternoon/evening slots", () => {
  const days = F.weeklyForecast(marineSeries(), forecastSeries(), WEEK, 90);
  assert.deepEqual(days.map((d) => d.date), WEEK);
  for (const day of days) {
    assert.deepEqual(Object.keys(day.slots), ["morning", "afternoon", "evening"]);
    for (const slot of Object.values(day.slots)) {
      assert.deepEqual(slot.data, BASE_DATA);
      assert.deepEqual(slot.scores, S.scoreSpot(BASE_DATA, 90));
    }
  }
  // bearing 90: offshore wind from 270 -> 20, 3m/s -> 8, swell from 90 -> 20, 11s -> 10, 1.25m -> 10
  assert.equal(days[0].slots.morning.scores.total, 68);
});

test("weeklyForecast nulls only the slot whose hours are missing", () => {
  // forecast day index 2 = 09-21: no wind speed 12:00-14:59
  const forecast = forecastSeries({
    windspeed_10m: (di, h) => (di === 2 && h >= 12 && h < 15 ? null : 3),
  });
  const days = F.weeklyForecast(marineSeries(), forecast, WEEK, 90);
  assert.equal(days[2].slots.afternoon, null);
  assert.notEqual(days[2].slots.morning, null);
  assert.notEqual(days[2].slots.evening, null);
  assert.notEqual(days[1].slots.afternoon, null);
});

test("weeklyForecast maxWaveHeight is the largest slot wave height of the day", () => {
  const marine = marineSeries({
    swell_wave_height: (di, h) => (h < 11 ? 0.5 : h < 16 ? 1.5 : 1.25),
  });
  const days = F.weeklyForecast(marine, forecastSeries(), WEEK, 90);
  assert.equal(days[0].slots.morning.data.wave_height, 0.5);
  assert.equal(days[0].slots.afternoon.data.wave_height, 1.5);
  assert.equal(days[0].slots.evening.data.wave_height, 1.25);
  for (const day of days) assert.equal(day.maxWaveHeight, 1.5);
});

test("weeklyForecast maxWaveHeight is null when every slot of the day is missing", () => {
  const days = F.weeklyForecast(marineSeries(), forecastSeries(), ["2026-09-25", "2026-09-26"], 90);
  assert.equal(days[0].maxWaveHeight, 1.25);
  assert.deepEqual(days[1].slots, { morning: null, afternoon: null, evening: null });
  assert.equal(days[1].maxWaveHeight, null);
});

test("weeklyForecast attaches each day's own tide events", () => {
  const marine = marineSeries();
  const days = F.weeklyForecast(marine, forecastSeries(), WEEK, 90);
  for (const day of days) {
    assert.deepEqual(day.tide, S.tideEvents(marine.time, marine.sea_level_height_msl, day.date));
    assert.ok(day.tide.length >= 3, `${day.date}: ${day.tide.length} events`);
  }
  assert.notDeepEqual(days[0].tide, days[1].tide);
});

test("weeklyForecast returns empty tide lists when sea level is not provided", () => {
  const marine = marineSeries();
  delete marine.sea_level_height_msl;
  const days = F.weeklyForecast(marine, forecastSeries(), WEEK, 90);
  for (const day of days) assert.deepEqual(day.tide, []);
});

// --- bestSlot ---

function cell(total) {
  return { data: {}, scores: { total } };
}

test("bestSlot returns the highest-scoring cell", () => {
  const days = [
    { date: "2026-09-19", slots: { morning: cell(40), afternoon: cell(55), evening: null } },
    { date: "2026-09-20", slots: { morning: cell(10), afternoon: null, evening: cell(72) } },
  ];
  assert.deepEqual(F.bestSlot(days), { date: "2026-09-20", slot: "evening", total: 72 });
});

test("bestSlot breaks ties by earlier date, then morning -> afternoon -> evening", () => {
  const days = [
    { date: "2026-09-19", slots: { morning: cell(30), afternoon: cell(60), evening: cell(60) } },
    { date: "2026-09-20", slots: { morning: cell(60), afternoon: null, evening: null } },
  ];
  assert.deepEqual(F.bestSlot(days), { date: "2026-09-19", slot: "afternoon", total: 60 });
});

test("bestSlot returns null when every cell is missing", () => {
  const empty = { morning: null, afternoon: null, evening: null };
  assert.equal(F.bestSlot([{ date: "2026-09-19", slots: empty }]), null);
  assert.equal(F.bestSlot([]), null);
});

// --- scoreBand ---

test("scoreBand boundaries (good >= 50, ok >= 30)", () => {
  assert.equal(F.scoreBand(85), "good");
  assert.equal(F.scoreBand(50), "good");
  assert.equal(F.scoreBand(49), "ok");
  assert.equal(F.scoreBand(30), "ok");
  assert.equal(F.scoreBand(29), "bad");
  assert.equal(F.scoreBand(0), "bad");
});
```

テスト値は 0.5 / 1.25 / 1.5 など2進数で正確に表せる値にしている（0.8 や 1.4 は3点平均で誤差が出て `deepEqual` が不安定になるため）。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node --test forecast.test.js`
Expected: FAIL（`Cannot find module './forecast.js'`）

- [ ] **Step 3: `forecast.js` を実装する**

```js
// Hourly Open-Meteo series -> per-slot conditions and the 7-day grid.
// Shared by the ranking and weekly views; pure so it runs under node --test.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Forecast = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  // Hours are [start, end): morning covers 07:00, 08:00 and 09:00.
  const TIME_SLOTS = { morning: [7, 10], afternoon: [12, 15], evening: [16, 19] };
  const SLOT_ORDER = ["morning", "afternoon", "evening"];

  // Per-key mean over the slot's hours on `date`; null when no sample falls
  // in the window at all.
  function averageForWindow(hourly, slot, date) {
    const [startH, endH] = TIME_SLOTS[slot];
    const times = hourly.time;
    const idx = [];
    for (let i = 0; i < times.length; i++) {
      const h = parseInt(times[i].slice(11, 13), 10);
      if (times[i].startsWith(date) && h >= startH && h < endH) idx.push(i);
    }
    if (idx.length === 0) return null;
    const result = {};
    for (const key of Object.keys(hourly)) {
      if (key === "time") continue;
      const vals = idx.map((i) => hourly[key][i]).filter((v) => v !== null && v !== undefined);
      result[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return result;
  }

  function pick(primary, fallback) {
    return primary !== null && primary !== undefined ? primary : fallback;
  }

  // Scoring inputs for one slot. Swell components fall back to the combined
  // wave when the model has no swell partition.
  function slotConditions(marine, forecast, slot, date) {
    const m = averageForWindow(marine, slot, date);
    const f = averageForWindow(forecast, slot, date);
    if (!m || !f) return null;
    const data = {
      wind_dir: f.winddirection_10m,
      wind_speed: f.windspeed_10m,
      swell_dir: pick(m.swell_wave_direction, m.wave_direction),
      swell_period: pick(m.swell_wave_period, m.wave_period),
      wave_height: pick(m.swell_wave_height, m.wave_height),
    };
    return Object.values(data).some((v) => v == null) ? null : data;
  }

  function weeklyForecast(marine, forecast, dates, bearing) {
    return dates.map((date) => {
      const slots = {};
      const heights = [];
      for (const slot of SLOT_ORDER) {
        const data = slotConditions(marine, forecast, slot, date);
        slots[slot] = data ? { data, scores: Scoring.scoreSpot(data, bearing) } : null;
        if (data) heights.push(data.wave_height);
      }
      return {
        date,
        slots,
        maxWaveHeight: heights.length ? Math.max(...heights) : null,
        tide: Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date),
      };
    });
  }

  // Highest total; strict ">" keeps the first cell in date then slot order on ties.
  function bestSlot(days) {
    let best = null;
    for (const day of days) {
      for (const slot of SLOT_ORDER) {
        const cell = day.slots[slot];
        if (cell && (!best || cell.scores.total > best.total)) {
          best = { date: day.date, slot, total: cell.scores.total };
        }
      }
    }
    return best;
  }

  function scoreBand(total) {
    if (total >= 50) return "good";
    if (total >= 30) return "ok";
    return "bad";
  }

  return {
    TIME_SLOTS, SLOT_ORDER, averageForWindow, slotConditions,
    weeklyForecast, bestSlot, scoreBand,
  };
});
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `node --test`
Expected: PASS。末尾の集計が `ℹ tests 29`（`scoring.test.js` 12件 + `forecast.test.js` 17件）、`ℹ fail 0`

- [ ] **Step 5: コミット**

```bash
git add forecast.js forecast.test.js
git commit -m "feat: add forecast.js slot/weekly conversion with tests"
```

---

### Task 2: ランキングを `forecast.js` 経由に切り替える（見た目は変えない）

**Files:**
- Modify: `app.js`（`TIME_SLOTS` 定義、`pick`、`fetchSpotData`、`averageForWindow`、`rankSpot`）
- Modify: `index.html`（`forecast.js` の読み込み）

**Interfaces:**
- Consumes: `Forecast.TIME_SLOTS`、`Forecast.slotConditions`
- Produces: `fetchSpotData(lat, lon, startDate, endDate) -> Promise<{ marine, forecast }>`（marine は `startDate-1`〜`endDate+1`、forecast は `startDate`〜`endDate`）

- [ ] **Step 1: 比較用に `main` の worktree とハーネス用サーバーを用意する**

```bash
SP=/private/tmp/claude-501/-Users-tkasai-Projects-surf-check-deploy/5b275d7a-6c68-4a61-87e3-d43e9355d31f/scratchpad
git -C /Users/tkasai/Projects/surf-check-deploy worktree add --detach "$SP/base" main
cp "$SP/site/harness.html" "$SP/base/harness.html"
chmod +x "$SP/drive.sh"
# 8001 番で $SP/site を配信中のサーバーがあれば先に止める。
# $SP をルートに 8001 番で配信し直す（バックグラウンド）。site/ と base/ の両方を出す
(cd "$SP" && python3 -m http.server 8001)
```

Expected: `http://localhost:8001/base/harness.html` と `http://localhost:8001/site/harness.html` が 200 を返す。

- [ ] **Step 2: `app.js` を書き換える**

`TIME_SLOTS` の定義（9行目）を置き換える:

```js
const TIME_SLOTS = Forecast.TIME_SLOTS;
```

`pick`（32〜34行目）を削除する。

`fetchSpotData`（42〜58行目、直前のコメントを含む）を置き換える:

```js
// Marine data spans start-1..end+1 so tide extremes near midnight are
// detected; forecast covers only start..end, so the two hourly series have
// different lengths and must be kept separate (never merged index-wise).
async function fetchSpotData(lat, lon, startDate, endDate) {
  const base = { latitude: lat, longitude: lon, timezone: "Asia/Tokyo" };
  const marineUrl = `${MARINE_URL}?${qs({
    ...base, start_date: shiftDate(startDate, -1), end_date: shiftDate(endDate, 1),
    hourly: MARINE_PARAMS.join(","),
  })}`;
  const forecastUrl = `${FORECAST_URL}?${qs({
    ...base, start_date: startDate, end_date: endDate,
    hourly: FORECAST_PARAMS.join(","), wind_speed_unit: "ms",
  })}`;
  const [m, f] = await Promise.all([fetch(marineUrl), fetch(forecastUrl)]);
  if (!m.ok || !f.ok) throw new Error("API error");
  return { marine: (await m.json()).hourly, forecast: (await f.json()).hourly };
}
```

`averageForWindow`（60〜76行目）を削除する。

`rankSpot` の冒頭〜`scores` までを置き換える（`tide` 以降はそのまま）:

```js
async function rankSpot(spot, date, slot) {
  const { marine, forecast } = await fetchSpotData(spot.lat, spot.lon, date, date);
  const data = Forecast.slotConditions(marine, forecast, slot, date);
  if (!data) throw new Error("予報データなし");
  const scores = Scoring.scoreSpot(data, spot.bearing);
  const tide = Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date);
  const tideTrend = tideTrendLabel(marine, slot, date);
  const tideSeries = daySeries(marine, date);
  return { spot, scores, data, tide, tideTrend, tideSeries };
}
```

- [ ] **Step 3: `index.html` で `forecast.js` を読み込む**

```html
  <script src="scoring.js"></script>
  <script src="forecast.js"></script>
  <script src="app.js"></script>
```

- [ ] **Step 4: 単体テストを流す**

Run: `node --test`
Expected: PASS（fail 0）

- [ ] **Step 5: `main` と送信 URL・描画 HTML を比較する**

明日の日付を使う（今日だと「現在時刻」の縦線の位置が実行のたびに変わるため）。

```bash
SP=/private/tmp/claude-501/-Users-tkasai-Projects-surf-check-deploy/5b275d7a-6c68-4a61-87e3-d43e9355d31f/scratchpad
TOMORROW=$(date -v+1d +%F)
for q in "region=%E8%8C%A8%E5%9F%8E&slot=morning" "region=%E6%B9%98%E5%8D%97&slot=evening" "region=%E5%8D%83%E8%91%89%E5%8D%97&slot=afternoon"; do
  "$SP/drive.sh" "http://localhost:8001/base/harness.html?$q&date=$TOMORROW&urls=1&dump=1" > "$SP/base.txt"
  "$SP/drive.sh" "http://localhost:8001/site/harness.html?$q&date=$TOMORROW&urls=1&dump=1" > "$SP/site.txt"
  head -1 "$SP/site.txt"; diff -q "$SP/base.txt" "$SP/site.txt" && echo "SAME: $q"
done
```

Expected: 3回とも `DONE` と `SAME: ...`。差分が出た場合は、Open-Meteo のデータ更新の可能性を除くためもう一度実行し、それでも出るなら `diff` の中身を調べて直す。

- [ ] **Step 6: コミット**

```bash
git add app.js index.html
git commit -m "refactor: route ranking through forecast.js"
```

---

### Task 3: 週間予報タブ（タブ切替・7日分の取得・スコア表）

**Files:**
- Modify: `index.html`（タブ、`data-mode`、`ranking-only` / `weekly-only`、`#weekly`）
- Modify: `app.js`（定数、日付ラベル、`check`、`runRanking`、週間予報の取得と描画、タブ切替）
- Modify: `style.css`（末尾に追加）

**Interfaces:**
- Consumes: `fetchSpotData(lat, lon, startDate, endDate)`、`Forecast.weeklyForecast`、`Forecast.bestSlot`、`Forecast.scoreBand`、`Forecast.SLOT_ORDER`、既存の `fmtDate`、`shiftDate`、`filterByRegion`、`escapeHtml`
- Produces:
  - `WEEKLY_RESULTS: [{ spot, days, best }]`（`days` は `weeklyForecast` の戻り値、`best` は `bestSlot` の戻り値）
  - `mdLabel(date) -> "9/19(土)"`、`dayColumnLabel(date) -> "土19"`、`SLOT_SHORT`
  - DOM: `article.wk-card[data-index]` の中に `button.wk-cell[data-day][data-slot][aria-pressed]`（データなしは `span.wk-cell.empty`）、`td.wk-wave`、空の `div.wk-detail-slot`

- [ ] **Step 1: ハーネスが失敗することを確認する（Red）**

```bash
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly"
```

Expected: `pending`（週間予報タブのボタンがまだないため）

- [ ] **Step 2: `index.html` を書き換える**

`<main class="app-shell">` を `<main class="app-shell" data-mode="ranking">` にする。

`</header>` の直後にタブを追加する:

```html
    <nav class="mode-tabs" role="tablist" aria-label="表示モード">
      <button type="button" class="mode-tab" role="tab" data-mode="ranking" aria-controls="results" aria-selected="true">ランキング</button>
      <button type="button" class="mode-tab" role="tab" data-mode="weekly" aria-controls="weekly" aria-selected="false">週間予報</button>
    </nav>
```

「日付」と「時間帯」の `<label>` を `<label class="ranking-only">` にする。

`#results` を `<section id="results" class="results ranking-only" aria-live="polite">` にし、その直後に追加する:

```html
    <section id="weekly" class="results weekly-only" aria-live="polite">
      <div class="empty-state">
        <b>エリアを選んでチェック</b>
        <span>各ポイントの7日分のスコアを、朝・昼・夕で比較できます。</span>
      </div>
    </section>
```

- [ ] **Step 3: `app.js` に週間予報を追加する**

`SLOT_LABELS` の直後に定数を追加する:

```js
const SLOT_SHORT = { morning: "朝", afternoon: "昼", evening: "夕" };
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
const WEEK_DAYS = 7;
```

`shiftDate` の直後に日付ラベルを追加する:

```js
function dateParts(date) {
  const d = new Date(`${date}T00:00:00`);
  return { month: d.getMonth() + 1, day: d.getDate(), weekday: WEEKDAYS_JA[d.getDay()] };
}

// "9/19(土)"
function mdLabel(date) {
  const p = dateParts(date);
  return `${p.month}/${p.day}(${p.weekday})`;
}

// "土19" — weekly grid column header
function dayColumnLabel(date) {
  const p = dateParts(date);
  return `${p.weekday}${p.day}`;
}
```

`run` を `runRanking` に改名し、ボタンの無効化を `check` に移す（`run` 全体をこれに置き換える）:

```js
async function runRanking() {
  const region = document.getElementById("region").value;
  const date = document.getElementById("date").value;
  const slot = document.getElementById("slot").value;
  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = `<div class="loading"><b>取得中...</b><span>Open-Meteoから波・風・潮汐データを読み込んでいます。</span></div>`;
  try {
    const spots = filterByRegion(region);
    const settled = await Promise.allSettled(spots.map((s) => rankSpot(s, date, slot)));
    const ok = [];
    const failed = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") ok.push(res.value);
      else failed.push(spots[i].name);
    });
    ok.sort((a, b) => b.scores.total - a.scores.total);
    renderResults(resultsEl, region, date, slot, ok, failed);
  } catch (e) {
    resultsEl.innerHTML = `<p class="failed">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

async function weeklySpot(spot, dates) {
  const { marine, forecast } = await fetchSpotData(spot.lat, spot.lon, dates[0], dates[dates.length - 1]);
  const days = Forecast.weeklyForecast(marine, forecast, dates, spot.bearing);
  const best = Forecast.bestSlot(days);
  if (!best) throw new Error("予報データなし");
  return { spot, days, best };
}

function weeklyCell(day, slot, dayIndex) {
  const cell = day.slots[slot];
  if (!cell) return `<td><span class="wk-cell empty" aria-label="データなし">–</span></td>`;
  const total = cell.scores.total;
  const label = `${mdLabel(day.date)} ${SLOT_SHORT[slot]} ${total}点`;
  return `<td><button type="button" class="wk-cell ${Forecast.scoreBand(total)}" data-day="${dayIndex}" data-slot="${slot}" aria-pressed="false" aria-label="${escapeHtml(label)}">${total}</button></td>`;
}

function weeklyCard(result, index) {
  const best = result.best;
  const head = result.days.map((day) => `<th scope="col">${escapeHtml(dayColumnLabel(day.date))}</th>`).join("");
  const rows = Forecast.SLOT_ORDER.map((slot) => {
    const cells = result.days.map((day, di) => weeklyCell(day, slot, di)).join("");
    return `<tr><th scope="row">${SLOT_SHORT[slot]}</th>${cells}</tr>`;
  }).join("");
  const waves = result.days.map((day) =>
    `<td class="wk-wave">${day.maxWaveHeight == null ? "–" : day.maxWaveHeight.toFixed(1)}</td>`).join("");

  return `<article class="ranking-card wk-card" data-index="${index}">
    <div class="wk-card-head">
      <span class="ranking-card-title">
        <b>${escapeHtml(result.spot.name)}</b>
        <span>${escapeHtml(result.spot.region)}</span>
      </span>
      <span class="wk-best">ベスト <b>${escapeHtml(dayColumnLabel(best.date))} ${SLOT_SHORT[best.slot]} ${best.total}点</b></span>
    </div>
    <table class="wk-grid">
      <thead><tr><th></th>${head}</tr></thead>
      <tbody>${rows}<tr><th scope="row">波</th>${waves}</tr></tbody>
    </table>
    <div class="wk-detail-slot"></div>
  </article>`;
}

let WEEKLY_RESULTS = [];

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
      <span>${escapeHtml(mdLabel(dates[0]))}〜${escapeHtml(mdLabel(dates[dates.length - 1]))} / ${results.length}件</span>
    </div>
    <div class="ranking-cards">
      ${results.map(weeklyCard).join("")}
    </div>
    ${failedNote}`;
}

async function runWeekly() {
  const region = document.getElementById("region").value;
  const weeklyEl = document.getElementById("weekly");
  weeklyEl.innerHTML = `<div class="loading"><b>取得中...</b><span>Open-Meteoから7日分の波・風・潮汐データを読み込んでいます。</span></div>`;
  try {
    const today = fmtDate(new Date());
    const dates = Array.from({ length: WEEK_DAYS }, (_, i) => shiftDate(today, i));
    const spots = filterByRegion(region);
    const settled = await Promise.allSettled(spots.map((s) => weeklySpot(s, dates)));
    const ok = [];
    const failed = [];
    settled.forEach((res, i) => {
      if (res.status === "fulfilled") ok.push(res.value);
      else failed.push(spots[i].name);
    });
    renderWeekly(weeklyEl, region, dates, ok, failed);
  } catch (e) {
    weeklyEl.innerHTML = `<p class="failed">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

function currentMode() {
  return document.querySelector(".app-shell").dataset.mode;
}

function setMode(mode) {
  document.querySelector(".app-shell").dataset.mode = mode;
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.mode === mode));
  });
}

// Both check buttons run whichever view is active; disabled while loading.
async function check() {
  const buttons = [document.getElementById("check"), document.getElementById("checkTop")].filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    if (currentMode() === "weekly") await runWeekly();
    else await runRanking();
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}
```

`DOMContentLoaded` の中を次のように変える（タブの配線を追加し、チェックボタンを `check` につなぐ）:

```js
  resultsEl.addEventListener("pointerleave", hideTideHover);
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });
  const r = await fetch("spots.json");
  SPOTS = await r.json();
  document.getElementById("check").addEventListener("click", check);
  document.getElementById("checkTop").addEventListener("click", check);
});
```

- [ ] **Step 4: `style.css` の末尾に追加する**

```css
/* --- Mode tabs --- */

.mode-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  margin-bottom: 10px;
  padding: 4px;
  border: 1px solid rgba(18, 69, 89, 0.12);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.9);
}

.mode-tab {
  min-height: 36px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 0.88rem;
  font-weight: 800;
  cursor: pointer;
}

.mode-tab[aria-selected="true"] {
  background: var(--deep);
  color: #fff;
}

.app-shell[data-mode="weekly"] .ranking-only,
.app-shell[data-mode="ranking"] .weekly-only {
  display: none;
}

.app-shell[data-mode="weekly"] .controls {
  grid-template-columns: minmax(0, 1fr) auto;
}

/* --- Weekly forecast --- */

.wk-card-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
  margin-bottom: 8px;
}

.wk-best {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 800;
  white-space: nowrap;
}

.wk-best b {
  color: var(--deep);
  font-size: 0.84rem;
  font-weight: 900;
}

.wk-grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 3px;
  table-layout: fixed;
  font-variant-numeric: tabular-nums;
}

.wk-grid th {
  padding: 0;
  color: var(--muted);
  font-size: 0.66rem;
  font-weight: 800;
  text-align: center;
  white-space: nowrap;
}

.wk-grid thead th:first-child {
  width: 22px;
}

.wk-grid td {
  padding: 0;
}

.wk-cell {
  display: grid;
  place-items: center;
  width: 100%;
  min-height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 6px;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 850;
  cursor: pointer;
}

.wk-cell.good {
  background: rgba(29, 154, 114, 0.14);
  color: var(--good);
}

.wk-cell.ok {
  background: rgba(244, 201, 107, 0.24);
  color: var(--ok);
}

.wk-cell.bad {
  background: rgba(239, 111, 94, 0.1);
  color: #b84a3c;
}

.wk-cell.empty {
  background: #f1f4f6;
  color: var(--muted);
  cursor: default;
}

.wk-wave {
  color: var(--deep);
  font-size: 0.74rem;
  font-weight: 800;
  text-align: center;
}
```

- [ ] **Step 5: 単体テストとハーネスで確認する（Green）**

```bash
node --test
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&urls=1"
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&region=%E5%85%A8%E5%9F%9F"
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&w=900"
```

Expected:
- `node --test` は fail 0。
- 茨城: `head=茨城の週間予報 {今日}〜{今日+6} / 4件`。各カードの行にセルが21個、波の値が7個。`details=0 pressed=0`、`failed=none`、`overflowX=false`。
- `urls=1`: marine は `start_date=今日-1&end_date=今日+7`、forecast は `start_date=今日&end_date=今日+6` が茨城の4スポット分。
- 全域: 32件（失敗があれば `failed=取得失敗: …` に名前が出る）、`overflowX=false`。
- 900px 幅: `overflowX=false`。

- [ ] **Step 6: ランキングが `main` と同一のままか確認する**

Task 2 Step 5 のループをもう一度実行する。Expected: 3回とも `SAME`。

- [ ] **Step 7: スクリーンショットで見た目を確認する**

```bash
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly" "$SP/weekly-375.png" 375
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&w=900" "$SP/weekly-900.png" 900
```

両方の画像を開いて見る。確認すること: タブの選択状態、日付・時間帯の入力が隠れていること、表が枠からはみ出していないこと、色分けが読めること、「ベスト」表示が名前と重ならないこと。

- [ ] **Step 8: コミット**

```bash
git add index.html app.js style.css
git commit -m "feat: add weekly forecast tab with per-spot 7-day score grid"
```

---

### Task 4: セルをタップして詳細を展開する

**Files:**
- Modify: `app.js`（`conditionMetrics` の切り出し、`resultCard`、`weeklyDetail`、`onWeeklyClick`、配線）
- Modify: `style.css`（末尾に追加）

**Interfaces:**
- Consumes: `WEEKLY_RESULTS`、`mdLabel`、`SLOT_LABELS`、`tideTimesLabel`、`reasonChips`、`metricIcon`、`jpDirection`、`windConditionLabel`、`waveIconClass`
- Produces: `conditionMetrics(data, bearing) -> HTML`（ランキングカードと詳細の両方が使う `card-metrics` ブロック）

- [ ] **Step 1: ハーネスが失敗することを確認する（Red）**

```bash
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&tap=1"
```

Expected: `details=0 pressed=0`（クリックしても何も起きない）

- [ ] **Step 2: `conditionMetrics` を切り出し、`resultCard` から使う**

`resultCard` の直前に追加する。返す文字列は、変更前の `resultCard` の `card-metrics` ブロックと1文字も違わないようにする（インデントも含む）:

```js
function conditionMetrics(data, bearing) {
  const waveSize = Scoring.waveSizeLabel(data.wave_height);
  const windCondition = windConditionLabel(data.wind_dir, data.wind_speed, bearing);
  const windFlowDeg = data.wind_dir + 180;
  const swellFlowDeg = data.swell_dir + 180;
  return `<div class="card-metrics">
      <span class="mini-metric">
        <b>波サイズ</b>
        <span class="wave-icon ${waveIconClass(data.wave_height)}" aria-hidden="true"></span>
        <span><strong>${data.wave_height.toFixed(1)}m ${escapeHtml(waveSize)}</strong><span class="metric-sub">周期 ${data.swell_period.toFixed(1)}s</span></span>
      </span>
      <span class="mini-metric">
        <b>風向き</b>
        ${metricIcon(windFlowDeg, data.wind_speed)}
        <span><strong>${escapeHtml(windCondition)}</strong><span class="metric-sub">${escapeHtml(jpDirection(data.wind_dir))}風 ${data.wind_speed.toFixed(1)}m/s</span></span>
      </span>
      <span class="mini-metric">
        <b>うねりの向き</b>
        ${metricIcon(swellFlowDeg)}
        <span><strong>${escapeHtml(jpDirection(data.swell_dir))}うねり</strong></span>
      </span>
    </div>`;
}
```

`resultCard` を次のように置き換える:

```js
function resultCard(result, index) {
  const rank = index + 1;
  const featured = index === 0 ? " featured" : "";

  return `<article class="ranking-card${featured}">
    <div class="ranking-card-head">
      <span class="medal">${rank}</span>
      <span class="ranking-card-title">
        <b>${escapeHtml(result.spot.name)}</b>
        <span>${escapeHtml(result.spot.region)} / ${rank === 1 ? "BEST" : "候補"}</span>
      </span>
      <span class="ranking-score">${result.scores.total}<span>/85</span></span>
    </div>

    ${conditionMetrics(result.data, result.spot.bearing)}

    <div class="tide-panel">
      <div class="tide-head">
        <span class="tide-now">潮汐</span>
        <span class="tide-percent">${escapeHtml(result.tideTrend || "")}</span>
      </div>
      ${result.tideSeries ? `<svg class="tide-curve" data-index="${index}" role="img" aria-label="${escapeHtml(tideAriaLabel(result.tide))}"></svg>` : ""}
      <div class="tide-times">
        <span class="tide-time"><b>満潮</b><strong>${escapeHtml(tideTimesLabel(result.tide, "high"))}</strong></span>
        <span class="tide-time"><b>干潮</b><strong>${escapeHtml(tideTimesLabel(result.tide, "low"))}</strong></span>
      </div>
    </div>

    <div class="reason-row">${reasonChips(result)}</div>
  </article>`;
}
```

- [ ] **Step 3: 詳細の描画とタップ処理を追加する**

`runWeekly` の直前に追加する:

```js
function weeklyDetail(spot, day, slot) {
  const { data, scores } = day.slots[slot];
  return `<div class="wk-detail">
    <div class="wk-detail-head">
      <b>${escapeHtml(mdLabel(day.date))} ${escapeHtml(SLOT_LABELS[slot])}</b>
      <span class="ranking-score">${scores.total}<span>/85</span></span>
    </div>
    ${conditionMetrics(data, spot.bearing)}
    <div class="tide-times">
      <span class="tide-time"><b>満潮</b><strong>${escapeHtml(tideTimesLabel(day.tide, "high"))}</strong></span>
      <span class="tide-time"><b>干潮</b><strong>${escapeHtml(tideTimesLabel(day.tide, "low"))}</strong></span>
    </div>
    <div class="reason-row">${reasonChips({ scores })}</div>
  </div>`;
}

// One open detail per card: tapping the open cell closes it, tapping another
// cell in the same card switches to it.
function onWeeklyClick(e) {
  const btn = e.target.closest ? e.target.closest("button.wk-cell") : null;
  if (!btn) return;
  const card = btn.closest(".wk-card");
  const detailSlot = card.querySelector(".wk-detail-slot");
  const wasOpen = btn.getAttribute("aria-pressed") === "true";
  card.querySelectorAll('button.wk-cell[aria-pressed="true"]').forEach((b) => b.setAttribute("aria-pressed", "false"));
  if (wasOpen) {
    detailSlot.innerHTML = "";
    return;
  }
  const result = WEEKLY_RESULTS[parseInt(card.dataset.index, 10)];
  const day = result.days[parseInt(btn.dataset.day, 10)];
  btn.setAttribute("aria-pressed", "true");
  detailSlot.innerHTML = weeklyDetail(result.spot, day, btn.dataset.slot);
}
```

`DOMContentLoaded` のタブ配線の直後に追加する:

```js
  document.getElementById("weekly").addEventListener("click", onWeeklyClick);
```

- [ ] **Step 4: `style.css` の末尾に追加する**

```css
.wk-cell[aria-pressed="true"] {
  border-color: var(--deep);
  box-shadow: 0 0 0 1px var(--deep);
}

.wk-detail {
  display: grid;
  gap: 10px;
  margin-top: 10px;
  padding-top: 12px;
  border-top: 1px solid var(--line);
}

.wk-detail-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  align-items: center;
}

.wk-detail-head b {
  color: var(--deep);
  font-size: 0.9rem;
}

.wk-detail .card-metrics {
  margin-bottom: 0;
}
```

- [ ] **Step 5: ハーネスで確認する（Green）**

```bash
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&tap=1"
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&tap=2"
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&tap=3"
```

Expected:
- `tap=1`: `details=1 pressed=1`。`detail:` の行が `{今日の月/日(曜)} 朝（07-10時） NN/85` で始まり、`波サイズ`、`風向き`、`うねりの向き`、`満潮`、`干潮` と理由チップの文言を含む。`overflowX=false`。
- `tap=2`（同じセルを2回）: `details=0 pressed=0`。
- `tap=3`（別のセルへ切替）: `details=1 pressed=1`。見出しが2番目のセル（明日の朝）の日付になっている。

- [ ] **Step 6: ランキングが `main` と同一のままか確認する**

Task 2 Step 5 のループをもう一度実行する（`resultCard` を書き換えたため）。Expected: 3回とも `SAME`。

- [ ] **Step 7: 詳細を開いた状態のスクリーンショットを確認する**

```bash
"$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&tap=1" "$SP/weekly-detail-375.png" 375
```

画像を開いて、詳細パネルがカード内に収まり、コンパスと風速リング、満潮・干潮、理由チップが崩れずに出ていることを見る。

- [ ] **Step 8: コミット**

```bash
git add app.js style.css
git commit -m "feat: expand slot details when a weekly grid cell is tapped"
```

---

### Task 5: README の更新と最終確認

**Files:**
- Modify: `README.md`
- Modify: `tasks/todo.md`（レビュー欄）

- [ ] **Step 1: README を更新する**

冒頭の説明文を置き換える:

```markdown
エリア・日付・時間帯を選ぶと、関東のサーフポイントを波質スコアでランキング表示する静的Webアプリ。
「週間予報」タブでは、エリア内の各ポイントの7日分のスコアを朝・昼・夕で一覧でき、セルをタップすると詳細を表示する。
データは [Open-Meteo](https://open-meteo.com)（Marine + Forecast API）をブラウザから直接取得。サーバー・APIキー不要。
```

「構成」を置き換える:

````markdown
```
index.html        UI
style.css
scoring.js        採点ロジック
forecast.js       時間帯平均・週間予報の組み立て（ランキングと共用）
app.js            取得→描画、タブ切替
spots.json        スポットデータ
scoring.test.js   テスト（採点）
forecast.test.js  テスト（時間帯平均・週間予報）
```
````

「テスト」のコマンドを `node --test`（全テストファイルを実行）に変える。

- [ ] **Step 2: 最終確認**

```bash
node --test
TOMORROW=$(date -v+1d +%F)
# ランキングが main と同一（Task 2 Step 5 のループ）
# 週間予報: 全エリア
for r in "%E8%8C%A8%E5%9F%8E" "%E6%B9%98%E5%8D%97" "%E5%8D%83%E8%91%89%E5%8D%97" "%E5%85%A8%E5%9F%9F"; do
  "$SP/drive.sh" "http://localhost:8001/site/harness.html?mode=weekly&region=$r" | grep -E "^(head|failed|overflowX)="
done
```

Expected: テストは fail 0、ランキングは `SAME`、週間予報は全エリアで `failed=none`（通信失敗があれば名前が出る）と `overflowX=false`。

- [ ] **Step 3: この `tasks/todo.md` の末尾にレビュー欄を書く**

実施した確認と結果、残っている懸念（あれば）を書く。秘密情報は書かない。

- [ ] **Step 4: コミット**

```bash
git add README.md tasks/todo.md
git commit -m "docs: describe weekly forecast tab and forecast.js"
```

- [ ] **Step 5: 後片付けとユーザー確認**

```bash
git -C /Users/tkasai/Projects/surf-check-deploy worktree remove "$SP/base"
```

8001 番のサーバーを止める。ユーザーに `http://localhost:8000/` で両タブとセルのタップを手元のブラウザで確認してもらう。`snapshot.html` は `forecast.js` を読み込んでいないため動かなくなっていることを伝える（`scoring.js` と `app.js` の間に `<script src="forecast.js"></script>` を足せば直る）。
