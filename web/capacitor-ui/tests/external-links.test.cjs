const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const plain = value => JSON.parse(JSON.stringify(value));

function fixture(isNative = true) {
  const calls = [];
  const popups = [];
  const store = new Map();
  const window = {
    __SILLYCLIENT_PREVIEW_FIXTURE__: {
      status: { serverReady: true, mode: "tavern", instanceId: "kept-native", operationId: "kept-operation", url: "http://127.0.0.1:8000/" },
    },
    open: (...args) => { popups.push(args); },
  };
  const localStorage = {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const modules = new Map();
  function load(filename) {
    filename = path.resolve(filename);
    if (modules.has(filename)) return modules.get(filename).exports;
    const module = { exports: {} };
    modules.set(filename, module);
    const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    assert.deepEqual(compiled.diagnostics, []);
    vm.runInNewContext(compiled.outputText, {
      module, exports: module.exports, window, localStorage, URL, setTimeout,
      require: name => {
        if (name === "@capacitor/core") return { Capacitor: { isNativePlatform: () => isNative } };
        if (name === "../capacitor-plugin") return {
          TarvenEnv: {
            openExternalUrl: async options => calls.push(plain(options)),
            enterImmersive: () => assert.fail("An external link must never enter Tavern"),
          },
        };
        assert.ok(name.startsWith("."), `Unexpected dependency ${name}`);
        return load(path.resolve(path.dirname(filename), `${name}.ts`));
      },
    }, { filename });
    return module.exports;
  }
  return { load, calls, popups, window };
}

test("external addresses accept only absolute credential-free HTTP(S) URLs", () => {
  const { load } = fixture();
  const { validateExternalUrl } = load(path.join(root, "src/lib/external-url.ts"));
  assert.equal(validateExternalUrl(" HTTPS://EXAMPLE.TEST:443/path?q=value#section "), "https://example.test/path?q=value#section");
  assert.equal(validateExternalUrl("http://[::1]:8000/"), "http://[::1]:8000/");
  for (const value of [
    null, 1, "", "https://", "https:///missing-host", "//example.test", "http:example.test",
    "javascript:alert(1)", "data:text/html,test", "file:///private", "intent://browser",
    "https://alice:secret@example.test", "https://alice@example.test", "https://@example.test",
    "https://example.test:65536", "https://example.test/\npath", "https://example.test\\path",
  ]) {
    assert.throws(() => validateExternalUrl(value), { name: "Error" });
  }
});

test("native external helper uses the additive bridge without opening a popup", async () => {
  const { load, calls, popups } = fixture();
  const { openExternalUrl } = load(path.join(root, "src/lib/external-links.ts"));
  await openExternalUrl("https://github.com/CAPTCHAAAAA/SillyClient");
  assert.deepEqual(calls, [{ url: "https://github.com/CAPTCHAAAAA/SillyClient" }]);
  assert.deepEqual(popups, []);
  for (const url of ["file:///private", "https://alice:secret@example.test"]) {
    await assert.rejects(openExternalUrl(url));
  }
  assert.equal(calls.length, 1);
});

test("web external helper opens the browser synchronously with opener isolation", async () => {
  const { load, calls, popups } = fixture(false);
  const { openExternalUrl } = load(path.join(root, "src/lib/external-links.ts"));
  const result = openExternalUrl("https://github.com/CAPTCHAAAAA/SillyClient");
  assert.deepEqual(popups, [["https://github.com/CAPTCHAAAAA/SillyClient", "_blank", "noopener,noreferrer"]]);
  await result;
  assert.deepEqual(calls, []);
});

test("anchor activation prevents document navigation and parent control activation", async () => {
  const { load, calls } = fixture();
  const { handleExternalLink } = load(path.join(root, "src/lib/external-links.ts"));
  const url = "https://github.com/SillyTavern/Extension-Dice";
  for (const type of ["click", "auxclick"]) {
    const events = [];
    handleExternalLink({
      type, button: type === "auxclick" ? 1 : 0,
      preventDefault: () => events.push("default"),
      stopPropagation: () => events.push("propagation"),
    }, url);
    assert.deepEqual(events, ["default", "propagation"]);
  }
  assert.equal(calls.length, 2);
  handleExternalLink({
    type: "auxclick", button: 2,
    preventDefault: () => assert.fail("Context menus remain native"),
    stopPropagation: () => assert.fail("Context menus remain native"),
  }, url);
  assert.equal(calls.length, 2);
});

test("native preview records external links and legacy external entry without changing the active instance", async () => {
  const { load, popups, window } = fixture();
  const { nativePreview, installNativePreview } = load(path.join(root, "src/dev/native-preview.ts"));
  installNativePreview();
  const before = plain(await nativePreview.getStatus());
  await nativePreview.openExternalUrl({ url: "https://github.com/N0VI028/JS-Slash-Runner" });
  await nativePreview.enterImmersive({ url: "https://github.com/CAPTCHAAAAA/SillyClient/releases/latest" });
  assert.deepEqual(plain(await nativePreview.getStatus()), before);
  assert.deepEqual(popups, []);
  assert.equal(window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "openExternalUrl").length, 2);
  await assert.rejects(nativePreview.openExternalUrl({ url: "https://alice:secret@example.test" }));
  assert.equal(window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "openExternalUrl").length, 2);
});

