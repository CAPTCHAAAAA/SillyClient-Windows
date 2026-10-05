const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test, before, after } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8767/";
let browser;
before(async () => {
  const chrome = process.env.CHROME_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
});
after(async () => { await browser?.close(); });

async function preview(viewport = { width: 1280, height: 900 }, fixture) {
  const page = await browser.newPage({ viewport });
  page.testErrors = [];
  page.on("pageerror", error => page.testErrors.push(error.message));
  if (fixture) {
    await page.addInitScript(options => {
      window.__SILLYCLIENT_PREVIEW_FIXTURE__ = options;
      if (options.instances) localStorage.setItem("sillyclient.instances", JSON.stringify(options.instances));
    }, fixture);
  }
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return route.continue();
    return route.abort();
  });
  await page.goto(`${baseURL}?nativePreview=1`);
  await page.waitForFunction(() => window.__SILLYCLIENT_TEST__ && document.querySelectorAll("[data-card-running]").length === 2);
  await page.waitForTimeout(1800);
  return page;
}

async function openWizard(page) {
  await page.getByRole("button", { name: /新建实例 设置新的酒馆环境/ }).click();
  await page.getByPlaceholder("我的酒馆").waitFor();
  await page.waitForTimeout(650);
  return page.locator(".ios-task-surface").filter({ has: page.getByPlaceholder("我的酒馆") });
}

async function selectExtensions(wizard, names) {
  await wizard.getByRole("button", { name: "预设安装", exact: true }).click();
  await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).waitFor();
  for (const name of names) {
    await wizard.getByRole("switch", { name: `预安装 ${name}`, exact: true }).click();
  }
}

async function waitForSavedInstance(page, name) {
  await page.waitForFunction(subtitle => JSON.parse(localStorage.getItem("sillyclient.instances") || "[]")
    .some(instance => instance.subtitle === subtitle), name);
  return page.evaluate(subtitle => JSON.parse(localStorage.getItem("sillyclient.instances") || "[]")
    .find(instance => instance.subtitle === subtitle), name);
}

test("real React runtime settles with no idle class mutation loop", async () => {
  const page = await preview();
  try {
    const mutations = await page.evaluate(async () => {
      let count = 0;
      const observer = new MutationObserver(records => { count += records.length; });
      observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"] });
      await new Promise(resolve => setTimeout(resolve, 500));
      observer.disconnect();
      return count;
    });
    assert.equal(mutations, 0);
  } finally { await page.close(); }
});

test("stop during provision rejects late ready and prevents immersive entry", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ manualProvision: true }));
    const first = page.locator("[data-card-running]").first();
    await first.click();
    await first.getByRole("button", { name: "启动", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.pending().length === 1);
    const operationId = await page.evaluate(() => window.__SILLYCLIENT_TEST__.pending()[0]);
    await page.getByRole("button", { name: "隐藏", exact: true }).click();
    await page.waitForTimeout(350);
    await first.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForFunction(() => document.querySelector("[data-card-running]")?.dataset.cardRunning === "false");
    await page.evaluate(id => window.__SILLYCLIENT_TEST__.complete(id, true), operationId);
    await page.waitForTimeout(650);
    const state = await page.evaluate(() => ({
      running: document.querySelector("[data-card-running]")?.dataset.cardRunning,
      enters: window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "enterImmersive").length,
    }));
    assert.equal(state.running, "false");
    assert.equal(state.enters, 0);
  } finally { await page.close(); }
});

