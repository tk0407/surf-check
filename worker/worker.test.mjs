import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import Calibration from "../calibration.js";
import { handle } from "./handler.mjs";
import { createD1 } from "./d1-sqlite.mjs";

const ORIGIN = "https://tk0407.github.io";
const NOW = new Date("2026-09-23T03:00:00Z"); // 12:00 in Japan
const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

function memoryR2(map) {
  return {
    async put(key, value) {
      map.set(key, new Uint8Array(value));
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

// vars override the Worker variables. Photos are allowed (switch off) unless a test says otherwise.
function setup(vars = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const photos = new Map();
  const env = {
    DB: createD1(sqlite),
    PHOTOS: memoryR2(photos),
    ALLOWED_ORIGINS: `${ORIGIN}, http://localhost:8000`,
    IP_SALT: "test-salt",
    R2_KILL_SWITCH: "false",
    ...vars,
  };
  const rows = (sql, ...args) => sqlite.prepare(sql).all(...args).map((r) => ({ ...r }));
  const usage = () => rows("SELECT scope, used_bytes, file_count FROM storage_usage ORDER BY scope");
  return { sqlite, photos, env, rows, usage };
}

// A D1 whose statements containing `failsOn` throw, alone or inside a batch.
function failingDb(realDb, failsOn) {
  return {
    prepare(sql) {
      if (!sql.includes(failsOn)) return realDb.prepare(sql);
      const fail = async () => { throw new Error("D1 unavailable"); };
      const broken = { broken: true, bind: () => broken, first: fail, all: fail, run: fail };
      return broken;
    },
    async batch(statements) {
      if (statements.some((s) => s.broken)) throw new Error("D1 unavailable");
      return realDb.batch(statements);
    },
  };
}

// Counts R2 writes without storing anything.
function countPuts(env) {
  const calls = { n: 0 };
  env.PHOTOS.put = async () => { calls.n += 1; };
  return calls;
}

// The Worker logs one JSON line per event with console.log. Keep them out of
// the test output; logging tests call resetCalls() and read them back.
const consoleLog = mock.method(console, "log", () => {});
const loggedLines = () => consoleLog.mock.calls.map((call) => {
  assert.equal(call.arguments.length, 1);
  return call.arguments[0];
});
const logged = () => loggedLines().map((line) => JSON.parse(line));

const deviceId = (i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

function record(overrides = {}) {
  return {
    device_id: deviceId(1),
    name: "たろう",
    spot: "一宮",
    date: "2026-09-23",
    slot: "morning",
    bearing: 100,
    forecast: { wave_height: 0.9, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5 },
    observed: { rating: 4, wave_band: 3, wind_side: "off", wind_strength: "light" },
    photo_meta: { lat: 35.34, lon: 140.39, taken_at: "2026-09-23T07:42" },
    ...overrides,
  };
}

function jpeg(size = 64, fill = 1) {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function feedbackRequest({ rec = record(), photo = null, filename = "photo.jpg", ip = "203.0.113.7", origin = ORIGIN, body, contentType } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;
  if (body === undefined) {
    body = new FormData();
    body.append("record", typeof rec === "string" ? rec : JSON.stringify(rec));
    if (photo) body.append("photo", new Blob([photo], { type: "image/jpeg" }), filename);
  }
  return new Request("https://api.example/feedback", { method: "POST", headers, body });
}

async function send(env, options = {}, now = NOW) {
  const res = await handle(feedbackRequest(options), env, now);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

// --- POST /feedback ---

test("POST stores one record, the photo and a submission", async () => {
  const { env, photos, rows, usage } = setup();
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, id: 1, updated: false });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const [row] = rows("SELECT * FROM feedback");
  assert.equal(row.spot, "一宮");
  assert.equal(row.name, "たろう");
  assert.equal(row.fc_wave_height, 0.9);
  assert.equal(row.rating, 4);
  assert.equal(row.wind_side, "off");
  assert.equal(row.photo_lat, 35.34);
  assert.equal(row.photo_taken_at, "2026-09-23T07:42");
  assert.match(row.photo_key, /^photos\/[0-9a-f-]{36}\.jpg$/);
  assert.match(row.ip_hash, /^[0-9a-f]{64}$/);
  assert.equal(row.created_at, NOW.toISOString());
  assert.deepEqual([...photos.keys()], [row.photo_key]);
  assert.deepEqual(photos.get(row.photo_key), jpeg());
  assert.equal(row.photo_bytes, 64);
  assert.deepEqual(rows("SELECT day, at, photo_bytes, photo_skipped FROM submissions"), [
    { day: "2026-09-23", at: NOW.getTime(), photo_bytes: 64, photo_skipped: null },
  ]);
  assert.deepEqual(usage(), [
    { scope: `device:${deviceId(1)}`, used_bytes: 64, file_count: 1 },
    { scope: "global", used_bytes: 64, file_count: 1 },
  ]);
});

test("POST without a photo stores null photo fields even when photo_meta is sent", async () => {
  const { env, photos, rows } = setup();
  assert.equal((await send(env)).status, 200);
  const [row] = rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback");
  assert.deepEqual(row, { photo_key: null, photo_lat: null, photo_lon: null, photo_taken_at: null });
  assert.equal(photos.size, 0);
});

test("resending the same session overwrites it and keeps created_at", async () => {
  const { env, rows } = setup();
  await send(env);
  const later = new Date("2026-09-23T04:00:00Z");
  const res = await send(env, { rec: record({ observed: { rating: 2, wave_band: 1, wind_side: "on", wind_strength: "strong" } }) }, later);
  assert.deepEqual(res.body, { ok: true, id: 1, updated: true });
  const all = rows("SELECT rating, wave_band, created_at, updated_at FROM feedback");
  assert.deepEqual(all, [{ rating: 2, wave_band: 1, created_at: NOW.toISOString(), updated_at: later.toISOString() }]);
  assert.equal(rows("SELECT * FROM submissions").length, 2);
});

test("a different slot, date or spot from the same device is a separate record", async () => {
  const { env, rows } = setup();
  await send(env);
  await send(env, { rec: record({ slot: "afternoon" }) });
  await send(env, { rec: record({ date: "2026-09-22" }) });
  await send(env, { rec: record({ spot: "志田下" }) });
  assert.equal(rows("SELECT * FROM feedback").length, 4);
});

test("resending without a photo keeps the earlier photo and its location", async () => {
  const { env, photos, rows } = setup();
  await send(env, { photo: jpeg() });
  const [before] = rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback");
  await send(env, { rec: record({ photo_meta: null }) });
  assert.deepEqual(rows("SELECT photo_key, photo_lat, photo_lon, photo_taken_at FROM feedback"), [before]);
  assert.deepEqual([...photos.keys()], [before.photo_key]);
});

test("resending with a new photo replaces the file, deletes the old one and counts only the new one", async () => {
  const { env, photos, rows, usage } = setup();
  await send(env, { photo: jpeg(1000, 1) });
  const [{ photo_key: oldKey }] = rows("SELECT photo_key FROM feedback");
  await send(env, { photo: jpeg(600, 2), rec: record({ photo_meta: { lat: 35.1, lon: 140.2, taken_at: null } }) });
  const [row] = rows("SELECT photo_key, photo_lat, photo_taken_at, photo_bytes FROM feedback");
  assert.notEqual(row.photo_key, oldKey);
  assert.equal(row.photo_lat, 35.1);
  assert.equal(row.photo_taken_at, null);
  assert.equal(row.photo_bytes, 600);
  assert.deepEqual([...photos.keys()], [row.photo_key]);
  assert.deepEqual(photos.get(row.photo_key), jpeg(600, 2));
  assert.deepEqual(usage(), [
    { scope: `device:${deviceId(1)}`, used_bytes: 600, file_count: 1 },
    { scope: "global", used_bytes: 600, file_count: 1 },
  ]);
});

test("the photo key is made by the server, whatever the record or the file name says", async () => {
  const { env, photos, rows } = setup();
  const res = await send(env, { photo: jpeg(), rec: record({ photo_key: "../other/x.jpg" }), filename: "../../evil.jpg" });
  assert.equal(res.status, 200);
  const [{ photo_key }] = rows("SELECT photo_key FROM feedback");
  assert.match(photo_key, /^photos\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/);
  assert.deepEqual([...photos.keys()], [photo_key]);
});

test("an invalid record gets 400 naming the field, and nothing is stored", async () => {
  const { env, photos, rows } = setup();
  const res = await send(env, { photo: jpeg(), rec: record({ observed: { rating: 9, wave_band: 3, wind_side: "off", wind_strength: "light" } }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /observed\.rating/);
  assert.deepEqual(res.body.errors.map((e) => e.split(":")[0]), ["observed.rating"]);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
  assert.equal(rows("SELECT * FROM submissions").length, 0);
  assert.equal(photos.size, 0);
});

test("malformed bodies get 400, not 500", async () => {
  const { env, rows } = setup();
  const notJson = await send(env, { rec: "{" });
  assert.equal(notJson.status, 400);
  assert.match(notJson.body.error, /^record:/);

  const missing = new FormData();
  missing.append("other", "x");
  assert.equal((await send(env, { body: missing })).status, 400);

  const plain = await send(env, { body: "hello", contentType: "text/plain" });
  assert.equal(plain.status, 400);
  assert.equal(plain.headers.get("Access-Control-Allow-Origin"), ORIGIN);

  const brokenMultipart = await send(env, { body: "--x\r\nbroken", contentType: "multipart/form-data; boundary=x" });
  assert.equal(brokenMultipart.status, 400);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a photo that is not a JPEG gets 415", async () => {
  const { env, photos } = setup();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal((await send(env, { photo: png })).status, 415);
  assert.equal((await send(env, { photo: new Uint8Array(0) })).status, 415);
  assert.equal(photos.size, 0);
});

test("photos are accepted up to 1,572,864 bytes and rejected with 413 above", async () => {
  const { env, photos } = setup();
  assert.equal((await send(env, { photo: jpeg(1572864) })).status, 200);
  assert.equal((await send(env, { photo: jpeg(1572865) })).status, 413);
  assert.equal(photos.size, 1);
});

test("a request body over 2 MB gets 413", async () => {
  const { env, rows } = setup();
  const res = await send(env, { photo: jpeg(2 * 1024 * 1024) });
  assert.equal(res.status, 413);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a streamed body without Content-Length stops being read soon after the limit", async () => {
  const { env, rows } = setup();
  const chunk = new Uint8Array(64 * 1024);
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (pulled >= 50 * 1024 * 1024) return controller.close();
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const request = new Request("https://api.example/feedback", {
    method: "POST",
    body: stream,
    duplex: "half",
    headers: { Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", "Content-Type": "multipart/form-data; boundary=x" },
  });
  const res = await handle(request, env, NOW);
  assert.equal(res.status, 413);
  assert.ok(pulled < 3 * 1024 * 1024, `read ${pulled} bytes`);
  assert.equal(rows("SELECT * FROM submissions").length, 0);
});

test("MAX_UPLOAD_SIZE sets the photo limit, up to a ceiling of 10 MB", async () => {
  const small = setup({ MAX_UPLOAD_SIZE: "1000" });
  assert.equal((await send(small.env, { photo: jpeg(1000) })).status, 200);
  assert.equal((await send(small.env, { photo: jpeg(1001), rec: record({ slot: "afternoon" }) })).status, 413);
  assert.equal(small.photos.size, 1);

  const ceiling = setup({ MAX_UPLOAD_SIZE: String(10 * 1024 * 1024) });
  assert.equal((await send(ceiling.env, { photo: jpeg(2 * 1024 * 1024) })).status, 200);
});

test("limit variables that are not whole numbers make POST fail closed with 500", async () => {
  const cases = [
    ["DAILY_UPLOAD_COUNT_LIMIT", "10MB"],
    ["GLOBAL_STORAGE_LIMIT", "-1"],
    ["MINUTE_COUNT_LIMIT", "1.5"],
    ["USER_STORAGE_LIMIT", "1e6"],
    ["MAX_UPLOAD_SIZE", String(10 * 1024 * 1024 + 1)],
  ];
  for (const [name, value] of cases) {
    const { env, rows } = setup({ [name]: value });
    const puts = countPuts(env);
    consoleLog.mock.resetCalls();
    const res = await send(env, { photo: jpeg() });
    assert.equal(res.status, 500, name);
    assert.equal(rows("SELECT * FROM feedback").length, 0, name);
    assert.equal(rows("SELECT * FROM submissions").length, 0, name);
    assert.equal(puts.n, 0, name);
    assert.deepEqual(logged()[0], { event: "config_error", variable: name });
  }
});

test("an empty or blank limit variable falls back to the default", async () => {
  const { env } = setup({ MAX_UPLOAD_SIZE: "", DAILY_UPLOAD_COUNT_LIMIT: "  " });
  assert.equal((await send(env, { photo: jpeg(1572864) })).status, 200);
  assert.equal((await send(env, { photo: jpeg(1572865), rec: record({ slot: "afternoon" }) })).status, 413);
});

// --- photo kill switch ---

test("photos are not stored unless R2_KILL_SWITCH is false or 0, but the record is", async () => {
  for (const value of [undefined, "", "true", "yes", "on"]) {
    const { env, rows, usage } = setup({ R2_KILL_SWITCH: value });
    const puts = countPuts(env);
    const res = await send(env, { photo: jpeg() });
    assert.deepEqual(res.body, { ok: true, id: 1, updated: false, photo_skipped: "kill_switch" }, String(value));
    assert.equal(puts.n, 0);
    assert.deepEqual(rows("SELECT rating, photo_key, photo_lat, photo_bytes FROM feedback"), [
      { rating: 4, photo_key: null, photo_lat: null, photo_bytes: null },
    ]);
    assert.deepEqual(rows("SELECT photo_bytes, photo_skipped FROM submissions"), [{ photo_bytes: 0, photo_skipped: "kill_switch" }]);
    assert.deepEqual(usage(), []);
    const noPhoto = await send(env, { rec: record({ slot: "afternoon" }) });
    assert.deepEqual(noPhoto.body, { ok: true, id: 2, updated: false });
  }
});

test("R2_KILL_SWITCH false or 0, in any case and with spaces, lets photos through", async () => {
  for (const value of ["false", "FALSE", " 0 "]) {
    const { env, photos } = setup({ R2_KILL_SWITCH: value });
    const res = await send(env, { photo: jpeg() });
    assert.deepEqual(res.body, { ok: true, id: 1, updated: false }, value);
    assert.equal(photos.size, 1);
  }
});

// --- daily limits ---

test("the 21st submission from one device in a day gets 429 device", async () => {
  const { env } = setup({ MINUTE_COUNT_LIMIT: "100" });
  for (let i = 0; i < 20; i++) assert.equal((await send(env, { ip: `198.51.100.${i}` })).status, 200);
  const res = await send(env, { ip: "198.51.100.99" });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "device");
});

test("the 31st submission from one connection in a day gets 429 ip", async () => {
  const { env } = setup({ MINUTE_COUNT_LIMIT: "100" });
  for (let i = 0; i < 30; i++) assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }) })).status, 200);
  const res = await send(env, { rec: record({ device_id: deviceId(99) }) });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "ip");
});

