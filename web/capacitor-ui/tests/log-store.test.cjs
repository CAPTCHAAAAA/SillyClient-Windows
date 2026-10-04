const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { loadSource } = require("./load-source.cjs");
const { InstanceLogStore } = loadSource(path.join(__dirname, "../src/lib/log-store.ts"));

test("10,000 lines remain ordered and bounded to 2,000 per instance", () => {
  const store = new InstanceLogStore();
  for (let index = 0; index < 10000; index++) store.append("a", { msg: String(index) });
  store.append("b", { msg: "independent" });
  store.flush();
  const snapshot = store.getSnapshot("a");
  assert.equal(snapshot.length, 2000);
  assert.equal(snapshot[0].msg, "8000");
  assert.equal(snapshot.at(-1).msg, "9999");
  assert.equal(store.getSnapshot("b")[0].msg, "independent");
  assert.ok(Object.isFrozen(snapshot));
  store.dispose();
});

test("subscribers receive one immutable snapshot per batch, never per line", () => {
  const store = new InstanceLogStore();
  let notifications = 0;
  const unsubscribe = store.subscribe("a", () => notifications++);
  const previous = store.getSnapshot("a");
  for (let index = 0; index < 500; index++) store.append("a", { msg: String(index) });
  assert.equal(store.getSnapshot("a"), previous);
  assert.equal(notifications, 0);
  store.flush();
  assert.equal(notifications, 1);
  assert.equal(store.getSnapshot("a"), store.getSnapshot("a"));
  unsubscribe();
  store.append("a", { msg: "hidden" });
  store.flush();
  assert.equal(notifications, 1);
  store.dispose();
});

test("lines and replacements are bounded; consecutive progress is merged", () => {
  const store = new InstanceLogStore(3, 20);
  store.update("a", [{ msg: "x".repeat(200) }]);
  store.append("a", { msg: "download 10%", level: "info" }, true);
  store.append("a", { msg: "download 20%", level: "info" }, true);
  store.flush();
  assert.equal(store.getSnapshot("a").length, 2);
  assert.equal(store.getSnapshot("a")[0].msg.length, 20);
  assert.equal(store.getSnapshot("a")[1].msg, "download 20%");
  store.update("a", []);
  store.flush();
  assert.equal(store.getSnapshot("a").length, 0);
  store.dispose();
});
