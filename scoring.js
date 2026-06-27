// Port of waveinfo_collector/scoring.py (+ surf_checker.py wind/compass helpers).
// Python version is the source of truth — update BOTH when thresholds change.
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof self !== "undefined" ? self : this, function () {
  function angleDiff(a, b) {
    const diff = Math.abs(a - b) % 360;
    return diff <= 180 ? diff : 360 - diff;
  }

  function windDirectionScore(windDir, bearing) {
    const offshoreFrom = (bearing + 180) % 360;
    const diff = angleDiff(windDir, offshoreFrom);
    if (diff < 45) return 20;
    if (diff <= 75) return 14;
    if (diff <= 105) return 8;
    if (diff <= 135) return 3;
    return 0;
  }

  function windSpeedScore(windSpeedMs) {
    if (windSpeedMs <= 2) return 10;
    if (windSpeedMs <= 5) return 8;
    if (windSpeedMs <= 8) return 5;
    if (windSpeedMs <= 12) return 2;
    return 0;
  }

  function swellDirectionScore(swellDir, bearing) {
    const diff = angleDiff(swellDir, bearing);
    if (diff <= 30) return 20;
    if (diff <= 60) return 14;
    if (diff <= 90) return 6;
    return 0;
  }

  function swellPeriodScore(periodS) {
    if (periodS >= 15) return 20;
    if (periodS >= 12) return 16;
    if (periodS >= 10) return 10;
    if (periodS >= 8) return 5;
    return 0;
  }

  function waveHeightScore(heightM) {
    if (heightM >= 2.0) return 15;
    if (heightM >= 1.5) return 13;
    if (heightM >= 1.0) return 10;
    if (heightM >= 0.5) return 5;
    return 0;
  }

  function waveSizeLabel(heightM) {
    if (heightM < 0.3) return "フラット";
    if (heightM < 0.5) return "ヒザ";
    if (heightM < 0.8) return "コシ〜ハラ";
    if (heightM < 1.1) return "ムネ〜カタ";
    if (heightM < 1.5) return "カタ〜アタマ";
    if (heightM < 2.0) return "アタマ〜オーバー";
    if (heightM < 2.5) return "オーバーヘッド";
    return "ダブル+";
  }

  const WIND_DIR_NAMES = [
    [0, 22.5, "N"], [22.5, 67.5, "NE"], [67.5, 112.5, "E"],
    [112.5, 157.5, "SE"], [157.5, 202.5, "S"], [202.5, 247.5, "SW"],
    [247.5, 292.5, "W"], [292.5, 337.5, "NW"], [337.5, 360, "N"],
  ];

  function degreesToCompass(deg) {
    deg = ((deg % 360) + 360) % 360;
    for (const [lo, hi, name] of WIND_DIR_NAMES) {
      if (lo <= deg && deg < hi) return name;
    }
    return "N";
  }

  function windLabel(windDir, windSpeed, bearing) {
    const compass = degreesToCompass(windDir);
    const offshoreFrom = (bearing + 180) % 360;
    let diff = Math.abs(windDir - offshoreFrom) % 360;
    if (diff > 180) diff = 360 - diff;
    let tag;
    if (diff < 45) tag = "✅オフショア";
    else if (diff <= 75) tag = "⚡サイドオフ";
    else if (diff <= 105) tag = "💨サイドショア";
    else tag = "❌オンショア";
    return `${compass} ${windSpeed.toFixed(1)}m/s ${tag}`;
  }

  function scoreSpot(data, bearing) {
    const scores = {
      wind_direction: windDirectionScore(data.wind_dir, bearing),
      wind_speed: windSpeedScore(data.wind_speed),
      swell_direction: swellDirectionScore(data.swell_dir, bearing),
      swell_period: swellPeriodScore(data.swell_period),
      wave_height: waveHeightScore(data.wave_height),
    };
    scores.total = scores.wind_direction + scores.wind_speed +
      scores.swell_direction + scores.swell_period + scores.wave_height;
    return scores;
  }

  return {
    angleDiff, windDirectionScore, windSpeedScore, swellDirectionScore,
    swellPeriodScore, waveHeightScore, waveSizeLabel, degreesToCompass,
    windLabel, scoreSpot,
  };
});