test("the 101st submission in a day overall gets 429 total", async () => {
  const { env } = setup();
  for (let i = 0; i < 100; i++) {
    assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }), ip: `10.0.${i >> 8}.${i & 255}` })).status, 200);
  }
  const res = await send(env, { rec: record({ device_id: deviceId(500) }), ip: "192.0.2.1" });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "total");
});

test("GLOBAL_DAILY_COUNT_LIMIT 0 refuses every send, so it stops intake in an emergency", async () => {
  const { env, rows } = setup({ GLOBAL_DAILY_COUNT_LIMIT: "0" });
  const puts = countPuts(env);
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 429);
  assert.equal(res.body.limit, "total");
  assert.equal(puts.n, 0);
  assert.deepEqual(rows("SELECT id FROM feedback"), []);
  assert.deepEqual(rows("SELECT id FROM submissions"), []);
});

test("limits restart at midnight Japan time even though the clock is UTC", async () => {
  const { env, rows } = setup({ MINUTE_COUNT_LIMIT: "100" });
  const lastMinute = new Date("2026-09-23T14:59:00Z"); // 23:59 on the 23rd in Japan
  const midnight = new Date("2026-09-23T15:00:00Z"); // 00:00 on the 24th in Japan
  for (let i = 0; i < 20; i++) assert.equal((await send(env, {}, lastMinute)).status, 200);
  assert.equal((await send(env, {}, lastMinute)).status, 429);
  assert.equal((await send(env, {}, midnight)).status, 200);
  assert.deepEqual(rows("SELECT day, COUNT(*) AS n FROM submissions GROUP BY day ORDER BY day"), [
    { day: "2026-09-23", n: 20 },
    { day: "2026-09-24", n: 1 },
  ]);
});

