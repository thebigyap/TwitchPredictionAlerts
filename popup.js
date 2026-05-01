const KEYS = {
  predictionSound: "predictionSound",
  autoClaim: "autoClaim"
};

const DEFAULTS = {
  [KEYS.predictionSound]: true,
  [KEYS.autoClaim]: true
};

const predictionEl = document.getElementById("predictionSound");
const autoClaimEl = document.getElementById("autoClaim");

function load() {
  chrome.storage.local.get(DEFAULTS, (items) => {
    predictionEl.checked = items[KEYS.predictionSound] !== false;
    autoClaimEl.checked = items[KEYS.autoClaim] !== false;
  });
}

function save(key, value) {
  chrome.storage.local.set({ [key]: value });
}

predictionEl.addEventListener("change", () => {
  save(KEYS.predictionSound, predictionEl.checked);
});

autoClaimEl.addEventListener("change", () => {
  save(KEYS.autoClaim, autoClaimEl.checked);
});

load();
