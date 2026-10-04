const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { loadSource } = require("./load-source.cjs");
const { OperationCoordinator, OperationCancelledError } = loadSource(path.join(__dirname, "../src/lib/operation-coordinator.ts"));
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

test("cancel settles an outstanding await immediately and rejects late completion", async () => {
  const coordinator = new OperationCoordinator();
  const operation = coordinator.begin("a", "launch");
  const pending = deferred();
  const result = operation.wait(pending.promise);
  coordinator.cancel("a");
  await assert.rejects(result, OperationCancelledError);
  pending.resolve({ ready: true });
  assert.equal(operation.isCurrent, false);
  assert.equal(coordinator.busy, false);
});

test("listener registering after cancellation is removed exactly once", async () => {
  const coordinator = new OperationCoordinator();
  const operation = coordinator.begin("a", "launch");
  const pending = deferred();
  let removes = 0;
  const registration = operation.listen(pending.promise);
  coordinator.cancel();
  await assert.rejects(registration, OperationCancelledError);
  pending.resolve({ remove: async () => { removes++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removes, 1);
});

test("new generation rejects old, unidentified, and instance-only events", () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.begin("a", "launch");
  assert.equal(first.accepts({}), true);
  assert.equal(first.accepts({ instanceId: "other" }), false);
  const second = coordinator.begin("a", "launch");
  assert.equal(first.accepts({ operationId: first.id }), false);
  assert.equal(second.accepts({ operationId: first.id, instanceId: "a" }), false);
  assert.equal(second.accepts({ instanceId: "a" }), false);
  assert.equal(second.accepts({}), false);
  assert.equal(second.accepts({ operationId: second.id, instanceId: "a" }), true);
  assert.equal(coordinator.acceptsGlobal({ instanceId: "a" }), false);
  coordinator.cancel();
  assert.equal(coordinator.acceptsGlobal({ operationId: second.id }), false);
});

test("finish releases resources but a closing timer cannot commit after replacement", async () => {
  const coordinator = new OperationCoordinator();
  const first = coordinator.begin("a", "launch");
  let removes = 0;
  let commits = 0;
  await first.listen(Promise.resolve({ remove: async () => { removes++; } }));
  first.schedule(() => commits++, 20);
  first.finish();
  assert.equal(removes, 1);
  assert.equal(first.isCurrent, true);
  assert.equal(first.busy, false);
  coordinator.begin("b", "launch");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(commits, 0);
  coordinator.cancel();
});

test("wrong-instance stop does not invalidate a live operation", () => {
  const coordinator = new OperationCoordinator();
  const operation = coordinator.begin("a", "launch");
  assert.equal(coordinator.cancel("b"), null);
  assert.equal(operation.isCurrent, true);
  coordinator.cancel();
});

test("matching operation tags cannot route an event to a different native instance", () => {
  const coordinator = new OperationCoordinator();
  const operation = coordinator.begin("native-instance", "launch");
  assert.equal(coordinator.acceptsGlobal({ operationId: operation.id, instanceId: "scan-native-instance" }), false);
  assert.equal(coordinator.acceptsGlobal({ operationId: operation.id, instanceId: "native-instance" }), true);
  operation.finish();
  assert.equal(coordinator.acceptsGlobal({ operationId: operation.id, instanceId: "scan-native-instance" }), false);
  assert.equal(coordinator.acceptsGlobal({ operationId: operation.id, instanceId: "native-instance" }), true);
  coordinator.cancel();
});
