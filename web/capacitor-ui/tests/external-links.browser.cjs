const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/data/preinstall-catalog.json"), "utf8"));
const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8767/";
const releaseUrl = "https://github.com/CAPTCHAAAAA/SillyClient/releases/latest";
let browser;

before(async () => {
  const chrome = process.env.CHROME_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}) });
});
after(async () => { await browser?.close(); });

async function preview(viewport = { width: 1280, height: 900 }, contentOpenMode = "webview") {
  const page = await browser.newPage({ viewport });
  page.errors = [];
  page.actualPopups = [];
  page.on("pageerror", error => page.errors.push(error.message));
  page.on("popup", popup => {
    page.actualPopups.push(popup.url());
    void popup.close();
  });
  await page.addInitScript(contentOpenMode => {
    window.__EXTERNAL_POPUPS__ = [];
    window.open = (...args) => { window.__EXTERNAL_POPUPS__.push(args); return null; };
    window.__SILLYCLIENT_PREVIEW_FIXTURE__ = {
      contentOpenMode,
      status: {
        serverReady: true, mode: "launcher", instanceId: "preview-local",
        operationId: "kept-operation", url: "http://127.0.0.1:8000/",
      },
    };
  }, contentOpenMode);
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto(`${baseURL}?nativePreview=1`);
  await page.waitForFunction(() => window.__SILLYCLIENT_TEST__ && document.querySelectorAll("[data-card-running]").length === 2);
  await page.waitForTimeout(1800);
  return page;
}

async function currentStatus(page) {
  return page.evaluate(async () => (await import("/src/capacitor-plugin.ts")).TarvenEnv.getStatus());
}

async function externalCalls(page) {
  return page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "openExternalUrl").map(call => call.options.url));
}

async function assertKeptView(page, before, documentUrl) {
  assert.equal(page.url(), documentUrl);
  assert.deepEqual(await currentStatus(page), before);
  assert.equal(await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "enterImmersive").length), 0);
  assert.deepEqual(await page.evaluate(() => window.__EXTERNAL_POPUPS__), []);
  assert.deepEqual(page.actualPopups, []);
  assert.deepEqual(page.errors, []);
}

async function openSettings(page) {
  await page.locator("header button").last().click();
  const drawer = page.locator(".app-settings-surface");
  await drawer.waitFor();
  await page.waitForTimeout(650);
  return drawer;
}

