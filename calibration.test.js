const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("./calibration.js");
const S = require("./scoring.js");

const round3 = (v) => Math.round(v * 1000) / 1000;
const W0 = { wind_direction: 20, wind_speed: 10, swell_direction: 20, swell_period: 20, wave_height: 15 };
const KEYS = Object.keys(W0);

// A D1 feedback row. Bearing 90, so the offshore wind blows from 270.
// The observed values match the forecast unless overridden.
function row(overrides = {}) {
  return {
    device_id: "dev-a", spot: "一宮", bearing: 90,
    fc_wave_height: 1.0, fc_wind_dir: 270, fc_wind_speed: 3, fc_swell_dir: 90, fc_swell_period: 11,
    rating: 3, wave_band: 3, wind_side: "off", wind_strength: "light",
    ...overrides,
  };
}

// --- bands and categories ---

test("waveBand splits at 0.3/0.5/0.8/1.1/1.5/2.0/2.5, each band [lo, hi)", () => {
  const cases = [[0, 0], [0.29, 0], [0.3, 1], [0.49, 1], [0.5, 2], [0.79, 2], [0.8, 3], [1.09, 3],
    [1.1, 4], [1.49, 4], [1.5, 5], [1.99, 5], [2.0, 6], [2.49, 6], [2.5, 7], [6, 7]];
  for (const [h, band] of cases) assert.equal(C.waveBand(h), band, `h=${h}`);
});

test("waveBand labels agree with Scoring.waveSizeLabel from 0 to 4 m", () => {
  for (let i = 0; i <= 80; i++) {
    const h = i / 20;
    assert.equal(C.WAVE_BANDS[C.waveBand(h)].label, S.waveSizeLabel(h), `h=${h}`);
  }
});

test("windSide is off up to 75°, side up to 105°, on beyond (from offshore)", () => {
  // bearing 90 -> offshore wind comes from 270
  assert.equal(C.windSide(270, 90), "off");
  assert.equal(C.windSide(345, 90), "off"); // 75
  assert.equal(C.windSide(346, 90), "side"); // 76
  assert.equal(C.windSide(15, 90), "side"); // 105
  assert.equal(C.windSide(16, 90), "on"); // 106
  assert.equal(C.windSide(90, 90), "on"); // 180
});

test("windStrength is calm up to 2, light up to 5, strong beyond", () => {
  assert.equal(C.windStrength(0), "calm");
  assert.equal(C.windStrength(2), "calm");
  assert.equal(C.windStrength(2.01), "light");
  assert.equal(C.windStrength(5), "light");
  assert.equal(C.windStrength(5.01), "strong");
});

// --- per-record errors ---

test("waveError is 0 inside the observed band and the log ratio to its center outside", () => {
  assert.equal(C.waveError(1.0, 3), 0);
  assert.equal(C.waveError(0.8, 3), 0);
  assert.equal(C.waveError(1.1, 3), Math.log(0.95 / 1.1)); // 1.1 belongs to band 4
  assert.equal(C.waveError(0.6, 3), Math.log(0.95 / 0.6));
});

test("waveError clamps to ±ln 2 and skips forecasts of 0 or below", () => {
  assert.equal(C.waveError(0.2, 7), Math.LN2);
  assert.equal(C.waveError(3.0, 0), -Math.LN2);
  assert.equal(C.waveError(0, 3), null);
  assert.equal(C.waveError(-0.1, 3), null);
});

test("windError is 0 inside the observed range and center minus forecast outside, clamped to ±4", () => {
  assert.equal(C.windError(3, "light"), 0);
  assert.equal(C.windError(2, "calm"), 0);
  assert.equal(C.windError(2, "light"), 1.5); // 2 is calm, not light
  assert.equal(C.windError(6, "light"), -2.5);
  assert.equal(C.windError(1, "strong"), 4); // 7 - 1 = 6 -> 4
  assert.equal(C.windError(9, "calm"), -4); // 1 - 9 = -8 -> -4
});

// --- per-spot aggregation (K = 3) ---

