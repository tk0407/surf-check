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
// 実況フィードバックの Worker の URL（末尾の / は付けない）。空のあいだは
// 補正を取りに行かず、「行ってきた」ボタンも出さない。
const FEEDBACK_API = "https://surf-check-feedback.butandingtech-account.workers.dev";
const CALIBRATION_TIMEOUT_MS = 2000;

let SPOTS = [];
// CALIBRATION は今の検索（とその入力パネル）が使う補正、loadedCalibration は Worker から届いた最新の補正。
let CALIBRATION = null;
let loadedCalibration = null;
let calibrationReady = Promise.resolve();
const PREFS = Prefs.create();

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

// 補正は起動時に取りに行き、最初の検索は最大 2 秒だけ待つ。遅れて届いた補正は
// loadedCalibration に置くだけにして、次の check() の最初で CALIBRATION に移す
// (検索の途中で CALIBRATION が書き換わらないようにするため)。取れない・形が
// 違うときは補正なし（今と同じ表示）のまま。
function loadCalibration() {
  if (!FEEDBACK_API) return Promise.resolve();
  const load = fetch(`${FEEDBACK_API}/calibration`)
    .then((res) => (res.ok ? res.json() : null))
    .then((json) => { if (Calibration.validate(json)) loadedCalibration = json; })
    .catch(() => {});
  const timeout = new Promise((resolve) => setTimeout(resolve, CALIBRATION_TIMEOUT_MS));
  return Promise.race([load, timeout]);
}

// 入力パネル用：その日・時間帯の補正前の予報値。
async function fetchConditions(spot, date, slot) {
  const { marine, forecast } = await fetchSpotData(spot.lat, spot.lon, date, date);
  const data = Forecast.slotConditions(marine, forecast, slot, date);
  if (!data) throw new Error("予報データなし");
  return data;
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
  const rawData = Forecast.slotConditions(marine, forecast, slot, date);
  if (!rawData) throw new Error("予報データなし");
  const { data, scores } = Calibration.apply(rawData, spot, CALIBRATION);
  const tide = Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date);
  const tideTrend = tideTrendLabel(marine, slot, date);
  const tideSeries = daySeries(marine, date);
  return { spot, scores, data, rawData, tide, tideTrend, tideSeries };
}

// HTML エスケープは共有カードと同じものを使う。
const escapeHtml = Share.escapeHtml;

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

function calibrationChip(spot) {
  const label = Calibration.summaryLabel(spot.name, CALIBRATION);
  return label ? `<span class="chip calib">${escapeHtml(label)}</span>` : "";
}

// session はパネルが最初に開く日・時間帯（Feedback.defaultSession）。null ならボタンを出さない。
function feedbackLabel(spot, session) {
  return FeedbackPanel.hasSent(spot.name, session.date, session.slot) ? "送り直す" : "行ってきた";
}

