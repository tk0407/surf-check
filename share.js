// 表示ラベルの整形と、共有用のテキスト・カード。画面・共有テキスト・共有
// 画像が同じ文字列を出せるよう、ラベルはここにだけ置く。pure な部分は
// node --test で動く。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Share = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  const SLOT_SHORT = { morning: "朝", afternoon: "昼", evening: "夕" };
  const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];

  function dateParts(date) {
    const d = new Date(`${date}T00:00:00`);
    return { month: d.getMonth() + 1, day: d.getDate(), weekday: WEEKDAYS_JA[d.getDay()] };
  }

  // "9/19(土)"
  function mdLabel(date) {
    const p = dateParts(date);
    return `${p.month}/${p.day}(${p.weekday})`;
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

  // 共有テキストと共有カードが参照する唯一の整形。results は
  // scores.total の降順に並んでいる前提。
  function cardRows(results) {
    return results.slice(0, 3).map((r, i) => ({
      rank: i + 1,
      name: r.spot.name,
      score: r.scores.total,
      wave: `${r.data.wave_height.toFixed(1)}m ${Scoring.waveSizeLabel(r.data.wave_height)}`,
      wind: `${jpDirection(r.data.wind_dir)} ${r.data.wind_speed.toFixed(1)}m/s `
        + `${windConditionLabel(r.data.wind_dir, r.data.wind_speed, r.spot.bearing)}`,
    }));
  }

  function shareLines(region, date, slot, results) {
    const head = `${region} ${mdLabel(date)} ${SLOT_SHORT[slot]}のサーフチェック`;
    const rows = cardRows(results).map(
      (r) => `${r.rank}位 ${r.name} ${r.score}点（${r.wave.split(" ")[0]} / ${r.wind.replace(" ", "")}）`
    );
    return [head, ...rows];
  }

  function shareText(region, date, slot, results, url) {
    return `${shareLines(region, date, slot, results).join("\n")}\n\n${url}`;
  }

  function shareUrl(base, region, date, slot) {
    const u = new URL(base);
    u.search = new URLSearchParams({ region, date, slot }).toString();
    return u.toString();
  }

  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl,
  };
});