test("native 10k-line burst stays local and hidden faces stay unsubscribed", async () => {
  const page = await preview({ width: 390, height: 844 });
  try {
    const result = await page.evaluate(async () => {
      const { instanceLogs } = await import("/src/lib/log-store.ts");
      for (let index = 0; index < 10000; index++) {
        window.__SILLYCLIENT_TEST__.emit("log", { instanceId: "preview-local", message: `line-${index}` });
      }
      await new Promise(resolve => setTimeout(resolve, 120));
      return {
        lines: instanceLogs.getSnapshot("preview-local").length,
        first: instanceLogs.getSnapshot("preview-local")[0]?.msg,
        hiddenRows: Array.from(document.querySelectorAll("[data-card-running='false'] [data-native-log-list]")).reduce((sum, list) => sum + list.querySelectorAll("div.whitespace-pre-wrap").length, 0),
        listeners: instanceLogs.buckets.get("preview-local").listeners.size,
      };
    });
    assert.equal(result.lines, 2000);
    assert.equal(result.first, "line-8000");
    assert.equal(result.hiddenRows, 0);
    assert.equal(result.listeners, 0);
  } finally { await page.close(); }
});

test("real drag and tilt listeners coordinate snap ownership without disabling tilt", async () => {
  const page = await preview();
  try {
    const result = await page.evaluate(() => {
      const card = document.querySelector("[data-card-running]");
      const track = card.closest(".carousel-scrollbar-hidden");
      const rect = card.getBoundingClientRect();
      card.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: rect.left + 30, clientY: rect.top + 30 }));
      const tilted = card.style.transform.includes("perspective(900px)");
      track.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 30 }));
      card.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse", relatedTarget: document.body }));
      const duringDrag = track.style.scrollSnapType;
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      return { tilted, duringDrag, restored: track.style.scrollSnapType, returnDuration: card.style.getPropertyValue("--tilt-dur") };
    });
    assert.equal(result.tilted, true);
    assert.equal(result.duringDrag, "none");
    assert.equal(result.restored, "");
    assert.equal(result.returnDuration, "0ms");
  } finally { await page.close(); }
});

