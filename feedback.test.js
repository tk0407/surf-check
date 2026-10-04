const test = require("node:test");
const assert = require("node:assert/strict");
const Feedback = require("./feedback.js");

// Japan time → the UTC instant the Worker and browsers see.
const jst = (s) => new Date(Date.parse(`${s}:00+09:00`));
const NOW = jst("2026-09-23T13:00"); // Wednesday afternoon, JST
const DEVICE = "2f1c6a3e-9b7d-4c21-8e5f-0a1b2c3d4e5f";

function validRecord(overrides = {}) {
  return {
    device_id: DEVICE,
    name: "",
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
const withForecast = (patch) => validRecord({ forecast: { ...validRecord().forecast, ...patch } });
const withObserved = (patch) => validRecord({ observed: { ...validRecord().observed, ...patch } });
const withPhoto = (patch) => validRecord({ photo_meta: { ...validRecord().photo_meta, ...patch } });
const fields = (errors) => errors.map((e) => e.split(":")[0]);

// --- JST helpers ---

test("jstNow converts a UTC instant to the Japan date and minutes", () => {
  assert.deepEqual(Feedback.jstNow(new Date("2026-09-22T15:00:00Z")), { date: "2026-09-23", minutes: 0 });
  assert.deepEqual(Feedback.jstNow(new Date("2026-09-22T14:59:00Z")), { date: "2026-09-22", minutes: 23 * 60 + 59 });
});

test("dateRange spans 30 days before today through today", () => {
  assert.deepEqual(Feedback.dateRange(NOW), { min: "2026-08-24", max: "2026-09-23" });
});

// --- defaultSession ---

test("defaultSession keeps the card's slot at the exact start minute", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, jst("2026-09-23T07:00")), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "afternoon" }, jst("2026-09-23T12:00")), { date: "2026-09-23", slot: "afternoon" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "evening" }, jst("2026-09-23T16:00")), { date: "2026-09-23", slot: "evening" });
});

test("defaultSession falls back one minute before a slot starts", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "afternoon" }, jst("2026-09-23T11:59")), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "evening" }, jst("2026-09-23T15:59")), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession before 7:00 is the previous evening", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, jst("2026-09-23T06:59")), { date: "2026-09-22", slot: "evening" });
});

test("defaultSession keeps a past date's slot and replaces a future date", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-20", slot: "evening" }, NOW), { date: "2026-09-20", slot: "evening" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-25", slot: "morning" }, NOW), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession replaces a date older than 30 days", () => {
  assert.deepEqual(Feedback.defaultSession({ date: "2026-08-24", slot: "morning" }, NOW), { date: "2026-08-24", slot: "morning" });
  assert.deepEqual(Feedback.defaultSession({ date: "2026-08-23", slot: "morning" }, NOW), { date: "2026-09-23", slot: "afternoon" });
});

test("defaultSession uses Japan time on a UTC clock across midnight", () => {
  // 2026-09-22T22:30Z is 07:30 on the 23rd in Japan: today's morning has begun.
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, new Date("2026-09-22T22:30:00Z")), { date: "2026-09-23", slot: "morning" });
  // 2026-09-22T15:30Z is 00:30 on the 23rd: before 7:00, so the evening of the 22nd.
  assert.deepEqual(Feedback.defaultSession({ date: "2026-09-23", slot: "morning" }, new Date("2026-09-22T15:30:00Z")), { date: "2026-09-22", slot: "evening" });
});

// --- slotForTime / sessionFromPhoto ---

test("slotForTime picks the slot containing the time, ends included", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T07:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T10:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T13:30"), "afternoon");
  assert.equal(Feedback.slotForTime("2026-09-23T19:00"), "evening");
});

test("slotForTime picks the nearest slot between and outside ranges", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T10:59"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T11:01"), "afternoon");
  assert.equal(Feedback.slotForTime("2026-09-23T05:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T22:00"), "evening");
});

test("slotForTime breaks ties toward the earlier slot", () => {
  assert.equal(Feedback.slotForTime("2026-09-23T11:00"), "morning");
  assert.equal(Feedback.slotForTime("2026-09-23T15:30"), "afternoon");
});

test("sessionFromPhoto returns the photo's date and slot when selectable", () => {
  assert.deepEqual(Feedback.sessionFromPhoto("2026-09-23T07:42", NOW), { date: "2026-09-23", slot: "morning" });
  assert.deepEqual(Feedback.sessionFromPhoto("2026-09-10T17:10", NOW), { date: "2026-09-10", slot: "evening" });
});

