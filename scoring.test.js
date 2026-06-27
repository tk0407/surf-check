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