test("each submission purges submission rows older than 3 days", async () => {
  const { env, sqlite, rows } = setup();
  const insert = sqlite.prepare("INSERT INTO submissions (token, device_id, ip_hash, day, at) VALUES (?, 'd', 'h', ?, 0)");
  for (const day of ["2026-09-19", "2026-09-20", "2026-09-22"]) insert.run(day, day);
  await send(env);
  assert.deepEqual(rows("SELECT day FROM submissions ORDER BY day").map((r) => r.day), ["2026-09-20", "2026-09-22", "2026-09-23"]);
});

test("the 6th send from one device within a minute gets 429 device_minute until 60 s have passed", async () => {
  const { env } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await send(env, { ip: `198.51.100.${i}` })).status, 200);
  const sixth = await send(env, { ip: "198.51.100.9" });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.limit, "device_minute");
  assert.equal((await send(env, { ip: "198.51.100.9" }, new Date(NOW.getTime() + 59999))).body.limit, "device_minute");
  assert.equal((await send(env, { ip: "198.51.100.9" }, new Date(NOW.getTime() + 60000))).status, 200);
});

test("the 6th send from one connection within a minute gets 429 ip_minute", async () => {
  const { env } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await send(env, { rec: record({ device_id: deviceId(i) }) })).status, 200);
  const sixth = await send(env, { rec: record({ device_id: deviceId(9) }) });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.limit, "ip_minute");
});