const E06 = Math.log(0.95 / 0.6); // forecast 0.6 m, observed ムネ〜カタ

test("compute pulls a single record's wave error to 1/4 (K = 3)", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 })]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 4)));
  assert.equal(cal.spots["一宮"].n, 1);
});

test("compute gives three records from one device half the error", () => {
  const cal = C.compute([1, 2, 3].map(() => row({ fc_wave_height: 0.6 })));
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 2)));
});

test("compute averages two devices with one record each over 2 + 3", () => {
  const cal = C.compute([
    row({ device_id: "a", fc_wave_height: 0.6 }),
    row({ device_id: "b", fc_wave_height: 1.0 }), // in band -> error 0
  ]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 5)));
});

test("compute caps one device's weight at 5 records per spot", () => {
  const five = C.compute(Array.from({ length: 5 }, () => row({ fc_wave_height: 0.6 })));
  const eight = C.compute(Array.from({ length: 8 }, () => row({ fc_wave_height: 0.6 })));
  assert.equal(eight.spots["一宮"].wave_factor, round3(Math.exp((5 * E06) / 8)));
  assert.equal(eight.spots["一宮"].wave_factor, five.spots["一宮"].wave_factor);
});

test("compute leaves forecasts of 0 out of the wave factor but counts them elsewhere", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 }), row({ device_id: "b", fc_wave_height: 0, wave_band: 2 })]);
  assert.equal(cal.spots["一宮"].wave_factor, round3(Math.exp(E06 / 4)));
  assert.equal(cal.spots["一宮"].n, 2);
});

test("compute derives wind_offset the same way and wind_side_hit as a plain rate", () => {
  const cal = C.compute([
    row({ fc_wind_speed: 6, wind_strength: "light" }), // error -2.5
    row({ device_id: "b", wind_side: "on" }), // forecast off -> miss
  ]);
  assert.equal(cal.spots["一宮"].wind_offset, round3(-2.5 / 5));
  assert.equal(cal.spots["一宮"].wind_side_hit, 0.5);
});

test("compute keeps each spot separate and returns defaults with no records", () => {
  const cal = C.compute([row({ fc_wave_height: 0.6 }), row({ spot: "志田下" })]);
  assert.deepEqual(Object.keys(cal.spots).sort(), ["一宮", "志田下"].sort());
  assert.equal(cal.spots["志田下"].wave_factor, 1);
  assert.deepEqual(C.compute([]), { version: 1, n: 0, spots: {}, weights: W0, weights_learned: false });
});

// --- weights ---

// All 32 on/off combinations of the five features: orthogonal once centered.
function factorial(ratingOf) {
  const rows = [];
  for (let m = 0; m < 32; m++) {
    const x = [0, 1, 2, 3, 4].map((i) => (m >> i) & 1);
    rows.push({ x, r: ratingOf(x), w: 1 });
  }
  return rows;
}
const dot = (x, w) => x.reduce((s, xi, i) => s + xi * w[i], 0);
const W0_LIST = KEYS.map((k) => W0[k]);

test("fitWeights returns the default weights when ratings follow the default total exactly", () => {
  const w = C.fitWeights(factorial((x) => 1 + (4 * dot(x, W0_LIST)) / 85));
  for (const k of KEYS) assert.ok(Math.abs(w[k] - W0[k]) < 1e-9, `${k}: ${w[k]}`);
});

test("fitWeights raises the weight of a component the ratings lean on", () => {
  const w = C.fitWeights(factorial((x) => 1 + (4 * (dot(x, W0_LIST) + 20 * x[4])) / 105));
  assert.ok(w.wave_height > 15, `wave_height ${w.wave_height}`);
  for (const k of KEYS.filter((k) => k !== "wave_height")) {
    assert.ok(w.wave_height / 15 > w[k] / W0[k], k);
  }
});

