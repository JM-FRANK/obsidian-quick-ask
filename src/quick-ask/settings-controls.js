const { ANSWER_RESERVE_TOKENS } = require("./settings");

// Split decimal K text into whole thousands and single tokens rather than
// multiplying a binary float: 32.001 * 1000 is not an integer in JavaScript.
function contextWindowControlTokens(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = /^\+?(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(text);
  if (!match) return NaN;
  const fraction = (match[2] ?? match[3] ?? "").replace(/0+$/, "");
  if (fraction.length > 3) return NaN;
  return Number(match[1] ?? "0") * 1000 + Number(fraction.padEnd(3, "0"));
}

function validContextWindowControl(value) {
  const tokens = contextWindowControlTokens(value);
  return tokens === null || (Number.isSafeInteger(tokens) && tokens > ANSWER_RESERVE_TOKENS);
}

function quickAskControlValue(values, key) {
  const field = key.slice("quickAsk.".length);
  if (field.startsWith("webSearch.")) return values.quickAsk.webSearch[field.slice("webSearch.".length)];
  if (field.startsWith("display.")) return values.quickAsk.display[field.slice("display.".length)];
  if (field === "preservedCopy.enabled") return values.quickAsk.preservedCopy.enabled;
  if (field === "preservedCopy.directory") return values.quickAsk.preservedCopy.directory;
  if (field === "contextWindowTokens") {
    const tokens = values.quickAsk.contextWindowTokens;
    if (tokens == null) return "";
    const whole = Math.floor(tokens / 1000);
    const remainder = tokens % 1000;
    return `${whole}${remainder ? `.${String(remainder).padStart(3, "0").replace(/0+$/, "")}` : ""}`;
  }
  return values.quickAsk[field];
}

function quickAskControlPatch(key, value) {
  const field = key.slice("quickAsk.".length);
  const patch = {};
  if (field.startsWith("webSearch.")) {
    patch.webSearch = { [field.slice("webSearch.".length)]: value };
  } else if (field.startsWith("display.")) {
    patch.display = { [field.slice("display.".length)]: value };
  } else if (field === "preservedCopy.enabled" || field === "preservedCopy.directory") {
    patch.preservedCopy = { [field.slice("preservedCopy.".length)]: value };
  } else if (field === "contextWindowTokens") {
    const tokens = contextWindowControlTokens(value);
    patch.contextWindowTokens = tokens === null ? "" : tokens;
  } else {
    patch[field] = value;
  }
  return patch;
}

module.exports = { quickAskControlValue, quickAskControlPatch, validContextWindowControl };
