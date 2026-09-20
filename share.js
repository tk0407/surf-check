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

  const CARD_SIZE = 1080;
  const CARD_PAD = 64;
  const CARD_FONT = 'system-ui, -apple-system, "Hiragino Sans", "Yu Gothic", sans-serif';
  const SLOT_LONG = { morning: "朝 07-10時", afternoon: "昼 12-15時", evening: "夕 16-19時" };

  // "9月20日(日)"
  function longDateLabel(date) {
    const p = dateParts(date);
    return `${p.month}月${p.day}日(${p.weekday})`;
  }

  // 幅に収まらない名前は末尾を … にする。
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let cut = text;
    while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
    return `${cut}…`;
  }

  function drawShareCard(canvas, info) {
    canvas.width = CARD_SIZE;
    canvas.height = CARD_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#edf3f5";
    ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";

    ctx.fillStyle = "#007f8f";
    ctx.font = `800 30px ${CARD_FONT}`;
    ctx.fillText("SURF CHECK", CARD_PAD, CARD_PAD + 30);

    ctx.fillStyle = "#124559";
    ctx.font = `800 54px ${CARD_FONT}`;
    ctx.fillText(`${info.region} / ${longDateLabel(info.date)}`, CARD_PAD, CARD_PAD + 104);
    ctx.fillStyle = "#687481";
    ctx.font = `700 38px ${CARD_FONT}`;
    ctx.fillText(SLOT_LONG[info.slot], CARD_PAD, CARD_PAD + 160);

    ctx.strokeStyle = "#dce5eb";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(CARD_PAD, CARD_PAD + 200);
    ctx.lineTo(CARD_SIZE - CARD_PAD, CARD_PAD + 200);
    ctx.stroke();

    info.rows.forEach((row, i) => {
      const top = CARD_PAD + 250 + i * 200;

      // 順位バッジ
      ctx.beginPath();
      ctx.arc(CARD_PAD + 34, top + 24, 34, 0, Math.PI * 2);
      ctx.fillStyle = row.rank === 1 ? "#124559" : "#ffffff";
      ctx.fill();
      if (row.rank !== 1) {
        ctx.strokeStyle = "#124559";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = row.rank === 1 ? "#ffffff" : "#124559";
      ctx.font = `900 38px ${CARD_FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(String(row.rank), CARD_PAD + 34, top + 38);
      ctx.textAlign = "left";

      // 点数は右端から逆算して置く
      ctx.font = `900 56px ${CARD_FONT}`;
      const scoreText = String(row.score);
      const scoreWidth = ctx.measureText(scoreText).width;
      ctx.font = `700 30px ${CARD_FONT}`;
      const suffixWidth = ctx.measureText("/85").width;
      const scoreLeft = CARD_SIZE - CARD_PAD - scoreWidth - suffixWidth;
      ctx.fillStyle = "#007f8f";
      ctx.font = `900 56px ${CARD_FONT}`;
      ctx.fillText(scoreText, scoreLeft, top + 44);
      ctx.fillStyle = "#687481";
      ctx.font = `700 30px ${CARD_FONT}`;
      ctx.fillText("/85", scoreLeft + scoreWidth, top + 44);

      // ポイント名は点数の手前まで
      ctx.fillStyle = "#17212b";
      ctx.font = `800 48px ${CARD_FONT}`;
      const nameMax = scoreLeft - (CARD_PAD + 90) - 24;
      ctx.fillText(fitText(ctx, row.name, nameMax), CARD_PAD + 90, top + 40);

      ctx.fillStyle = "#687481";
      ctx.font = `600 32px ${CARD_FONT}`;
      ctx.fillText(`${row.wave} ・ ${row.wind}`, CARD_PAD + 90, top + 92);
    });

    const rest = info.count - info.rows.length;
    ctx.fillStyle = "#687481";
    ctx.font = `700 30px ${CARD_FONT}`;
    if (rest > 0) ctx.fillText(`ほか${rest}件`, CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "right";
    ctx.fillText("tk0407.github.io/surf-check", CARD_SIZE - CARD_PAD, CARD_SIZE - CARD_PAD);
    ctx.textAlign = "left";
  }

  return {
    SLOT_SHORT, dateParts, mdLabel, jpDirection, windConditionLabel, cardRows,
    shareLines, shareText, shareUrl, drawShareCard,
  };
});
