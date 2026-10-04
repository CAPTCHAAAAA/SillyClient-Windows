const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const catalog = JSON.parse(fs.readFileSync(
  path.join(__dirname, "../src/data/preinstall-catalog.json"), "utf8",
));

test("preinstall catalog pins reviewed sources and bounded archives", () => {
  assert.equal(catalog.revision, 1);
  assert.equal(catalog.extensions.length, 4);
  const ids = new Set();
  for (const extension of catalog.extensions) {
    assert.equal(ids.has(extension.id), false);
    ids.add(extension.id);
    assert.match(extension.repository, /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(extension.commit, /^[a-f0-9]{40}$/);
    assert.match(extension.archiveSha256, /^[A-F0-9]{64}$/);
    assert.ok(Number.isInteger(extension.archiveBytes) && extension.archiveBytes > 0
      && extension.archiveBytes <= 32 * 1024 * 1024);
    assert.ok(extension.displayName && extension.version && extension.license);
    assert.ok(extension.licensePath && !extension.licensePath.split("/").includes(".."));
  }
});

test("catalog clearly retains noncommercial and original notice requirements", () => {
  const helper = catalog.extensions.find(item => item.id === "tavern-helper");
  const whitebox = catalog.extensions.find(item => item.id === "littlewhitebox");
  assert.equal(helper.license, "PolyForm-Noncommercial-1.0.0");
  assert.equal(helper.minimumClientVersion, "1.13.0");
  assert.equal(whitebox.licensePath, "docs/LICENSE.md");
  assert.match(whitebox.license, /attribution/);
});