test("fitWeights clamps each weight to 0.5-2x before rescaling the sum to 85", () => {
  // Ratings depend on the swell period only: it hits 2x (40), the rest hit 0.5x.
  const w = C.fitWeights(factorial((x) => 1 + 4 * x[3]));
  const scale = 85 / (10 + 5 + 10 + 40 + 7.5);
  assert.deepEqual(Object.fromEntries(KEYS.map((k) => [k, round3(w[k])])), {
    wind_direction: round3(10 * scale), wind_speed: round3(5 * scale), swell_direction: round3(10 * scale),
    swell_period: round3(40 * scale), wave_height: round3(7.5 * scale),
  });
  assert.ok(Math.abs(KEYS.reduce((s, k) => s + w[k], 0) - 85) < 1e-9);
});

test("fitWeights keeps the defaults when ratings are flat, inverted, or the totals never vary", () => {
  assert.equal(C.fitWeights(factorial(() => 3)), null);
  assert.equal(C.fitWeights(factorial((x) => 5 - (4 * dot(x, W0_LIST)) / 85)), null);
  const same = Array.from({ length: 20 }, (_, j) => ({ x: [1, 1, 0, 1, 0], r: 1 + (j % 5), w: 1 }));
  assert.equal(C.fitWeights(same), null);
});

// Records spread over the five components; the observed values match the
// forecast so the spot factors stay neutral and features equal raw points.
function spreadRecords(ratingOf, device = (j) => `dev-${j}`) {
  const winds = [[270, 1], [0, 4], [90, 10]];
  const swells = [[90, 16], [150, 11], [200, 7]];
  const heights = [0.4, 1.2, 2.2];
  const out = [];
  let j = 0;
  for (const [wd, ws] of winds) for (const [sd, sp] of swells) for (const h of heights) {
    const data = { wind_dir: wd, wind_speed: ws, swell_dir: sd, swell_period: sp, wave_height: h };
    const scores = S.scoreSpot(data, 90);
    out.push(row({
      device_id: device(j), fc_wind_dir: wd, fc_wind_speed: ws, fc_swell_dir: sd, fc_swell_period: sp, fc_wave_height: h,
      wave_band: C.waveBand(h), wind_side: C.windSide(wd, 90), wind_strength: C.windStrength(ws),
      rating: ratingOf(scores),
    }));
    j += 1;
  }
  return out;
}
const byTotal = (s) => Math.min(5, Math.max(1, Math.round(1 + (4 * s.total) / 85)));

test("compute keeps the default weights below 15 records and learns from 15", () => {
  const records = spreadRecords(byTotal);
  const fourteen = C.compute(records.slice(0, 14));
  assert.equal(fourteen.weights_learned, false);
  assert.deepEqual(fourteen.weights, W0);
  const fifteen = C.compute(records.slice(0, 15));
  assert.equal(fifteen.weights_learned, true);
});

test("compute learns weights near the defaults from ratings that follow the default total", () => {
  const cal = C.compute(spreadRecords(byTotal));
  assert.equal(cal.weights_learned, true);
  for (const k of KEYS) {
    const ratio = cal.weights[k] / W0[k];
    assert.ok(ratio > 0.75 && ratio < 1.25, `${k}: ${cal.weights[k]}`);
  }
  assert.ok(Math.abs(KEYS.reduce((s, k) => s + cal.weights[k], 0) - 85) <= 0.01);
});

test("compute weights a device's records by min(1, 30 / its record count)", () => {
  const bySize = (s) => (s.wave_height >= 10 ? 5 : 1);
  const byPeriod = (s) => (s.swell_period >= 10 ? 5 : 1);
  const others = spreadRecords(byPeriod);
  const heavy = spreadRecords(bySize, () => "heavy").slice(0, 15);
  const copies = (n, device) => Array.from({ length: n }, () => heavy.map((r) => ({ ...r, device_id: device }))).flat();
  // 60 records from one device weigh 0.5 each: the same as 30 records weighing 1.
  const sixty = C.compute([...others, ...copies(4, "heavy")]);
  const thirty = C.compute([...others, ...copies(2, "heavy")]);
  // Without the cap, 60 records from two devices of 30 pull twice as hard.
  const twoDevices = C.compute([...others, ...copies(2, "heavy"), ...copies(2, "heavy-2")]);
  for (const k of KEYS) assert.ok(Math.abs(sixty.weights[k] - thirty.weights[k]) < 0.002, k);
  assert.notDeepEqual(sixty.weights, twoDevices.weights);
});

