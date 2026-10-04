const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const ts = require("typescript");

const modules = new Map();
function loadSource(filename) {
  filename = path.resolve(filename);
  if (modules.has(filename)) return modules.get(filename).exports;
  const module = { exports: {} };
  modules.set(filename, module);
  const nativeRequire = createRequire(filename);
  const source = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, {
    module, exports: module.exports, URL, AbortController,
    setTimeout, clearTimeout, setInterval, clearInterval,
    require: name => name.startsWith(".")
      ? loadSource(path.resolve(path.dirname(filename), name + ".ts"))
      : nativeRequire(name),
  }, { filename });
  return module.exports;
}
module.exports = { loadSource };
