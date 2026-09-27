// Browser-only feedback panel: the <dialog>, photo resizing and the POST.
// Everything it needs comes in through open(); it reads no app.js globals.
// The rules (defaults, validation, EXIF) live in feedback.js, which is tested.
(function (root) {
  const { Feedback, Calibration, Forecast, Share } = root;
  const escapeHtml = Share.escapeHtml;

  const STORAGE = { device: "surfcheck.device_id", name: "surfcheck.name", sent: "surfcheck.sent" };
  const MAX_SIDE = 1600;
  const MAX_PHOTO_BYTES = 1572864;
  const QUALITIES = [0.8, 0.6];
  const CLOSE_AFTER_MS = 1200;
  const RATINGS = ["ダメ", "イマイチ", "ふつう", "良い", "最高"];
  const MESSAGES = {
    loading: "予報を読み込んでいます…",
    forecastFailed: "予報を取得できませんでした",
    photoFailed: "写真を読み込めませんでした",
    photoTooBig: "写真が大きすぎます",
    rejectedPhoto: "写真を送れませんでした（大きさ・形式）",
    limited: "今日はこれ以上送れません",
    tooFast: "短い間に送りすぎです。1分ほど待ってから送ってください",
    failed: "送れませんでした。もう一度送ってください",
    sending: "送っています…",
    sent: "送りました",
    sentWithoutPhoto: "送りました。写真は今は受け付けていないため、記録だけ保存しました",
  };
  const FIELDS = {
    rating: RATINGS.map((label, i) => [String(i + 1), `${i + 1} ${label}`]),
    wave_band: Calibration.WAVE_BANDS.map((band, i) => [String(i), band.label]),
    wind_side: Object.entries(Calibration.WIND_SIDES),
    wind_strength: Object.entries(Calibration.WIND_STRENGTHS).map(([key, s]) => [key, s.label]),
  };
  const NUMERIC_FIELDS = ["rating", "wave_band"];

  // localStorage can throw (private mode, blocked storage); the panel still
  // works without it, it just forgets between visits.
  function load(key) {
    try { return root.localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { root.localStorage.setItem(key, value); } catch (e) { /* not persisted */ }
  }

  let sessionDeviceId = null;
  function deviceId() {
    const stored = load(STORAGE.device);
    if (stored) return stored;
    sessionDeviceId = sessionDeviceId || root.crypto.randomUUID();
    save(STORAGE.device, sessionDeviceId);
    return sessionDeviceId;
  }

  function sentList() {
    try {
      const list = JSON.parse(load(STORAGE.sent) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }
  const sentKey = (spotName, date, slot) => `${spotName}|${date}|${slot}`;
  function hasSent(spotName, date, slot) {
    return sentList().includes(sentKey(spotName, date, slot));
  }
  function markSent(spotName, date, slot) {
    const list = sentList();
    const key = sentKey(spotName, date, slot);
    if (!list.includes(key)) save(STORAGE.sent, JSON.stringify([...list, key]));
  }

  function decodeImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("decode")); };
      img.src = url;
    });
  }

  function encodeJpeg(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  }

  // Longest side MAX_SIDE, JPEG at 0.8 then 0.6; null when both stay over
  // MAX_PHOTO_BYTES. Re-encoding through a canvas drops all EXIF, GPS included.
  async function resizePhoto(file) {
    const img = await decodeImage(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITIES) {
      const blob = await encodeJpeg(canvas, quality);
      if (!blob) throw new Error("encode");
      if (blob.size <= MAX_PHOTO_BYTES) return blob;
    }
    return null;
  }

  async function readJson(res) {
    try { return await res.json(); } catch (e) { return null; }
  }

  async function failureMessage(res) {
    if (!res || res.status >= 500) return MESSAGES.failed;
    if (res.status === 413 || res.status === 415) return MESSAGES.rejectedPhoto;
    const body = await readJson(res);
    if (res.status === 429) {
      const perMinute = body && typeof body.limit === "string" && body.limit.endsWith("_minute");
      return perMinute ? MESSAGES.tooFast : MESSAGES.limited;
    }
    if (res.status === 400 && body && typeof body.error === "string") return body.error;
    return MESSAGES.failed;
  }

  function choiceRow(label, field) {
    const buttons = FIELDS[field].map(([value, text]) =>
      `<button type="button" class="fb-choice" data-field="${field}" data-value="${escapeHtml(value)}" aria-pressed="false">${escapeHtml(text)}</button>`).join("");
    return `<div class="fb-row"><span class="fb-label">${label}</span><div class="fb-choices" role="group" aria-label="${label}">${buttons}</div></div>`;
  }

  function panelHtml(showName) {
    const slots = Forecast.SLOT_ORDER.map((slot) =>
      `<button type="button" class="fb-choice" data-slot="${slot}" aria-pressed="false">${Share.SLOT_SHORT[slot]}</button>`).join("");
    const nameRow = showName
      ? `<div class="fb-row"><label class="fb-label" for="fb-name">名前</label><input id="fb-name" class="fb-name" maxlength="20" autocomplete="nickname" placeholder="任意"></div>`
      : "";
    return `<div class="fb-form">
      <div class="fb-head">
        <b class="fb-title"></b>
        <button type="button" class="fb-close" aria-label="閉じる">×</button>
      </div>
      <div class="fb-when">
        <input type="date" class="fb-date" aria-label="日付" required>
        <div class="fb-choices" role="group" aria-label="時間帯">${slots}</div>
      </div>
      <p class="fb-suggest" hidden><span class="fb-suggest-text"></span><button type="button" class="fb-switch"></button></p>
      ${choiceRow("総合", "rating")}
      ${choiceRow("波", "wave_band")}
      ${choiceRow("風向き", "wind_side")}
      ${choiceRow("風の強さ", "wind_strength")}
      <div class="fb-row"><span class="fb-label">写真</span><div class="fb-photo">
        <label class="fb-photo-add">写真を追加<input type="file" accept="image/*" class="fb-file"></label>
        <span class="fb-preview" hidden><img alt="選んだ写真"><button type="button" class="fb-photo-remove">取り消す</button></span>
        <span class="fb-hint">任意</span>
      </div></div>
      ${nameRow}
      <p class="fb-status" role="status" aria-live="polite"></p>
      <button type="button" class="fb-send" disabled>送る</button>
    </div>`;
  }

  let dialog = null;
  let current = null;

  // The dialog is shared across every card's panel, and its native "close" event is a
  // queued task: open() can reassign things and show a new panel before that event for
  // the OLD panel fires. So a panel's own retirement can't wait on that event; open()
  // retires the outgoing panel synchronously instead.
  function retire(state) {
    if (!state || state.closed) return;
    state.closed = true;
    clearTimeout(state.closeTimer);
    state.loadSeq += 1;
    if (state.photo) URL.revokeObjectURL(state.photo.url);
  }

  // opts: { api, spot, spots, card: { date, slot, rawData }, calibration,
  //         fetchConditions(spot, date, slot) -> Promise<rawData>, onSent() }
  function open(opts) {
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.className = "fb-panel";
      document.body.appendChild(dialog);
      // A close event that arrives while the dialog is open again belongs to the
      // previous panel, which has already been retired synchronously below.
      dialog.addEventListener("close", () => {
        if (!dialog.open) retire(current);
      });
    }
    retire(current);
    dialog.innerHTML = panelHtml(sentList().length === 0);
    const $ = (sel) => dialog.querySelector(sel);
    const initial = Feedback.defaultSession(opts.card, new Date());
    const state = {
      spot: opts.spot,
      date: initial.date,
      slot: initial.slot,
      rawData: null,
      observed: { rating: null, wave_band: null, wind_side: null, wind_strength: null },
      photo: null,
      suggestion: null,
      sessionTouched: false,
      loadSeq: 0,
      sending: false,
      done: false,
      closed: false,
      closeTimer: null,
    };
    current = state;

    function setStatus(text, tone) {
      const el = $(".fb-status");
      el.textContent = text || "";
      el.dataset.tone = tone || "";
    }

    function syncSession() {
      const now = new Date();
      const { min, max } = Feedback.dateRange(now);
      $(".fb-title").textContent = `${state.spot.name}  ${Share.mdLabel(state.date)}`;
      const dateEl = $(".fb-date");
      dateEl.min = min;
      dateEl.max = max;
      dateEl.value = state.date;
      dialog.querySelectorAll("[data-slot]").forEach((btn) => {
        btn.disabled = !Feedback.slotStarted(state.date, btn.dataset.slot, now);
        btn.setAttribute("aria-pressed", String(btn.dataset.slot === state.slot));
      });
    }

    function syncChoices() {
      dialog.querySelectorAll("[data-field]").forEach((btn) => {
        const field = btn.dataset.field;
        btn.setAttribute("aria-pressed", String(String(state.observed[field]) === btn.dataset.value));
        btn.disabled = field !== "rating" && !state.rawData;
      });
      $(".fb-send").disabled = state.sending || state.done || !state.rawData || state.observed.rating === null;
    }

    function syncPhoto() {
      const preview = $(".fb-preview");
      preview.hidden = !state.photo;
      $(".fb-photo-add").hidden = Boolean(state.photo);
      if (state.photo) preview.querySelector("img").src = state.photo.url;
      const row = $(".fb-suggest");
      row.hidden = !state.suggestion;
      if (state.suggestion) {
        const { spot, km } = state.suggestion;
        $(".fb-suggest-text").textContent = `写真は ${spot.name} 付近（約 ${km.toFixed(1)}km）で撮られています`;
        $(".fb-switch").textContent = `${spot.name}に変える`;
      }
    }

    async function loadForecast() {
      const seq = ++state.loadSeq;
      state.rawData = null;
      Object.assign(state.observed, { wave_band: null, wind_side: null, wind_strength: null });
      syncSession();
      syncChoices();
      const card = opts.card;
      let raw = null;
      if (card.rawData && state.spot === opts.spot && state.date === card.date && state.slot === card.slot) {
        raw = card.rawData;
      } else {
        setStatus(MESSAGES.loading);
        try {
          raw = await opts.fetchConditions(state.spot, state.date, state.slot);
        } catch (e) {
          raw = null;
        }
        if (seq !== state.loadSeq) return; // a newer date, slot or spot took over
      }
      if (!raw) {
        setStatus(MESSAGES.forecastFailed, "error");
        syncChoices();
        return;
      }
      state.rawData = raw;
      // Defaults come from what the card showed (calibrated); the record keeps raw.
      const shown = Calibration.adjust(raw, state.spot.name, opts.calibration);
      Object.assign(state.observed, Feedback.initialObserved(shown, state.spot.bearing));
      if ($(".fb-status").textContent === MESSAGES.loading) setStatus("");
      syncChoices();
    }

    function changeSession(date, slot, byHand) {
      if (byHand) state.sessionTouched = true;
      const next = Feedback.defaultSession({ date, slot }, new Date());
      if (next.date === state.date && next.slot === state.slot) {
        syncSession();
        return;
      }
      state.date = next.date;
      state.slot = next.slot;
      loadForecast();
    }

    function clearPhoto() {
      if (state.photo) URL.revokeObjectURL(state.photo.url);
      state.photo = null;
      state.suggestion = null;
      $(".fb-file").value = "";
      syncPhoto();
    }

    async function onPhoto(file) {
      clearPhoto();
      if (!file) return;
      if ($(".fb-status").dataset.tone === "error") setStatus("");
      let meta = null;
      try {
        meta = Feedback.readExif(await file.arrayBuffer());
      } catch (e) {
        meta = null;
      }
      let blob;
      try {
        blob = await resizePhoto(file);
      } catch (e) {
        // the panel was closed (maybe reopened for another card) while resizing: leave the screen alone
        if (state.closed) return;
        setStatus(MESSAGES.photoFailed, "error");
        return;
      }
      // the panel was closed (maybe reopened for another card) while resizing: leave the screen alone
      if (state.closed) return;
      if (!blob) {
        setStatus(MESSAGES.photoTooBig, "error");
        return;
      }
      state.photo = { blob, url: URL.createObjectURL(blob), meta };
      state.suggestion = Feedback.suggestSpot(meta, state.spot, opts.spots);
      syncPhoto();
      if (meta && meta.taken_at && !state.sessionTouched) {
        const session = Feedback.sessionFromPhoto(meta.taken_at, new Date());
        if (session) changeSession(session.date, session.slot, false);
      }
    }

    function switchSpot() {
      if (!state.suggestion) return;
      state.spot = state.suggestion.spot;
      state.suggestion = null;
      syncPhoto();
      loadForecast();
    }

    async function send() {
      if (state.sending || state.done || !state.rawData || state.observed.rating === null) return;
      const nameEl = $(".fb-name");
      const record = Feedback.buildRecord({
        deviceId: deviceId(),
        name: nameEl ? nameEl.value : load(STORAGE.name) || "",
        spot: state.spot,
        date: state.date,
        slot: state.slot,
        rawData: state.rawData,
        observed: state.observed,
        photoMeta: state.photo ? state.photo.meta : null,
      });
      const errors = Feedback.validateRecord(record, new Date());
      if (errors.length) {
        setStatus(errors.join(" / "), "error");
        return;
      }
      const body = new FormData();
      body.append("record", JSON.stringify(record));
      if (state.photo) body.append("photo", state.photo.blob, "photo.jpg");
      state.sending = true;
      syncChoices();
      setStatus(MESSAGES.sending);
      let res = null;
      try {
        res = await fetch(`${opts.api}/feedback`, { method: "POST", body });
      } catch (e) {
        res = null;
      }
      state.sending = false;
      if (res && res.ok) {
        // The Worker keeps the record but may skip the photo (limits, kill switch).
        const photoSkipped = Boolean((await readJson(res) || {}).photo_skipped);
        state.done = true;
        markSent(record.spot, record.date, record.slot);
        if (nameEl) save(STORAGE.name, record.name);
        if (opts.onSent) opts.onSent();
        // the panel was closed (maybe reopened for another card) while sending: keep the
        // record's bookkeeping, leave the screen alone
        if (state.closed) return;
        setStatus(photoSkipped ? MESSAGES.sentWithoutPhoto : MESSAGES.sent, "ok");
        syncChoices();
        // Leave that note up until the user closes the panel.
        if (!photoSkipped) state.closeTimer = setTimeout(() => dialog.close(), CLOSE_AFTER_MS);
        return;
      }
      const message = await failureMessage(res);
      // the panel was closed (maybe reopened for another card) while sending: leave the screen alone
      if (state.closed) return;
      setStatus(message, "error");
      syncChoices();
    }

    // Handlers are assigned (not added) so each open replaces the last one's.
    dialog.onclick = (e) => {
      const btn = e.target.closest("button");
      if (!btn || btn.disabled) return;
      if (btn.classList.contains("fb-close")) dialog.close();
      else if (btn.dataset.slot) changeSession(state.date, btn.dataset.slot, true);
      else if (btn.dataset.field) {
        const field = btn.dataset.field;
        state.observed[field] = NUMERIC_FIELDS.includes(field) ? Number(btn.dataset.value) : btn.dataset.value;
        syncChoices();
      } else if (btn.classList.contains("fb-photo-remove")) clearPhoto();
      else if (btn.classList.contains("fb-switch")) switchSpot();
      else if (btn.classList.contains("fb-send")) send();
    };
    dialog.onchange = (e) => {
      if (e.target.classList.contains("fb-date")) {
        if (e.target.value) changeSession(e.target.value, state.slot, true);
        else syncSession();
      } else if (e.target.classList.contains("fb-file")) {
        onPhoto(e.target.files[0]);
      }
    };
    syncPhoto();
    loadForecast();
    dialog.showModal();
  }

  root.FeedbackPanel = { open, hasSent };
})(self);
