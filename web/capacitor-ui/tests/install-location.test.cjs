const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { loadSource } = require("./load-source.cjs");

const location = loadSource(path.join(__dirname, "../src/lib/install-location.ts"));
const plain = value => JSON.parse(JSON.stringify(value));

test("installation selection preserves the full path, never the display name", () => {
  for (const selectedPath of [
    "D:\\Taverns\\Same name",
    "/data/user/0/com.sillyclient/files/tarven/installations",
    "/private/var/mobile/Containers/Data/Application/test/Documents/Custom",
  ]) {
    assert.deepEqual(plain(location.installationSelection({ name: "Same name", path: selectedPath })),
      { path: selectedPath, mode: "exact" });
  }
});

test("path quotes normalize without damaging spaces or platform separators", () => {
  assert.equal(location.cleanInstallPath('  "D:\\Taverns\\My Tavern"  '), "D:\\Taverns\\My Tavern");
  assert.equal(location.cleanInstallPath(" '/private/My Tavern' "), "/private/My Tavern");
  assert.equal(location.cleanInstallPath(""), undefined);
});

test("missing picker path cannot silently fall back to a folder name", () => {
  for (const path of ["", "  ", undefined]) {
    assert.throws(() => location.installationSelection({ name: "Tavern", path }));
  }
});

test("installation modes are explicit and invalid modes are rejected", () => {
  assert.equal(location.installationSelection({ path: "/root/exact", installPathMode: "exact" }).mode, "exact");
  assert.throws(() => location.installationSelection({ path: "/root", installPathMode: "guess" }));
});

test("only an explicit root selection adds the dedicated instance folder", () => {
  const selected = location.installationSelection({ path: "/external/Selected", installPathMode: "root" });
  assert.equal(selected.mode, "root");
  assert.equal(location.exactInstallTarget(selected.path, selected.mode, "New instance"), "/external/Selected/New instance");
  const exact = location.installationSelection({ path: "/external/Selected" });
  assert.equal(location.exactInstallTarget(exact.path, exact.mode, "New instance"), "/external/Selected");
});

test("a selected root produces an immediate child without changing identity", () => {
  assert.equal(location.exactInstallTarget("D:\\Custom\\", "root", "local-100"), "D:\\Custom\\local-100");
  assert.equal(location.exactInstallTarget("/private/Custom/", "root", "local-100"), "/private/Custom/local-100");
  assert.equal(location.exactInstallTarget("/", "root", "local-100"), "/local-100");
  assert.equal(location.exactInstallTarget("D:\\Custom\\chosen-name", "exact", "local-100"), "D:\\Custom\\chosen-name");
  assert.equal(location.exactInstallTarget("", "root", "local-100"), undefined);
});

test("a same-named parent never substitutes for a new instance directory", () => {
  assert.equal(location.buildInstanceSubfolder("/storage/My Tavern", "My Tavern"), "/storage/My Tavern/My Tavern");
  assert.equal(location.buildInstanceSubfolder("D:\\Tavern\\", "Tavern"), "D:\\Tavern\\Tavern");
  assert.equal(location.buildInstanceSubfolder("/", "Tavern"), "/Tavern");
});

test("relocation preserves the physical directory name under the selected parent", () => {
  assert.equal(location.relocationTargetInParent("/storage/New", "/storage/Old/Actual name"), "/storage/New/Actual name");
  assert.equal(location.relocationTargetInParent("/storage/Actual name", "/storage/Old/Actual name"), "/storage/Actual name/Actual name");
  assert.equal(location.relocationTargetInParent(" '/storage/New/' ", "/storage/Old/Original?name"), "/storage/New/Original?name");
  assert.equal(location.relocationTargetInParent("/", "/storage/Old/Tavern"), "/Tavern");
  assert.equal(location.relocationTargetInParent("E:\\Taverns\\", "D:\\Old\\Actual name"), "E:\\Taverns\\Actual name");
});

test("relocation rejects a missing parent or unresolved physical directory", () => {
  for (const [parent, source] of [["", "/storage/Old/Tavern"], ["/storage/New", ""], ["/storage/New", "/"], ["/storage/New", ".."]]) {
    assert.throws(() => location.relocationTargetInParent(parent, source));
  }
  assert.throws(() => location.relocationTargetInParent("content://provider/tree/test", "/storage/Old/Tavern"));
  assert.throws(() => location.relocationTargetInParent("/storage/New", "content://provider/tree/test"));
});

test("document-provider URIs cannot be disguised as executable install paths", () => {
  assert.throws(() => location.installationSelection({ path: "content://provider/tree/test" }));
  assert.throws(() => location.exactInstallTarget("content://provider/tree/test", "exact", "local-100"));
});

test("validateInstallPathInput rejects URIs, breadcrumb labels, relative iOS paths, and parent traversals", () => {
  assert.equal(location.validateInstallPathInput("", { isIOS: true }), null);
  assert.equal(location.validateInstallPathInput("/var/mobile/Containers/Data/SillyClient", { isIOS: true }), null);
  assert.match(
    location.validateInstallPathInput("我的 iPhone ▸ SillyClient", { isIOS: true }),
    /浏览/
  );
  assert.match(
    location.validateInstallPathInput("relative/path", { isIOS: true }),
    /浏览/
  );
  assert.match(
    location.validateInstallPathInput("/var/mobile/../escape", { isIOS: true }),
    /\.\./
  );
  assert.match(
    location.validateInstallPathInput("content://com.android.externalstorage/tree", { isIOS: false }),
    /本地路径/
  );
  assert.match(
    location.validateInstallPathInput("C:\\Users\\test\\..\\escape", { isIOS: false }),
    /\.\./
  );
  assert.equal(location.validateInstallPathInput("D:\\Tavern\\Instances\\demo", { isIOS: false }), null);

  assert.equal(location.normalizeInstanceIdentity("测试中文", "fallback-id"), "fallback-id");
  assert.equal(location.normalizeInstanceIdentity("My Instance 01"), "My-Instance-01");
});

test("iOS picker hides only its explicit cancellation code, not provider errors or unexpected dismissals", () => {
  assert.equal(location.shouldShowDirectoryPickerError({ code: "PICKER_CANCELLED", message: "Selection cancelled" }, true), false);
  assert.equal(location.shouldShowDirectoryPickerError(new Error("PICKER_CANCELLED"), true), false);
  assert.equal(location.shouldShowDirectoryPickerError({ code: "PICKER_DISMISSED_WITHOUT_RESULT", message: "PICKER_DISMISSED_WITHOUT_RESULT" }, true), true);
  assert.equal(location.shouldShowDirectoryPickerError(new Error("PICKER_DISMISSED_WITHOUT_RESULT"), true), true);
  assert.equal(location.shouldShowDirectoryPickerError(new Error("NSFileProviderError: operation cancelled by provider"), true), true);
  assert.equal(location.shouldShowDirectoryPickerError(new Error("Selection cancelled"), true), true);
});
