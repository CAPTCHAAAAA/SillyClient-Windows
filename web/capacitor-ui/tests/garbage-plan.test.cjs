const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { loadSource } = require("./load-source.cjs");
const { executeGarbagePlan } = loadSource(path.join(__dirname, "../src/lib/garbage-plan.ts"));
const item = (name, token = name) => ({ path: name, token, description: name, type: "cache", sizeBytes: 1 });

test("only scanned tokenized items are deleted, failures remain in the plan", async () => {
  const calls = [];
  const result = await executeGarbagePlan([item("a"), item("b"), { ...item("c"), token: undefined }], async options => {
    calls.push(options);
    if (options.path === "b") throw new Error("permission denied");
    return { success: true };
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].token, "a");
  assert.equal(result.failed[0].path, "b");
  assert.ok(result.errors[0].includes("permission denied"));
  assert.equal(result.failed.length, 2);
  assert.ok(result.errors[1].includes("Missing scan token"));
});

test("mutating the caller list during an await cannot expand the deletion plan", async () => {
  const list = [item("a")];
  const paths = [];
  await executeGarbagePlan(list, async options => {
    list.push(item("not-scanned"));
    paths.push(options.path);
    return { success: true };
  });
  assert.deepEqual(paths, ["a"]);
});

test("native success false is retained as a failure", async () => {
  const result = await executeGarbagePlan([item("a")], async () => ({ success: false }));
  assert.equal(result.failed.length, 1);
});

test("native refusal detail is surfaced without dropping the item", async () => {
  const result = await executeGarbagePlan([item("a")], async () => ({
    success: false,
    error: "File changed since the scan",
  }));
  assert.equal(result.failed.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0], "a: File changed since the scan");
});
