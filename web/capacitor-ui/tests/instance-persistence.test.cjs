const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { test } = require("node:test");
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
    module,
    exports: module.exports,
    URL,
    require: name => name.startsWith(".")
      ? loadSource(path.resolve(path.dirname(filename), name + ".ts"))
      : nativeRequire(name),
  }, { filename });
  return module.exports;
}

const codec = loadSource(path.join(__dirname, "../src/lib/instance-persistence.ts"));
const local = {
  id: "local-1",
  name: "Local",
  type: "local",
  status: "running",
  color: "#123456",
  installDir: "local-1",
  installPath: '"D:\\Tavern"',
  version: "vv1.19.0",
};
const remote = {
  id: "remote-1",
  name: "Remote",
  type: "remote",
  status: "online",
  color: "#654321",
  url: "https://example.test/tavern",
  basicAuth: { username: "alice", password: "must-not-persist" },
};
const plain = value => JSON.parse(JSON.stringify(value));

test("saved records whitelist fields and discard nested or top-level credentials", () => {
  const stored = codec.serializeInstanceRecords([{
    ...remote, password: "must-not-persist", icon: {}, unexpected: "must-not-persist",
  }]);
  assert.deepEqual(plain(stored[0].basicAuth), { username: "alice" });
  assert.equal(JSON.stringify(stored).includes("must-not-persist"), false);
  assert.equal("icon" in stored[0], false);
  assert.equal("unexpected" in stored[0], false);
});

test("import resets transient statuses and first-entry hints", () => {
  const records = codec.parseInstanceBackup(JSON.stringify({
    version: 2,
    instances: [{ ...local, pendingTavernGestureHint: true }, remote],
  }));
  assert.equal(records[0].status, "stopped");
  assert.equal(records[1].status, "offline");
  assert.equal("pendingTavernGestureHint" in records[0], false);
});

test("local path quotes and version prefixes normalize without losing the target", () => {
  const [stored] = codec.serializeInstanceRecords([local]);
  assert.equal(stored.installPath, "D:\\Tavern");
  assert.equal(stored.version, "1.19.0");
  assert.equal(stored.installDir, "local-1");
});

test("credential-bearing URLs and unsupported protocols are never persisted", () => {
  for (const url of ["https://alice:password@example.test", "file:///private", "javascript:alert(1)"]) {
    assert.equal(codec.serializeInstanceRecords([{ ...remote, url }]).length, 0);
  }
  const [stored] = codec.serializeInstanceRecords([{
    ...local, cover: "https://alice:password@example.test/image.png",
    zipballUrl: "https://alice:password@example.test/source.zip",
  }]);
  assert.equal(stored.cover, undefined);
  assert.equal(stored.zipballUrl, undefined);
});

test("malformed records do not poison the remaining valid instance list", () => {
  const records = codec.normalizeStoredInstances([
    null, [], {}, { ...local, id: "" }, { ...local, type: "alien" }, local,
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "local-1");
  assert.equal(codec.normalizeStoredInstances({}).length, 0);
});

test("invalid ports, nonfinite heartbeat, and unknown config fields are discarded", () => {
  const [stored] = codec.serializeInstanceRecords([{
    ...local,
    port: 70000,
    config: { listen: true, ipv4: false, heartbeat: Infinity, password: "must-not-persist" },
  }]);
  assert.equal(stored.port, undefined);
  assert.deepEqual(plain(stored.config), {
    listen: true, ipv4: false, ipv6: false, dnsIpv6: false, heartbeat: 0, keepAlive: false,
  });
});

test("duplicate records merge deterministically without object prototype keys", () => {
  const records = codec.normalizeStoredInstances([
    local, { ...local, name: "Updated" }, { ...local, id: "__proto__" },
  ]);
  assert.equal(records.length, 2);
  assert.equal(records[0].name, "Updated");
  assert.equal(records[1].id, "__proto__");
});

test("backup validates structure, schema version and input bounds", () => {
  for (const content of [
    "null", "{}", '{"instances":{}}', '{"version":99,"instances":[]}',
    '{"instances":[null,{}]}',
  ]) {
    assert.throws(() => codec.parseInstanceBackup(content));
  }
  assert.throws(() => codec.parseInstanceBackup(" ".repeat(5 * 1024 * 1024 + 1)));
  assert.throws(() => codec.normalizeStoredInstances(Array(2001).fill(local)));
});

test("backup exports never exceed their own import bound", () => {
  const cover = "data:image/png;base64," + "A".repeat(2 * 1024 * 1024 - 32);
  assert.throws(() => codec.createInstanceBackup([1, 2, 3].map(id => ({
    ...local, id: `local-${id}`, cover,
  }))));
  assert.equal(codec.parseInstanceBackup(codec.createInstanceBackup([])).length, 0);
});

test("heartbeat normalization does not overflow native integer configuration", () => {
  for (const heartbeat of [-1, 2_147_483_648, Number.MAX_SAFE_INTEGER]) {
    const [stored] = codec.serializeInstanceRecords([{ ...local, config: { heartbeat } }]);
    assert.equal(stored.config.heartbeat, 0);
  }
  const [stored] = codec.serializeInstanceRecords([{ ...local, config: { heartbeat: 30.5 } }]);
  assert.equal(stored.config.heartbeat, 30);
});

test("preinstall persistence retains only catalog IDs, never imported source locations", () => {
  const [stored] = codec.serializeInstanceRecords([{
    ...local,
    preinstall: { revision: 1, extensionIds: ["tavern-helper", "dice", "dice", "../../escape", null],
      repository: "https://user:must-not-persist@example.test" },
  }]);
  assert.deepEqual(plain(stored.preinstall), { revision: 1, extensionIds: ["tavern-helper", "dice"] });
  assert.equal(JSON.stringify(stored).includes("must-not-persist"), false);
  assert.equal(codec.serializeInstanceRecords([{ ...local, preinstall: { revision: 99, extensionIds: ["dice"] } }])[0].preinstall, undefined);
});

test("export and reimport round-trip only non-sensitive metadata", () => {
  const exported = codec.createInstanceBackup([local, remote]);
  assert.equal(exported.includes("must-not-persist"), false);
  const restored = codec.parseInstanceBackup(exported);
  assert.equal(restored.length, 2);
  assert.equal(restored[0].status, "stopped");
  assert.equal(restored[1].basicAuth.username, "alice");
});
