const test = require("node:test");
const assert = require("node:assert/strict");
const Prefs = require("./prefs.js");

const REGIONS = ["千葉北", "千葉南", "千葉", "湘南", "茨城", "全域"];

// localStorage と同じ getItem / setItem を持つ、メモリだけの入れ物。
function memoryStorage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => { items.set(key, String(value)); },
    items,
  };
}

// プライベートモードやサイトデータのブロックで、読み書きが例外になる環境。
function throwingStorage() {
  const fail = () => { throw new Error("SecurityError"); };
  return { getItem: fail, setItem: fail };
}

test("a first visit shows the guide and has no saved region", () => {
  const prefs = Prefs.create(memoryStorage());
  assert.equal(prefs.guideClosed(), false);
  assert.equal(prefs.region(REGIONS), null);
});

test("closing the guide is remembered across page loads", () => {
  const storage = memoryStorage();
  assert.equal(Prefs.create(storage).closeGuide(), true);
  assert.equal(storage.items.get("surfcheck.guide_closed"), "1");
  assert.equal(Prefs.create(storage).guideClosed(), true);
});

test("the saved region comes back on the next page load", () => {
  const storage = memoryStorage();
  assert.equal(Prefs.create(storage).saveRegion("湘南"), true);
  assert.equal(storage.items.get("surfcheck.region"), "湘南");
  assert.equal(Prefs.create(storage).region(REGIONS), "湘南");
});

test("a saved region that is no longer selectable is ignored", () => {
  const prefs = Prefs.create(memoryStorage({ "surfcheck.region": "九十九里" }));
  assert.equal(prefs.region(REGIONS), null);
});

test("an empty saved region is ignored", () => {
  const prefs = Prefs.create(memoryStorage({ "surfcheck.region": "" }));
  assert.equal(prefs.region(REGIONS), null);
});

test("storage that throws never breaks the page: the guide shows and nothing is saved", () => {
  const prefs = Prefs.create(throwingStorage());
  assert.equal(prefs.guideClosed(), false);
  assert.equal(prefs.closeGuide(), false);
  assert.equal(prefs.guideClosed(), false);
  assert.equal(prefs.saveRegion("湘南"), false);
  assert.equal(prefs.region(REGIONS), null);
});

test("missing storage behaves like storage that throws", () => {
  const prefs = Prefs.create(null);
  assert.equal(prefs.guideClosed(), false);
  assert.equal(prefs.closeGuide(), false);
  assert.equal(prefs.saveRegion("湘南"), false);
  assert.equal(prefs.region(REGIONS), null);
});