test("project anchors retain catalog licenses and external callbacks never use immersive navigation", () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "src/data/preinstall-catalog.json"), "utf8"));
  assert.equal(catalog.extensions.length, 4);
  assert.ok(catalog.extensions.every(extension => extension.license && extension.licensePath && /^[\w.-]+\/[\w.-]+$/.test(extension.repository)));
  for (const filename of ["src/routes/index.tsx", "src/components/modals/AppSettingsDrawer.tsx", "src/components/instance/PreinstallOptions.tsx"]) {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    assert.ok(source.includes("external-links"));
    assert.ok(!source.includes("window.open("), filename);
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "TarvenEnv.enterImmersive") {
        const options = node.arguments[0];
        assert.ok(ts.isObjectLiteralExpression(options));
        assert.ok(options.properties.some(property => property.name?.getText(ast) === "instanceId"), filename);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  const component = fs.readFileSync(path.join(root, "src/components/instance/PreinstallOptions.tsx"), "utf8");
  assert.match(component, /<a[\s\S]*?href=\{projectUrl\}/);
  assert.ok(component.includes('target="_blank"') && component.includes('rel="noopener noreferrer"'));
  assert.ok(component.includes("underline") && component.includes("onClick={event => handleExternalLink"));
  assert.ok(component.includes("max-w-full truncate") && component.includes("title={projectUrl}"));
  assert.match(component, /<a[\s\S]*?>\s*\{projectUrl\}\s*<\/a>/);
});

test("Android wiring scopes navigation to the dedicated view and preserves download and gateway hooks", () => {
  const android = path.resolve(root, "../../../release-hardening-android");
  const activity = fs.readFileSync(path.join(android, "app/src/main/java/com/sillyclient/MainActivity.kt"), "utf8");
  const plugin = fs.readFileSync(path.join(android, "app/src/main/java/com/sillyclient/plugin/TarvenEnvPlugin.kt"), "utf8");
  const popup = fs.readFileSync(path.join(android, "app/src/main/java/com/sillyclient/navigation/ExternalPopupHandler.kt"), "utf8");
  const enter = activity.slice(activity.indexOf("fun enterTavern("), activity.indexOf("/** 判断是否本地"));
  assert.ok(enter.indexOf("instanceId.isNullOrBlank()") < enter.indexOf("if (isWebViewVisible)"));
  assert.ok(enter.indexOf("openExternalUrl(targetUrl)") < enter.indexOf("currentTavernInstanceId = requestedInstanceId"));
  assert.ok(plugin.indexOf("instanceId == null && target != null") < plugin.indexOf("val credentials = instanceId?.let"));
  assert.ok(activity.includes("request.isForMainFrame"));
  assert.ok(activity.includes("tavernStaticGateway.shouldInterceptRequest(request)"));
  assert.ok(activity.includes('addJavascriptInterface(tavernDownloadBridge, "SillyClientAndroidDownloads")'));
  assert.ok(activity.includes("requestTavernUrlDownload(url, contentDisposition, mimeType, contentLength)"));
  assert.ok(activity.includes("Intent.CATEGORY_APP_BROWSER"));
  assert.ok(popup.includes("settings.javaScriptEnabled = false") && popup.includes("settings.blockNetworkLoads = true"));
  assert.ok(popup.includes("handler.removeCallbacks(timeout)") && popup.includes("view.destroy()"));
  assert.ok(popup.includes("ViewGroup.LayoutParams(0, 0)") && popup.includes("removeView(view)"));
  assert.ok(popup.includes("isFocusable = false") && popup.includes("onCloseWindow"));
  assert.ok(!popup.includes("addJavascriptInterface") && !popup.includes("loadUrl("));
});