test("sessionFromPhoto rejects out-of-range dates, unstarted slots and missing times", () => {
  assert.equal(Feedback.sessionFromPhoto("2026-08-23T08:00", NOW), null);
  assert.equal(Feedback.sessionFromPhoto("2026-09-24T08:00", NOW), null);
  // 15:50 is nearest the evening slot, which has not begun at 13:00.
  assert.equal(Feedback.sessionFromPhoto("2026-09-23T15:50", NOW), null);
  assert.equal(Feedback.sessionFromPhoto(null, NOW), null);
});

// --- initialObserved / buildRecord ---

test("initialObserved derives band, side and strength from the shown forecast", () => {
  assert.deepEqual(
    Feedback.initialObserved({ wave_height: 1.2, wind_dir: 270, wind_speed: 3.6, swell_dir: 90, swell_period: 11 }, 90),
    { wave_band: 4, wind_side: "off", wind_strength: "light" },
  );
  assert.deepEqual(
    Feedback.initialObserved({ wave_height: 0.3, wind_dir: 90, wind_speed: 2, swell_dir: 90, swell_period: 11 }, 90),
    { wave_band: 1, wind_side: "on", wind_strength: "calm" },
  );
});

test("buildRecord stores the raw forecast, the trimmed name and a null photo_meta", () => {
  const rec = Feedback.buildRecord({
    deviceId: DEVICE,
    name: "  たろう ",
    spot: { name: "一宮", bearing: 100, lat: 35.37, lon: 140.39 },
    date: "2026-09-23",
    slot: "morning",
    rawData: { wave_height: 0.9, wind_dir: 270, wind_speed: 3.2, swell_dir: 95, swell_period: 9.5, extra: 1 },
    observed: { rating: 4, wave_band: 3, wind_side: "off", wind_strength: "light" },
  });
  assert.deepEqual(rec, { ...validRecord(), name: "たろう", photo_meta: null });
  assert.deepEqual(Feedback.validateRecord(rec, NOW), []);
});

// --- validateRecord ---

function assertValid(rec) {
  assert.deepEqual(Feedback.validateRecord(rec, NOW), []);
}
function assertInvalid(rec, field) {
  assert.deepEqual(fields(Feedback.validateRecord(rec, NOW)), [field]);
}

test("validateRecord accepts the spec example and a null photo_meta", () => {
  assertValid(validRecord());
  assertValid(validRecord({ photo_meta: null }));
  assertValid(withPhoto({ lat: null, lon: null, taken_at: null }));
});

test("validateRecord rejects a non-object record", () => {
  assert.deepEqual(fields(Feedback.validateRecord(null, NOW)), ["record"]);
  assert.deepEqual(fields(Feedback.validateRecord([], NOW)), ["record"]);
  assert.deepEqual(fields(Feedback.validateRecord("x", NOW)), ["record"]);
});

test("validateRecord checks device_id is a UUID v4", () => {
  assertInvalid(validRecord({ device_id: "not-a-uuid" }), "device_id");
  assertInvalid(validRecord({ device_id: "2f1c6a3e-9b7d-1c21-8e5f-0a1b2c3d4e5f" }), "device_id"); // version 1
  assertInvalid(validRecord({ device_id: 123 }), "device_id");
});

test("validateRecord limits name to 20 characters after trimming, without control characters", () => {
  assertValid(validRecord({ name: "あ".repeat(20) }));
  assertValid(validRecord({ name: `  ${"a".repeat(20)}  ` }));
  assertValid(validRecord({ name: "🏄".repeat(20) }));
  assertInvalid(validRecord({ name: "あ".repeat(21) }), "name");
  assertInvalid(validRecord({ name: "a\tb" }), "name");
  assertInvalid(validRecord({ name: null }), "name");
});

test("validateRecord limits spot to 1-40 characters", () => {
  assertValid(validRecord({ spot: "あ".repeat(40) }));
  assertInvalid(validRecord({ spot: "" }), "spot");
  assertInvalid(validRecord({ spot: "あ".repeat(41) }), "spot");
});

test("validateRecord accepts dates from 30 days ago through today", () => {
  assertValid(validRecord({ date: "2026-08-24" }));
  assertInvalid(validRecord({ date: "2026-08-23" }), "date");
  assertInvalid(validRecord({ date: "2026-09-24" }), "date");
  assertInvalid(validRecord({ date: "2026-02-30" }), "date");
  assertInvalid(validRecord({ date: "2026-9-23" }), "date");
});

test("validateRecord rejects unknown slots and today's slots that have not begun", () => {
  assertValid(validRecord({ slot: "afternoon" }));
  assertValid(validRecord({ date: "2026-09-22", slot: "evening" }));
  assertInvalid(validRecord({ slot: "evening" }), "slot");
  assertInvalid(validRecord({ slot: "night" }), "slot");
});

