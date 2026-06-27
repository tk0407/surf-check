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
const MEDALS = ["🥇", "🥈", "🥉"];

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
  if (idx.length === 0) throw new Error(`時間帯のデータがありません`);
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

function renderResults(el, region, date, slot, results, failed) {
  if (results.length === 0) {
    el.innerHTML = `<p>データを取得できませんでした。</p>`;
    return;
  }
  const rows = results
    .map((r, i) => {
      const rank = MEDALS[i] || `#${i + 1}`;
      const wlabel = Scoring.windLabel(r.data.wind_dir, r.data.wind_speed, r.spot.bearing);
      const size = Scoring.waveSizeLabel(r.data.wave_height);
      return `<tr>
        <td>${rank}</td>
        <td>${r.spot.name}</td>
        <td>${r.scores.total}/85</td>
        <td>${r.data.wave_height.toFixed(1)}m (${size})</td>
        <td>${r.data.swell_period.toFixed(1)}s</td>
        <td>${wlabel}</td>
      </tr>`;
    })
    .join("");
  const failedNote = failed.length ? `<p class="failed">取得失敗: ${failed.join(", ")}</p>` : "";
  el.innerHTML = `
    <h2>${date} ${SLOT_LABELS[slot]} ${region}</h2>
    <table>
      <thead><tr><th>順位</th><th>スポット</th><th>スコア</th><th>波</th><th>周期</th><th>風</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${failedNote}`;
}

async function run() {
  const region = document.getElementById("region").value;
  const date = document.getElementById("date").value;
  const slot = document.getElementById("slot").value;
  const resultsEl = document.getElementById("results");
  const btn = document.getElementById("check");
  btn.disabled = true;
  resultsEl.innerHTML = `<p>取得中…</p>`;
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
    resultsEl.innerHTML = `<p class="failed">エラー: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
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
});
