(() => {
  const STORAGE_DEFAULTS = {
    predictionSound: true,
    autoClaim: true
  };
  let opts = { ...STORAGE_DEFAULTS };

  const SOUND_PATH = "sounds/alert.mp3";
  const COOLDOWN_MS = 10_000;
  const RECENT_EVENT_CACHE_MS = 90_000;
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

  let lastAlertAt = 0;
  let lastBonusClaimAt = 0;
  let pendingBonusClaimTimeout = null;
  const recentEventKeys = new Map();
  let pendingScan = false;

  function cleanupRecentEvents() {
    const now = Date.now();
    for (const [key, ts] of recentEventKeys.entries()) {
      if (now - ts > RECENT_EVENT_CACHE_MS) {
        recentEventKeys.delete(key);
      }
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
    opts.autoClaim = items.autoClaim !== false;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") {
      return;
    }
    if (changes.predictionSound) {
      opts.predictionSound = changes.predictionSound.newValue !== false;
    }
    if (changes.autoClaim) {
      opts.autoClaim = changes.autoClaim.newValue !== false;
      if (!opts.autoClaim && pendingBonusClaimTimeout !== null) {
        window.clearTimeout(pendingBonusClaimTimeout);
        pendingBonusClaimTimeout = null;
      }
    }
  });

  async function playAlertSound() {
    if (!opts.predictionSound) {
      return;
    }
    const now = Date.now();
    if (now - lastAlertAt < COOLDOWN_MS) {
      return;
    }
    lastAlertAt = now;

    const src = chrome.runtime.getURL(SOUND_PATH);
    const audio = new Audio(src);
    audio.volume = 1;
    audio.preload = "auto";

    try {
      await audio.play();
    } catch (_) {
      tryPlayFallbackBeep();
    }
  }

  function isPredictionText(text) {
    const normalized = normalizeText(text);
    if (!normalized) {
      return false;
    }
    return KEYWORDS.some((keyword) => normalized.includes(keyword));
  }

  function buildEventKey(text, pathHint) {
    const normalized = normalizeText(text).slice(0, 120);
    return `${pathHint}|${normalized}`;
  }

  function shouldAlertForText(text, pathHint = "unknown") {
    if (!isPredictionText(text)) {
      return false;
    }

    cleanupRecentEvents();
    const key = buildEventKey(text, pathHint);
    if (recentEventKeys.has(key)) {
      return false;
    }
    recentEventKeys.set(key, Date.now());
    return true;
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

  function scanVisiblePredictionRegions() {
    const candidates = document.querySelectorAll(
      "[role='dialog'], [aria-live='polite'], [aria-live='assertive'], section, article"
    );

    for (const candidate of candidates) {
      if (shouldAlertForText(candidate.textContent || "", candidate.getAttribute("role") || candidate.tagName.toLowerCase())) {
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
