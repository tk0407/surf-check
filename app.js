const MARINE_URL = "https://marine-api.open-meteo.com/v1/marine";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const MARINE_PARAMS = [
  "wave_height", "wave_period", "wave_direction",
  "swell_wave_height", "swell_wave_period", "swell_wave_direction",
  "sea_surface_temperature",
];
const FORECAST_PARAMS = ["windspeed_10m", "winddirection_10m"];
const TIME_SLOTS = { morning: [7, 10], afternoon: [12, 15], evening: [16, 19] };
const SLOT_LABELS = { morning: "朝（07-10時）", afternoon: "昼（12-15時）", evening: "夕（16-19時）" };

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

function pick(primary, fallback) {
  return primary !== null && primary !== undefined ? primary : fallback;
}

async function fetchSpotData(lat, lon, date) {
  const base = { latitude: lat, longitude: lon, start_date: date, end_date: date, timezone: "Asia/Tokyo" };
  const marineUrl = `${MARINE_URL}?${qs({ ...base, hourly: MARINE_PARAMS.join(",") })}`;
  const forecastUrl = `${FORECAST_URL}?${qs({ ...base, hourly: FORECAST_PARAMS.join(","), wind_speed_unit: "ms" })}`;
  const [m, f] = await Promise.all([fetch(marineUrl), fetch(forecastUrl)]);
  if (!m.ok || !f.ok) throw new Error("API error");
  const marine = (await m.json()).hourly;
  const forecast = (await f.json()).hourly;
  const merged = { ...marine };
  for (const k of FORECAST_PARAMS) merged[k] = forecast[k];
  return merged;
}

function averageForWindow(hourly, slot) {
  const [startH, endH] = TIME_SLOTS[slot];
  const times = hourly.time;
  const idx = [];
  for (let i = 0; i < times.length; i++) {
    const h = parseInt(times[i].slice(11, 13), 10);
    if (h >= startH && h < endH) idx.push(i);
  }
  if (idx.length === 0) throw new Error("時間帯のデータがありません");
  const result = {};
  for (const key of Object.keys(hourly)) {
    if (key === "time") continue;
    const vals = idx.map((i) => hourly[key][i]).filter((v) => v !== null && v !== undefined);
    result[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return result;
}

async function rankSpot(spot, date, slot) {
  const raw = await fetchSpotData(spot.lat, spot.lon, date);
  const avg = averageForWindow(raw, slot);
  const data = {
    wind_dir: avg.winddirection_10m,
    wind_speed: avg.windspeed_10m,
    swell_dir: pick(avg.swell_wave_direction, avg.wave_direction),
    swell_period: pick(avg.swell_wave_period, avg.wave_period),
    wave_height: pick(avg.swell_wave_height, avg.wave_height),
  };
  const scores = Scoring.scoreSpot(data, spot.bearing);
  return { spot, scores, data };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

function flowLabel(fromDeg) {
  return `${jpDirection(fromDeg)}→${jpDirection(fromDeg + 180)}`;
}

function waveIconClass(height) {
  if (height < 0.8) return "small";
  if (height < 1.2) return "medium";
  return "large";
}

function windLinesClass(speed) {
  if (speed <= 2) return "soft";
  if (speed >= 5) return "strong";
  return "";
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

function metricIcon(directionDeg, lineClass = "") {
  const rotate = ((directionDeg % 360) + 360) % 360;
  return `<span class="wind-icon" aria-hidden="true">
    <span class="wind-compass" style="--dir-rotate: ${rotate}deg;">↑</span>
    <span class="wind-lines ${lineClass}"><i></i><i></i><i></i></span>
  </span>`;
}

function resultCard(result, index) {
  const rank = index + 1;
  const waveSize = Scoring.waveSizeLabel(result.data.wave_height);
  const windCondition = windConditionLabel(result.data.wind_dir, result.data.wind_speed, result.spot.bearing);
  const windFlowDeg = result.data.wind_dir + 180;
  const swellFlowDeg = result.data.swell_dir + 180;
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

    <div class="card-metrics">
      <span class="mini-metric">
        <b>波サイズ</b>
        <span class="wave-icon ${waveIconClass(result.data.wave_height)}" aria-hidden="true"></span>
        <span><strong>${result.data.wave_height.toFixed(1)}m ${escapeHtml(waveSize)}</strong><span class="metric-sub">周期 ${result.data.swell_period.toFixed(1)}s</span></span>
      </span>
      <span class="mini-metric">
        <b>風</b>
        ${metricIcon(windFlowDeg, windLinesClass(result.data.wind_speed))}
        <span><strong>${escapeHtml(windCondition)}</strong><span class="metric-sub">${escapeHtml(flowLabel(result.data.wind_dir))} ${result.data.wind_speed.toFixed(1)}m/s</span></span>
      </span>
      <span class="mini-metric">
        <b>うねり</b>
        ${metricIcon(swellFlowDeg)}
        <span><strong>${escapeHtml(jpDirection(result.data.swell_dir))}</strong><span class="metric-sub">${escapeHtml(flowLabel(result.data.swell_dir))}</span></span>
      </span>
    </div>

    <div class="tide-panel">
      <div class="tide-head">
        <span class="tide-now">潮汐</span>
        <span class="tide-percent">データ未接続</span>
      </div>
      <div class="tide-times">
        <span class="tide-time"><b>満潮</b><strong>--:--</strong></span>
        <span class="tide-time"><b>干潮</b><strong>--:--</strong></span>
      </div>
    </div>

    <div class="reason-row">${reasonChips(result)}</div>
  </article>`;
}

function renderResults(el, region, date, slot, results, failed) {
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
    <div class="ranking-cards">
      ${results.map(resultCard).join("")}
    </div>
    ${failedNote}`;
}

async function run() {
  const region = document.getElementById("region").value;
  const date = document.getElementById("date").value;
  const slot = document.getElementById("slot").value;
  const resultsEl = document.getElementById("results");
  const buttons = [document.getElementById("check"), document.getElementById("checkTop")].filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  resultsEl.innerHTML = `<div class="loading"><b>取得中...</b><span>Open-Meteoから波・風・うねりデータを読み込んでいます。</span></div>`;
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
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

function initDate() {
  const dateEl = document.getElementById("date");
  const today = new Date();
  const max = new Date(today);
  max.setDate(max.getDate() + 16);
  dateEl.min = fmtDate(today);
  dateEl.max = fmtDate(max);
  dateEl.value = fmtDate(today);
}

window.addEventListener("DOMContentLoaded", async () => {
  initDate();
  const r = await fetch("spots.json");
  SPOTS = await r.json();
  document.getElementById("check").addEventListener("click", run);
  document.getElementById("checkTop").addEventListener("click", run);
});
