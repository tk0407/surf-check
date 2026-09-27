// POST /feedback stores one session record (and optional photo);
// GET /calibration returns the corrections computed from all records.
import Calibration from "../calibration.js";
import Feedback from "../feedback.js";
import { ConfigError, photosAllowed, readLimits, release, reserve } from "./quota.mjs";

// Room for the record and the multipart framing on top of the photo.
const FORM_OVERHEAD_BYTES = 524288;
const KEEP_SUBMISSION_DAYS = 3;
const MAX_LOGGED_ERROR = 200;

const CALIBRATION_COLUMNS =
  "device_id, spot, bearing, fc_wave_height, fc_wind_dir, fc_wind_speed, fc_swell_dir, fc_swell_period, rating, wave_band, wind_side, wind_strength";

const UPSERT = `INSERT INTO feedback (device_id, name, spot, date, slot, bearing,
    fc_wave_height, fc_wind_dir, fc_wind_speed, fc_swell_dir, fc_swell_period,
    rating, wave_band, wind_side, wind_strength,
    photo_key, photo_bytes, photo_lat, photo_lon, photo_taken_at, ip_hash, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (device_id, spot, date, slot) DO UPDATE SET
    name = excluded.name, bearing = excluded.bearing,
    fc_wave_height = excluded.fc_wave_height, fc_wind_dir = excluded.fc_wind_dir,
    fc_wind_speed = excluded.fc_wind_speed, fc_swell_dir = excluded.fc_swell_dir,
    fc_swell_period = excluded.fc_swell_period,
    rating = excluded.rating, wave_band = excluded.wave_band,
    wind_side = excluded.wind_side, wind_strength = excluded.wind_strength,
    photo_key = COALESCE(excluded.photo_key, feedback.photo_key),
    photo_bytes = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_bytes ELSE excluded.photo_bytes END,
    photo_lat = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_lat ELSE excluded.photo_lat END,
    photo_lon = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_lon ELSE excluded.photo_lon END,
    photo_taken_at = CASE WHEN excluded.photo_key IS NULL THEN feedback.photo_taken_at ELSE excluded.photo_taken_at END,
    ip_hash = excluded.ip_hash, updated_at = excluded.updated_at
  RETURNING id`;

const SELECT_SESSION = "SELECT id, photo_key, photo_bytes FROM feedback WHERE device_id = ? AND spot = ? AND date = ? AND slot = ?";

// One JSON line per event, read with `wrangler tail`. Never log device ids,
// names, IPs or their hashes.
const log = (entry) => console.log(JSON.stringify(entry));
const errorText = (e) => `${e && e.name}: ${e && e.message}`.slice(0, MAX_LOGGED_ERROR);

