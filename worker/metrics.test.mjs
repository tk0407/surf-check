// worker/metrics.mjs runs Calibration.metrics() offline against a
// `wrangler d1 execute --json` dump, for spots too large for the 10ms CPU
// budget of GET /calibration?metrics=1 on the Workers Free plan (see
// README.md). These tests cover only its own parsing/formatting logic;
// the calibration math itself is covered by calibration.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Calibration from "../calibration.js";
import { CALIBRATION_COLUMNS } from "./handler.mjs";
import { SELECT, rowsFromWranglerJson } from "./metrics.mjs";

const SCRIPT = new URL("./metrics.mjs", import.meta.url);

test("SELECT reuses handler.mjs's CALIBRATION_COLUMNS, not a second copy", () => {
  assert.equal(SELECT, `SELECT ${CALIBRATION_COLUMNS} FROM feedback ORDER BY id`);
});

test("rowsFromWranglerJson reads the results array out of wrangler --json's shape", () => {
  const wranglerOutput = JSON.stringify([
    {
      results: [
        { spot: "一宮", rating: 4, wave_band: 5 },
        { spot: "太東", rating: 3, wave_band: 3 },
      ],
      success: true,
      meta: { duration: 1 },
    },
  ]);
  assert.deepEqual(rowsFromWranglerJson(wranglerOutput), [
    { spot: "一宮", rating: 4, wave_band: 5 },
    { spot: "太東", rating: 3, wave_band: 3 },
  ]);
});

test("rowsFromWranglerJson returns an empty array for a query that matched no rows", () => {
  const wranglerOutput = JSON.stringify([{ results: [], success: true, meta: { duration: 0 } }]);
  assert.deepEqual(rowsFromWranglerJson(wranglerOutput), []);
});

test("rowsFromWranglerJson throws a clear error when the input is not wrangler --json's shape", () => {
  assert.throws(() => rowsFromWranglerJson(JSON.stringify({ not: "an array" })), /wrangler --json/);
  assert.throws(() => rowsFromWranglerJson(JSON.stringify([{ no_results: true }])), /wrangler --json/);
});

test("--sql prints the SELECT and exits, without reading stdin", () => {
  const out = execFileSync(process.execPath, [SCRIPT.pathname, "--sql"], { encoding: "utf8" });
  assert.equal(out.trim(), SELECT);
});

test("piping a wrangler --json dump in prints Calibration.metrics() of those rows as JSON", () => {
  const wranglerOutput = JSON.stringify([
    {
      results: [
        {
          device_id: "d1", spot: "一宮", bearing: 90,
          fc_wave_height: 0.5, fc_wind_dir: 90, fc_wind_speed: 3, fc_swell_dir: 90, fc_swell_period: 8,
          rating: 4, wave_band: 4, wind_side: "off", wind_strength: "light",
        },
        {
          device_id: "d2", spot: "一宮", bearing: 90,
          fc_wave_height: 0.5, fc_wind_dir: 90, fc_wind_speed: 3, fc_swell_dir: 90, fc_swell_period: 8,
          rating: 3, wave_band: 3, wind_side: "on", wind_strength: "strong",
        },
      ],
      success: true,
      meta: { duration: 1 },
    },
  ]);
  const out = execFileSync(process.execPath, [SCRIPT.pathname], { input: wranglerOutput, encoding: "utf8" });
  const printed = JSON.parse(out);
  assert.deepEqual(printed, Calibration.metrics(JSON.parse(wranglerOutput)[0].results));
});
