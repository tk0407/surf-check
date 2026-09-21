const test = require("node:test");
const assert = require("node:assert/strict");
const SPOTS = require("./spots.json");

// spots.json は手で編集するデータなので、壊れた行が本番に出ないよう形を固定する。
// ライブカメラの URL は外部サイトを指すため、到達性ではなく「形」と
// 「使い回しの範囲」を検証する。

const REGIONS = new Set(["千葉北", "千葉南", "茨城", "湘南"]);

test("spots.json は配列で、ポイントが1件以上ある", () => {
  assert.ok(Array.isArray(SPOTS));
  assert.ok(SPOTS.length > 0);
});

test("全ポイントが name / region / lat / lon / bearing を正しい型で持つ", () => {
  for (const s of SPOTS) {
    assert.equal(typeof s.name, "string", `name が文字列でない: ${JSON.stringify(s)}`);
    assert.notEqual(s.name.trim(), "", "name が空");
    assert.ok(REGIONS.has(s.region), `未知のエリア: ${s.region} (${s.name})`);
    assert.ok(Number.isFinite(s.lat) && s.lat > 20 && s.lat < 50, `lat が日本の範囲外: ${s.name} ${s.lat}`);
    assert.ok(Number.isFinite(s.lon) && s.lon > 120 && s.lon < 150, `lon が日本の範囲外: ${s.name} ${s.lon}`);
    assert.ok(Number.isInteger(s.bearing) && s.bearing >= 0 && s.bearing < 360, `bearing が0-359でない: ${s.name} ${s.bearing}`);
  }
});

test("ポイント名は重複しない（app.js が名前で結果を引くため）", () => {
  const names = SPOTS.map((s) => s.name);
  assert.equal(new Set(names).size, names.length, `重複: ${names.filter((n, i) => names.indexOf(n) !== i)}`);
});

test("別のポイント同士が同じ地点に重ならない（100m以上離れている）", () => {
  // 住所を取り違えると、隣のブレイクの座標へ寄ってしまい2件が実質同じ点になる。
  // 過去に東浪見とサンライズが90m、東浪見と志田下が11mまで寄った。
  // 100m は現実の最小間隔（玉石と稲村ケ崎の約540m）より十分小さく、
  // 正しいデータを落とさずに座標の取り違えだけを捕まえる。
  const MIN_KM = 0.1;
  const distanceKm = (a, b) => {
    const dy = (a.lat - b.lat) * 111.32;
    const dx = (a.lon - b.lon) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
    return Math.sqrt(dy * dy + dx * dx);
  };
  for (let i = 0; i < SPOTS.length; i += 1) {
    for (let j = i + 1; j < SPOTS.length; j += 1) {
      const km = distanceKm(SPOTS[i], SPOTS[j]);
      assert.ok(
        km >= MIN_KM,
        `${SPOTS[i].name} と ${SPOTS[j].name} が ${Math.round(km * 1000)}m しか離れていない`
      );
    }
  }
});

test("cams があるポイントは1〜2本で、各カメラが label と https の url を持つ", () => {
  for (const s of SPOTS) {
    if (!("cams" in s)) continue;
    assert.ok(Array.isArray(s.cams), `cams が配列でない: ${s.name}`);
    assert.ok(s.cams.length >= 1 && s.cams.length <= 2, `cams が1〜2本でない: ${s.name} (${s.cams.length}本)`);
    for (const cam of s.cams) {
      assert.equal(typeof cam.label, "string", `label が文字列でない: ${s.name}`);
      assert.notEqual(cam.label.trim(), "", `label が空: ${s.name}`);
      assert.match(cam.url, /^https:\/\/[^\s"'<>]+$/, `url が https の単一トークンでない: ${s.name} ${cam.url}`);
    }
  }
});

test("cams が空配列のポイントは置かない（カメラが無いなら cams ごと省く）", () => {
  const empty = SPOTS.filter((s) => Array.isArray(s.cams) && s.cams.length === 0);
  assert.deepEqual(empty.map((s) => s.name), []);
});

test("同一ポイント内で同じカメラURLを2回出さない", () => {
  for (const s of SPOTS) {
    if (!s.cams) continue;
    const urls = s.cams.map((c) => c.url);
    assert.equal(new Set(urls).size, urls.length, `同じURLが重複: ${s.name}`);
  }
});

test("同じカメラURLを共有するポイントは同一エリア内に限る", () => {
  const regionsByUrl = new Map();
  for (const s of SPOTS) {
    for (const cam of s.cams || []) {
      if (!regionsByUrl.has(cam.url)) regionsByUrl.set(cam.url, new Set());
      regionsByUrl.get(cam.url).add(s.region);
    }
  }
  for (const [url, regions] of regionsByUrl) {
    assert.equal(regions.size, 1, `エリアをまたいで使い回されている: ${url} → ${[...regions]}`);
  }
});

test("カメラのラベルは提供元が分かる接頭辞で始まる", () => {
  for (const s of SPOTS) {
    for (const cam of s.cams || []) {
      assert.match(cam.label, /^(YouTube|Surfers Ocean|BCM)\b/, `提供元が分からないラベル: ${s.name} 「${cam.label}」`);
    }
  }
});

test("カメラのホストは調査済みの3つに限る", () => {
  const allowed = new Set(["www.youtube.com", "www.surfers-ocean.com", "www.bcm-surfpatrol.com"]);
  for (const s of SPOTS) {
    for (const cam of s.cams || []) {
      const host = new URL(cam.url).host;
      assert.ok(allowed.has(host), `未調査のホスト: ${host} (${s.name})`);
    }
  }
});

test("どのエリアにもカメラ付きのポイントが1つ以上ある（cams の消失を検知する）", () => {
  // spots.json は別プロジェクトで再生成されることがあり、そのとき cams が
  // 丸ごと落ちうる。cams は任意フィールドなので、他のテストでは気づけない。
  const withCam = new Set(SPOTS.filter((s) => s.cams && s.cams.length > 0).map((s) => s.region));
  const missing = [...REGIONS].filter((r) => !withCam.has(r));
  assert.deepEqual(missing, [], `カメラ付きポイントが1つも無いエリア: ${missing}`);
});
