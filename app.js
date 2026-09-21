const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_PARAMS = [
  "wave_height", "wave_period", "wave_direction",
  "swell_wave_height", "swell_wave_period", "swell_wave_direction",
  "sea_surface_temperature", "sea_level_height_msl",
];
const FORECAST_PARAMS = ["windspeed_10m", "winddirection_10m"];
const TIME_SLOTS = Forecast.TIME_SLOTS;
const SLOT_LABELS = { morning: "朝（07-10時）", afternoon: "昼（12-15時）", evening: "夕（16-19時）" };
const WEEK_DAYS = 7;

let SPOTS = [];

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

function filterByRegion(region) {
  if (region === "全域") return SPOTS;
  return SPOTS.filter((s) => s.region.includes(region) || s.region === region);
}

function shiftDate(date, days) {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

// "土19" — weekly grid column header
function dayColumnLabel(date) {
  const p = Share.dateParts(date);
  return `${p.weekday}${p.day}`;
}

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

function tideTrendLabel(marine, slot, date) {
  const levels = marine.sea_level_height_msl;
  if (!levels) return "";
  const [startH, endH] = TIME_SLOTS[slot];
  const levelAt = (h) => {
    const i = marine.time.indexOf(`${date}T${String(h).padStart(2, "0")}:00`);
    return i >= 0 ? levels[i] : null;
  };
  const start = levelAt(startH);
  const end = levelAt(endH);
  if (start === null || end === null) return "";
  if (end - start > 0.05) return "時間帯は上げ潮";
  if (start - end > 0.05) return "時間帯は下げ潮";
  return "時間帯は潮止まり前後";
}

// Hourly sea level for `date`, closed at 24:00 with the next day's first
// sample so the sparkline reaches the right edge.
function daySeries(marine, date) {
  const levels = marine.sea_level_height_msl;
  if (!levels) return null;
  const minutes = [];
  const heights = [];
  for (let i = 0; i < marine.time.length; i++) {
    if (marine.time[i].startsWith(date)) {
      minutes.push(parseInt(marine.time[i].slice(11, 13), 10) * 60);
      heights.push(levels[i]);
    } else if (minutes.length && minutes[minutes.length - 1] < 1440) {
      minutes.push(1440);
      heights.push(levels[i]);
      break;
    }
  }
  if (!heights.some((v) => v != null)) return null;
  return { minutes, heights };
}

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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function waveIconClass(height) {
  if (height < 0.8) return "small";
  if (height < 1.2) return "medium";
  return "large";
}

function tideTimesLabel(events, type) {
  const times = (events || []).filter((e) => e.type === type).map((e) => e.time);
  return times.length ? times.join(" / ") : "--:--";
}

function tideAriaLabel(events) {
  const high = tideTimesLabel(events, "high").replace(" / ", "・");
  const low = tideTimesLabel(events, "low").replace(" / ", "・");
  return `潮位の推移: 満潮 ${high} / 干潮 ${low}`;
}

function hhmmToMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
}

function minutesToHhmm(min) {
  if (min >= 1440) return "24:00";
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

const CURVE_H = 72;
const CURVE_PAD = 8;

// Shared x/y scales so the static render and the hover layer agree.
// The extent includes the refined extrema heights, which can poke past
// the hourly samples.
function tideScale(series, events, width) {
  const values = series.heights.filter((v) => v != null).concat(events.map((e) => e.height));
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 0.2) { const mid = (hi + lo) / 2; lo = mid - 0.1; hi = mid + 0.1; }
  const pad = (hi - lo) * 0.15;
  lo -= pad;
  hi += pad;
  return {
    x: (min) => (min / 1440) * width,
    y: (h) => CURVE_H - CURVE_PAD - ((h - lo) / (hi - lo)) * (CURVE_H - 2 * CURVE_PAD),
    lo,
    hi,
  };
}

