// Hourly Open-Meteo series -> per-slot conditions and the 7-day grid.
// Shared by the ranking and weekly views; pure so it runs under node --test.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./scoring.js"));
  else root.Forecast = factory(root.Scoring);
})(typeof self !== "undefined" ? self : this, function (Scoring) {
  // Hours are [start, end): morning covers 07:00, 08:00 and 09:00.
  const TIME_SLOTS = { morning: [7, 10], afternoon: [12, 15], evening: [16, 19] };
  const SLOT_ORDER = ["morning", "afternoon", "evening"];
  const JST_OFFSET_MS = 9 * 60 * 60 * 1000; // Japan has no daylight saving time

  // Per-key mean over the slot's hours on `date`; null when no sample falls
  // in the window at all.
  function averageForWindow(hourly, slot, date) {
    const [startH, endH] = TIME_SLOTS[slot];
    const times = hourly.time;
    const idx = [];
    for (let i = 0; i < times.length; i++) {
      const h = parseInt(times[i].slice(11, 13), 10);
      if (times[i].startsWith(date) && h >= startH && h < endH) idx.push(i);
    }
    if (idx.length === 0) return null;
    const result = {};
    for (const key of Object.keys(hourly)) {
      if (key === "time") continue;
      const vals = idx.map((i) => hourly[key][i]).filter((v) => v !== null && v !== undefined);
      result[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return result;
  }

  function pick(primary, fallback) {
    return primary !== null && primary !== undefined ? primary : fallback;
  }

  // Scoring inputs for one slot. Swell components fall back to the combined
  // wave when the model has no swell partition.
  function slotConditions(marine, forecast, slot, date) {
    const m = averageForWindow(marine, slot, date);
    const f = averageForWindow(forecast, slot, date);
    if (!m || !f) return null;
    const data = {
      wind_dir: f.winddirection_10m,
      wind_speed: f.windspeed_10m,
      swell_dir: pick(m.swell_wave_direction, m.wave_direction),
      swell_period: pick(m.swell_wave_period, m.wave_period),
      wave_height: pick(m.swell_wave_height, m.wave_height),
    };
    return Object.values(data).some((v) => v == null) ? null : data;
  }

  // scorer(data) returns the cell { data, scores }; the app passes one that
  // applies feedback calibration. maxWaveHeight follows the returned data.
  function weeklyForecast(marine, forecast, dates, bearing, scorer) {
    const score = scorer || ((data) => ({ data, scores: Scoring.scoreSpot(data, bearing) }));
    return dates.map((date) => {
      const slots = {};
      const heights = [];
      for (const slot of SLOT_ORDER) {
        const data = slotConditions(marine, forecast, slot, date);
        slots[slot] = data ? score(data) : null;
        if (slots[slot]) heights.push(slots[slot].data.wave_height);
      }
      return {
        date,
        slots,
        maxWaveHeight: heights.length ? Math.max(...heights) : null,
        tide: Scoring.tideEvents(marine.time, marine.sea_level_height_msl || [], date),
      };
    });
  }

  // Highest total; strict ">" keeps the first cell in date then slot order on ties.
  function bestSlot(days) {
    let best = null;
    for (const day of days) {
      for (const slot of SLOT_ORDER) {
        const cell = day.slots[slot];
        if (cell && (!best || cell.scores.total > best.total)) {
          best = { date: day.date, slot, total: cell.scores.total };
        }
      }
    }
    return best;
  }

  // The slot to check when the page opens: the first one today (Japan time)
  // that has not ended yet, or tomorrow morning once the evening is over.
  function upcomingSlot(now) {
    const jst = new Date(now.getTime() + JST_OFFSET_MS);
    const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();
    const slot = SLOT_ORDER.find((s) => minutes < TIME_SLOTS[s][1] * 60);
    if (!slot) jst.setUTCDate(jst.getUTCDate() + 1);
    return { date: jst.toISOString().slice(0, 10), slot: slot || SLOT_ORDER[0] };
  }

  function scoreBand(total) {
    if (total >= 50) return "good";
    if (total >= 30) return "ok";
    return "bad";
  }

  return {
    TIME_SLOTS, SLOT_ORDER, averageForWindow, slotConditions,
    weeklyForecast, bestSlot, upcomingSlot, scoreBand,
  };
});