// --- adjust / score ---

const DATA = { wind_dir: 270, wind_speed: 3, swell_dir: 90, swell_period: 11, wave_height: 1.0 };
const CAL = {
  version: 1, n: 3,
  spots: { 一宮: { n: 3, wave_factor: 1.2, wind_offset: 0.6, wind_side_hit: 1 } },
  weights: W0, weights_learned: false,
};

test("adjust scales the wave height and shifts the wind speed without touching its input", () => {
  const input = { ...DATA };
  const out = C.adjust(input, "一宮", CAL);
  assert.deepEqual(out, { ...DATA, wave_height: 1.2, wind_speed: 3.6 });
  assert.deepEqual(input, DATA);
});

test("adjust passes unknown spots and a null calibration through as copies", () => {
  assert.deepEqual(C.adjust(DATA, "志田下", CAL), DATA);
  assert.deepEqual(C.adjust(DATA, "一宮", null), DATA);
  assert.notEqual(C.adjust(DATA, "一宮", null), DATA);
  assert.deepEqual(C.adjust(DATA, "constructor", CAL), DATA);
});

test("adjust never pushes the wind speed below 0", () => {
  const cal = { ...CAL, spots: { 一宮: { n: 1, wave_factor: 1, wind_offset: -4, wind_side_hit: 1 } } };
  const out = C.adjust({ ...DATA, wind_speed: 1.5 }, "一宮", cal);
  assert.equal(out.wind_speed, 0);
  assert.equal(C.score(out, 90, cal).wind_speed, 10);
});

test("score matches Scoring.scoreSpot exactly with the default weights or no calibration", () => {
  for (const wind_dir of [0, 45, 100, 200, 270, 330]) for (const wind_speed of [0, 2, 4, 7, 11, 15])
    for (const swell_dir of [90, 130, 170, 250]) for (const swell_period of [6, 9, 11, 13, 16])
      for (const wave_height of [0.2, 0.6, 1.2, 1.7, 2.4]) {
        const data = { wind_dir, wind_speed, swell_dir, swell_period, wave_height };
        const expected = S.scoreSpot(data, 90);
        assert.deepEqual(C.score(data, 90, null), expected);
        assert.deepEqual(C.score(data, 90, CAL), expected);
      }
});

test("score keeps the component points and re-weights only the total", () => {
  const weights = { wind_direction: 10, wind_speed: 10, swell_direction: 20, swell_period: 20, wave_height: 25 };
  const out = C.score(DATA, 90, { ...CAL, weights });
  const base = S.scoreSpot(DATA, 90); // 20, 8, 20, 10, 10
  assert.deepEqual({ ...out, total: 0 }, { ...base, total: 0 });
  assert.equal(out.total, Math.round(10 * 20 / 20 + 10 * 8 / 10 + 20 * 20 / 20 + 20 * 10 / 20 + 25 * 10 / 15));
});

test("apply returns the calibrated data with its score, and the plain scoreSpot cell without calibration", () => {
  const spot = { name: "一宮", bearing: 90 };
  const adjusted = { ...DATA, wave_height: 1.2, wind_speed: 3.6 };
  assert.deepEqual(C.apply(DATA, spot, CAL), { data: adjusted, scores: C.score(adjusted, 90, CAL) });
  assert.deepEqual(C.apply(DATA, spot, null), { data: DATA, scores: S.scoreSpot(DATA, 90) });
  assert.deepEqual(C.apply(DATA, { name: "志田下", bearing: 90 }, CAL), { data: DATA, scores: S.scoreSpot(DATA, 90) });
});

// --- validate ---

test("validate accepts compute's output and the documented shape", () => {
  assert.equal(C.validate(C.compute([])), true);
  assert.equal(C.validate(C.compute(spreadRecords(byTotal))), true);
  assert.equal(C.validate(CAL), true);
});

