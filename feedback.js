// Feedback records: panel defaults, validation (shared by the site and the
// Worker), and photo EXIF reading. No DOM access, so it runs under node --test.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(require("./forecast.js"), require("./calibration.js"));
  } else {
    root.Feedback = factory(root.Forecast, root.Calibration);
  }
})(typeof self !== "undefined" ? self : this, function (Forecast, Calibration) {
  const { TIME_SLOTS, SLOT_ORDER } = Forecast;
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // Japan has no daylight saving time
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_AGE_DAYS = 30;
  const NAME_MAX = 20;
  const SPOT_MAX = 40;
  const SUGGEST_KM = 1.0;

  const pad = (n) => String(n).padStart(2, "0");

  // Date and minutes-since-midnight in Japan time, whatever the host's zone.
  function jstNow(now) {
    const d = new Date(now.getTime() + JST_OFFSET_MS);
    return {
      date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    };
  }

  function shiftDay(date, days) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
  }

  // Selectable dates: 30 days ago through today, Japan time.
  function dateRange(now) {
    const today = jstNow(now).date;
    return { min: shiftDay(today, -MAX_AGE_DAYS), max: today };
  }

  function slotStartMinutes(slot) {
    return TIME_SLOTS[slot][0] * 60;
  }

  // True when the slot on that date has begun (every slot of a past date has).
  function slotStarted(date, slot, now) {
    const { date: today, minutes } = jstNow(now);
    if (date < today) return true;
    if (date > today) return false;
    return minutes >= slotStartMinutes(slot);
  }

  function latestStarted(now) {
    const { date: today, minutes } = jstNow(now);
    let slot = null;
    for (const s of SLOT_ORDER) if (minutes >= slotStartMinutes(s)) slot = s;
    return slot ? { date: today, slot } : { date: shiftDay(today, -1), slot: SLOT_ORDER[SLOT_ORDER.length - 1] };
  }

  // The card's date and slot when they have begun and are in range;
  // otherwise the latest slot that has begun (before 7:00, yesterday evening).
  function defaultSession(card, now) {
    const { min, max } = dateRange(now);
    if (card.date >= min && card.date <= max && slotStarted(card.date, card.slot, now)) {
      return { date: card.date, slot: card.slot };
    }
    return latestStarted(now);
  }

  // Nearest slot to "YYYY-MM-DDTHH:MM"; 0 inside a slot, earlier slot on ties.
  function slotForTime(takenAt) {
    const m = parseInt(takenAt.slice(11, 13), 10) * 60 + parseInt(takenAt.slice(14, 16), 10);
    let best = null;
    let bestDist = Infinity;
    for (const slot of SLOT_ORDER) {
      const [startH, endH] = TIME_SLOTS[slot];
      const dist = m < startH * 60 ? startH * 60 - m : m > endH * 60 ? m - endH * 60 : 0;
      if (dist < bestDist) {
        best = slot;
        bestDist = dist;
      }
    }
    return best;
  }

  // Session suggested by a photo's capture time, or null when it falls
  // outside the selectable dates or on a slot of today that has not begun.
  function sessionFromPhoto(takenAt, now) {
    if (!takenAt) return null;
    const date = takenAt.slice(0, 10);
    const slot = slotForTime(takenAt);
    const { min, max } = dateRange(now);
    if (date < min || date > max || !slotStarted(date, slot, now)) return null;
    return { date, slot };
  }

  // Panel defaults from the forecast shown on the card (already calibrated).
  function initialObserved(data, bearing) {
    return {
      wave_band: Calibration.waveBand(data.wave_height),
      wind_side: Calibration.windSide(data.wind_dir, bearing),
      wind_strength: Calibration.windStrength(data.wind_speed),
    };
  }

  // rawData is the forecast before calibration: records must never learn
  // from their own corrections.
  function buildRecord({ deviceId, name, spot, date, slot, rawData, observed, photoMeta }) {
    return {
      device_id: deviceId,
      name: (name || "").trim(),
      spot: spot.name,
      date,
      slot,
      bearing: spot.bearing,
      forecast: {
        wave_height: rawData.wave_height,
        wind_dir: rawData.wind_dir,
        wind_speed: rawData.wind_speed,
        swell_dir: rawData.swell_dir,
        swell_period: rawData.swell_period,
      },
      observed: {
        rating: observed.rating,
        wave_band: observed.wave_band,
        wind_side: observed.wind_side,
        wind_strength: observed.wind_strength,
      },
      photo_meta: photoMeta || null,
    };
  }

  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const CONTROL = /[\u0000-\u001f\u007f]/;
  const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const inRange = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const charCount = (s) => Array.from(s).length;

  function realDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
  }

  // Returns a list of "field: problem" messages in Japanese; empty when valid.
  function validateRecord(rec, now) {
    if (!isObject(rec)) return ["record: 形が正しくありません"];
    const errors = [];
    const fail = (field, msg) => errors.push(`${field}: ${msg}`);

    if (typeof rec.device_id !== "string" || !UUID_V4.test(rec.device_id)) fail("device_id", "UUID v4 ではありません");
    if (typeof rec.name !== "string") fail("name", "文字列ではありません");
    else if (charCount(rec.name.trim()) > NAME_MAX) fail("name", `${NAME_MAX}文字までです`);
    else if (CONTROL.test(rec.name)) fail("name", "使えない文字が含まれています");
    if (typeof rec.spot !== "string" || charCount(rec.spot) < 1 || charCount(rec.spot) > SPOT_MAX) {
      fail("spot", `1〜${SPOT_MAX}文字で指定してください`);
    }

    const { min, max } = dateRange(now);
    const dateOk = realDate(rec.date);
    if (!dateOk) fail("date", "日付が正しくありません");
    else if (rec.date < min || rec.date > max) fail("date", "今日から30日前までの日付にしてください");
    if (!SLOT_ORDER.includes(rec.slot)) fail("slot", "morning / afternoon / evening のどれかにしてください");
    else if (dateOk && rec.date === max && !slotStarted(rec.date, rec.slot, now)) fail("slot", "まだ始まっていない時間帯です");

    if (!inRange(rec.bearing, 0, 360)) fail("bearing", "0〜360 にしてください");
    const fc = rec.forecast;
    if (!isObject(fc)) fail("forecast", "形が正しくありません");
    else {
      if (!inRange(fc.wave_height, 0, 20)) fail("forecast.wave_height", "0〜20 にしてください");
      if (!inRange(fc.wind_dir, 0, 360)) fail("forecast.wind_dir", "0〜360 にしてください");
      if (!inRange(fc.wind_speed, 0, 60)) fail("forecast.wind_speed", "0〜60 にしてください");
      if (!inRange(fc.swell_dir, 0, 360)) fail("forecast.swell_dir", "0〜360 にしてください");
      if (!inRange(fc.swell_period, 0, 30)) fail("forecast.swell_period", "0〜30 にしてください");
    }
    const ob = rec.observed;
    if (!isObject(ob)) fail("observed", "形が正しくありません");
    else {
      if (!isInt(ob.rating, 1, 5)) fail("observed.rating", "1〜5 の整数にしてください");
      if (!isInt(ob.wave_band, 0, Calibration.WAVE_BANDS.length - 1)) fail("observed.wave_band", "0〜7 の整数にしてください");
      if (!Object.prototype.hasOwnProperty.call(Calibration.WIND_SIDES, ob.wind_side)) fail("observed.wind_side", "off / side / on のどれかにしてください");
      if (!Object.prototype.hasOwnProperty.call(Calibration.WIND_STRENGTHS, ob.wind_strength)) fail("observed.wind_strength", "calm / light / strong のどれかにしてください");
    }
    const pm = rec.photo_meta;
    if (pm != null) {
      if (!isObject(pm)) fail("photo_meta", "形が正しくありません");
      else {
        if (pm.lat != null && !inRange(pm.lat, -90, 90)) fail("photo_meta.lat", "−90〜90 にしてください");
        if (pm.lon != null && !inRange(pm.lon, -180, 180)) fail("photo_meta.lon", "−180〜180 にしてください");
        if (pm.taken_at != null && (typeof pm.taken_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(pm.taken_at))) {
          fail("photo_meta.taken_at", "YYYY-MM-DDTHH:MM にしてください");
        }
      }
    }
    return errors;
  }

  // --- EXIF (JPEG only) ---

  // Returns { lat, lon, taken_at } (each possibly null), or null when the
  // file is not a JPEG, has no usable EXIF, or is cut short. Never throws.
  function readExif(buffer) {
    try {
      const view = new DataView(buffer);
      if (view.getUint16(0) !== 0xffd8) return null;
      let offset = 2;
      while (offset + 4 <= view.byteLength) {
        if (view.getUint8(offset) !== 0xff) return null;
        const marker = view.getUint8(offset + 1);
        if (marker === 0xda || marker === 0xd9) return null; // image data: no EXIF before it
        const size = view.getUint16(offset + 2);
        if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966 && view.getUint16(offset + 8) === 0) {
          return readTiff(new DataView(buffer, offset + 10, size - 8));
        }
        offset += 2 + size;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function readTiff(tiff) {
    const order = tiff.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const le = order === 0x4949;
    const u16 = (o) => tiff.getUint16(o, le);
    const u32 = (o) => tiff.getUint32(o, le);
    if (u16(2) !== 42) return null;

    function entries(ifdOffset) {
      const out = new Map();
      const count = u16(ifdOffset);
      for (let i = 0; i < count; i++) {
        const e = ifdOffset + 2 + i * 12;
        out.set(u16(e), { type: u16(e + 2), count: u32(e + 4), at: e + 8 });
      }
      return out;
    }
    const valueOffset = (entry, bytes) => (entry.count * bytes <= 4 ? entry.at : u32(entry.at));
    function ascii(entry) {
      const start = valueOffset(entry, 1);
      let s = "";
      for (let i = 0; i < entry.count; i++) {
        const c = tiff.getUint8(start + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    function degrees(entry) {
      const start = u32(entry.at); // 3 rationals never fit inline
      let deg = 0;
      for (let i = 0; i < 3; i++) deg += u32(start + i * 8) / u32(start + i * 8 + 4) / 60 ** i;
      return deg;
    }

    const ifd0 = entries(u32(4));
    let takenAt = null;
    if (ifd0.has(0x8769)) {
      const exif = entries(u32(ifd0.get(0x8769).at));
      if (exif.has(0x9003)) {
        const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(ascii(exif.get(0x9003)));
        if (m) takenAt = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
      }
    }
    let lat = null;
    let lon = null;
    if (ifd0.has(0x8825)) {
      const gps = entries(u32(ifd0.get(0x8825).at));
      if ([1, 2, 3, 4].every((tag) => gps.has(tag))) {
        const la = degrees(gps.get(2)) * (ascii(gps.get(1)) === "S" ? -1 : 1);
        const lo = degrees(gps.get(4)) * (ascii(gps.get(3)) === "W" ? -1 : 1);
        // A position that decodes outside the real range can't be read either;
        // it becomes null like any other unreadable GPS (both lat and lon).
        if (Number.isFinite(la) && Number.isFinite(lo) && Math.abs(la) <= 90 && Math.abs(lo) <= 180) {
          lat = la;
          lon = lo;
        }
      }
    }
    if (takenAt === null && lat === null) return null;
    return { lat, lon, taken_at: takenAt };
  }

  // --- photo location ---

  function distanceKm(a, b) {
    const R = 6371;
    const rad = (d) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLon = rad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // { spot, km } for the spot nearest the photo when that is not the chosen
  // spot and the chosen spot is more than 1.0 km away; otherwise null.
  function suggestSpot(meta, current, spots) {
    if (!meta || typeof meta.lat !== "number" || typeof meta.lon !== "number") return null;
    const at = { lat: meta.lat, lon: meta.lon };
    let nearest = null;
    let nearestKm = Infinity;
    for (const s of spots) {
      const km = distanceKm(at, s);
      if (km < nearestKm) {
        nearest = s;
        nearestKm = km;
      }
    }
    if (!nearest || nearest.name === current.name) return null;
    if (distanceKm(at, current) <= SUGGEST_KM) return null;
    return { spot: nearest, km: nearestKm };
  }

  return {
    jstNow, shiftDay, dateRange, slotStarted, defaultSession, slotForTime, sessionFromPhoto,
    initialObserved, buildRecord, validateRecord, readExif, distanceKm, suggestSpot,
  };
});