// Catmull-Rom through the sample points, emitted as cubic beziers.
function smoothPath(pts) {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C ${c1[0].toFixed(1)} ${c1[1].toFixed(1)}, ${c2[0].toFixed(1)} ${c2[1].toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function tideCurveSvg(series, events, slot, date, width, nowMinutes) {
  const scale = tideScale(series, events, width);
  const pts = [];
  for (let i = 0; i < series.minutes.length; i++) {
    if (series.heights[i] == null) continue;
    pts.push([scale.x(series.minutes[i]), scale.y(series.heights[i])]);
  }
  if (pts.length < 2) return "";
  const curve = smoothPath(pts);
  const area = `${curve} L ${pts[pts.length - 1][0].toFixed(1)} ${CURVE_H} L ${pts[0][0].toFixed(1)} ${CURVE_H} Z`;

  const [startH, endH] = TIME_SLOTS[slot];
  const parts = [];
  parts.push(`<rect x="${scale.x(startH * 60).toFixed(1)}" y="0" width="${(scale.x(endH * 60) - scale.x(startH * 60)).toFixed(1)}" height="${CURVE_H}" fill="rgba(18, 69, 89, 0.05)"/>`);
  if (scale.lo < 0 && scale.hi > 0) {
    const y0 = scale.y(0).toFixed(1);
    parts.push(`<line x1="0" x2="${width}" y1="${y0}" y2="${y0}" stroke="#dce5eb" stroke-width="1"/>`);
  }
  parts.push(`<path d="${area}" fill="#007f8f" fill-opacity="0.1"/>`);
  parts.push(`<path d="${curve}" fill="none" stroke="#007f8f" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
  if (nowMinutes != null && nowMinutes >= 0 && nowMinutes <= 1440) {
    const xn = scale.x(nowMinutes).toFixed(1);
    parts.push(`<line x1="${xn}" x2="${xn}" y1="0" y2="${CURVE_H}" stroke="rgba(23, 33, 43, 0.3)" stroke-width="1"/>`);
  }
  for (const e of events) {
    parts.push(`<circle cx="${scale.x(hhmmToMinutes(e.time)).toFixed(1)}" cy="${scale.y(e.height).toFixed(1)}" r="4" fill="#007f8f" stroke="#eef8f7" stroke-width="2"/>`);
  }
  parts.push(`<line class="tc-cross" x1="0" x2="0" y1="0" y2="${CURVE_H}" stroke="rgba(23, 33, 43, 0.35)" stroke-width="1" visibility="hidden"/>`);
  parts.push(`<circle class="tc-dot" cx="0" cy="0" r="4" fill="#124559" stroke="#eef8f7" stroke-width="2" visibility="hidden"/>`);
  return parts.join("");
}

function chip(label, tone = "ok") {
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

function reasonChips(result) {
  const chips = [];
  if (result.scores.swell_direction >= 14) chips.push(chip("うねり向き良好", "good"));
  else chips.push(chip("うねり向き注意", "bad"));

  if (result.scores.wind_direction >= 20) chips.push(chip("風が合う", "good"));
  else if (result.scores.wind_direction >= 14) chips.push(chip("風は少し横", "ok"));
  else chips.push(chip("風向き注意", "bad"));

  if (result.scores.wave_height >= 10) chips.push(chip("サイズ良好", "good"));
  else if (result.scores.wave_height >= 5) chips.push(chip("サイズ控えめ", "ok"));
  else chips.push(chip("サイズ不足", "bad"));

  if (result.scores.swell_period >= 10) chips.push(chip("周期あり", "good"));
  else chips.push(chip("周期短め", "ok"));

  return chips.join("");
}

// Compass icon: fixed circle with an N reference mark, only the arrow
// rotates (pointing where the flow is heading).
// Ring gauge around the compass: arc length = speed (capped at 12 m/s,
// where the wind score bottoms out), color = calm/mid/strong severity.
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 19;

function speedGauge(windSpeedMs) {
  const frac = Math.min(Math.max(windSpeedMs / 12, 0), 1);
  const arc = (frac * GAUGE_CIRCUMFERENCE).toFixed(1);
  const tone = windSpeedMs <= 3 ? "" : windSpeedMs <= 7 ? " mid" : " strong";
  return `<svg class="compass-gauge" viewBox="0 0 42 42" aria-hidden="true">
    <circle class="gauge-track" cx="21" cy="21" r="19"/>
    <circle class="gauge-fill${tone}" cx="21" cy="21" r="19" stroke-dasharray="${arc} ${GAUGE_CIRCUMFERENCE.toFixed(1)}"/>
  </svg>`;
}

function metricIcon(directionDeg, windSpeedMs) {
  const rotate = ((directionDeg % 360) + 360) % 360;
  return `<span class="wind-compass" aria-hidden="true">
    ${windSpeedMs != null ? speedGauge(windSpeedMs) : ""}
    <i class="compass-n">N</i>
    <span class="compass-arrow" style="--dir-rotate: ${rotate}deg;">↑</span>
  </span>`;
}

function conditionMetrics(data, bearing) {
  const waveSize = Scoring.waveSizeLabel(data.wave_height);
  const windCondition = Share.windConditionLabel(data.wind_dir, data.wind_speed, bearing);
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
        <span><strong>${escapeHtml(windCondition)}</strong><span class="metric-sub">${escapeHtml(Share.jpDirection(data.wind_dir))}風 ${data.wind_speed.toFixed(1)}m/s</span></span>
      </span>
      <span class="mini-metric">
        <b>うねりの向き</b>
        ${metricIcon(swellFlowDeg)}
        <span><strong>${escapeHtml(Share.jpDirection(data.swell_dir))}うねり</strong></span>
      </span>
    </div>`;
}

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

let LAST_RESULTS = [];
// { el, date, slot } from the most recent renderResults call, so setMode can
// redraw tide curves that were laid out at width 0 while #results was
// display:none (see drawTideCurves), without re-fetching anything.
let LAST_RANKING_RENDER = null;

function drawTideCurves(el, results, date, slot) {
  const now = new Date();
  const nowMinutes = fmtDate(now) === date ? now.getHours() * 60 + now.getMinutes() : null;
  el.querySelectorAll("svg.tide-curve").forEach((svg) => {
    const r = results[parseInt(svg.dataset.index, 10)];
    if (!r || !r.tideSeries) { svg.remove(); return; }
    const width = Math.max(Math.round(svg.getBoundingClientRect().width) || 300, 100);
    svg.setAttribute("viewBox", `0 0 ${width} ${CURVE_H}`);
    svg.innerHTML = tideCurveSvg(r.tideSeries, r.tide, slot, date, width, nowMinutes);
  });
}

// 共有ボタンの行。結果が1件以上あるときだけ描く。
function shareRow() {
  return `<div class="share-row">
      <button type="button" class="share-btn line share-line">LINEで送る</button>
      <button type="button" class="share-btn share-image">画像で共有</button>
    </div>`;
}

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

// LINEはURLスキームでテキストしか受け取れないので、画像とは別の導線になる。
function openLineShare(root, payload) {
  const win = window.open(`https://line.me/R/msg/text/?${encodeURIComponent(payload.text)}`, "_blank", "noopener");
  if (!win) shareError(root, "LINEを開けませんでした");
}

// 押す前にラベルを決めたいので、同じ形のダミーPNGで共有可否を先に聞く。
// navigator.canShare の有無だけでは足りない（PCのChromeは関数を持っているが
// ファイル共有はできないので、「画像で共有」と出して保存が走ってしまう）。
function canShareImageFile() {
  if (!navigator.canShare) return false;
  try {
    return navigator.canShare({ files: [new File([], "surf-check.png", { type: "image/png" })] });
  } catch (e) {
    return false;
  }
}

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

function renderResults(el, region, date, slot, results, failed) {
  LAST_RESULTS = results;
  LAST_RANKING_RENDER = { el, date, slot };
  if (results.length === 0) {
    el.innerHTML = `<p class="failed">データを取得できませんでした。</p>`;
    return;
  }
  const failedNote = failed.length ? `<p class="failed">取得失敗: ${escapeHtml(failed.join(", "))}</p>` : "";
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
  const share = Share.rankingShare(location.origin + location.pathname, region, date, slot, results);
  wireShareRow(el, share);
  drawTideCurves(el, results, date, slot);
  history.replaceState(null, "", share.url);
}

// Runs fn for every spot in parallel; spots whose promise rejects are
// reported by name so the rest can still render.
async function settleBySpot(spots, fn) {
  const settled = await Promise.allSettled(spots.map(fn));
  const ok = [];
  const failed = [];
  settled.forEach((res, i) => {
    if (res.status === "fulfilled") ok.push(res.value);
    else failed.push(spots[i].name);
  });
  return { ok, failed };
}

async function runRanking() {
  const region = document.getElementById("region").value;
  const date = document.getElementById("date").value;
  const slot = document.getElementById("slot").value;
  const resultsEl = document.getElementById("results");
  resultsEl.innerHTML = `<div class="loading"><b>取得中...</b><span>Open-Meteoから波・風・潮汐データを読み込んでいます。</span></div>`;
  try {
    const { ok, failed } = await settleBySpot(filterByRegion(region), (s) => rankSpot(s, date, slot));
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
  if (!cell) return `<td><span class="wk-cell empty" role="img" aria-label="データなし">–</span></td>`;
  const total = cell.scores.total;
  const label = `${Share.mdLabel(day.date)} ${Share.SLOT_SHORT[slot]} ${total}点`;
  return `<td><button type="button" class="wk-cell ${Forecast.scoreBand(total)}" data-day="${dayIndex}" data-slot="${slot}" aria-pressed="false" aria-label="${escapeHtml(label)}">${total}</button></td>`;
}

function weeklyCard(result, index) {
  const best = result.best;
  const head = result.days.map((day) => `<th scope="col">${escapeHtml(dayColumnLabel(day.date))}</th>`).join("");
  const rows = Forecast.SLOT_ORDER.map((slot) => {
    const cells = result.days.map((day, di) => weeklyCell(day, slot, di)).join("");
    return `<tr><th scope="row">${Share.SLOT_SHORT[slot]}</th>${cells}</tr>`;
  }).join("");
  const waves = result.days.map((day) =>
    `<td class="wk-wave">${day.maxWaveHeight == null ? "–" : day.maxWaveHeight.toFixed(1)}</td>`).join("");

  return `<article class="ranking-card wk-card" data-index="${index}">
    <div class="wk-card-head">
      <span class="ranking-card-title">
        <b>${escapeHtml(result.spot.name)}</b>
        <span>${escapeHtml(result.spot.region)}</span>
      </span>
      <span class="wk-best">ベスト <b>${escapeHtml(dayColumnLabel(best.date))} ${Share.SLOT_SHORT[best.slot]} ${best.total}点</b></span>
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
      <span>${escapeHtml(Share.mdLabel(dates[0]))}〜${escapeHtml(Share.mdLabel(dates[dates.length - 1]))} / ${results.length}件</span>
    </div>
    <div class="ranking-cards">
      ${results.map(weeklyCard).join("")}
    </div>
    ${failedNote}`;
}

function weeklyDetail(spot, day, slot) {
  const { data, scores } = day.slots[slot];
  return `<div class="wk-detail">
    <div class="wk-detail-head">
      <b>${escapeHtml(Share.mdLabel(day.date))} ${escapeHtml(SLOT_LABELS[slot])}</b>
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

async function runWeekly() {
  const region = document.getElementById("region").value;
  const weeklyEl = document.getElementById("weekly");
  weeklyEl.innerHTML = `<div class="loading"><b>取得中...</b><span>Open-Meteoから7日分の波・風・潮汐データを読み込んでいます。</span></div>`;
  try {
    const today = fmtDate(new Date());
    const dates = Array.from({ length: WEEK_DAYS }, (_, i) => shiftDate(today, i));
    const { ok, failed } = await settleBySpot(filterByRegion(region), (s) => weeklySpot(s, dates));
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
  // #results may have finished a render while hidden (display:none gives
  // sparklines a 0 width to measure); redraw now that it's visible again.
  // Reading a rect below forces the style recalc, so the width is fresh.
  if (mode === "ranking" && LAST_RANKING_RENDER) {
    drawTideCurves(LAST_RANKING_RENDER.el, LAST_RESULTS, LAST_RANKING_RENDER.date, LAST_RANKING_RENDER.slot);
  }
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

function initDate() {
  const dateEl = document.getElementById("date");
  const today = new Date();
  // Open-Meteo marine data (waves & sea level) only extends ~10 days out;
  // +9 is the last date with full-day coverage.
  const max = new Date(today);
  max.setDate(max.getDate() + 9);
  dateEl.min = fmtDate(today);
  dateEl.max = fmtDate(max);
  dateEl.value = fmtDate(today);
}

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

// Hover layer: crosshair + dot inside the hovered sparkline, one shared
// tooltip (textContent only) positioned above the snapped sample.
let tideTip = null;
let hoveredSvg = null;

function hideTideHover() {
  if (hoveredSvg) {
    const cross = hoveredSvg.querySelector(".tc-cross");
    const dot = hoveredSvg.querySelector(".tc-dot");
    if (cross) cross.setAttribute("visibility", "hidden");
    if (dot) dot.setAttribute("visibility", "hidden");
    hoveredSvg = null;
  }
  if (tideTip) tideTip.style.display = "none";
}

function onTideHover(e) {
  const svg = e.target.closest ? e.target.closest("svg.tide-curve") : null;
  if (!svg) { hideTideHover(); return; }
  const r = LAST_RESULTS[parseInt(svg.dataset.index, 10)];
  if (!r || !r.tideSeries) { hideTideHover(); return; }
  const rect = svg.getBoundingClientRect();
  if (rect.width === 0) return;
  const s = r.tideSeries;
  const targetMin = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1) * 1440;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < s.minutes.length; i++) {
    if (s.heights[i] == null) continue;
    const dist = Math.abs(s.minutes[i] - targetMin);
    if (dist < bestDist) { bestDist = dist; best = i; }
  }
  if (best < 0) { hideTideHover(); return; }
  if (hoveredSvg && hoveredSvg !== svg) hideTideHover();
  hoveredSvg = svg;
  const scale = tideScale(s, r.tide, rect.width);
  const cx = scale.x(s.minutes[best]);
  const cy = scale.y(s.heights[best]);
  const cross = svg.querySelector(".tc-cross");
  const dot = svg.querySelector(".tc-dot");
  if (cross) {
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
  }
  if (dot) {
    dot.setAttribute("cx", cx);
    dot.setAttribute("cy", cy);
    dot.setAttribute("visibility", "visible");
  }
  const h = s.heights[best];
  tideTip.firstChild.textContent = `${h >= 0 ? "+" : ""}${h.toFixed(2)}m`;
  tideTip.lastChild.textContent = minutesToHhmm(s.minutes[best]);
  tideTip.style.display = "block";
  tideTip.style.left = `${rect.left + cx}px`;
  tideTip.style.top = `${rect.top + cy}px`;
}

window.addEventListener("DOMContentLoaded", async () => {
  initDate();
  tideTip = document.createElement("div");
  tideTip.className = "tide-tooltip";
  tideTip.appendChild(document.createElement("b"));
  tideTip.appendChild(document.createElement("span"));
  document.body.appendChild(tideTip);
  const resultsEl = document.getElementById("results");
  resultsEl.addEventListener("pointermove", onTideHover);
  resultsEl.addEventListener("pointerleave", hideTideHover);
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });
  document.getElementById("weekly").addEventListener("click", onWeeklyClick);
  const r = await fetch("spots.json");
  SPOTS = await r.json();
  document.getElementById("check").addEventListener("click", check);
  document.getElementById("checkTop").addEventListener("click", check);
  if (applyParams()) check();
});