for (const width of [320, 390, 1280]) {
  test(`project links are real underlined anchors and preserve the wizard at ${width}px`, async () => {
    const page = await preview({ width, height: width === 1280 ? 900 : 844 });
    try {
      const before = await currentStatus(page);
      const documentUrl = page.url();
      await page.getByRole("button", { name: /新建实例 设置新的酒馆环境/ }).click();
      const wizard = page.locator(".ios-task-surface").filter({ has: page.getByPlaceholder("我的酒馆") });
      await wizard.getByPlaceholder("我的酒馆").fill("Kept project-link draft");
      await page.waitForTimeout(650);
      for (const mode of ["local", "copy"]) {
        if (mode === "copy") {
          await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
          await page.waitForTimeout(650);
        }
        await wizard.getByRole("button", { name: "预制安装", exact: true }).click();
        await wizard.getByRole("switch", { name: "预安装 酒馆助手", exact: true }).click();
        const selection = await wizard.getByRole("switch").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-checked")));
        const links = wizard.getByRole("link", { name: /^https:\/\/github\.com\// });
        assert.equal(await links.count(), 4);
        const callCount = (await externalCalls(page)).length;
        for (const [index, extension] of catalog.extensions.entries()) {
          const link = links.nth(index);
          const attrs = await link.evaluate(anchor => ({
            href: anchor.href, target: anchor.target, rel: anchor.rel,
            text: anchor.textContent, title: anchor.title,
            underline: getComputedStyle(anchor).textDecorationLine.includes("underline"),
            whiteSpace: getComputedStyle(anchor).whiteSpace,
            overflow: getComputedStyle(anchor).overflowX,
            textOverflow: getComputedStyle(anchor).textOverflow,
          }));
          assert.deepEqual(attrs, {
            href: `https://github.com/${extension.repository}`, target: "_blank",
            text: `https://github.com/${extension.repository}`, title: `https://github.com/${extension.repository}`,
            rel: "noopener noreferrer", underline: true,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          });
          const dimensions = await link.evaluate(anchor => {
            const toggle = anchor.closest(".companion-preset__row").querySelector("[role='switch']");
            const rect = anchor.getBoundingClientRect();
            const toggleRect = toggle.getBoundingClientRect();
            return {
              width: anchor.clientWidth,
              right: rect.right, switchLeft: toggleRect.left,
              switchRight: toggleRect.right,
              lineHeight: Number.parseFloat(getComputedStyle(anchor).lineHeight),
              height: rect.height,
            };
          });
          const theme = await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).boundingBox();
          assert.ok(dimensions.width > 0 && dimensions.right <= dimensions.switchLeft);
          assert.ok(dimensions.height <= dimensions.lineHeight + 1, `${width}px URL must remain a single line`);
          assert.ok(Math.abs(dimensions.switchRight - (theme.x + theme.width)) <= 1);
          await link.click();
        }
        await links.first().focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(expected => window.__SILLYCLIENT_TEST__.calls.filter(call => call.method === "openExternalUrl").length === expected, callCount + 5);
        assert.deepEqual((await externalCalls(page)).slice(callCount), [
          ...catalog.extensions.map(extension => `https://github.com/${extension.repository}`),
          `https://github.com/${catalog.extensions[0].repository}`,
        ]);
        assert.deepEqual(await wizard.getByRole("switch").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-checked"))), selection);
        assert.equal(await wizard.getByPlaceholder("我的酒馆").inputValue(), "Kept project-link draft");
        assert.equal(await wizard.getByRole("button", { name: "预制安装", exact: true }).getAttribute("aria-expanded"), "true");
        await assertKeptView(page, before, documentUrl);
      }
    } finally { await page.close(); }
  });
}

for (const mode of ["webview", "browser"]) {
  test(`project and update links ignore the ${mode} Tavern open mode`, async () => {
    const page = await preview({ width: 1280, height: 900 }, mode);
    try {
      const before = await currentStatus(page);
      const documentUrl = page.url();
      await page.getByRole("button", { name: "查看", exact: true }).click();
      let settings = await openSettings(page);
      const toggle = settings.locator(".app-settings-row").filter({ hasText: "系统浏览器" }).getByRole("switch");
      assert.equal(await toggle.getAttribute("aria-checked"), String(mode === "browser"));
      await toggle.click();
      await toggle.click();
      const selected = await page.evaluate(async () => (await import("/src/capacitor-plugin.ts")).TarvenEnv.getContentOpenMode());
      assert.equal(selected.mode, mode);
      await settings.getByRole("button", { name: "维护", exact: true }).click();
      await page.waitForTimeout(650);
      await settings.getByRole("button", { name: "项目发布页 查看安装包、更新说明与项目动态" }).click();
      await page.waitForTimeout(650);
      settings = await openSettings(page);
      await settings.getByRole("button", { name: "维护", exact: true }).click();
      await page.waitForTimeout(650);
      await settings.getByRole("button", { name: "查看", exact: true }).click();
      await page.waitForTimeout(650);
      assert.deepEqual(await externalCalls(page), [
        releaseUrl, "https://captchaaaaa.github.io/SillyClient/", releaseUrl,
      ]);
      await assertKeptView(page, before, documentUrl);
    } finally { await page.close(); }
  });
}

test("invalid native links and legacy immersive external entry preserve the active native state", async () => {
  const page = await preview();
  try {
    const before = await currentStatus(page);
    const documentUrl = page.url();
    const rejected = await page.evaluate(async () => {
      const { TarvenEnv } = await import("/src/capacitor-plugin.ts");
      const invalid = ["file:///private", "javascript:alert(1)", "data:text/html,test", "https://alice:secret@example.test", "https://"];
      const outcomes = [];
      for (const url of invalid) {
        try { await TarvenEnv.openExternalUrl({ url }); outcomes.push(false); }
        catch { outcomes.push(true); }
      }
      await TarvenEnv.enterImmersive({ url: "https://github.com/CAPTCHAAAAA/SillyClient/releases/latest" });
      return outcomes;
    });
    assert.deepEqual(rejected, [true, true, true, true, true]);
    assert.deepEqual(await currentStatus(page), before);
    assert.equal(page.url(), documentUrl);
    assert.deepEqual(await externalCalls(page), [releaseUrl]);
    assert.deepEqual(await page.evaluate(() => window.__EXTERNAL_POPUPS__), []);
    assert.deepEqual(page.actualPopups, []);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});