function feedbackButton(result, index, session) {
  if (!session) return "";
  return `<button type="button" class="feedback-open" data-index="${index}">${feedbackLabel(result.spot, session)}</button>`;
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

// BEST のカードの波サイズ：立った人の横に、呼び方の目安の高さ（Share.waveBodyLevel）
// で波を描く。viewBox の外まで地面を伸ばしてあるので、横に広い画面でも途切れない。
const FIGURE_GROUND = 108; // 足元の y
const FIGURE_PERSON = 66; // 足元から頭のてっぺんまで
const FIGURE_MARKS = [["アタマ", 0.96], ["ムネ", 0.67], ["コシ", 0.47], ["ヒザ", 0.24]];

function waveFigureSvg(heightM) {
  const h = Share.waveBodyLevel(heightM) * FIGURE_PERSON;
  const crest = FIGURE_GROUND - h;
  const y = (k) => (FIGURE_GROUND - k * h).toFixed(1);
  const marks = FIGURE_MARKS.map(([label, level]) => {
    const my = (FIGURE_GROUND - level * FIGURE_PERSON).toFixed(1);
    return `<path d="M64 ${my} H330" stroke="#9fb4bf" stroke-dasharray="3 4"/><text x="68" y="${(my - 3).toFixed(1)}">${label}</text>`;
  }).join("");
  return `<svg class="wave-figure-svg" viewBox="0 0 330 120" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    <rect x="64" y="${(crest - 5).toFixed(1)}" width="266" height="10" fill="#ef6f5e" opacity="0.14"/>
    <g fill="#687481" font-size="9" font-weight="700">${marks}</g>
    <path d="M120 ${FIGURE_GROUND} C 160 ${FIGURE_GROUND} 178 ${y(0.92)} 222 ${y(1)} C 256 ${y(1)} 276 ${y(0.68)} 296 ${y(0.32)} C 310 ${y(0.08)} 320 ${FIGURE_GROUND} 330 ${FIGURE_GROUND} Z" fill="#69c7c9"/>
    <path d="M222 ${y(1)} C 246 ${y(0.99)} 262 ${y(0.84)} 276 ${y(0.6)}" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity="0.8"/>
    <path d="M150 ${FIGURE_GROUND} C 190 ${FIGURE_GROUND} 220 ${y(0.44)} 262 ${y(0.44)} C 290 ${y(0.44)} 310 ${y(0.16)} 330 ${y(0.08)} L330 ${FIGURE_GROUND} Z" fill="#007f8f"/>
    <rect x="-2000" y="${FIGURE_GROUND}" width="4330" height="40" fill="#124559"/>
    <g transform="translate(6 34.7) scale(0.7333)" fill="#124559">
      <circle cx="46" cy="18" r="8"/>
      <path d="M34 30 Q46 26 58 30 L61 60 L56 61 L54 100 L48 100 L46 66 L44 100 L38 100 L36 61 L31 60 Z"/>
    </g>
    <rect x="200" y="${Math.max(2, crest - 22).toFixed(1)}" width="44" height="16" rx="8" fill="#fff"/>
    <text x="222" y="${(Math.max(2, crest - 22) + 12).toFixed(1)}" fill="#124559" font-size="10" font-weight="900" text-anchor="middle">${heightM.toFixed(1)}m</text>
  </svg>`;
}

function waveFigureMetric(data) {
  return `<span class="mini-metric wave-figure">
        <span class="wave-figure-head"><b>波サイズ</b><span class="metric-sub">周期 ${data.swell_period.toFixed(1)}s</span></span>
        ${waveFigureSvg(data.wave_height)}
        <span><strong>${escapeHtml(Share.waveScaleLabel(data.wave_height))}</strong><span class="metric-sub">目安です。実際の見え方は地形や潮で変わります。</span></span>
      </span>`;
}

// figure が true（BEST のカード）なら、波サイズを立った人の絵で見せる。
function conditionMetrics(data, bearing, figure = false) {
  const waveSize = Scoring.waveSizeLabel(data.wave_height);
  const windCondition = Share.windConditionLabel(data.wind_dir, data.wind_speed, bearing);
  const windFlowDeg = data.wind_dir + 180;
  const swellFlowDeg = data.swell_dir + 180;
  const waveMetric = figure ? waveFigureMetric(data) : `<span class="mini-metric">
        <b>波サイズ</b>
        <span class="wave-icon ${waveIconClass(data.wave_height)}" aria-hidden="true"></span>
        <span><strong>${data.wave_height.toFixed(1)}m ${escapeHtml(waveSize)}</strong><span class="metric-sub">周期 ${data.swell_period.toFixed(1)}s</span></span>
      </span>`;
  return `<div class="card-metrics${figure ? " has-figure" : ""}">
      ${waveMetric}
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

function resultCard(result, index, session) {
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

    ${conditionMetrics(result.data, result.spot.bearing, index === 0)}

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

    <div class="reason-row">${reasonChips(result)}${calibrationChip(result.spot)}</div>
    ${Share.camRow(result.spot)}${feedbackButton(result, index, session)}
  </article>`;
}

let LAST_RESULTS = [];
// { el, date, slot } from the most recent renderResults call, so setMode can
// redraw tide curves that were laid out at width 0 while #results was
// display:none (see drawTideCurves), without re-fetching anything.
let LAST_RANKING_RENDER = null;
let LAST_FEEDBACK_SESSION = null;

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
// noopener を付けた window.open は、実際に開けたかどうかによらず仕様上つねに
// null を返す。つまり戻り値で失敗は判定できず、判定を残すと共有が成功するたび
// にエラー行が出る。noopener のほうを優先して、失敗の検出は行わない。
function openLineShare(payload) {
  window.open(`https://line.me/R/msg/text/?${encodeURIComponent(payload.text)}`, "_blank", "noopener");
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

// 前回の失敗表示を消す。消さないと、あとで共有に成功しても古いエラーが残る。
function clearShareNote(root) {
  const note = root.querySelector(".share-note");
  if (note) note.remove();
}

// canvas -> PNG。ファイル共有ができる端末は共有シート、それ以外は保存。
async function shareImage(root, payload) {
  clearShareNote(root);
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
  if (lineBtn) lineBtn.addEventListener("click", () => openLineShare(payload));
  const imageBtn = root.querySelector(".share-image");
  if (imageBtn) {
    // ファイル共有ができない環境では、押す前に「保存」だと分かるようにする。
    if (!canShareImageFile()) imageBtn.textContent = "画像を保存";
    imageBtn.addEventListener("click", () => shareImage(root, payload));
  }
}

// replaceUrl が false（開いたときの自動チェック）なら URL を書き換えない。
function renderResults(el, region, date, slot, results, failed, { replaceUrl = true } = {}) {
  LAST_RESULTS = results;
  LAST_RANKING_RENDER = { el, date, slot };
  LAST_FEEDBACK_SESSION = FEEDBACK_API ? Feedback.defaultSession({ date, slot }, new Date()) : null;
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
      ${results.map((r, i) => resultCard(r, i, LAST_FEEDBACK_SESSION)).join("")}
    </div>
    ${failedNote}`;
  const share = Share.rankingShare(location.origin + location.pathname, region, date, slot, results);
  wireShareRow(el, share);
  drawTideCurves(el, results, date, slot);
  if (replaceUrl) history.replaceState(null, "", share.url);
}

function relabelFeedbackButtons(el, results, session) {
  el.querySelectorAll(".feedback-open").forEach((btn) => {
    const result = results[Number(btn.dataset.index)];
    if (result) btn.textContent = feedbackLabel(result.spot, session);
  });
}

// After a send from either view: the session sent may be the one the other
// view's buttons point at.
function refreshFeedbackButtons() {
  if (LAST_RANKING_RENDER && LAST_FEEDBACK_SESSION) {
    relabelFeedbackButtons(LAST_RANKING_RENDER.el, LAST_RESULTS, LAST_FEEDBACK_SESSION);
  }
  const weeklySession = weeklyFeedbackSession();
  if (weeklySession) relabelFeedbackButtons(document.getElementById("weekly"), WEEKLY_RESULTS, weeklySession);
}

function onFeedbackClick(e) {
  const btn = e.target.closest(".feedback-open");
  if (!btn || !LAST_RANKING_RENDER) return;
  const result = LAST_RESULTS[Number(btn.dataset.index)];
  if (!result) return;
  const { date, slot } = LAST_RANKING_RENDER;
  FeedbackPanel.open({
    api: FEEDBACK_API,
    spot: result.spot,
    spots: SPOTS,
    card: { date, slot, rawData: result.rawData },
    calibration: CALIBRATION,
    fetchConditions,
    onSent: refreshFeedbackButtons,
  });
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

// 「いちばん」のカードの飾りの波。
const BEST_NOW_STRIP = `<svg class="best-now-strip" viewBox="0 0 330 46" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 28 C 40 16 80 16 120 26 C 160 36 200 36 240 24 C 280 14 310 16 330 22 L330 46 L0 46 Z" fill="#69c7c9" opacity="0.9"/>
    <path d="M0 36 C 50 28 100 28 150 36 C 200 44 260 42 330 32 L330 46 L0 46 Z" fill="#fff" opacity="0.28"/>
  </svg>`;

// 開いたときの自動チェックの上位3つ。day は「今日」か「明日」。
function bestNowHtml(day, region, slot, results) {
  const [top, ...rest] = results.slice(0, 3);
  const d = top.data;
  const chips = [
    Scoring.waveSizeLabel(d.wave_height),
    Share.windConditionLabel(d.wind_dir, d.wind_speed, top.spot.bearing),
    `周期 ${d.swell_period.toFixed(1)}s`,
  ];
  const restRows = rest.map((r, i) => `<li><span>${i + 2}</span><b>${escapeHtml(r.spot.name)}</b><strong>${r.scores.total}</strong></li>`).join("");
  return `
    <div class="best-now-head">
      <h2 id="bestNowTitle">${escapeHtml(`${day} ${SLOT_LABELS[slot]}の${region}でいちばん`)}</h2>
      <span class="best-now-badge">自動でチェックしました</span>
    </div>
    <div class="best-now-main">
      <b>${escapeHtml(top.spot.name)}</b>
      <span class="best-now-score">${top.scores.total}<span>/85</span></span>
    </div>
    ${BEST_NOW_STRIP}
    <div class="best-now-chips">${chips.map((c) => `<span>${escapeHtml(c)}</span>`).join("")}</div>
    ${restRows ? `<ol class="best-now-rest">${restRows}</ol>` : ""}
    <button type="button" class="best-now-all">ランキングをすべて見る</button>`;
}

function onBestNowClick(e) {
  if (!e.target.closest(".best-now-all")) return;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.getElementById("results").scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
}

// auto は開いたときの自動チェック（{ day: "今日" | "明日" }）。そのときだけ
// 「いちばん」のカードを出し、URL は書き換えない。手でチェックしたらカードは消す。
async function runRanking(auto = null) {
  const region = document.getElementById("region").value;
  const date = document.getElementById("date").value;
  const slot = document.getElementById("slot").value;
  const resultsEl = document.getElementById("results");
  const bestEl = document.getElementById("bestNow");
  bestEl.hidden = true;
  const loadingTitle = auto ? `${auto.day} ${Share.SLOT_SHORT[slot]}の${region}をチェック中…` : "取得中...";
  resultsEl.innerHTML = `<div class="loading"><b>${escapeHtml(loadingTitle)}</b><span>Open-Meteoから波・風・潮汐データを読み込んでいます。</span></div>`;
  try {
    const { ok, failed } = await settleBySpot(filterByRegion(region), (s) => rankSpot(s, date, slot));
    ok.sort((a, b) => b.scores.total - a.scores.total);
    renderResults(resultsEl, region, date, slot, ok, failed, { replaceUrl: !auto });
    if (auto && ok.length) {
      bestEl.innerHTML = bestNowHtml(auto.day, region, slot, ok);
      bestEl.hidden = false;
    }
  } catch (e) {
    resultsEl.innerHTML = `<p class="failed">エラー: ${escapeHtml(e.message)}</p>`;
  }
}

// Each slot keeps rawData too: the feedback panel records the uncalibrated forecast.
async function weeklySpot(spot, dates) {
  const { marine, forecast } = await fetchSpotData(spot.lat, spot.lon, dates[0], dates[dates.length - 1]);
  const days = Forecast.weeklyForecast(marine, forecast, dates, spot.bearing,
    (data) => ({ ...Calibration.apply(data, spot, CALIBRATION), rawData: data }));
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

function weeklyCard(result, index, session) {
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
    ${feedbackButton(result, index, session)}
  </article>`;
}

let WEEKLY_RESULTS = [];

// The weekly view's buttons point at the latest slot that has begun, not at a
// cell: almost every cell is still in the future.
function weeklyFeedbackSession() {
  return FEEDBACK_API ? Feedback.latestStarted(new Date()) : null;
}

function renderWeekly(el, region, dates, results, failed) {
  WEEKLY_RESULTS = results;
  const session = weeklyFeedbackSession();
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
      ${results.map((r, i) => weeklyCard(r, i, session)).join("")}
    </div>
    ${failedNote}`;
  const share = Share.weeklyShare(location.origin + location.pathname, region, dates, results);
  wireShareRow(el, share);
  history.replaceState(null, "", share.url);
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
    <div class="reason-row">${reasonChips({ scores })}${calibrationChip(spot)}</div>
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

// Opens on the latest slot that has begun as of the tap, so a page left open
// since before the session still lands on it. Today's slots reuse the fetched
// forecast; anything else (yesterday evening) is fetched by the panel.
function onWeeklyFeedbackClick(e) {
  const btn = e.target.closest(".feedback-open");
  if (!btn) return;
  const result = WEEKLY_RESULTS[Number(btn.dataset.index)];
  if (!result) return;
  const session = Feedback.latestStarted(new Date());
  const day = result.days.find((d) => d.date === session.date);
  const cell = day ? day.slots[session.slot] : null;
  FeedbackPanel.open({
    api: FEEDBACK_API,
    spot: result.spot,
    spots: SPOTS,
    card: { ...session, rawData: cell ? cell.rawData : null },
    calibration: CALIBRATION,
    fetchConditions,
    onSent: refreshFeedbackButtons,
  });
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
// auto (the check on open) always runs the ranking; see runRanking.
async function check(auto = null) {
  const buttons = [document.getElementById("check"), document.getElementById("checkTop")].filter(Boolean);
  buttons.forEach((btn) => { btn.disabled = true; });
  try {
    await calibrationReady;
    CALIBRATION = loadedCalibration;
    if (!auto && currentMode() === "weekly") await runWeekly();
    else await runRanking(auto);
  } finally {
    buttons.forEach((btn) => { btn.disabled = false; });
  }
}

// ボタンで調べたエリアを、次に開いたときの自動チェックに使う（共有リンクのエリアは残さない）。
function onCheckClick() {
  PREFS.saveRegion(document.getElementById("region").value);
  check();
}

function selectableRegions() {
  return Array.from(document.getElementById("region").options).map((o) => o.value);
}

// 共有リンク以外で開いたら、これから入れる枠を前回のエリア（無ければ先頭の千葉北）で
// 自動でチェックする。URL は書き換えないので、再読み込みするとその時点の枠を選び直す。
function autoCheck() {
  const now = new Date();
  const { date, slot } = Forecast.upcomingSlot(now);
  const region = PREFS.region(selectableRegions());
  if (region) document.getElementById("region").value = region;
  document.getElementById("date").value = date;
  document.getElementById("slot").value = slot;
  check({ day: date === Feedback.jstNow(now).date ? "今日" : "明日" });
}

// はじめての案内。×か「使い方」で閉じたら、次からは出さない（保存できない環境では毎回出る）。
function showGuide(open) {
  document.getElementById("guide").hidden = !open;
  document.getElementById("guideToggle").setAttribute("aria-expanded", String(open));
}

function closeGuide() {
  showGuide(false);
  PREFS.closeGuide();
}

function initGuide() {
  const toggle = document.getElementById("guideToggle");
  showGuide(!PREFS.guideClosed());
  toggle.addEventListener("click", () => {
    if (document.getElementById("guide").hidden) showGuide(true);
    else closeGuide();
  });
  document.getElementById("guideClose").addEventListener("click", () => {
    closeGuide();
    toggle.focus();
  });
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
    regions: selectableRegions(),
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
  calibrationReady = loadCalibration();
  initDate();
  initGuide();
  tideTip = document.createElement("div");
  tideTip.className = "tide-tooltip";
  tideTip.appendChild(document.createElement("b"));
  tideTip.appendChild(document.createElement("span"));
  document.body.appendChild(tideTip);
  const resultsEl = document.getElementById("results");
  resultsEl.addEventListener("pointermove", onTideHover);
  resultsEl.addEventListener("pointerleave", hideTideHover);
  resultsEl.addEventListener("click", onFeedbackClick);
  document.getElementById("bestNow").addEventListener("click", onBestNowClick);
  document.querySelectorAll(".mode-tab").forEach((tab) => {
    tab.addEventListener("click", () => setMode(tab.dataset.mode));
  });
  const weeklyEl = document.getElementById("weekly");
  weeklyEl.addEventListener("click", onWeeklyClick);
  weeklyEl.addEventListener("click", onWeeklyFeedbackClick);
  const r = await fetch("spots.json?v=20260924");
  SPOTS = await r.json();
  document.getElementById("check").addEventListener("click", onCheckClick);
  document.getElementById("checkTop").addEventListener("click", onCheckClick);
  if (applyParams()) check();
  else autoCheck();
});