test("validate rejects a wrong version, out-of-range values, NaN and missing fields", () => {
  const bad = [
    null, "x", { ...CAL, version: 2 }, { ...CAL, spots: [] },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wave_factor: 2.01 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wave_factor: 0.49 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wind_offset: -4.01 } } },
    { ...CAL, spots: { 一宮: { ...CAL.spots["一宮"], wind_offset: NaN } } },
    { ...CAL, spots: { 一宮: { n: 3, wave_factor: 1.2, wind_offset: 0.6 } } },
    { ...CAL, weights: { ...W0, wave_height: undefined } },
    { ...CAL, weights: { ...W0, wind_speed: 0 } },
    { ...CAL, weights: { ...W0, wave_height: 15.2 } }, // sums to 85.2
    { ...CAL, weights: undefined },
  ];
  bad.forEach((json, i) => assert.equal(C.validate(json), false, `case ${i}`));
  assert.equal(C.validate({ ...CAL, weights: { ...W0, wave_height: 15.1 } }), true); // 85.1
});

// --- metrics ---

test("metrics shows the calibrated wave bands closer than the raw forecast for a biased spot", () => {
  // Every visitor at 一宮 saw ムネ〜カタ while the forecast said 0.6 m (コシ〜ハラ).
  const records = Array.from({ length: 8 }, (_, j) => row({ device_id: `d${j}`, fc_wave_height: 0.6, wave_band: 3 }));
  const m = C.metrics(records);
  assert.equal(m.n, 8);
  assert.equal(m.wave_band_mae.raw, 1);
  assert.equal(m.wave_band_mae.calibrated, 0);
  assert.equal(m.wind_side_hit, 1);
});

test("metrics compares rating concordance for the default and calibrated scores", () => {
  const m = C.metrics(spreadRecords(byTotal));
  assert.equal(m.rating_concordance.default, 1);
  assert.ok(m.rating_concordance.calibrated > 0.9, String(m.rating_concordance.calibrated));
  assert.equal(m.wind_strength_hit.raw, 1);
});

test("metrics returns nulls for one record or none", () => {
  const empty = {
    wave_band_mae: { raw: null, calibrated: null }, wind_strength_hit: { raw: null, calibrated: null },
    wind_side_hit: null, rating_concordance: { default: null, calibrated: null },
  };
  assert.deepEqual(C.metrics([]), { n: 0, ...empty });
  assert.deepEqual(C.metrics([row()]), { n: 1, ...empty });
});

// --- summaryLabel ---

test("summaryLabel shows the record count, the wave factor and a signed wind offset", () => {
  assert.equal(C.summaryLabel("一宮", CAL), "実況補正 3件（波×1.2・風+0.6m/s）");
  const neg = { ...CAL, spots: { 一宮: { n: 7, wave_factor: 0.84, wind_offset: -1.26, wind_side_hit: 1 } } };
  assert.equal(C.summaryLabel("一宮", neg), "実況補正 7件（波×0.8・風-1.3m/s）");
});

test("summaryLabel drops the wind part inside ±0.5 m/s", () => {
  const at = (off) => ({ ...CAL, spots: { 一宮: { n: 2, wave_factor: 1.12, wind_offset: off, wind_side_hit: 1 } } });
  assert.equal(C.summaryLabel("一宮", at(0.5)), "実況補正 2件（波×1.1・風+0.5m/s）");
  assert.equal(C.summaryLabel("一宮", at(-0.5)), "実況補正 2件（波×1.1・風-0.5m/s）");
  assert.equal(C.summaryLabel("一宮", at(0.499)), "実況補正 2件（波×1.1）");
  assert.equal(C.summaryLabel("一宮", at(-0.499)), "実況補正 2件（波×1.1）");
});

test("summaryLabel is empty for spots without records and without a calibration", () => {
  assert.equal(C.summaryLabel("志田下", CAL), "");
  assert.equal(C.summaryLabel("一宮", null), "");
  assert.equal(C.summaryLabel("一宮", C.compute([])), "");
});
