function quickAskControlValue(values, key) {
  const field = key.slice("quickAsk.".length);
  if (field.startsWith("webSearch.")) return values.quickAsk.webSearch[field.slice("webSearch.".length)];
  if (field.startsWith("display.")) return values.quickAsk.display[field.slice("display.".length)];
  if (field === "preservedCopy.enabled") return values.quickAsk.preservedCopy.enabled;
  if (field === "preservedCopy.directory") return values.quickAsk.preservedCopy.directory;
  if (field === "contextWindowTokens") return values.quickAsk.contextWindowTokens == null ? "" : String(values.quickAsk.contextWindowTokens);
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
    const trimmed = String(value ?? "").trim();
    patch.contextWindowTokens = trimmed === "" ? "" : Number(trimmed);
  } else {
    patch[field] = value;
  }
  return patch;
}

module.exports = { quickAskControlValue, quickAskControlPatch };