test("25 sends at once from one device store exactly the daily 20", async () => {
  const { env, rows } = setup({ MINUTE_COUNT_LIMIT: "100" });
  const results = await Promise.all(Array.from({ length: 25 }, () => send(env)));
  assert.equal(results.filter((r) => r.status === 200).length, 20);
  assert.deepEqual(results.filter((r) => r.status !== 200).map((r) => [r.status, r.body.limit]), Array(5).fill([429, "device"]));
  assert.equal(rows("SELECT * FROM submissions").length, 20);
});

// --- photo storage limits: the record is kept, only the photo is skipped ---

test("DAILY_UPLOAD_LIMIT skips photos past one device's bytes for the day", async () => {
  const { env, photos, rows } = setup({ DAILY_UPLOAD_LIMIT: "2000" });
  assert.deepEqual((await send(env, { photo: jpeg(1000) })).body, { ok: true, id: 1, updated: false });
  assert.deepEqual((await send(env, { photo: jpeg(1000), rec: record({ slot: "afternoon" }) })).body, { ok: true, id: 2, updated: false });
  const third = await send(env, { photo: jpeg(1000), rec: record({ slot: "evening", date: "2026-09-22" }) });
  assert.deepEqual(third.body, { ok: true, id: 3, updated: false, photo_skipped: "device_bytes" });
  assert.deepEqual(rows("SELECT photo_key FROM feedback WHERE id = 3"), [{ photo_key: null }]);
  assert.equal(photos.size, 2);
  const other = await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(2) }) });
  assert.equal("photo_skipped" in other.body, false);
  assert.equal(photos.size, 3);
});

