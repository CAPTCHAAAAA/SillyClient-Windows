const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../public/reviewed-material-runtime.js"), "utf8");
const start = source.indexOf("const ensureCardRevealStructure =");
const end = source.indexOf("// —— 卡片轻微 3D", start);
const context = {};
vm.runInNewContext(source.slice(start, end) + "\nthis.ensure = ensureCardRevealStructure;", context);

test("repeated reveal annotation produces no new class/inert/style mutations", () => {
  let writes = 0;
  const classes = values => ({
    values: new Set(values),
    contains(value) { return this.values.has(value); },
    add(value) { writes++; this.values.add(value); },
  });
  const subtitle = { classList: classes([]), offsetTop: 200 };
  const status = { classList: classes([]) };
  const attributes = new Set();
  const accordion = {
    classList: classes(["motion-accordion"]),
    hasAttribute(name) { return attributes.has(name); },
    setAttribute(name) { writes++; attributes.add(name); },
    removeAttribute(name) { writes++; attributes.delete(name); },
    querySelector() { return { scrollHeight: 80 }; },
  };
  const properties = new Map();
  const content = {
    classList: classes(["relative", "h-full", "flex-col"]),
    children: [subtitle, status, accordion], clientHeight: 320,
    querySelector() { return accordion; },
    style: {
      getPropertyValue(key) { return properties.get(key); },
      setProperty(key, value) { writes++; properties.set(key, value); },
    },
  };
  const card = { children: [content] };
  const doc = { querySelectorAll: () => [card] };
  context.ensure(doc);
  const initial = writes;
  for (let index = 0; index < 100; index++) context.ensure(doc);
  assert.equal(initial, 4);
  assert.equal(writes, initial);
});

test("observer ignores runtime-only classes and terminal descendants", () => {
  const mutationStart = source.indexOf("const isProductMutation =");
  const mutationEnd = source.indexOf("const installMutationObserver =", mutationStart);
  const filter = {};
  vm.runInNewContext(source.slice(mutationStart, mutationEnd) + "\nthis.check = isProductMutation;", filter);
  const target = {
    nodeType: 1,
    closest: () => null,
    getAttribute: () => "title preview-card-subtitle",
  };
  assert.equal(filter.check({ type: "attributes", target, oldValue: "title" }), false);
  target.getAttribute = () => "title is-expanded";
  assert.equal(filter.check({ type: "attributes", target, oldValue: "title" }), true);
  target.closest = () => ({});
  assert.equal(filter.check({ type: "childList", target, addedNodes: [{}], removedNodes: [] }), false);
});
