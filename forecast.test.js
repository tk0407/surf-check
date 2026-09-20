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