test("GLOBAL_DAILY_UPLOAD_LIMIT skips photos past the day's total bytes", async () => {
  const { env, photos } = setup({ GLOBAL_DAILY_UPLOAD_LIMIT: "2000" });
  for (const i of [1, 2]) assert.equal("photo_skipped" in (await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(i) }) })).body, false);
  const third = await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(3) }) });
  assert.equal(third.status, 200);
  assert.equal(third.body.photo_skipped, "global_bytes");
  assert.equal(photos.size, 2);
});

test("USER_STORAGE_LIMIT skips photos once a device's stored photos reach it, on later days too", async () => {
  const { env, photos } = setup({ USER_STORAGE_LIMIT: "2000" });
  await send(env, { photo: jpeg(1000) });
  await send(env, { photo: jpeg(1000), rec: record({ slot: "afternoon" }) });
  assert.equal((await send(env, { photo: jpeg(1000), rec: record({ date: "2026-09-22" }) })).body.photo_skipped, "device_storage");
  const nextDay = new Date(NOW.getTime() + 24 * 3600 * 1000);
  assert.equal((await send(env, { photo: jpeg(1000), rec: record({ date: "2026-09-24" }) }, nextDay)).body.photo_skipped, "device_storage");
  assert.equal("photo_skipped" in (await send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(2) }) })).body, false);
  assert.equal(photos.size, 3);
});

