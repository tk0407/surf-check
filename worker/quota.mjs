// Limits on POST /feedback and the D1 bookkeeping that enforces them. A send
// is checked and recorded in one D1 transaction, so sends arriving at the
// same moment cannot all slip under a limit. docs/r2-security.md explains
// each limit and how to change it.

// Each can be overridden by a Worker variable of the same name.
export const DEFAULT_LIMITS = {
  MAX_UPLOAD_SIZE: 1572864, // bytes in one photo (1.5 MB)
  MINUTE_COUNT_LIMIT: 5, // sends per device, and per connection, in any 60 s
  DAILY_UPLOAD_COUNT_LIMIT: 20, // sends per device per day (Japan time)
  IP_DAILY_COUNT_LIMIT: 30, // sends per connection per day
  GLOBAL_DAILY_COUNT_LIMIT: 100, // sends per day from everyone
  DAILY_UPLOAD_LIMIT: 10485760, // photo bytes per device per day (10 MB)
  GLOBAL_DAILY_UPLOAD_LIMIT: 104857600, // photo bytes per day from everyone (100 MB)
  USER_STORAGE_LIMIT: 209715200, // photo bytes kept in R2 per device (200 MB)
  GLOBAL_STORAGE_LIMIT: 5368709120, // photo bytes kept in R2 in all (5 GB, half the free 10 GB)
};
export const MAX_UPLOAD_SIZE_CEILING = 10485760;

export class ConfigError extends Error {
  constructor(variable) {
    super(`${variable} is not a valid limit`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

// Unset or blank variables take the default. Anything else must be a whole
// number, or the Worker refuses to store anything rather than guess.
export function readLimits(env) {
  const limits = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const text = String(env[name] ?? "").trim();
    if (text === "") limits[name] = fallback;
    else if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) limits[name] = Number(text);
    else throw new ConfigError(name);
  }
  if (limits.MAX_UPLOAD_SIZE > MAX_UPLOAD_SIZE_CEILING) throw new ConfigError("MAX_UPLOAD_SIZE");
  return limits;
}

// Photos go to R2 only while R2_KILL_SWITCH is "false" or "0". A missing or
// mistyped value leaves the switch on, so a bad deploy cannot start writing.
export function photosAllowed(env) {
  return ["false", "0"].includes(String(env.R2_KILL_SWITCH ?? "").trim().toLowerCase());
}

// Bound as ?6..?13 after ?1 device, ?2 ip_hash, ?3 day, ?4 now (ms) and
// ?5 the photo bytes wanted (0 for none).
const LIMIT_ORDER = [
  "MINUTE_COUNT_LIMIT", "DAILY_UPLOAD_COUNT_LIMIT", "IP_DAILY_COUNT_LIMIT", "GLOBAL_DAILY_COUNT_LIMIT",
  "DAILY_UPLOAD_LIMIT", "GLOBAL_DAILY_UPLOAD_LIMIT", "USER_STORAGE_LIMIT", "GLOBAL_STORAGE_LIMIT",
];

// reason: why the send is refused (429), checked in this order.
// photo_reason: why the photo is skipped though the record is kept.
// TOTAL() is 0 when no row matches.
const VERDICT = `SELECT
    CASE
      WHEN TOTAL(device_id = ?1 AND at > ?4 - 60000) >= ?6 THEN 'device_minute'
      WHEN TOTAL(ip_hash = ?2 AND at > ?4 - 60000) >= ?6 THEN 'ip_minute'
      WHEN TOTAL(device_id = ?1 AND day = ?3) >= ?7 THEN 'device'
      WHEN TOTAL(ip_hash = ?2 AND day = ?3) >= ?8 THEN 'ip'
      WHEN TOTAL(day = ?3) >= ?9 THEN 'total'
    END AS reason,
    CASE
      WHEN ?5 = 0 THEN NULL
      WHEN ?5 + TOTAL(CASE WHEN device_id = ?1 AND day = ?3 THEN photo_bytes END) > ?10 THEN 'device_bytes'
      WHEN ?5 + TOTAL(CASE WHEN day = ?3 THEN photo_bytes END) > ?11 THEN 'global_bytes'
      WHEN ?5 + (SELECT TOTAL(used_bytes) FROM storage_usage WHERE scope = 'device:' || ?1) > ?12 THEN 'device_storage'
      WHEN ?5 + (SELECT TOTAL(used_bytes) FROM storage_usage WHERE scope = 'global') > ?13 THEN 'global_storage'
    END AS photo_reason
  FROM submissions`;

// Records the send only when no count limit is reached. ?14 is a fresh
// token, ?15 a reason the caller already has to skip the photo (or null).
const RESERVE = `INSERT INTO submissions (token, device_id, ip_hash, day, at, photo_bytes, photo_skipped)
  SELECT ?14, ?1, ?2, ?3, ?4, CASE WHEN photo_reason IS NULL THEN ?5 ELSE 0 END, COALESCE(?15, photo_reason)
  FROM (${VERDICT}) WHERE reason IS NULL
  RETURNING photo_bytes, photo_skipped`;

// Adds the photo reserved under token ?1 to the device's and the global totals.
const COUNT_STORAGE = `INSERT INTO storage_usage (scope, used_bytes, file_count)
  SELECT scope, photo_bytes, 1 FROM (
    SELECT 'global' AS scope, photo_bytes FROM submissions WHERE token = ?1 AND photo_bytes > 0
    UNION ALL
    SELECT 'device:' || device_id, photo_bytes FROM submissions WHERE token = ?1 AND photo_bytes > 0
  ) WHERE true
  ON CONFLICT (scope) DO UPDATE SET used_bytes = used_bytes + excluded.used_bytes, file_count = file_count + 1`;

const RELEASE = `UPDATE storage_usage SET used_bytes = MAX(0, used_bytes - ?1), file_count = MAX(0, file_count - 1)
  WHERE scope IN ('global', 'device:' || ?2)`;

// Returns { limit } when a count limit refuses the send. Otherwise the send is
// recorded and it returns { photoBytes, photoSkipped }: the bytes the caller
// may now put in R2 (0 when the photo must be skipped) and why it is skipped.
export async function reserve(db, limits, { device, ipHash, day, at, bytes, skipped = null }) {
  const verdict = [device, ipHash, day, at, bytes, ...LIMIT_ORDER.map((name) => limits[name])];
  const token = crypto.randomUUID();
  const [reserved] = await db.batch([
    db.prepare(RESERVE).bind(...verdict, token, skipped),
    db.prepare(COUNT_STORAGE).bind(token),
  ]);
  const row = reserved.results[0];
  if (row) return { photoBytes: row.photo_bytes, photoSkipped: row.photo_skipped };
  const { reason } = await db.prepare(VERDICT).bind(...verdict).first();
  return { limit: reason };
}

// Gives the bytes of a photo that is gone from R2 back to both totals.
export async function release(db, device, bytes) {
  await db.prepare(RELEASE).bind(bytes, device).run();
}
