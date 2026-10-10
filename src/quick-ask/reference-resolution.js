const { canReferencePath } = require("./file-input");

// Host callbacks return plain paths. Resolving a link never reads file contents.
// The Composer has no source note: short links use Vault-root resolution.
function createReferenceResolver({ exactPath, linkPath, resolveRole, isExcluded }) {
  return reference => {
    // Aliases and subpaths are presentation/navigation syntax only. Quick Ask
    // always adds the whole file, without resolving a heading or block target.
    const target = typeof reference === "string" ? reference.split(/[|#]/, 1)[0] : null;
    if (!canReferencePath(reference) || !canReferencePath(target) || target.startsWith("/") || target.includes("\\") || isExcluded(target)) {
      return { path: null, role: null, status: "missing" };
    }
    const path = exactPath(target) ?? linkPath(target, "");
    if (!path || isExcluded(path)) return { path: null, role: null, status: "missing" };
    const role = resolveRole(path);
    return { path, role, status: role ? "supported" : "unsupported" };
  };
}

module.exports = { createReferenceResolver };