test("preinstallation starts off and is inert outside local or copy mode", async () => {
  const page = await preview({ width: 390, height: 844 });
  try {
    const wizard = await openWizard(page);
    assert.equal(await wizard.getByRole("switch").count(), 0);
    await selectExtensions(wizard, []);
    assert.equal(await wizard.getByRole("switch").count(), 5);
    for (const control of await wizard.getByRole("switch").all()) {
      assert.equal(await control.getAttribute("aria-checked"), "false");
    }
    const catalog = JSON.parse(fs.readFileSync(require("node:path").join(__dirname, "../src/data/preinstall-catalog.json"), "utf8"));
    assert.equal(await wizard.getByRole("link", { name: /^https:\/\/github\.com\// }).count(), 4);
    for (const extension of catalog.extensions) {
      const url = `https://github.com/${extension.repository}`;
      const anchor = wizard.getByRole("link", { name: url, exact: true });
      assert.equal(await anchor.getAttribute("href"), url);
      assert.equal(await anchor.textContent(), url);
      assert.equal(await anchor.getAttribute("title"), url);
      assert.ok(extension.license && extension.licensePath);
    }
    await wizard.getByRole("switch", { name: "预安装 酒馆助手", exact: true }).click();
    await wizard.getByRole("button", { name: "远程连接", exact: true }).click();
    await page.waitForTimeout(650);
    assert.equal(await wizard.getByRole("button", { name: "预设安装", exact: true }).count(), 0);
    const inactive = await wizard.locator("[role='switch'][aria-label^='预安装'], [role='switch'][aria-label='使用 SC Bordeaux 主题预设']")
      .evaluateAll(nodes => nodes.every(node => !!node.closest("[inert]")));
    assert.equal(inactive, true);
    await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
    await page.waitForTimeout(650);
    assert.equal(await wizard.getByRole("button", { name: "预设安装", exact: true }).count(), 1);
    await selectExtensions(wizard, []);
    assert.equal(await wizard.getByRole("switch", { name: "预安装 酒馆助手", exact: true }).getAttribute("aria-checked"), "true");
    await wizard.getByRole("button", { name: "原地接管", exact: true }).click();
    await page.waitForTimeout(650);
    assert.equal(await wizard.getByRole("button", { name: "预设安装", exact: true }).count(), 0);
    assert.equal(await wizard.locator("[role='switch'][aria-label^='预安装'], [role='switch'][aria-label='使用 SC Bordeaux 主题预设']")
      .evaluateAll(nodes => nodes.every(node => !!node.closest("[inert]"))), true);
    await wizard.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForTimeout(400);
    const reopened = await openWizard(page);
    await selectExtensions(reopened, []);
    for (const control of await reopened.getByRole("switch").all()) {
      assert.equal(await control.getAttribute("aria-checked"), "false");
    }
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("preinstall extension names and URL ellipses fit with switches aligned to the theme control", async () => {
  for (const viewport of [{ width: 320, height: 720 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const page = await preview(viewport);
    try {
      const wizard = await openWizard(page);
      for (const mode of ["local", "copy"]) {
        if (mode === "copy") {
          await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
          await page.waitForTimeout(650);
        }
        await selectExtensions(wizard, []);
        await page.waitForTimeout(650);
        const theme = await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).boundingBox();
        assert.ok(theme);
        const rows = await wizard.getByRole("switch", { name: /^预安装 / }).evaluateAll(controls =>
          controls.map(control => {
            const row = control.closest(".companion-preset__row");
            return {
              label: control.getAttribute("aria-label"),
              right: control.getBoundingClientRect().right,
              text: Array.from(row.querySelectorAll(".companion-preset__name, .companion-preset__summary")).map(node => ({
                value: node.textContent,
                client: node.clientWidth,
                scroll: node.scrollWidth,
                link: node.tagName === "A",
                whiteSpace: getComputedStyle(node).whiteSpace,
                overflow: getComputedStyle(node).overflowX,
                textOverflow: getComputedStyle(node).textOverflow,
                href: node.getAttribute("href"),
                title: node.getAttribute("title"),
              })),
            };
          }));
        assert.equal(rows.length, 4);
        for (const row of rows) {
          assert.ok(Math.abs(row.right - (theme.x + theme.width)) <= 1,
            `${viewport.width}px ${mode}: ${row.label} switch is not aligned`);
          for (const text of row.text) {
            assert.ok(text.client > 0, `${viewport.width}px ${mode}: ${text.value} has no width`);
            if (text.link) {
              assert.equal(text.whiteSpace, "nowrap");
              assert.equal(text.overflow, "hidden");
              assert.equal(text.textOverflow, "ellipsis");
              assert.equal(text.value, text.href);
              assert.equal(text.title, text.href);
            } else {
              assert.ok(text.scroll <= text.client,
                `${viewport.width}px ${mode}: ${text.value} overflows ${text.client}px`);
            }
          }
        }
      }
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  }
});

test("local provisioning and retry retain captured preinstall selections", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ manualProvision: true }));
    const wizard = await openWizard(page);
    await wizard.getByPlaceholder("我的酒馆").fill("Local preinstall");
    await selectExtensions(wizard, ["酒馆助手", "骰子"]);
    await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).click();
    await wizard.getByRole("button", { name: "创建", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.pending().length === 1);
    const initial = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.find(call => call.method === "provisionAndStart").options);
    assert.deepEqual(initial.preinstall, { revision: 1, extensionIds: ["tavern-helper", "dice"] });
    assert.ok(initial.companionPreset);
    await page.evaluate(id => window.__SILLYCLIENT_TEST__.complete(id, false), initial.operationId);
    await page.getByRole("button", { name: "重试", exact: true }).waitFor();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "provisionAndStart").length === 2);
    const retry = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "provisionAndStart")[1].options);
    assert.notEqual(retry.operationId, initial.operationId);
    assert.deepEqual(retry.preinstall, initial.preinstall);
    assert.deepEqual(retry.companionPreset, initial.companionPreset);
    await page.evaluate(id => window.__SILLYCLIENT_TEST__.complete(id, true), retry.operationId);
    const saved = await waitForSavedInstance(page, "Local preinstall");
    assert.deepEqual(saved.preinstall, initial.preinstall);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("cancel creation is explicit and late readiness cannot register the cancelled instance", async () => {
  const page = await preview({ width: 390, height: 844 });
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ manualProvision: true }));
    const wizard = await openWizard(page);
    await wizard.getByPlaceholder("我的酒馆").fill("Cancelled preinstall");
    await selectExtensions(wizard, ["骰子"]);
    await wizard.getByRole("button", { name: "创建", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.pending().length === 1);
    const operationId = await page.evaluate(() => window.__SILLYCLIENT_TEST__.pending()[0]);
    await page.getByRole("button", { name: "取消创建", exact: true }).click();
    await page.waitForTimeout(400);
    await page.evaluate(id => window.__SILLYCLIENT_TEST__.complete(id, true), operationId);
    await page.waitForTimeout(500);
    const result = await page.evaluate(() => ({
      saved: JSON.parse(localStorage.getItem("sillyclient.instances") || "[]"),
      calls: window.__SILLYCLIENT_TEST__.calls,
    }));
    assert.equal(result.saved.length, 2);
    assert.equal(result.saved.some(instance => instance.subtitle === "Cancelled preinstall"), false);
    assert.equal(result.calls.filter(call => call.method === "enterImmersive").length, 0);
    assert.equal(result.calls.find(call => call.method === "closeTavern").options.operationId, operationId);
    await openWizard(page);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("copy migration retries migration with the original selections", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ failMigration: true }));
    const wizard = await openWizard(page);
    await wizard.getByPlaceholder("我的酒馆").fill("Copy preinstall");
    await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
    await page.waitForTimeout(650);
    await wizard.getByPlaceholder("选择文件夹或 ZIP 文件路径").fill("D:\\Synthetic\\Old");
    await selectExtensions(wizard, ["小白盒", "提示词模板"]);
    await wizard.getByRole("button", { name: "开始复制", exact: true }).click();
    await page.getByRole("button", { name: "重试", exact: true }).waitFor();
    const initial = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.find(call => call.method === "migrateInstance").options);
    assert.equal(initial.mode, "copy");
    assert.deepEqual(initial.preinstall, { revision: 1, extensionIds: ["littlewhitebox", "prompt-template"] });
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ failMigration: false }));
    await page.getByRole("button", { name: "重试", exact: true }).click();
    const saved = await waitForSavedInstance(page, "Copy preinstall");
    const calls = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls);
    const retry = calls.filter(call => call.method === "migrateInstance")[1].options;
    assert.notEqual(retry.operationId, initial.operationId);
    assert.deepEqual(retry.preinstall, initial.preinstall);
    assert.equal(retry.sourcePath, initial.sourcePath);
    assert.equal(calls.filter(call => call.method === "provisionAndStart").length, 0);
    assert.deepEqual(saved.preinstall, initial.preinstall);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("takeover and remote creation discard hidden preset selections", async () => {
  for (const mode of ["takeover", "remote"]) {
    const page = await preview();
    try {
      const wizard = await openWizard(page);
      await wizard.getByPlaceholder("我的酒馆").fill(`No preinstall ${mode}`);
      await selectExtensions(wizard, ["酒馆助手", "小白盒", "提示词模板", "骰子"]);
      await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).click();
      if (mode === "takeover") {
        await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
        await page.waitForTimeout(650);
        await wizard.getByRole("button", { name: "原地接管", exact: true }).click();
        await page.waitForTimeout(650);
        await wizard.getByPlaceholder("选择旧酒馆本地目录").fill("D:\\Synthetic\\Old");
        await wizard.getByRole("button", { name: "开始接管", exact: true }).click();
      } else {
        await wizard.getByRole("button", { name: "远程连接", exact: true }).click();
        await page.waitForTimeout(650);
        await wizard.getByPlaceholder("https://example.com").fill("https://synthetic.test/");
        await wizard.getByRole("button", { name: "创建", exact: true }).click();
      }
      const saved = await waitForSavedInstance(page, `No preinstall ${mode}`);
      assert.equal(saved.preinstall, undefined);
      assert.equal(saved.companionPreset, undefined);
      const calls = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls);
      assert.equal(calls.filter(call => call.method === "provisionAndStart").length, 0);
      if (mode === "takeover") {
        const migration = calls.find(call => call.method === "migrateInstance").options;
        assert.equal(migration.mode, "takeover");
        assert.equal(migration.preinstall, undefined);
      }
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  }
});

