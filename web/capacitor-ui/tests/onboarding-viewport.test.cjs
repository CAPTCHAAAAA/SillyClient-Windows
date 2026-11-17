const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { test } = require("node:test");

const sourcePath = path.join(__dirname, "../src/components/onboarding/onboarding-viewport.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const compiledModule = { exports: {} };
vm.runInNewContext(compiled, { exports: compiledModule.exports, module: compiledModule }, {
  filename: sourcePath,
});
const viewport = compiledModule.exports;

test("visual viewport offsets and keyboard-reduced dimensions define visible bounds", () => {
  assert.deepEqual(
    { ...viewport.getViewportBounds({ offsetLeft: 12, offsetTop: 284, width: 360, height: 388 }, 800, 900) },
    { left: 12, top: 284, right: 372, bottom: 672 },
  );
  assert.deepEqual(
    { ...viewport.getViewportBounds(null, 800, 900) },
    { left: 0, top: 0, right: 800, bottom: 900 },
  );
});

test("target clipping intersects every ancestor and exposes only visible scrollports", () => {
  const clipping = viewport.resolveTargetClipping(
    { left: 0, top: 0, right: 400, bottom: 800 },
    [
      { bounds: { left: 20, top: 200, right: 380, bottom: 600 }, scrollable: true },
      { bounds: { left: 100, top: 100, right: 300, bottom: 700 }, scrollable: false },
    ],
  );
  assert.deepEqual({ ...clipping.visibleClip }, { left: 100, top: 200, right: 300, bottom: 600 });
  assert.deepEqual(Array.from(clipping.scrollports, port => ({
    ancestorIndex: port.ancestorIndex,
    bounds: { ...port.bounds },
  })), [
    { ancestorIndex: 0, bounds: { left: 100, top: 200, right: 300, bottom: 600 } },
  ]);
});

test("nested scrollports keep their own visible bounds and ancestor identities", () => {
  const clipping = viewport.resolveTargetClipping(
    { left: 0, top: 0, right: 400, bottom: 600 },
    [
      { bounds: { left: 20, top: 200, right: 380, bottom: 500 }, scrollable: true },
      { bounds: { left: 50, top: 100, right: 350, bottom: 350 }, scrollable: true },
      { bounds: { left: 0, top: 0, right: 400, bottom: 550 }, scrollable: false },
    ],
  );
  assert.deepEqual(Array.from(clipping.scrollports, port => ({
    ancestorIndex: port.ancestorIndex,
    bounds: { ...port.bounds },
  })), [
    { ancestorIndex: 0, bounds: { left: 50, top: 200, right: 350, bottom: 350 } },
    { ancestorIndex: 1, bounds: { left: 50, top: 100, right: 350, bottom: 350 } },
  ]);
});

test("reveal distance includes the desired margin and becomes stable after scrolling", () => {
  const clip = { left: 20, top: 100, right: 340, bottom: 300 };
  const target = { left: 40, top: 260, right: 220, bottom: 300 };
  const range = { position: 18, min: 0, max: 104 };
  assert.deepEqual(
    { ...viewport.getRevealDelta(target, clip, null, range) },
    { left: 0, top: 8 },
  );
  assert.deepEqual(
    { ...viewport.getRevealDelta({ ...target, top: 252, bottom: 292 }, clip, null, { ...range, position: 26 }) },
    { left: 0, top: 0 },
  );
});

test("reveal distance respects scroll limits and permits targets larger than the viewport", () => {
  const clip = { left: 0, top: 0, right: 360, bottom: 220 };
  assert.deepEqual(
    { ...viewport.getRevealDelta(
      { left: 20, top: 90, right: 280, bottom: 620 },
      clip,
      null,
      { position: 10, min: 0, max: 200 },
    ) },
    { left: 0, top: 82 },
  );
  assert.deepEqual(
    { ...viewport.getRevealDelta(
      { left: 20, top: 200, right: 280, bottom: 235 },
      clip,
      null,
      { position: 98, min: 0, max: 100 },
    ) },
    { left: 0, top: 2 },
  );
  assert.deepEqual(
    { ...viewport.getRevealDelta(
      { left: 20, top: 198, right: 280, bottom: 233 },
      clip,
      null,
      { position: 100, min: 0, max: 100 },
    ) },
    { left: 0, top: 0 },
  );
});

test("negative scroll ranges and axes without scroll capacity are handled independently", () => {
  assert.deepEqual(
    { ...viewport.getRevealDelta(
      { left: -20, top: -30, right: 40, bottom: 10 },
      { left: 0, top: 0, right: 300, bottom: 200 },
      { position: -20, min: -100, max: 0 },
      { position: -40, min: -100, max: 0 },
    ) },
    { left: -28, top: -38 },
  );
  assert.deepEqual(
    { ...viewport.getRevealDelta(
      { left: -20, top: 250, right: 40, bottom: 290 },
      { left: 0, top: 0, right: 300, bottom: 200 },
      null,
      { position: 50, min: 0, max: 50 },
    ) },
    { left: 0, top: 0 },
  );
});

test("callout stays inside offset viewports and reports its actual narrow width", () => {
  const offsetViewport = { left: 18, top: 260, right: 378, bottom: 650 };
  const position = viewport.getCalloutPosition(
    { left: 290, top: 570, right: 340, bottom: 610 },
    292,
    150,
    offsetViewport,
  );
  assert.deepEqual({ ...position }, { left: 70, top: 402, width: 292 });
  assert.ok(position.left >= offsetViewport.left + 16);
  assert.ok(position.left + position.width <= offsetViewport.right - 16);
  assert.ok(position.top >= offsetViewport.top + 16);

  const narrow = viewport.getCalloutPosition(
    { left: 200, top: 100, right: 240, bottom: 140 },
    292,
    132,
    { left: 40, top: 0, right: 260, bottom: 400 },
  );
  assert.deepEqual({ ...narrow }, { left: 56, top: 158, width: 188 });
});