test("validateRecord checks numeric ranges at both edges", () => {
  for (const bearing of [0, 360]) assertValid(validRecord({ bearing }));
  for (const bearing of [-0.1, 360.1]) assertInvalid(validRecord({ bearing }), "bearing");
  const ranges = { wave_height: [0, 20], wind_dir: [0, 360], wind_speed: [0, 60], swell_dir: [0, 360], swell_period: [0, 30] };
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    assertValid(withForecast({ [key]: lo }));
    assertValid(withForecast({ [key]: hi }));
    assertInvalid(withForecast({ [key]: lo - 0.01 }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: hi + 0.01 }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: NaN }), `forecast.${key}`);
    assertInvalid(withForecast({ [key]: "1" }), `forecast.${key}`);
  }
  assertInvalid(validRecord({ forecast: null }), "forecast");
});

test("validateRecord checks observed values", () => {
  for (const rating of [1, 5]) assertValid(withObserved({ rating }));
  for (const rating of [0, 6, 3.5, "4"]) assertInvalid(withObserved({ rating }), "observed.rating");
  for (const wave_band of [0, 7]) assertValid(withObserved({ wave_band }));
  for (const wave_band of [-1, 8, 2.5]) assertInvalid(withObserved({ wave_band }), "observed.wave_band");
  for (const wind_side of ["off", "side", "on"]) assertValid(withObserved({ wind_side }));
  for (const wind_side of ["offshore", "constructor", null]) assertInvalid(withObserved({ wind_side }), "observed.wind_side");
  for (const wind_strength of ["calm", "light", "strong"]) assertValid(withObserved({ wind_strength }));
  for (const wind_strength of ["breeze", "toString"]) assertInvalid(withObserved({ wind_strength }), "observed.wind_strength");
});

test("validateRecord checks photo_meta ranges and time format", () => {
  assertValid(withPhoto({ lat: -90, lon: 180 }));
  assertInvalid(withPhoto({ lat: 90.01 }), "photo_meta.lat");
  assertInvalid(withPhoto({ lon: -180.01 }), "photo_meta.lon");
  assertInvalid(withPhoto({ taken_at: "2026-09-23 07:42" }), "photo_meta.taken_at");
  assertInvalid(validRecord({ photo_meta: "x" }), "photo_meta");
});

test("validateRecord reports every problem at once", () => {
  const errors = Feedback.validateRecord(validRecord({ spot: "", slot: "night", observed: { rating: 0, wave_band: 3, wind_side: "off", wind_strength: "light" } }), NOW);
  assert.deepEqual(fields(errors), ["spot", "slot", "observed.rating"]);
  assert.ok(errors.every((e) => /: \S/.test(e)));
});

// --- readExif ---

// Builds a JPEG with an APP0 (JFIF) segment, then an EXIF APP1 in the given
// byte order holding DateTimeOriginal and/or GPS, then start-of-scan.
function buildJpeg({ le = true, takenAt = null, gps = null } = {}) {
  const u16 = (v) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
  const entry = (tag, type, count, value) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  const ascii = (s) => Array.from(s + "\0", (c) => c.charCodeAt(0));
  const inline = (s) => [...ascii(s), 0, 0, 0, 0].slice(0, 4);
  const rationals = (dms) => dms.flatMap((v) => [...u32(Math.round(v * 100)), ...u32(100)]);

  let tiff = [];
  if (takenAt || gps) {
    const count0 = (takenAt ? 1 : 0) + (gps ? 1 : 0);
    let cursor = 8 + 2 + 12 * count0 + 4;
    const exifAt = cursor;
    if (takenAt) cursor += 2 + 12 + 4 + 20;
    const gpsAt = cursor;
    tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8), ...u16(count0)];
    if (takenAt) tiff.push(...entry(0x8769, 4, 1, u32(exifAt)));
    if (gps) tiff.push(...entry(0x8825, 4, 1, u32(gpsAt)));
    tiff.push(...u32(0));
    if (takenAt) tiff.push(...u16(1), ...entry(0x9003, 2, 20, u32(exifAt + 18)), ...u32(0), ...ascii(takenAt));
    if (gps) {
      tiff.push(
        ...u16(4),
        ...entry(1, 2, 2, inline(gps.latRef)),
        ...entry(2, 5, 3, u32(gpsAt + 54)),
        ...entry(3, 2, 2, inline(gps.lonRef)),
        ...entry(4, 5, 3, u32(gpsAt + 78)),
        ...u32(0),
        ...rationals(gps.lat),
        ...rationals(gps.lon),
      );
    }
  }
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 = tiff.length ? [0xff, 0xe1, (tiff.length + 8) >> 8, (tiff.length + 8) & 255, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff] : [];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]).buffer;
}
const ICHINOMIYA = { latRef: "N", lat: [35, 20, 24], lonRef: "E", lon: [140, 23, 24] }; // 35.34, 140.39

