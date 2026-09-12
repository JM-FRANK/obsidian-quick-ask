const path = require("node:path");
const esbuild = require("esbuild");
module.exports = function quickAskRuntime(root) {
// Quick Ask's pinned third-party packages are bundled into the artifact, so the
// installable plugin stays self-contained with no runtime npm resolution.
const quickAskDependencies = ["eventsource-parser", "diff", "zustand/vanilla"].map((name) => {
  const source = esbuild.buildSync({
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
const composerRuntime = esbuild.buildSync({
  entryPoints: [path.join(root, "src/quick-ask/composer-view.js")],
  bundle: true, write: false, format: "cjs", platform: "browser", target: "es2022",
}).outputFiles[0].text.replace(/[ \t]+$/gm, "");
const composerModule = `"./quick-ask/composer-view": function(module, exports, require) {\n${composerRuntime}\n}`;

return { quickAskDependencies, composerModule };
};
