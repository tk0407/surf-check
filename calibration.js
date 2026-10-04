// Feedback-driven calibration layered on top of scoring.js, which stays
// untouched so its thresholds keep matching the Python source of truth.
// Shared by the site, the Worker and the tests.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Calibration = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  const PRIOR_K = 3;
  const DEVICE_CAP_SPOT = 5;
  const DEVICE_CAP_WEIGHTS = 30;
  const WAVE_LOG_CLAMP = Math.LN2;
  const WIND_CLAMP = 4;
  const RIDGE_LAMBDA = 5;
  const MIN_WEIGHT_RECORDS = 15;
  const WEIGHT_BOUNDS = [0.5, 2];
  const TOTAL_POINTS = 85;

  // Same cut points as Scoring.waveSizeLabel; each band is [lo, hi).
  const WAVE_BANDS = [
    { label: "フラット", lo: 0, hi: 0.3, center: 0.15 },
    { label: "ヒザ", lo: 0.3, hi: 0.5, center: 0.4 },
    { label: "コシ〜ハラ", lo: 0.5, hi: 0.8, center: 0.65 },
    { label: "ムネ〜カタ", lo: 0.8, hi: 1.1, center: 0.95 },
    { label: "カタ〜アタマ", lo: 1.1, hi: 1.5, center: 1.3 },
    { label: "アタマ〜オーバー", lo: 1.5, hi: 2.0, center: 1.75 },
    { label: "オーバーヘッド", lo: 2.0, hi: 2.5, center: 2.25 },
    { label: "ダブル+", lo: 2.5, hi: Infinity, center: 3.0 },
  ];
  // Same cut points as Scoring.windSpeedScore; each range is (lo, hi].
  const WIND_STRENGTHS = {
    calm: { label: "無風", lo: -Infinity, hi: 2, center: 1.0 },
    light: { label: "弱い", lo: 2, hi: 5, center: 3.5 },
    strong: { label: "強い", lo: 5, hi: Infinity, center: 7.0 },
  };
  const WIND_SIDES = { off: "オフ", side: "サイド", on: "オン" };

  const COMPONENTS = [
    { key: "wind_direction", max: 20 },
    { key: "wind_speed", max: 10 },
    { key: "swell_direction", max: 20 },
    { key: "swell_period", max: 20 },
    { key: "wave_height", max: 15 },
  ];
  const DEFAULT_WEIGHTS = Object.freeze(Object.fromEntries(COMPONENTS.map((c) => [c.key, c.max])));

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const round3 = (v) => Math.round(v * 1000) / 1000;
  const own = (obj, key) => obj != null && Object.prototype.hasOwnProperty.call(obj, key);

  function waveBand(height) {
    for (let i = 0; i < WAVE_BANDS.length; i++) if (height < WAVE_BANDS[i].hi) return i;
    return WAVE_BANDS.length - 1;
  }

  // Groups windConditionLabel's five labels into off / side / on.
  function windSide(windDir, bearing) {
    const diff = Scoring.angleDiff(windDir, (bearing + 180) % 360);
    if (diff <= 75) return "off";
    if (diff <= 105) return "side";
    return "on";
  }

  function windStrength(speed) {
    if (speed <= 2) return "calm";
    if (speed <= 5) return "light";
    return "strong";
  }

  // Log-ratio from the forecast to the observed band's center; 0 inside the
  // band, null when there is no positive forecast to take a ratio of.
  function waveError(height, band) {
    if (!(height > 0)) return null;
    const b = WAVE_BANDS[band];
    if (height >= b.lo && height < b.hi) return 0;
    return clamp(Math.log(b.center / height), -WAVE_LOG_CLAMP, WAVE_LOG_CLAMP);
  }

  function windError(speed, strength) {
    const s = WIND_STRENGTHS[strength];
    if (speed > s.lo && speed <= s.hi) return 0;
    return clamp(s.center - speed, -WIND_CLAMP, WIND_CLAMP);
  }

  // Per-device means, each device weighted by min(n, DEVICE_CAP_SPOT), and
  // pulled toward 0 ("no correction") by PRIOR_K pseudo-records.
  function shrunkMean(samples) {
    const byDevice = new Map();
    for (const { device, e } of samples) {
      const acc = byDevice.get(device) || { sum: 0, n: 0 };
      acc.sum += e;
      acc.n += 1;
      byDevice.set(device, acc);
    }
    let num = 0;
    let den = 0;
    for (const { sum, n } of byDevice.values()) {
      const w = Math.min(n, DEVICE_CAP_SPOT);
      num += (w * sum) / n;
      den += w;
    }
    return num / (den + PRIOR_K);
  }

  function rawData(record) {
    return {
      wind_dir: record.fc_wind_dir,
      wind_speed: record.fc_wind_speed,
      swell_dir: record.fc_swell_dir,
      swell_period: record.fc_swell_period,
      wave_height: record.fc_wave_height,
    };
  }

  function spotCalibration(records) {
    const bySpot = new Map();
    for (const r of records) {
      if (!bySpot.has(r.spot)) bySpot.set(r.spot, []);
      bySpot.get(r.spot).push(r);
    }
    const spots = {};
    for (const [name, rs] of bySpot) {
      const wave = [];
      const wind = [];
      let sideHits = 0;
      for (const r of rs) {
        const we = waveError(r.fc_wave_height, r.wave_band);
        if (we !== null) wave.push({ device: r.device_id, e: we });
        wind.push({ device: r.device_id, e: windError(r.fc_wind_speed, r.wind_strength) });
        if (windSide(r.fc_wind_dir, r.bearing) === r.wind_side) sideHits += 1;
      }
      spots[name] = {
        n: rs.length,
        wave_factor: Math.exp(shrunkMean(wave)),
        wind_offset: shrunkMean(wind),
        wind_side_hit: sideHits / rs.length,
      };
    }
    return spots;
  }

  function adjust(data, spotName, cal) {
    const s = cal && own(cal.spots, spotName) ? cal.spots[spotName] : null;
    if (!s) return { ...data };
    return {
      ...data,
      wave_height: data.wave_height * s.wave_factor,
      wind_speed: Math.max(0, data.wind_speed + s.wind_offset),
    };
  }

  // Component points stay scoreSpot's; only the total is re-weighted.
  function score(data, bearing, cal) {
    const base = Scoring.scoreSpot(data, bearing);
    const weights = (cal && cal.weights) || DEFAULT_WEIGHTS;
    let total = 0;
    for (const c of COMPONENTS) total += (weights[c.key] * base[c.key]) / c.max;
    return { ...base, total: Math.round(total) };
  }

  // One forecast cell as the site shows it: { data, scores } after calibration.
  // Used by the ranking and, as weeklyForecast's scorer, by the weekly view.
  function apply(rawData, spot, cal) {
    const data = adjust(rawData, spot.name, cal);
    return { data, scores: score(data, spot.bearing, cal) };
  }

  function features(data, bearing) {
    const base = Scoring.scoreSpot(data, bearing);
    return COMPONENTS.map((c) => base[c.key] / c.max);
  }

  // Gaussian elimination with partial pivoting; A is n×n, b has length n.
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  // rows: [{ x: [5 features in COMPONENTS order, each 0..1], r: rating, w: row weight }].
  // Returns learned weights (summing to TOTAL_POINTS), or null to keep the defaults.
  function fitWeights(rows) {
    const w0 = COMPONENTS.map((c) => DEFAULT_WEIGHTS[c.key]);
    const W = rows.reduce((s, row) => s + row.w, 0);
    if (!(W > 0)) return null;
    const t = rows.map((row) => row.x.reduce((s, xi, i) => s + w0[i] * xi, 0));
    const tBar = rows.reduce((s, row, j) => s + row.w * t[j], 0) / W;
    const rBar = rows.reduce((s, row) => s + row.w * row.r, 0) / W;
    let varT = 0;
    let covTR = 0;
    rows.forEach((row, j) => {
      varT += row.w * (t[j] - tBar) ** 2;
      covTR += row.w * (t[j] - tBar) * (row.r - rBar);
    });
    if (!(varT > 1e-12)) return null;
    const gamma = covTR / varT;
    if (!(gamma > 0)) return null;

    const k = COMPONENTS.length;
    const xBar = w0.map((_, i) => rows.reduce((s, row) => s + row.w * row.x[i], 0) / W);
    const A = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, m) => (i === m ? RIDGE_LAMBDA : 0)));
    const b = w0.map((wi) => RIDGE_LAMBDA * gamma * wi);
    for (const row of rows) {
      const xc = row.x.map((xi, i) => xi - xBar[i]);
      const rc = row.r - rBar;
      for (let i = 0; i < k; i++) {
        b[i] += row.w * xc[i] * rc;
        for (let m = 0; m < k; m++) A[i][m] += row.w * xc[i] * xc[m];
      }
    }
    const theta = solve(A, b);
    const bounded = theta.map((th, i) => clamp(th / gamma, WEIGHT_BOUNDS[0] * w0[i], WEIGHT_BOUNDS[1] * w0[i]));
    const scale = TOTAL_POINTS / bounded.reduce((s, v) => s + v, 0);
    return Object.fromEntries(COMPONENTS.map((c, i) => [c.key, bounded[i] * scale]));
  }

  function learnWeights(records, spots) {
    if (records.length < MIN_WEIGHT_RECORDS) return null;
    const perDevice = new Map();
    for (const r of records) perDevice.set(r.device_id, (perDevice.get(r.device_id) || 0) + 1);
    const cal = { spots };
    const rows = records.map((r) => ({
      x: features(adjust(rawData(r), r.spot, cal), r.bearing),
      r: r.rating,
      w: Math.min(1, DEVICE_CAP_WEIGHTS / perDevice.get(r.device_id)),
    }));
    return fitWeights(rows);
  }

  function compute(records) {
    const spots = spotCalibration(records);
    const learned = learnWeights(records, spots);
    const outSpots = {};
    for (const [name, s] of Object.entries(spots)) {
      outSpots[name] = {
        n: s.n,
        wave_factor: round3(s.wave_factor),
        wind_offset: round3(s.wind_offset),
        wind_side_hit: round3(s.wind_side_hit),
      };
    }
    const weights = learned || DEFAULT_WEIGHTS;
    return {
      version: 1,
      n: records.length,
      spots: outSpots,
      weights: Object.fromEntries(COMPONENTS.map((c) => [c.key, round3(weights[c.key])])),
      weights_learned: Boolean(learned),
    };
  }

  // Share of rating-discordant pairs whose higher-rated record got the higher
  // score; tied scores count half. null when every rating is the same.
  function concordance(ratings, scores) {
    let pairs = 0;
    let agree = 0;
    for (let i = 0; i < ratings.length; i++) {
      for (let j = i + 1; j < ratings.length; j++) {
        if (ratings[i] === ratings[j]) continue;
        pairs += 1;
        const hi = ratings[i] > ratings[j] ? i : j;
        const lo = hi === i ? j : i;
        if (scores[hi] > scores[lo]) agree += 1;
        else if (scores[hi] === scores[lo]) agree += 0.5;
      }
    }
    return pairs ? agree / pairs : null;
  }

  // Leave-one-out: each record is predicted by a calibration computed from
  // all the other records. O(n²) compute calls — fine for a few hundred.
  function metrics(records) {
    const n = records.length;
    const out = {
      n,
      wave_band_mae: { raw: null, calibrated: null },
      wind_strength_hit: { raw: null, calibrated: null },
      wind_side_hit: null,
      rating_concordance: { default: null, calibrated: null },
    };
    if (n < 2) return out;
    let maeRaw = 0;
    let maeCal = 0;
    let windRaw = 0;
    let windCal = 0;
    let side = 0;
    const ratings = [];
    const defaultScores = [];
    const calScores = [];
    records.forEach((r, j) => {
      const cal = compute(records.filter((_, i) => i !== j));
      const raw = rawData(r);
      const adj = adjust(raw, r.spot, cal);
      maeRaw += Math.abs(waveBand(raw.wave_height) - r.wave_band);
      maeCal += Math.abs(waveBand(adj.wave_height) - r.wave_band);
      if (windStrength(raw.wind_speed) === r.wind_strength) windRaw += 1;
      if (windStrength(adj.wind_speed) === r.wind_strength) windCal += 1;
      if (windSide(raw.wind_dir, r.bearing) === r.wind_side) side += 1;
      ratings.push(r.rating);
      defaultScores.push(Scoring.scoreSpot(raw, r.bearing).total);
      calScores.push(score(adj, r.bearing, cal).total);
    });
    const def = concordance(ratings, defaultScores);
    const calc = concordance(ratings, calScores);
    out.wave_band_mae = { raw: round3(maeRaw / n), calibrated: round3(maeCal / n) };
    out.wind_strength_hit = { raw: round3(windRaw / n), calibrated: round3(windCal / n) };
    out.wind_side_hit = round3(side / n);
    out.rating_concordance = {
      default: def === null ? null : round3(def),
      calibrated: calc === null ? null : round3(calc),
    };
    return out;
  }

  function validate(json) {
    if (!json || typeof json !== "object" || json.version !== 1) return false;
    if (!json.spots || typeof json.spots !== "object" || Array.isArray(json.spots)) return false;
    for (const s of Object.values(json.spots)) {
      if (!s || typeof s !== "object") return false;
      if (![s.n, s.wave_factor, s.wind_offset, s.wind_side_hit].every(Number.isFinite)) return false;
      if (s.wave_factor < 0.5 || s.wave_factor > 2) return false;
      if (s.wind_offset < -4 || s.wind_offset > 4) return false;
    }
    const w = json.weights;
    if (!w || typeof w !== "object") return false;
    let sum = 0;
    for (const c of COMPONENTS) {
      const v = w[c.key];
      if (!Number.isFinite(v) || v <= 0) return false;
      sum += v;
    }
    return Math.abs(sum - TOTAL_POINTS) <= 0.1;
  }

  // "実況補正 7件（波×1.2・風+0.6m/s）"; empty when the spot has no records.
  function summaryLabel(spotName, cal) {
    const s = cal && own(cal.spots, spotName) ? cal.spots[spotName] : null;
    if (!s || !(s.n >= 1)) return "";
    const parts = [`波×${s.wave_factor.toFixed(1)}`];
    if (Math.abs(s.wind_offset) >= 0.5) {
      parts.push(`風${s.wind_offset > 0 ? "+" : "-"}${Math.abs(s.wind_offset).toFixed(1)}m/s`);
    }
    return `実況補正 ${s.n}件（${parts.join("・")}）`;
  }

  return {
    WAVE_BANDS, WIND_STRENGTHS, WIND_SIDES, DEFAULT_WEIGHTS,
    waveBand, windSide, windStrength, waveError, windError,
    compute, fitWeights, metrics, adjust, score, apply, validate, summaryLabel,
  };
});
