#!/usr/bin/env node
// Offline leave-one-out metrics for spots with more feedback than the
// Workers Free plan's 10ms CPU limit lets GET /calibration?metrics=1
// compute (see README.md's 「実況フィードバックと補正」の注記). Runs the
// same SELECT and the same Calibration.metrics() as handler.mjs, just from
// a JSON dump instead of live in the Worker.
//
// Usage (run from worker/):
//   npx wrangler@4 d1 execute surf-check-feedback --remote --json \
//     --command "$(node metrics.mjs --sql)" | node metrics.mjs
//
// node metrics.mjs --sql   prints only the SELECT above and exits.
import Calibration from "../calibration.js";
import { CALIBRATION_COLUMNS } from "./handler.mjs";

export const SELECT = `SELECT ${CALIBRATION_COLUMNS} FROM feedback ORDER BY id`;

// `wrangler d1 execute --json` prints an array with one entry per statement
// run: [{ results, success, meta }, ...]. One SELECT means one entry.
export function rowsFromWranglerJson(text) {
  const parsed = JSON.parse(text);
  const first = Array.isArray(parsed) ? parsed[0] : null;
  if (!first || !Array.isArray(first.results)) {
    throw new Error("not wrangler --json's shape: expected an array of { results, success, meta }");
  }
  return first.results;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main(argv) {
  if (argv.includes("--sql")) {
    console.log(SELECT);
    return;
  }
  const rows = rowsFromWranglerJson(await readStdin());
  console.log(JSON.stringify(Calibration.metrics(rows), null, 2));
}

// Only run as a script; worker/metrics.test.mjs imports SELECT and
// rowsFromWranglerJson without triggering this.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
