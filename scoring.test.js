const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./scoring.js");

test("windDirectionScore boundaries (beach faces E=90, offshore from 270)", () => {
  assert.equal(S.windDirectionScore(270, 90), 20); // diff 0
  assert.equal(S.windDirectionScore(314, 90), 20); // diff 44
  assert.equal(S.windDirectionScore(315, 90), 14); // diff 45
  assert.equal(S.windDirectionScore(345, 90), 14); // diff 75
  assert.equal(S.windDirectionScore(346, 90), 8);  // diff 76
  assert.equal(S.windDirectionScore(15, 90), 8);   // diff 105
  assert.equal(S.windDirectionScore(16, 90), 3);   // diff 106
  assert.equal(S.windDirectionScore(45, 90), 3);   // diff 135
  assert.equal(S.windDirectionScore(46, 90), 0);   // diff 136
  assert.equal(S.windDirectionScore(90, 90), 0);   // onshore, diff 180
});

test("windSpeedScore boundaries", () => {
  assert.equal(S.windSpeedScore(2), 10);
  assert.equal(S.windSpeedScore(2.1), 8);
  assert.equal(S.windSpeedScore(5), 8);
  assert.equal(S.windSpeedScore(5.1), 5);
  assert.equal(S.windSpeedScore(8), 5);
  assert.equal(S.windSpeedScore(8.1), 2);
  assert.equal(S.windSpeedScore(12), 2);
  assert.equal(S.windSpeedScore(12.1), 0);
});

test("swellDirectionScore boundaries (bearing 180)", () => {
  assert.equal(S.swellDirectionScore(180, 180), 20); // diff 0
  assert.equal(S.swellDirectionScore(210, 180), 20); // diff 30
  assert.equal(S.swellDirectionScore(211, 180), 14); // diff 31
  assert.equal(S.swellDirectionScore(240, 180), 14); // diff 60
  assert.equal(S.swellDirectionScore(241, 180), 6);  // diff 61
  assert.equal(S.swellDirectionScore(270, 180), 6);  // diff 90
  assert.equal(S.swellDirectionScore(271, 180), 0);  // diff 91
});

test("swellPeriodScore boundaries", () => {
  assert.equal(S.swellPeriodScore(15), 20);
  assert.equal(S.swellPeriodScore(14.9), 16);
  assert.equal(S.swellPeriodScore(12), 16);
  assert.equal(S.swellPeriodScore(11.9), 10);
  assert.equal(S.swellPeriodScore(10), 10);
  assert.equal(S.swellPeriodScore(9.9), 5);
  assert.equal(S.swellPeriodScore(8), 5);
  assert.equal(S.swellPeriodScore(7.9), 0);
});

test("waveHeightScore boundaries", () => {
  assert.equal(S.waveHeightScore(2.0), 15);
  assert.equal(S.waveHeightScore(1.9), 13);
  assert.equal(S.waveHeightScore(1.5), 13);
  assert.equal(S.waveHeightScore(1.4), 10);
  assert.equal(S.waveHeightScore(1.0), 10);
  assert.equal(S.waveHeightScore(0.9), 5);
  assert.equal(S.waveHeightScore(0.5), 5);
  assert.equal(S.waveHeightScore(0.4), 0);
});

test("waveSizeLabel boundaries", () => {
  assert.equal(S.waveSizeLabel(0.29), "フラット");
  assert.equal(S.waveSizeLabel(0.3), "ヒザ");
  assert.equal(S.waveSizeLabel(0.5), "コシ〜ハラ");
  assert.equal(S.waveSizeLabel(0.8), "ムネ〜カタ");
  assert.equal(S.waveSizeLabel(1.1), "カタ〜アタマ");
  assert.equal(S.waveSizeLabel(1.5), "アタマ〜オーバー");
  assert.equal(S.waveSizeLabel(2.0), "オーバーヘッド");
  assert.equal(S.waveSizeLabel(2.5), "ダブル+");
});

test("degreesToCompass key points", () => {
  assert.equal(S.degreesToCompass(0), "N");
  assert.equal(S.degreesToCompass(45), "NE");
  assert.equal(S.degreesToCompass(90), "E");
  assert.equal(S.degreesToCompass(180), "S");
  assert.equal(S.degreesToCompass(270), "W");
  assert.equal(S.degreesToCompass(359), "N");
});

test("windLabel matches CLI format (千倉 example)", () => {
  // bearing 175, wind from E(90), 0.9m/s -> side-onshore
  assert.equal(S.windLabel(90, 0.9, 175), "E 0.9m/s 💨サイドショア");
});

test("scoreSpot sums components", () => {
  const data = { wind_dir: 270, wind_speed: 1.5, swell_dir: 180, swell_period: 12, wave_height: 2.0 };
  const s = S.scoreSpot(data, 180);
  assert.equal(s.wind_direction, 8);  // offshore from 0, diff 90
  assert.equal(s.wind_speed, 10);
  assert.equal(s.swell_direction, 20);
  assert.equal(s.swell_period, 16);
  assert.equal(s.wave_height, 15);
  assert.equal(s.total, 69);
});

// --- tideEvents ---

// 3 days of hourly samples around the target date, like the app fetches.
function tideSeries(heightFn) {
  const days = ["2026-07-04", "2026-07-05", "2026-07-06"];
  const times = [];
  const heights = [];
  days.forEach((day, di) => {
    for (let h = 0; h < 24; h++) {
      times.push(`${day}T${String(h).padStart(2, "0")}:00`);
      heights.push(heightFn(di * 24 + h));
    }
  });
  return { times, heights };
}

function toMinutes(hhmm) {
  return parseInt(hhmm.slice(0, 2), 10) * 60 + parseInt(hhmm.slice(3, 5), 10);
}

// M2 tide: 12.4h period cosine peaking at t=27h (=2026-07-05 03:00).
const m2 = (t) => 0.5 * Math.cos((2 * Math.PI * (t - 27)) / 12.4);

test("tideEvents finds semidiurnal highs/lows on the target date with minute precision", () => {
  const { times, heights } = tideSeries(m2);
  const events = S.tideEvents(times, heights, "2026-07-05");
  // analytic extremes on 07-05: highs 03:00 / 15:24, lows 09:12 / 21:36
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((e) => e.type), ["high", "low", "high", "low"]);
  const expected = ["03:00", "09:12", "15:24", "21:36"];
  events.forEach((e, i) => {
    const delta = Math.abs(toMinutes(e.time) - toMinutes(expected[i]));
    assert.ok(delta <= 6, `event ${i}: ${e.time} vs ${expected[i]} (off by ${delta}min)`);
  });
  assert.ok(Math.abs(events[0].height - 0.5) < 0.02);
  assert.ok(Math.abs(events[1].height + 0.5) < 0.02);
});

test("tideEvents skips extremes whose neighborhood contains nulls", () => {
  const { times, heights } = tideSeries(m2);
  for (let i = 36; i <= 42; i++) heights[i] = null; // kills the 15:24 high
  const events = S.tideEvents(times, heights, "2026-07-05");
  assert.deepEqual(events.map((e) => e.type), ["high", "low", "low"]);
  assert.ok(Math.abs(toMinutes(events[0].time) - toMinutes("03:00")) <= 6);
  assert.ok(Math.abs(toMinutes(events[2].time) - toMinutes("21:36")) <= 6);
});

test("tideEvents returns empty for monotonic data", () => {
  const { times, heights } = tideSeries((t) => t * 0.01);
  assert.deepEqual(S.tideEvents(times, heights, "2026-07-05"), []);
});