function json(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigin(origin, env) {
  if (!origin) return false;
  return (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).includes(origin);
}

const corsFor = (origin) => ({ "Access-Control-Allow-Origin": origin, Vary: "Origin" });

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const isJpeg = (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

// Reads the body but stops, and returns null, as soon as it passes max bytes,
// so a huge or endless upload is never read to the end.
async function readBody(request, max) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handle(request, env, now) {
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (url.pathname === "/feedback") {
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: { ...corsFor(origin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
      });
    }
    if (request.method !== "POST") return json({ error: "POST で送ってください" }, 405);
    if (!allowedOrigin(origin, env)) return json({ error: "このサイトからは送れません" }, 403);
    let res;
    try {
      res = await postFeedback(request, env, now);
    } catch (e) {
      log({ event: "error", error: errorText(e) });
      res = { status: 500, body: { error: "サーバーでエラーが起きました" } };
    }
    const { limit, updated, photo_skipped } = res.body;
    log({ event: "feedback", status: res.status, limit, updated, photo_skipped, photo_bytes: res.photoBytes || undefined });
    return json(res.body, res.status, corsFor(origin));
  }
  if (url.pathname === "/calibration" && request.method === "GET") return getCalibration(url, env, now);
  return json({ error: "見つかりません" }, 404);
}

// Returns { status, body, photoBytes }; handle() turns it into the response
// and the log line.
async function postFeedback(request, env, now) {
  const reply = (status, body, photoBytes = 0) => ({ status, body, photoBytes });
  if (!env.IP_SALT) {
    log({ event: "config_error", variable: "IP_SALT" });
    return reply(500, { error: "サーバーの設定が足りません" });
  }
  let limits;
  try {
    limits = readLimits(env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    log({ event: "config_error", variable: e.variable });
    return reply(500, { error: "サーバーの設定が正しくありません" });
  }

  const maxBody = limits.MAX_UPLOAD_SIZE + FORM_OVERHEAD_BYTES;
  if (Number(request.headers.get("Content-Length")) > maxBody) return reply(413, { error: "送信が大きすぎます" });
  const body = await readBody(request, maxBody);
  if (!body) return reply(413, { error: "送信が大きすぎます" });

  let form;
  try {
    form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") || "" } }).formData();
  } catch (e) {
    return reply(400, { error: "送信の形が正しくありません" });
  }
  let rec;
  try {
    rec = JSON.parse(form.get("record"));
  } catch (e) {
    return reply(400, { error: "record: JSON ではありません" });
  }
  const errors = Feedback.validateRecord(rec, now);
  if (errors.length) return reply(400, { error: errors.join(" / "), errors });

  const photo = form.get("photo");
  let photoBytes = null;
  if (photo !== null) {
    if (typeof photo === "string") return reply(415, { error: "写真は JPEG にしてください" });
    photoBytes = new Uint8Array(await photo.arrayBuffer());
    if (photoBytes.byteLength > limits.MAX_UPLOAD_SIZE) return reply(413, { error: "写真が大きすぎます" });
    if (!isJpeg(photoBytes)) return reply(415, { error: "写真は JPEG にしてください" });
  }

  const day = Feedback.jstNow(now).date;
  const ipHash = await sha256Hex((request.headers.get("CF-Connecting-IP") || "") + env.IP_SALT);
  const killed = photoBytes !== null && !photosAllowed(env);
  const reservation = await reserve(env.DB, limits, {
    device: rec.device_id,
    ipHash,
    day,
    at: now.getTime(),
    bytes: photoBytes && !killed ? photoBytes.byteLength : 0,
    skipped: killed ? "kill_switch" : null,
  });
  if (reservation.limit) {
    const error = reservation.limit.endsWith("_minute") ? "短い間に送りすぎです。1分ほど待ってから送ってください" : "今日はこれ以上送れません";
    return reply(429, { error, limit: reservation.limit });
  }

  // The key is always made here: nothing the sender writes reaches it.
  const photoKey = reservation.photoBytes > 0 ? `photos/${crypto.randomUUID()}.jpg` : null;
  if (photoKey) {
    try {
      await env.PHOTOS.put(photoKey, photoBytes, { httpMetadata: { contentType: "image/jpeg" } });
    } catch (e) {
      log({ event: "r2_error", error: errorText(e) });
      await discardPhoto(env, photoKey, reservation.photoBytes, rec.device_id);
      return reply(500, { error: "保存できませんでした" });
    }
  }

  const meta = (photoKey && rec.photo_meta) || {};
  const stamp = now.toISOString();
  let before, saved;
  try {
    // Reading the old row in the same transaction tells exactly which photo
    // this save replaced, even when two sends of the same session race.
    [before, saved] = await env.DB.batch([
      env.DB.prepare(SELECT_SESSION).bind(rec.device_id, rec.spot, rec.date, rec.slot),
      env.DB.prepare(UPSERT).bind(
        rec.device_id, rec.name.trim(), rec.spot, rec.date, rec.slot, rec.bearing,
        rec.forecast.wave_height, rec.forecast.wind_dir, rec.forecast.wind_speed, rec.forecast.swell_dir, rec.forecast.swell_period,
        rec.observed.rating, rec.observed.wave_band, rec.observed.wind_side, rec.observed.wind_strength,
        photoKey, photoKey ? reservation.photoBytes : null, meta.lat ?? null, meta.lon ?? null, meta.taken_at ?? null,
        ipHash, stamp, stamp,
      ),
    ]);
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
    if (photoKey) await discardPhoto(env, photoKey, reservation.photoBytes, rec.device_id);
    return reply(500, { error: "保存できませんでした" });
  }
  const old = before.results[0] || null;
  await afterSave(env, day, photoKey && old && old.photo_key ? old : null, rec.device_id);

  const result = { ok: true, id: saved.results[0].id, updated: Boolean(old) };
  if (reservation.photoSkipped) result.photo_skipped = reservation.photoSkipped;
  return reply(200, result, reservation.photoBytes);
}

// The record is saved by now, so failures here are logged, not returned.
async function afterSave(env, day, replaced, device) {
  try {
    await env.DB.prepare("DELETE FROM submissions WHERE day < ?").bind(Feedback.shiftDay(day, -KEEP_SUBMISSION_DAYS)).run();
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
  }
  if (!replaced) return;
  try {
    await discardPhoto(env, replaced.photo_key, replaced.photo_bytes, device);
  } catch (e) {
    log({ event: "d1_error", error: errorText(e) });
  }
}

// Deletes a photo, then gives its bytes back. If the delete fails the object
// may still be in R2, so its bytes stay counted and the key is logged for
// clean-up by hand (docs/r2-security.md).
async function discardPhoto(env, key, bytes, device) {
  try {
    await env.PHOTOS.delete(key);
  } catch (e) {
    log({ event: "photo_orphan", key, error: errorText(e) });
    return;
  }
  await release(env.DB, device, bytes);
}

async function getCalibration(url, env, now) {
  const { results } = await env.DB.prepare(`SELECT ${CALIBRATION_COLUMNS} FROM feedback ORDER BY id`).all();
  const body = { ...Calibration.compute(results), generated_at: now.toISOString() };
  if (url.searchParams.get("metrics") === "1") body.metrics = Calibration.metrics(results);
  return json(body, 200, { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" });
}
