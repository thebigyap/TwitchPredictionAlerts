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
  const COUNTDOWN_TICK_INTERVAL_MS = 250;
  const COUNTDOWN_LOCATE_INTERVAL_MS = 1_000; // throttle the page-wide timer search
  const COUNTDOWN_PRESENCE_GRACE_MS = 4_000; // card absent this long -> stop countdown
  const PREDICTION_ALERT_REARM_MS = 10_000; // prediction gone this long -> alert can fire again
  const COUNTDOWN_DEADLINE_OFFSET_SECONDS = 0; // fire the countdown N seconds early (timer is accurate, so 0)
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
  // Last time any prediction signal was seen (region scan or timer text).
  // Drives countdown-stop and alert re-arm.
  let predictionLastSeenAt = 0;
  let alertedThisRun = false;
  let countdownElement = null;
  let lastCountdownLocateAt = 0;
  // Wall-clock countdown: anchor a deadline from the timer text and tick against
  // it, so the final 10s still plays through a brief panel collapse.
  let countdownDeadlineAt = 0;
  let countdownPlayedSecond = Infinity;
  // In the final 10s the countdown is "committed": deadline locked, plays out
  // tick-by-tick ignoring timer re-reads and cancellation (never doubles/cuts).
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

  // A prediction card is on screen. Includes the collapsed card ("Predict with
  // Channel Points", no timer) so presence survives collapsing the panel.
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
      // Bare timer/presence text has no title to key on; reuse the active key.
      key = activePredictionKey || `${getChannelKey()}|active-prediction`;
    }
    if (!key) {
      return null;
    }

    return { key, alertable, remainingSeconds };
  }

  // A remaining-seconds reading only anchors the clock; tickCountdown plays.
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

    // Alert once per "presence run": re-arms in updatePredictionPresence after
    // the card is gone. Robust to the card's identity text churning with votes.
    const canPlayAlert =
      !alertedThisRun && now - lastPredictionAlertAt >= PREDICTION_ALERT_COOLDOWN_MS;

    if (canPlayAlert) {
      alertedThisRun = true;
      lastPredictionAlertAt = now;
      dbg("ALERT fired:", prediction.key);
    }

    return canPlayAlert;
  }

  // Card gone: stop a running countdown (grace), then re-arm the alert (longer),
  // then drop the stale key. Skipped while the countdown is committed.
  function updatePredictionPresence(now) {
    const missingFor = predictionLastSeenAt ? now - predictionLastSeenAt : Infinity;

    if (countdownDeadlineAt && missingFor >= COUNTDOWN_PRESENCE_GRACE_MS) {
      countdownDeadlineAt = 0;
      countdownPlayedSecond = Infinity;
    }

    if (alertedThisRun && missingFor >= PREDICTION_ALERT_REARM_MS) {
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

  // Finds the closing-timer text anywhere on the page (the region scan only
  // looks inside specific wrappers and can miss the card). Cached + throttled.
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
      // All ancestors match; keep the shortest (tightest timer string).
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
      void playCountdownSound();
    }
  }

  // Anchors the wall-clock deadline from the timer text, reacts to the card
  // disappearing, and plays the per-second countdown.
  function tickCountdown() {
    const now = Date.now();

    const text = findCountdownText();
    const textSeconds = text ? parsePredictionRemainingSeconds(text) : null;
    if (Number.isFinite(textSeconds)) {
      predictionLastSeenAt = now;
      // Committed: don't re-anchor, or opening the panel could double a tick.
      if (!countdownCommitted) {
        anchorCountdownSeconds(textSeconds, now);
      }
    }

    if (!countdownCommitted) {
      updatePredictionPresence(now);
    }

    let displaySecond = null;
    if (countdownDeadlineAt) {
      displaySecond = Math.ceil((countdownDeadlineAt - now) / 1000);
    }

    // Entering the final window locks the countdown so it plays out uninterrupted.
    if (
      !countdownCommitted &&
      displaySecond !== null &&
      displaySecond >= 1 &&
      displaySecond <= COUNTDOWN_THRESHOLD_SECONDS
    ) {
      countdownCommitted = true;
    }

    if (displaySecond !== null) {
      // Before commit, a jump up to a longer timer = new prediction; reset dedup.
      if (!countdownCommitted && displaySecond > countdownPlayedSecond + 2) {
        countdownPlayedSecond = Infinity;
      }
      maybePlayCountdownSecond(displaySecond);
    }

    if (countdownCommitted && displaySecond !== null && displaySecond <= 0) {
      countdownCommitted = false;
      countdownDeadlineAt = 0;
      countdownPlayedSecond = Infinity;
    }
  }

  function scanVisiblePredictionRegions() {
    const candidates = document.querySelectorAll(
      "[role='dialog'], [aria-live='polite'], [aria-live='assertive'], section, article"
    );

    // inspectPredictionText -> notePredictionSeen refreshes the presence timer.
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
