const path = require("node:path");
const esbuild = require("esbuild");
module.exports = function quickAskRuntime(root) {
const bundledPackageDirectories = new Set();
function bundle(options) {
  const result = esbuild.buildSync({ ...options, absWorkingDir: root, metafile: true });
  for (const input of Object.keys(result.metafile.inputs)) {
    const normalized = input.replaceAll("\\", "/");
    const marker = normalized.lastIndexOf("node_modules/");
    if (marker < 0) continue;
    const parts = normalized.slice(marker + 13).split("/");
    const count = parts[0].startsWith("@") ? 2 : 1;
    bundledPackageDirectories.add(path.resolve(root, normalized.slice(0, marker + 13), ...parts.slice(0, count)));
  }
  return result;
}
// Quick Ask's pinned third-party packages are bundled into the artifact, so the
// installable plugin stays self-contained with no runtime npm resolution.
const quickAskDependencies = ["eventsource-parser", "diff", "zustand/vanilla"].map((name) => {
  const source = bundle({
    entryPoints: [require.resolve(name, { paths: [root] })],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    target: "es2022",
  }).outputFiles[0].text;
  return `${JSON.stringify(name)}: function(module, exports, require) {\n${source}\n}`;
}).join(",\n");
// The owned Composer has one bundled CodeMirror graph, independent of the
// host's extensions. Its factory is evaluated only when a desktop view opens.
const composerRuntime = bundle({
  entryPoints: [path.join(root, "src/quick-ask/composer-view.js")],
  bundle: true, write: false, format: "cjs", platform: "browser", target: "es2022",
}).outputFiles[0].text.replace(/[ \t]+$/gm, "");
const composerModule = `"./quick-ask/composer-view": function(module, exports, require) {\n${composerRuntime}\n}`;

return { quickAskDependencies, composerModule, bundledPackageDirectories: [...bundledPackageDirectories].sort() };
};