test("GLOBAL_STORAGE_LIMIT holds when 10 devices send photos at once", async () => {
  const { env, photos, usage } = setup({ GLOBAL_STORAGE_LIMIT: "3000" });
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    send(env, { photo: jpeg(1000), rec: record({ device_id: deviceId(i) }), ip: `198.51.100.${i}` })));
  assert.ok(results.every((r) => r.status === 200));
  assert.deepEqual(results.map((r) => r.body.photo_skipped).filter(Boolean), Array(7).fill("global_storage"));
  assert.equal(photos.size, 3);
  assert.deepEqual(usage().find((u) => u.scope === "global"), { scope: "global", used_bytes: 3000, file_count: 3 });
});

// --- CORS and configuration ---

test("allowed origins get CORS headers on OPTIONS and POST", async () => {
  const { env } = setup();
  for (const origin of [ORIGIN, "http://localhost:8000"]) {
    const res = await handle(new Request("https://api.example/feedback", { method: "OPTIONS", headers: { Origin: origin } }), env, NOW);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
    assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
  }
  assert.equal((await send(env, { origin: "http://localhost:8000" })).headers.get("Access-Control-Allow-Origin"), "http://localhost:8000");
});

test("other or missing origins get 403 and nothing is stored", async () => {
  const { env, rows } = setup();
  const options = await handle(new Request("https://api.example/feedback", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }), env, NOW);
  assert.equal(options.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal((await send(env, { origin: "https://evil.example" })).status, 403);
  assert.equal((await send(env, { origin: null })).status, 403);
  assert.equal((await send(env, { origin: `${ORIGIN}.evil.example` })).status, 403);
  assert.equal((await send(env, { origin: "https://tk0407.github" })).status, 403); // a prefix of an allowed origin
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("a missing IP_SALT gets 500 and nothing is stored", async () => {
  const { env, rows } = setup();
  delete env.IP_SALT;
  assert.equal((await send(env)).status, 500);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

// --- failures of R2 and D1 ---

test("when saving the record fails, the uploaded photo is removed, its bytes given back and 500 returned", async () => {
  const { env, photos, rows, usage } = setup();
  env.DB = failingDb(env.DB, "INSERT INTO feedback");
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "保存できませんでした");
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => [u.used_bytes, u.file_count]), [[0, 0], [0, 0]]);
  assert.equal(rows("SELECT * FROM submissions").length, 1); // the attempt still counts toward the limits
  assert.ok(logged().some((e) => e.event === "d1_error"));
});

test("when the database cannot take the send, no photo is uploaded", async () => {
  const { env, rows } = setup();
  env.DB = failingDb(env.DB, "INSERT INTO submissions");
  const puts = countPuts(env);
  const res = await send(env, { photo: jpeg() });
  assert.equal(res.status, 500);
  assert.equal(puts.n, 0);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
});

test("when the photo upload fails, nothing is saved and its bytes are given back", async () => {
  const { env, photos, rows, usage } = setup();
  env.PHOTOS.put = async () => { throw new Error("R2 returned 500"); };
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg(1000) });
  assert.equal(res.status, 500);
  assert.equal(rows("SELECT * FROM feedback").length, 0);
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => [u.used_bytes, u.file_count]), [[0, 0], [0, 0]]);
  assert.deepEqual(logged().map((e) => e.event), ["r2_error", "feedback"]);
});

test("an upload that times out after writing leaves no object behind", async () => {
  const { env, photos, usage } = setup();
  const realPut = env.PHOTOS.put;
  env.PHOTOS.put = async (...args) => {
    await realPut(...args);
    throw new Error("timed out");
  };
  assert.equal((await send(env, { photo: jpeg(1000) })).status, 500);
  assert.equal(photos.size, 0);
  assert.deepEqual(usage().map((u) => u.used_bytes), [0, 0]);
});

