const KEYS = {
  predictionSound: "predictionSound",
  predictionCountdown: "predictionCountdown",
  autoClaim: "autoClaim"
};

const DEFAULTS = {
  [KEYS.predictionSound]: true,
  [KEYS.predictionCountdown]: true,
  [KEYS.autoClaim]: true
};

const predictionEl = document.getElementById("predictionSound");
const countdownEl = document.getElementById("predictionCountdown");
const autoClaimEl = document.getElementById("autoClaim");

function load() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    predictionEl.checked = items[KEYS.predictionSound] !== false;
    countdownEl.checked = items[KEYS.predictionCountdown] !== false;
    autoClaimEl.checked = items[KEYS.autoClaim] !== false;
  });
}

function save(key, value) {
  chrome.storage.local.set({ [key]: value });
}

predictionEl.addEventListener("change", () => {
  save(KEYS.predictionSound, predictionEl.checked);
});

countdownEl.addEventListener("change", () => {
  save(KEYS.predictionCountdown, countdownEl.checked);
});

autoClaimEl.addEventListener("change", () => {
  save(KEYS.autoClaim, autoClaimEl.checked);
});

load();
