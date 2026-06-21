(() => {
  const STORAGE_DEFAULTS = {
    predictionSound: true,
    predictionCountdown: true,
    autoClaim: true
  };
  let opts = { ...STORAGE_DEFAULTS };

  const ALERT_SOUND_PATH = "sounds/alert.mp3";
  const COUNTDOWN_SOUND_PATH = "sounds/countdown.mp3";
  // Flip to false to silence the console diagnostics.
  const DEBUG = true;
  const PREDICTION_ALERT_COOLDOWN_MS = 10_000;
  const PREDICTION_MISSING_RESET_MS = 2 * 60_000;
  const PREDICTION_SCAN_INTERVAL_MS = 1_000;
  // Drive the countdown from a local wall-clock and re-check it 4x a second so
  // every whole-second value (10..1) plays even when the on-screen timer is not
  // currently readable (e.g. the prediction card is collapsed).
  const COUNTDOWN_TICK_INTERVAL_MS = 250;
  // Cap how often we re-search the whole page for the timer element when it
  // isn't already cached, so a chatty page doesn't trigger constant lookups.
  const COUNTDOWN_LOCATE_INTERVAL_MS = 1_000;
  // If no prediction signal (timer text or progress bar) is seen for this long,
  // the card vanished mid-life — a mod canceled the prediction — so stop ticking.
  const COUNTDOWN_CANCEL_GRACE_MS = 1_500;
  // Minimum spacing between progress-bar samples used to estimate the remaining
  // time from the bar's rate of movement when no timer text is available.
  const COUNTDOWN_BAR_MIN_SPAN_MS = 750;
  // The purple submission-progress bar. Present even when the card is collapsed,
  // so it doubles as a "prediction still exists" signal.
  const COUNTDOWN_BAR_XPATH =
    '//*[@id="live-page-chat"]/div/div/div[2]/div/div[2]/section/div/div[3]' +
    "/div[1]/div/div[2]/div/div/div[1]/div/div/div/div/div/div/div[2]";
  const COUNTDOWN_THRESHOLD_SECONDS = 10;
  const BONUS_CLAIM_COOLDOWN_MS = 4_000;
  const BONUS_DELAY_MIN_SECONDS = 5;
  const BONUS_DELAY_MAX_SECONDS = 30;
  const KEYWORDS = [
    "new prediction",
    "prediction started",
    "predict now",
    "make your prediction",
    "choose your outcome"
  ];

  let lastBonusClaimAt = 0;
  let pendingBonusClaimTimeout = null;
  let lastPredictionAlertAt = 0;
  let activePredictionKey = null;
  let activePredictionMissingSince = 0;
  let alertedThisRun = false;
  let lastSeenAlertableKey = null;
  let countdownElement = null;
  let lastCountdownLocateAt = 0;
  let lastDebugSecond = null;
  // Local countdown clock + presence tracking. Once we learn how many seconds
  // remain (from text, the region scan, or the progress bar) we anchor a
  // deadline and tick against the wall clock, so audio keeps firing without the
  // timer staying visible.
  let countdownDeadlineAt = 0;
  let countdownPlayedSecond = Infinity;
  let countdownSessionActive = false;
  let countdownAbsentSince = 0;
  let countdownBarElement = null;
  let lastBarLocateAt = 0;
  let countdownBarSampleOld = null;
  let countdownBarSampleNew = null;
  let pendingScan = false;

  function dbg(...args) {
    if (DEBUG) {
      // console.log (not console.debug) so it shows at the default log level.
      console.log("[PredictionAlerts]", ...args);
    }
  }

  function normalizeText(text) {
    return text.replace(/\s+/g, " ").trim().toLowerCase();
  }

  function tryPlayFallbackBeep() {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      osc.stop(ctx.currentTime + 0.36);
      osc.onended = () => ctx.close().catch(() => {});
    } catch (_) {}
  }

  function applyStorage(items) {
    opts.predictionSound = items.predictionSound !== false;
    opts.predictionCountdown = items.predictionCountdown !== false;
    opts.autoClaim = items.autoClaim !== false;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.predictionSound) {
      opts.predictionSound = changes.predictionSound.newValue !== false;
    }
    if (changes.predictionCountdown) {
      opts.predictionCountdown = changes.predictionCountdown.newValue !== false;
    }
    if (changes.autoClaim) {
      opts.autoClaim = changes.autoClaim.newValue !== false;
      if (!opts.autoClaim && pendingBonusClaimTimeout !== null) {
        window.clearTimeout(pendingBonusClaimTimeout);
        pendingBonusClaimTimeout = null;
      }
    }
  });

  async function playSound(path, volume, useFallbackBeep = false) {
    const src = chrome.runtime.getURL(path);
    const audio = new Audio(src);
    audio.volume = volume;
    audio.preload = "auto";

    try {
      await audio.play();
    } catch (_) {
      if (useFallbackBeep) {
        tryPlayFallbackBeep();
      }
    }
  }

  async function playAlertSound() {
    if (!opts.predictionSound) {
      return;
    }
    await playSound(ALERT_SOUND_PATH, 1, true);
  }

  async function playCountdownSound() {
    if (!opts.predictionCountdown) {
      return;
    }
    await playSound(COUNTDOWN_SOUND_PATH, 0.5);
  }

  function isPredictionText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }
    return KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  function isPredictionCountdownText(text) {
    return normalizeText(text).includes("submissions closing in");
  }

  // Recognizes a prediction card that is still on screen but no longer taking
  // submissions (locked / closed / awaiting result). This keeps the current
  // prediction "session" alive through the close transition so we don't treat
  // the post-close text as a brand-new prediction and alert again.
  function isPredictionPresenceText(text) {
    const normalized = normalizeText(text);
    return (
      normalized.includes("submissions closing in") ||
      normalized.includes("submissions closed") ||
      normalized.includes("submissions locked")
    );
  }

  function getChannelKey() {
    const pathParts = location.pathname.split("/").filter(Boolean);
    if (pathParts[0] === "popout" && pathParts[1]) {
      return pathParts[1].toLowerCase();
    }
    return (pathParts[0] || "unknown").toLowerCase();
  }

  function normalizePredictionIdentityText(text) {
    return normalizeText(text)
      .replace(/\bsubmissions?\s+closing\s+in\s+(?:(?:\d+:)?\d{1,2}:\d{2}|\d+\s*(?:seconds?|secs?|s|minutes?|mins?|m))\b/g, " ")
      .replace(/\bsubmissions?\s+(?:closed|open|locked)\b/g, " ")
      .replace(/\bprediction\s+(?:started|ended|closed|locked)\b/g, " ")
      .replace(/\b(?:new prediction|predict now|make your prediction|choose your outcome)\b/g, " ")
      .replace(/\b\d+(?:\.\d+)?\s*%/g, " ")
      .replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:k|m)?\s*(?:channel\s+points?|points?|pts?)\b/g, " ")
      .replace(/\b(?:total|voters?|votes?|users?|viewers?)\s*:?\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m)?\b/g, " ")
      .replace(/[|*]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

  function buildPredictionKey(text, pathHint, allowFallback) {
    const identityText = normalizePredictionIdentityText(text);
    if (identityText.length >= 8) {
      return `${getChannelKey()}|${identityText}`;
    }

    if (!allowFallback) {
      return null;
    }

    const fallbackText = normalizeText(text)
      .replace(/\bsubmissions?\s+closing\s+in\s+(?:(?:\d+:)?\d{1,2}:\d{2}|\d+\s*(?:seconds?|secs?|s|minutes?|mins?|m))\b/g, " ")
      .replace(/\bsubmissions?\s+(?:closed|open|locked)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120);
    if (fallbackText.length < 8) {
      return null;
    }
    return `${getChannelKey()}|${pathHint}|${fallbackText}`;
  }

  function parsePredictionRemainingSeconds(text) {
    const normalized = normalizeText(text);
    const closingIndex = normalized.indexOf("submissions closing in");
    if (closingIndex === -1) {
      return null;
    }

    const closingText = normalized.slice(closingIndex, closingIndex + 100);
    const timeMatch = closingText.match(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/);
    if (timeMatch) {
      if (timeMatch[3]) {
        return Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
      }
      return Number(timeMatch[1]) * 60 + Number(timeMatch[2]);
    }

    const secondsMatch = closingText.match(/\b(\d+)\s*(?:seconds?|secs?|s)\b/);
    if (secondsMatch) {
      return Number(secondsMatch[1]);
    }

    const minutesMatch = closingText.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/);
    if (minutesMatch) {
      return Number(minutesMatch[1]) * 60;
    }

    return null;
  }

  function makePredictionFromText(text, pathHint = "unknown") {
    const alertable = isPredictionText(text);
    const remainingSeconds = parsePredictionRemainingSeconds(text);
    const hasCountdown = isPredictionCountdownText(text) && Number.isFinite(remainingSeconds);
    const isPresent = isPredictionPresenceText(text);
    if (!alertable && !hasCountdown && !isPresent) {
      return null;
    }

    let key = buildPredictionKey(text, pathHint, alertable);
    if (!key && (hasCountdown || isPresent)) {
      // The bare timer text ("Submissions closing in 0:09") has no title to
      // build an identity from, so reuse the active prediction's key. Fall back
      // to a channel-scoped key when there is no active key (e.g. a long
      // prediction whose key already aged out) so the countdown can still fire.
      key = activePredictionKey || `${getChannelKey()}|active-prediction`;
    }
    if (!key) {
      return null;
    }

    return {
      key,
      alertable,
      remainingSeconds,
      sample: DEBUG ? normalizeText(text).slice(0, 160) : null
    };
  }

  // Any reading of how many seconds remain (from the region scan or the timer
  // text) just anchors the local clock. The actual per-second playback happens
  // in tickCountdown so it survives the timer becoming unreadable.
  function handlePredictionCountdown(prediction) {
    if (!opts.predictionCountdown) {
      return;
    }
    anchorCountdownSeconds(prediction.remainingSeconds, Date.now());
  }

  function anchorCountdownSeconds(seconds, now) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return;
    }
    countdownDeadlineAt = now + seconds * 1000;
  }

  function notePredictionSeen(prediction) {
    const now = Date.now();
    cleanupPredictionState(now);

    if (activePredictionKey !== prediction.key) {
      activePredictionKey = prediction.key;
    }
    activePredictionMissingSince = 0;

    handlePredictionCountdown(prediction);

    if (!prediction.alertable) {
      return false;
    }

    if (prediction.key !== lastSeenAlertableKey) {
      lastSeenAlertableKey = prediction.key;
      dbg("alertable seen | alertedThisRun:", alertedThisRun, "| key:", prediction.key, "| text:", prediction.sample);
    }

    // Alert once per prediction "presence run". The run stays alive for the
    // whole prediction because the closing-timer is on screen the entire time
    // (tracked by the countdown subsystem), and only re-arms once the card is
    // gone (resetCountdownTracking). This is immune to the prediction card's
    // identity text churning as votes come in — which is what was causing the
    // alert to re-fire every cooldown window.
    const canPlayAlert =
      !alertedThisRun && now - lastPredictionAlertAt >= PREDICTION_ALERT_COOLDOWN_MS;

    if (canPlayAlert) {
      alertedThisRun = true;
      lastPredictionAlertAt = now;
      dbg("ALERT fired:", prediction.key);
    }

    return canPlayAlert;
  }

  function cleanupPredictionState(now) {
    if (
      activePredictionKey &&
      activePredictionMissingSince &&
      now - activePredictionMissingSince > PREDICTION_MISSING_RESET_MS
    ) {
      activePredictionKey = null;
      activePredictionMissingSince = 0;
    }
  }

  function handleMissingPrediction(now) {
    if (activePredictionKey && !activePredictionMissingSince) {
      activePredictionMissingSince = now;
    }
    cleanupPredictionState(now);
  }

  function inspectPredictionText(text, pathHint = "unknown") {
    const prediction = makePredictionFromText(text, pathHint);
    if (!prediction) {
      return { seen: false, shouldAlert: false };
    }
    return { seen: true, shouldAlert: notePredictionSeen(prediction) };
  }

  function shouldAlertForText(text, pathHint = "unknown") {
    return inspectPredictionText(text, pathHint).shouldAlert;
  }

  function checkNodeAndChildren(rootNode) {
    if (!(rootNode instanceof Element)) {
      return false;
    }

    const directText = rootNode.textContent || "";
    if (shouldAlertForText(directText, rootNode.tagName.toLowerCase())) {
      return true;
    }

    const regions = rootNode.querySelectorAll("[role='dialog'], [aria-live], section, article");
    for (const region of regions) {
      if (shouldAlertForText(region.textContent || "", region.getAttribute("role") || region.tagName.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  // Locates the prediction's closing-timer text anywhere on the page. The
  // region scan only looks inside dialog/aria-live/section/article wrappers,
  // which can miss the prediction card; this searches by the timer's own text
  // so the per-second countdown is read no matter where the card lives.
  function findCountdownText() {
    if (countdownElement && countdownElement.isConnected) {
      const cachedText = countdownElement.textContent || "";
      if (isPredictionCountdownText(cachedText)) {
        return cachedText;
      }
    }
    countdownElement = null;

    const now = Date.now();
    if (now - lastCountdownLocateAt < COUNTDOWN_LOCATE_INTERVAL_MS) {
      return null;
    }
    lastCountdownLocateAt = now;

    let bestNode = null;
    try {
      const xpath =
        "//*[contains(translate(normalize-space(.)," +
        " 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')," +
        " 'submissions closing in')]";
      const snapshot = document.evaluate(
        xpath,
        document.body || document.documentElement,
        null,
        XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );
      // Every ancestor up to <body> matches; keep the most specific (shortest
      // text) one so parsing sees a tight timer string.
      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const candidate = snapshot.snapshotItem(i);
        if (!(candidate instanceof Element)) {
          continue;
        }
        const candidateLength = (candidate.textContent || "").length;
        if (!bestNode || candidateLength < (bestNode.textContent || "").length) {
          bestNode = candidate;
        }
      }
    } catch (_) {
      return null;
    }

    if (!bestNode) {
      return null;
    }
    countdownElement = bestNode;
    return bestNode.textContent || "";
  }

  function clamp01(value) {
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  // The purple progress bar exists even when the prediction card is collapsed,
  // so it is both a presence signal and a text-free way to read the timer.
  function getProgressBarElement() {
    if (countdownBarElement && countdownBarElement.isConnected) {
      return countdownBarElement;
    }
    countdownBarElement = null;
    const now = Date.now();
    if (now - lastBarLocateAt < COUNTDOWN_LOCATE_INTERVAL_MS) {
      return null;
    }
    lastBarLocateAt = now;
    try {
      const result = document.evaluate(
        COUNTDOWN_BAR_XPATH,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      );
      if (result.singleNodeValue instanceof Element) {
        countdownBarElement = result.singleNodeValue;
      }
    } catch (_) {}
    return countdownBarElement;
  }

  // Reads the bar's fill as a 0..1 fraction, trying the encodings Twitch is
  // likely to use (ARIA value, inline width/transform, then raw geometry).
  function readBarFraction(element) {
    if (!(element instanceof Element)) {
      return null;
    }

    const valueNow = element.getAttribute("aria-valuenow");
    const valueMax = element.getAttribute("aria-valuemax");
    if (valueNow !== null && valueMax !== null) {
      const now = Number(valueNow);
      const min = Number(element.getAttribute("aria-valuemin") || 0);
      const max = Number(valueMax);
      if (Number.isFinite(now) && Number.isFinite(max) && max > min) {
        return clamp01((now - min) / (max - min));
      }
    }

    const width = element.style && element.style.width;
    if (width && width.endsWith("%")) {
      const pct = Number(width.slice(0, -1));
      if (Number.isFinite(pct)) {
        return clamp01(pct / 100);
      }
    }

    const transform = element.style && element.style.transform;
    if (transform) {
      const scale = transform.match(/scaleX\(([\d.]+)\)/);
      if (scale) {
        const value = Number(scale[1]);
        if (Number.isFinite(value)) {
          return clamp01(value);
        }
      }
    }

    const parent = element.parentElement;
    if (parent) {
      const elementWidth = element.getBoundingClientRect().width;
      const parentWidth = parent.getBoundingClientRect().width;
      if (parentWidth > 0) {
        return clamp01(elementWidth / parentWidth);
      }
    }

    return null;
  }

  function updateBarSamples(fraction, now) {
    const sample = { fraction, at: now };
    if (!countdownBarSampleNew) {
      countdownBarSampleOld = sample;
      countdownBarSampleNew = sample;
      return;
    }
    if (now - countdownBarSampleNew.at >= COUNTDOWN_BAR_MIN_SPAN_MS) {
      countdownBarSampleOld = countdownBarSampleNew;
    }
    countdownBarSampleNew = sample;
  }

  // Estimates seconds remaining purely from how fast the bar is moving, so the
  // countdown still works when the timer text is never rendered. Extrapolates
  // the bar's linear motion to the point it empties (or fills).
  function estimateBarRemainingSeconds() {
    const older = countdownBarSampleOld;
    const newer = countdownBarSampleNew;
    if (!older || !newer) {
      return null;
    }
    const spanSeconds = (newer.at - older.at) / 1000;
    if (spanSeconds < COUNTDOWN_BAR_MIN_SPAN_MS / 1000) {
      return null;
    }
    const delta = older.fraction - newer.fraction;
    const slope = Math.abs(delta) / spanSeconds;
    if (slope < 0.0005) {
      return null;
    }
    const remaining = delta > 0 ? newer.fraction / slope : (1 - newer.fraction) / slope;
    if (!Number.isFinite(remaining) || remaining < 0 || remaining > 600) {
      return null;
    }
    return remaining;
  }

  function resetCountdownTracking() {
    if (countdownSessionActive) {
      dbg("prediction gone (resolved or canceled) — alert re-armed");
    }
    countdownSessionActive = false;
    countdownAbsentSince = 0;
    countdownDeadlineAt = 0;
    countdownPlayedSecond = Infinity;
    countdownBarElement = null;
    countdownBarSampleOld = null;
    countdownBarSampleNew = null;
    lastDebugSecond = null;
    // The prediction card is gone, so the next one is allowed to alert again.
    alertedThisRun = false;
  }

  function maybePlayCountdownSecond(second) {
    if (
      second >= 1 &&
      second <= COUNTDOWN_THRESHOLD_SECONDS &&
      second < countdownPlayedSecond
    ) {
      countdownPlayedSecond = second;
      dbg("PLAY countdown sound:", second);
      void playCountdownSound();
    }
  }

  // Runs whenever alerts or the countdown are enabled: it tracks prediction
  // presence (which arms/re-arms the once-per-run alert) and plays the per-second
  // countdown. Countdown playback is gated separately inside playCountdownSound.
  function tickCountdown() {
    const now = Date.now();

    const text = findCountdownText();
    const textSeconds = text ? parsePredictionRemainingSeconds(text) : null;
    const hasTextSeconds = Number.isFinite(textSeconds);

    const barElement = getProgressBarElement();
    const barFraction = barElement ? readBarFraction(barElement) : null;
    if (barFraction !== null) {
      updateBarSamples(barFraction, now);
    }

    const present = hasTextSeconds || barElement !== null;

    if (!present) {
      if (countdownSessionActive) {
        if (!countdownAbsentSince) {
          countdownAbsentSince = now;
        } else if (now - countdownAbsentSince > COUNTDOWN_CANCEL_GRACE_MS) {
          // No timer text and no progress bar: the prediction card is gone
          // (resolved, or a mod canceled it). Stop so we don't keep ticking.
          resetCountdownTracking();
        }
      }
      return;
    }

    countdownAbsentSince = 0;
    if (!countdownSessionActive) {
      countdownSessionActive = true;
      countdownPlayedSecond = Infinity;
      countdownDeadlineAt = 0;
      countdownBarSampleOld = null;
      countdownBarSampleNew = null;
      lastDebugSecond = null;
      dbg("prediction present — countdown armed", {
        text: hasTextSeconds,
        bar: barElement !== null
      });
    }

    let displaySecond = null;
    let source = null;
    if (hasTextSeconds) {
      anchorCountdownSeconds(textSeconds, now);
      displaySecond = textSeconds;
      source = "text";
    } else if (countdownDeadlineAt) {
      displaySecond = Math.ceil((countdownDeadlineAt - now) / 1000);
      source = "clock";
    } else {
      const barSeconds = estimateBarRemainingSeconds();
      if (barSeconds !== null) {
        anchorCountdownSeconds(barSeconds, now);
        displaySecond = Math.ceil(barSeconds);
        source = "bar";
      }
    }

    if (displaySecond !== null && displaySecond !== lastDebugSecond) {
      lastDebugSecond = displaySecond;
      // Only log the final stretch each second, plus a 30s heartbeat earlier,
      // so long predictions don't flood the console.
      if (displaySecond <= 30 || displaySecond % 30 === 0) {
        dbg("remaining:", displaySecond, "via", source, "| barFraction:", barFraction);
      }
    }

    if (displaySecond !== null) {
      maybePlayCountdownSecond(displaySecond);
    }
  }

  function scanVisiblePredictionRegions() {
    const candidates = document.querySelectorAll(
      "[role='dialog'], [aria-live='polite'], [aria-live='assertive'], section, article"
    );
    let sawPrediction = false;

    for (const candidate of candidates) {
      const result = inspectPredictionText(
        candidate.textContent || "",
        candidate.getAttribute("role") || candidate.tagName.toLowerCase()
      );
      if (result.seen) {
        sawPrediction = true;
      }
      if (result.shouldAlert) {
        return true;
      }
    }

    if (!sawPrediction) {
      handleMissingPrediction(Date.now());
    }
    return false;
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function isClickableBonusButton(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const disabledByAttr =
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";
    return !disabledByAttr;
  }

  function findClaimBonusButton() {
    const buttonSelectors = [
      "button[aria-label='Claim Bonus']",
      "button[aria-label*='Claim Bonus']",
      "[data-test-selector='community-points-summary'] button[aria-label*='bonus' i]",
      "button .claimable-bonus__icon"
    ];

    for (const selector of buttonSelectors) {
      const node = document.querySelector(selector);
      if (!(node instanceof Element)) {
        continue;
      }
      const button = node.matches("button") ? node : node.closest("button");
      if (isClickableBonusButton(button)) {
        return button;
      }
    }

    const icon = document.querySelector(".claimable-bonus__icon");
    if (icon instanceof Element) {
      const parentButton = icon.closest("button");
      if (isClickableBonusButton(parentButton)) {
        return parentButton;
      }
    }

    return null;
  }

  function claimBonusChestIfAvailable() {
    if (!opts.autoClaim) {
      return false;
    }
    const now = Date.now();
    if (now - lastBonusClaimAt < BONUS_CLAIM_COOLDOWN_MS) {
      return false;
    }
    if (pendingBonusClaimTimeout !== null) {
      return false;
    }

    const button = findClaimBonusButton();
    if (!button) {
      return false;
    }

    const delaySeconds = randomInt(BONUS_DELAY_MIN_SECONDS, BONUS_DELAY_MAX_SECONDS);
    const delayMs = delaySeconds * 1000;

    pendingBonusClaimTimeout = window.setTimeout(() => {
      pendingBonusClaimTimeout = null;
      const currentButton = findClaimBonusButton();
      const target = currentButton || button;
      if (!isClickableBonusButton(target)) {
        return;
      }
      target.click();
      lastBonusClaimAt = Date.now();
    }, delayMs);

    return true;
  }

  function triggerScan() {
    if (pendingScan) {
      return;
    }
    pendingScan = true;
    requestAnimationFrame(() => {
      pendingScan = false;
      if (opts.autoClaim) {
        claimBonusChestIfAvailable();
      }
      if (scanVisiblePredictionRegions()) {
        void playAlertSound();
      }
    });
  }

  function startObserver() {
    const observer = new MutationObserver((mutations) => {
      let found = false;

      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          const value = mutation.target?.textContent || "";
          if (shouldAlertForText(value, "characterData")) {
            found = true;
            break;
          }
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (checkNodeAndChildren(node)) {
            found = true;
            break;
          }
        }

        if (found) {
          break;
        }
      }

      if (found) {
        void playAlertSound();
      } else {
        triggerScan();
      }

      if (opts.autoClaim) {
        claimBonusChestIfAvailable();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function init() {
    chrome.storage.local.get(STORAGE_DEFAULTS, (items) => {
      applyStorage(items);
      dbg("content script loaded", { sound: opts.predictionSound, countdown: opts.predictionCountdown });
      startObserver();
      triggerScan();
      window.setInterval(() => {
        if (opts.predictionSound || opts.predictionCountdown) {
          triggerScan();
        }
      }, PREDICTION_SCAN_INTERVAL_MS);
      window.setInterval(() => {
        if (opts.predictionSound || opts.predictionCountdown) {
          tickCountdown();
        }
      }, COUNTDOWN_TICK_INTERVAL_MS);
      window.setInterval(() => {
        if (opts.autoClaim) {
          claimBonusChestIfAvailable();
        }
      }, 7_000);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
