// ブラウザに残す小さな設定：はじめての案内を閉じたか、前回チェックしたエリア。
// プライベートモードやサイトデータのブロックで localStorage が使えなくても
// 落ちない（案内は毎回出て、エリアは既定に戻るだけ）。node --test で動く。
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(root);
  else root.Prefs = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  const KEYS = { guideClosed: "surfcheck.guide_closed", region: "surfcheck.region" };

  // localStorage は触っただけで例外になる環境がある。
  function browserStorage() {
    try { return root.localStorage || null; } catch (e) { return null; }
  }

  // storage は getItem / setItem を持つもの（既定は localStorage）。
  function create(storage = browserStorage()) {
    function load(key) {
      try { return storage ? storage.getItem(key) : null; } catch (e) { return null; }
    }
    function save(key, value) {
      try {
        if (!storage) return false;
        storage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    }
    return {
      guideClosed: () => load(KEYS.guideClosed) === "1",
      closeGuide: () => save(KEYS.guideClosed, "1"),
      // 選べるエリアにないもの（名前を変えた・消したエリア）は無視する。
      region: (selectable) => {
        const region = load(KEYS.region);
        return region && selectable.includes(region) ? region : null;
      },
      saveRegion: (region) => save(KEYS.region, region),
    };
  }

  return { KEYS, create };
});