test("readExif reads GPS and capture time in little-endian order", () => {
  const meta = Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, "2026-09-23T07:42");
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon - 140.39) < 1e-9);
});

test("readExif reads big-endian (Motorola) EXIF the same way", () => {
  const meta = Feedback.readExif(buildJpeg({ le: false, takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, "2026-09-23T07:42");
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon - 140.39) < 1e-9);
});

test("readExif returns null lat/lon when only the capture time exists", () => {
  assert.deepEqual(Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 16:05:00" })), { lat: null, lon: null, taken_at: "2026-09-23T16:05" });
});

test("readExif returns a null time when only GPS exists", () => {
  const meta = Feedback.readExif(buildJpeg({ gps: ICHINOMIYA }));
  assert.equal(meta.taken_at, null);
  assert.ok(Math.abs(meta.lat - 35.34) < 1e-9);
});

test("readExif makes south and west negative", () => {
  const meta = Feedback.readExif(buildJpeg({ gps: { ...ICHINOMIYA, latRef: "S", lonRef: "W" } }));
  assert.ok(Math.abs(meta.lat + 35.34) < 1e-9);
  assert.ok(Math.abs(meta.lon + 140.39) < 1e-9);
});

test("readExif returns null lat/lon, as a pair, when the GPS decodes out of range but keeps the capture time", () => {
  const outOfRangeLat = { latRef: "N", lat: [95, 0, 0], lonRef: "E", lon: [140, 23, 24] }; // 95°, > 90
  const meta = Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: outOfRangeLat }));
  assert.deepEqual(meta, { lat: null, lon: null, taken_at: "2026-09-23T07:42" });
});

test("readExif returns null lat/lon when only the longitude is out of range", () => {
  const outOfRangeLon = { latRef: "N", lat: [35, 20, 24], lonRef: "E", lon: [185, 0, 0] }; // 185°, > 180
  const meta = Feedback.readExif(buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: outOfRangeLon }));
  assert.deepEqual(meta, { lat: null, lon: null, taken_at: "2026-09-23T07:42" });
});

test("readExif returns null for a JPEG without EXIF", () => {
  assert.equal(Feedback.readExif(buildJpeg()), null);
});

test("readExif returns null, without throwing, for truncated and non-JPEG input", () => {
  const full = buildJpeg({ takenAt: "2026:09:23 07:42:10", gps: ICHINOMIYA });
  for (const cut of [1, 3, 30, 60, full.byteLength - 60]) {
    assert.equal(Feedback.readExif(full.slice(0, cut)), null, `cut at ${cut}`);
  }
  assert.equal(Feedback.readExif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer), null);
  assert.equal(Feedback.readExif(new ArrayBuffer(0)), null);
});

// --- distanceKm / suggestSpot ---

const KM = 180 / (Math.PI * 6371); // degrees of latitude per km
const A = { name: "A", lat: 35, lon: 140 };
const B = { name: "B", lat: 35 + 1.5 * KM, lon: 140 };
const FAR = { name: "FAR", lat: 36, lon: 141 };

test("distanceKm measures along a meridian in km", () => {
  assert.ok(Math.abs(Feedback.distanceKm(A, B) - 1.5) < 1e-9);
  assert.equal(Feedback.distanceKm(A, A), 0);
});

test("suggestSpot suggests the nearest spot once the chosen one is over 1.0 km away", () => {
  const photo = { lat: 35 + 1.01 * KM, lon: 140, taken_at: null };
  const s = Feedback.suggestSpot(photo, A, [A, B, FAR]);
  assert.equal(s.spot, B);
  assert.ok(Math.abs(s.km - 0.49) < 1e-9);
});

test("suggestSpot stays quiet within 1.0 km of the chosen spot", () => {
  assert.equal(Feedback.suggestSpot({ lat: 35 + 0.99 * KM, lon: 140 }, A, [A, B, FAR]), null);
});

test("suggestSpot stays quiet when the chosen spot is the nearest", () => {
  assert.equal(Feedback.suggestSpot({ lat: 35 - 3 * KM, lon: 140 }, A, [A, B, FAR]), null);
});

test("suggestSpot stays quiet without a photo location", () => {
  assert.equal(Feedback.suggestSpot(null, A, [A, B]), null);
  assert.equal(Feedback.suggestSpot({ lat: null, lon: null, taken_at: "2026-09-23T07:00" }, A, [A, B]), null);
});
