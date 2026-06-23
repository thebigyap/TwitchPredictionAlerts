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
  const DEBUG = false;
  const PREDICTION_ALERT_COOLDOWN_MS = 10_000;
  const PREDICTION_MISSING_RESET_MS = 2 * 60_000;
  const PREDICTION_SCAN_INTERVAL_MS = 1_000;
  // Re-check the wall-clock countdown 4x a second so every whole-second value
  // (10..1) plays. The deadline is only ever anchored from the readable timer
  // text — never guessed from the progress bar.
  const COUNTDOWN_TICK_INTERVAL_MS = 250;
  // Cap how often we re-search the whole page for the timer element when it
  // isn't already cached, so a chatty page doesn't trigger constant lookups.
  const COUNTDOWN_LOCATE_INTERVAL_MS = 1_000;
  // How long the prediction card must be absent (no timer text and nothing in
  // the region scan) before we stop a running countdown — covers a mod
  // canceling the prediction mid-countdown.
  const COUNTDOWN_PRESENCE_GRACE_MS = 4_000;
  // How long the prediction must be gone before the once-per-prediction alert
  // re-arms for the next one.
  const PREDICTION_ALERT_REARM_MS = 10_000;
  // Seconds to fire the countdown early. Testing showed the on-screen
  // "Submissions closing in M:SS" timer is accurate to the real deadline, so 0.
  // Kept as a tunable knob in case a future Twitch change reintroduces an offset.
  const COUNTDOWN_DEADLINE_OFFSET_SECONDS = 0;
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
  // Timestamp of the last time any prediction signal was seen (region scan or
  // the readable timer text). Drives countdown-stop and alert re-arm.
  let predictionLastSeenAt = 0;
  let alertedThisRun = false;
  let lastSeenAlertableKey = null;
  let countdownElement = null;
  let lastCountdownLocateAt = 0;
  let lastDebugSecond = null;
  // Wall-clock countdown: once we read the timer text we anchor a deadline and
  // tick against it, so the final 10s still plays through a brief panel
  // collapse. Only ever anchored from the text — never guessed.
  let countdownDeadlineAt = 0;
  let countdownPlayedSecond = Infinity;
  // Once the final-10s countdown starts it is "committed": the deadline is
  // locked and plays out tick-by-tick, ignoring re-reads of the timer and
  // presence/cancellation, so it can never double a tick or be cut short.
  let countdownCommitted = false;
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

  // Recognizes that a prediction card is on screen. Crucially this includes the
  // collapsed card, which shows "Predict with Channel Points" but no timer — so
  // the presence run stays alive (alert doesn't re-fire, countdown isn't cut
  // short) while the panel is collapsed. Also covers the locked/closed/awaiting-
  // result states through the close transition.
  function isPredictionPresenceText(text) {
    const normalized = normalizeText(text);
    return (
      normalized.includes("predict with channel points") ||
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
    // The on-screen timer overshoots the real submission deadline, so shift the
    // deadline earlier by the offset.
    countdownDeadlineAt = now + (seconds - COUNTDOWN_DEADLINE_OFFSET_SECONDS) * 1000;
  }

  function notePredictionSeen(prediction) {
    const now = Date.now();
    predictionLastSeenAt = now;

    if (activePredictionKey !== prediction.key) {
      activePredictionKey = prediction.key;
    }

    handlePredictionCountdown(prediction);

    if (!prediction.alertable) {
      return false;
    }

    if (prediction.key !== lastSeenAlertableKey) {
      lastSeenAlertableKey = prediction.key;
      dbg("alertable seen | alertedThisRun:", alertedThisRun, "| key:", prediction.key, "| text:", prediction.sample);
    }

    // Alert once per prediction "presence run". The run stays alive as long as
    // the card is detected (region scan — works collapsed too) and re-arms once
    // it has been gone for PREDICTION_ALERT_REARM_MS (handled in
    // updatePredictionPresence). Immune to the card's identity text churning as
    // votes come in, which was causing the alert to re-fire every cooldown.
    const canPlayAlert =
      !alertedThisRun && now - lastPredictionAlertAt >= PREDICTION_ALERT_COOLDOWN_MS;

    if (canPlayAlert) {
      alertedThisRun = true;
      lastPredictionAlertAt = now;
      dbg("ALERT fired:", prediction.key);
    }

    return canPlayAlert;
  }

  // Reacts to the prediction card disappearing: stops a running countdown soon
  // after the card is gone, then re-arms the once-per-prediction alert a little
  // later so the next prediction sounds again.
  function updatePredictionPresence(now) {
    const missingFor = predictionLastSeenAt ? now - predictionLastSeenAt : Infinity;

    if (countdownDeadlineAt && missingFor >= COUNTDOWN_PRESENCE_GRACE_MS) {
      dbg("prediction gone — countdown stopped");
      countdownDeadlineAt = 0;
      countdownPlayedSecond = Infinity;
      lastDebugSecond = null;
    }

    if (alertedThisRun && missingFor >= PREDICTION_ALERT_REARM_MS) {
      dbg("prediction gone — alert re-armed");
      alertedThisRun = false;
    }

    if (activePredictionKey && missingFor > PREDICTION_MISSING_RESET_MS) {
      activePredictionKey = null;
    }
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

  // Runs whenever alerts or the countdown are enabled. Anchors the wall-clock
  // deadline from the readable timer text, reacts to the card disappearing, and
  // plays the per-second countdown. Playback is gated inside playCountdownSound.
  function tickCountdown() {
    const now = Date.now();

    const text = findCountdownText();
    const textSeconds = text ? parsePredictionRemainingSeconds(text) : null;
    if (Number.isFinite(textSeconds)) {
      predictionLastSeenAt = now;
      // Once committed, never re-anchor — re-reading the timer (e.g. opening the
      // panel) must not shift the locked deadline and double a tick.
      if (!countdownCommitted) {
        anchorCountdownSeconds(textSeconds, now);
      }
    }

    // While committed, ignore presence/cancellation so the countdown plays out.
    if (!countdownCommitted) {
      updatePredictionPresence(now);
    }

    let displaySecond = null;
    if (countdownDeadlineAt) {
      displaySecond = Math.ceil((countdownDeadlineAt - now) / 1000);
    }

    // Lock the countdown the moment it enters the final window with a real
    // deadline, so the remaining ticks play uninterrupted.
    if (
      !countdownCommitted &&
      displaySecond !== null &&
      displaySecond >= 1 &&
      displaySecond <= COUNTDOWN_THRESHOLD_SECONDS
    ) {
      countdownCommitted = true;
      dbg("countdown committed — playing out uninterrupted");
    }

    if (displaySecond !== null && displaySecond !== lastDebugSecond) {
      lastDebugSecond = displaySecond;
      // Only log the final stretch each second, plus a 30s heartbeat earlier,
      // so long predictions don't flood the console.
      if (displaySecond <= 30 || displaySecond % 30 === 0) {
        dbg("remaining:", displaySecond, "| rawText:", textSeconds);
      }
    }

    if (displaySecond !== null) {
      // Before commit, a jump up to a longer timer means a new prediction
      // started; re-arm the per-second dedup so its countdown plays too.
      if (!countdownCommitted && displaySecond > countdownPlayedSecond + 2) {
        countdownPlayedSecond = Infinity;
      }
      maybePlayCountdownSecond(displaySecond);
    }

    // Committed countdown reached zero: release the lock and reset for the next.
    if (countdownCommitted && displaySecond !== null && displaySecond <= 0) {
      dbg("countdown finished");
      countdownCommitted = false;
      countdownDeadlineAt = 0;
      countdownPlayedSecond = Infinity;
      lastDebugSecond = null;
    }
  }

  function scanVisiblePredictionRegions() {
    const candidates = document.querySelectorAll(
      "[role='dialog'], [aria-live='polite'], [aria-live='assertive'], section, article"
    );

    // inspectPredictionText -> notePredictionSeen refreshes predictionLastSeenAt
    // whenever a prediction is found, which keeps the presence timer alive.
    for (const candidate of candidates) {
      const result = inspectPredictionText(
        candidate.textContent || "",
        candidate.getAttribute("role") || candidate.tagName.toLowerCase()
      );
      if (result.shouldAlert) {
        return true;
      }
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