test("command logs after stop reach only the instance and rejected commands stay visible", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ manualProvision: true }));
    const first = page.locator("[data-card-running]").first();
    await first.click();
    await first.getByRole("button", { name: "启动", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.pending().length === 1);
    const operationId = await page.evaluate(() => window.__SILLYCLIENT_TEST__.pending()[0]);
    await page.getByRole("button", { name: "隐藏", exact: true }).click();
    await page.waitForTimeout(350);
    await first.getByRole("button", { name: "关闭", exact: true }).click();
    await page.waitForTimeout(650);
    await first.getByRole("button", { name: "操作菜单", exact: true }).click();
    await page.getByRole("button", { name: "管理", exact: true }).click();
    await page.getByRole("button", { name: "实例终端", exact: true }).click();
    const input = page.getByPlaceholder("输入 Windows 命令", { exact: true });
    await input.fill("echo after-stop");
    await input.press("Enter");
    await page.getByText("合成命令已接收: echo after-stop", { exact: true }).waitFor();
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ failCommands: true }));
    await input.fill("echo fail");
    await input.press("Enter");
    await page.getByText("命令失败: Synthetic command failure", { exact: true }).waitFor();
    const result = await page.evaluate(async operationId => {
      const { instanceLogs } = await import("/src/lib/log-store.ts");
      window.__SILLYCLIENT_TEST__.emit("log", { instanceId: "preview-local", operationId, message: "late-old-output" });
      window.__SILLYCLIENT_TEST__.emit("progress", { instanceId: "preview-local", source: "command", stage: "late-progress", percent: 99 });
      window.__SILLYCLIENT_TEST__.emit("ready", { instanceId: "preview-local", source: "command", ready: true });
      window.__SILLYCLIENT_TEST__.emit("mode", { instanceId: "preview-local", source: "command", mode: "launcher", tavernRunning: true });
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        instance: instanceLogs.getSnapshot("preview-local").map(line => line.msg),
        operation: instanceLogs.getSnapshot(`operation:${operationId}`).map(line => line.msg),
        running: document.querySelector("[data-card-running]")?.dataset.cardRunning,
      };
    }, operationId);
    assert.ok(result.instance.some(line => line.includes("合成命令已接收")));
    assert.ok(result.instance.some(line => line.includes("命令失败")));
    assert.equal(result.instance.some(line => /late-old-output|late-progress|就绪/.test(line)), false);
    assert.equal(result.operation.some(line => /after-stop|Synthetic command failure/.test(line)), false);
    assert.equal(result.running, "false");
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("garbage refusal remains visible and retains only failed scanned items", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ failDeletes: ["synthetic/cache-b"] }));
    await page.locator("header button").last().click();
    await page.getByRole("button", { name: "维护", exact: true }).click();
    await page.waitForTimeout(650);
    const row = page.locator(".app-settings-row").filter({ hasText: "临时文件" });
    await row.getByRole("button", { name: "检查", exact: true }).click();
    await page.getByText("合成缓存 A", { exact: true }).waitFor();
    await page.getByRole("button", { name: "全部清理", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Synthetic deletion refusal" }).waitFor();
    assert.equal(await page.getByText("合成缓存 A", { exact: true }).count(), 0);
    assert.equal(await page.getByText("合成缓存 B", { exact: true }).count(), 1);
    const calls = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls);
    const scan = calls.find(call => call.method === "cleanGarbage").options;
    assert.deepEqual(scan.activeInstanceIds, ["preview-local", "preview-second"]);
    assert.ok(calls.filter(call => call.method === "deleteGarbageItem").every(call => call.options.token));
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("scanned cards launch, enter, and retain logs using the native installation identity", async () => {
  const page = await preview({ width: 1280, height: 900 }, {
    instances: [],
    scannedInstanceIds: ["restored-native", "peer-native"],
  });
  try {
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.configure({ manualProvision: true }));
    const saved = await waitForSavedInstance(page, "restored-native");
    assert.equal(saved.id, "scan-restored-native");
    assert.equal(saved.installDir, "restored-native");
    const card = page.locator("[data-card-running]").filter({ hasText: "restored-native" });
    const peer = page.locator("[data-card-running]").filter({ hasText: "peer-native" });
    await card.click();
    await card.getByRole("button", { name: "启动", exact: true }).click();
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.pending().length === 1);
    const provision = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.find(call => call.method === "provisionAndStart").options);
    assert.equal(provision.instanceId, "restored-native");
    await page.evaluate(id => window.__SILLYCLIENT_TEST__.complete(id, true), provision.operationId);
    await page.waitForFunction(() => window.__SILLYCLIENT_TEST__.calls.some(call => call.method === "enterImmersive"));
    const entered = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.find(call => call.method === "enterImmersive").options);
    assert.equal(entered.instanceId, "restored-native");
    await page.waitForTimeout(1200);
    await page.evaluate(operationId => window.__SILLYCLIENT_TEST__.emit("log", {
      instanceId: "restored-native", operationId, message: "restored-native-log",
    }), provision.operationId);
    await card.getByText("restored-native-log", { exact: true }).waitFor();
    const keys = await page.evaluate(async () => {
      const { instanceLogs } = await import("/src/lib/log-store.ts");
      return {
        native: instanceLogs.getSnapshot("restored-native").map(line => line.msg),
        ui: instanceLogs.getSnapshot("scan-restored-native").map(line => line.msg),
      };
    });
    assert.ok(keys.native.includes("restored-native-log"));
    assert.equal(keys.ui.includes("restored-native-log"), false);
    await page.evaluate(operationId => window.__SILLYCLIENT_TEST__.emit("mode", {
      instanceId: "scan-restored-native", operationId, mode: "launcher", tavernRunning: false,
    }), provision.operationId);
    await page.waitForTimeout(100);
    assert.equal(await card.getAttribute("data-card-running"), "true");
    assert.equal(await peer.getAttribute("data-card-running"), "false");
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("status and mode restore only the matching native identity, never another card's alias or port", async () => {
  const record = (id, installDir, subtitle) => ({
    id, installDir, subtitle, name: "SillyTavern", type: "local", status: "stopped",
    version: "1.19.0", port: 8000, color: "#6366f1",
    createdAt: "2026-10-03", lastUsed: "-", totalUsage: "0s",
  });
  const page = await preview({ width: 390, height: 844 }, {
    instances: [
      record("other-native", "first-native", "First native"),
      record("ui-second", "other-native", "Second native"),
    ],
    scannedInstanceIds: ["first-native", "other-native"],
    status: {
      serverReady: true, mode: "launcher", instanceId: "other-native",
      operationId: "restored-operation", url: "http://127.0.0.1:8000/",
    },
  });
  try {
    const first = page.locator("[data-card-running]").filter({ hasText: "First native" });
    const second = page.locator("[data-card-running]").filter({ hasText: "Second native" });
    assert.equal(await first.getAttribute("data-card-running"), "false");
    assert.equal(await second.getAttribute("data-card-running"), "true");
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.emit("mode", {
      instanceId: "other-native", mode: "launcher", tavernRunning: true,
    }));
    await page.waitForTimeout(100);
    assert.equal(await first.getAttribute("data-card-running"), "false");
    assert.equal(await second.getAttribute("data-card-running"), "true");
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.emit("mode", {
      mode: "launcher", tavernRunning: false,
    }));
    await page.waitForTimeout(100);
    assert.equal(await second.getAttribute("data-card-running"), "true");
    await page.evaluate(() => window.__SILLYCLIENT_TEST__.emit("mode", {
      instanceId: "other-native", mode: "launcher", tavernRunning: false,
    }));
    await page.waitForTimeout(100);
    assert.equal(await first.getAttribute("data-card-running"), "false");
    assert.equal(await second.getAttribute("data-card-running"), "false");
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});
