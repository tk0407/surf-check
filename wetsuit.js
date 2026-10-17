// 海水温からおすすめのウェットを選ぶ。表は nicsurf（73navi）・beachaccesssurf・
// dovewet・rm-proud の目安の真ん中をとったもの。気温と風は見ない。
// 四捨五入した水温で表を引き、画面にもその整数を出す（出す数字と判定を揃える）。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.Wetsuit = factory();
})(typeof self !== "undefined" ? self : this, function () {
  // max はその段に入る最高の水温（℃、四捨五入後）。上から順に当てる。
  const TABLE = [
    { max: 11, key: "dry", name: "ドライ", note: "＋ブーツ・グローブ・キャップ" },
    { max: 15, key: "semidry", name: "セミドライ", note: "＋ブーツ・グローブ" },
    { max: 18, key: "full", name: "フルスーツ", note: "寒がりなら5/3セミドライ" },
    { max: 21, key: "full", name: "フルスーツ", note: "" },
    { max: 23, key: "seagull", name: "シーガル", note: "" },
    { max: 25, key: "spring", name: "スプリング", note: "" },
    { max: Infinity, key: "trunks", name: "海パン", note: "" },
  ];

  // 水温が無い（null・NaN など）ときは null。
  function recommend(waterTemp) {
    if (typeof waterTemp !== "number" || !Number.isFinite(waterTemp)) return null;
    const temp = Math.round(waterTemp);
    const { key, name, note } = TABLE.find((row) => temp <= row.max);
    return { temp, key, name, note };
  }

  return { recommend };
});
