// Load the app's TypeScript analysis modules directly for offline checks.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const cache = new Map();
module.exports = function loadAnalysis(name) {
  const file = path.resolve(root, name);
  if (!file.startsWith(root + path.sep)) throw new Error("Module outside workspace");
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const requireModule = id => {
    const target = id.startsWith("@/") ? path.join(root, id.slice(2)) : path.resolve(path.dirname(file), id);
    return loadAnalysis(path.relative(root, target + ".ts"));
  };
  vm.runInNewContext(code, { exports, require: requireModule }, { filename: file });
  return exports;
};