test("when the old photo cannot be deleted, the send still succeeds and the orphan is logged", async () => {
  const { env, photos, rows, usage } = setup();
  await send(env, { photo: jpeg(1000) });
  const [{ photo_key: oldKey }] = rows("SELECT photo_key FROM feedback");
  env.PHOTOS.delete = async () => { throw new Error("R2 returned 500"); };
  consoleLog.mock.resetCalls();
  const res = await send(env, { photo: jpeg(600) });
  assert.deepEqual(res.body, { ok: true, id: 1, updated: true });
  assert.equal(photos.size, 2);
  assert.deepEqual(usage().find((u) => u.scope === "global"), { scope: "global", used_bytes: 1600, file_count: 2 });
  assert.ok(logged().some((e) => e.event === "photo_orphan" && e.key === oldKey));
});

// --- logs ---

test("each POST logs JSON lines that hold no personal data", async () => {
  const { env, rows } = setup({ DAILY_UPLOAD_COUNT_LIMIT: "1" });
  consoleLog.mock.resetCalls();
  await send(env, { photo: jpeg() });
  await send(env, { rec: record({ observed: { rating: 9, wave_band: 3, wind_side: "off", wind_strength: "light" } }) });
  await send(env, { rec: record({ slot: "afternoon" }) });
  assert.deepEqual(logged(), [
    { event: "feedback", status: 200, photo_bytes: 64, updated: false },
    { event: "feedback", status: 400 },
    { event: "feedback", status: 429, limit: "device" },
  ]);
  const text = loggedLines().join("\n");
  const [{ ip_hash }] = rows("SELECT ip_hash FROM feedback");
  for (const secret of [deviceId(1), "たろう", "203.0.113.7", ip_hash, "test-salt"]) {
    assert.equal(text.includes(secret), false, secret);
  }
});

test("unknown paths get 404 and GET /feedback gets 405", async () => {
  const { env } = setup();
  assert.equal((await handle(new Request("https://api.example/nope"), env, NOW)).status, 404);
  assert.equal((await handle(new Request("https://api.example/feedback"), env, NOW)).status, 405);
});

// --- GET /calibration ---

const getCalibration = async (env, query = "") => {
  const res = await handle(new Request(`https://api.example/calibration${query}`), env, NOW);
  return { status: res.status, headers: res.headers, text: await res.clone().text(), body: await res.json() };
};

test("GET /calibration with no records returns the default weights", async () => {
  const { env } = setup();
  const res = await getCalibration(env);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    version: 1,
    n: 0,
    spots: {},
    weights: { ...Calibration.DEFAULT_WEIGHTS },
    weights_learned: false,
    generated_at: NOW.toISOString(),
  });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
});

test("GET /calibration matches Calibration.compute and leaks no personal data", async () => {
  const { env, rows } = setup();
  for (let i = 0; i < 3; i++) {
    const forecast = { wave_height: 0.6, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5 };
    await send(env, { rec: record({ device_id: deviceId(i), forecast }), photo: jpeg() });
  }
  const res = await getCalibration(env);
  const stored = rows("SELECT * FROM feedback ORDER BY id");
  const { generated_at, ...cal } = res.body;
  assert.deepEqual(cal, Calibration.compute(stored));
  assert.equal(cal.n, 3);
  assert.ok(cal.spots["一宮"].wave_factor > 1);
  assert.equal("metrics" in res.body, false);
  for (const secret of ["たろう", deviceId(0), "photos/", "35.34", stored[0].ip_hash]) {
    assert.equal(res.text.includes(secret), false, secret);
  }
});

test("GET /calibration?metrics=1 adds leave-one-out metrics", async () => {
  const { env, rows } = setup();
  for (let i = 0; i < 3; i++) await send(env, { rec: record({ device_id: deviceId(i) }) });
  const res = await getCalibration(env, "?metrics=1");
  assert.deepEqual(res.body.metrics, Calibration.metrics(rows("SELECT * FROM feedback ORDER BY id")));
  assert.equal(res.body.metrics.n, 3);
});
