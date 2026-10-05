const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8767/";
const phase = process.env.SCROLL_LAYOUT_PHASE || "after";
const evidenceDir = process.env.SCROLL_LAYOUT_EVIDENCE
  || "D:/BACKUP/Project/SillyClient/Local/evidence/release-hardening-20261003/output/playwright";
const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }];
let browser;

before(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const chrome = process.env.CHROME_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({
    headless: true,
    ignoreDefaultArgs: ["--hide-scrollbars"],
    args: ["--disable-features=OverlayScrollbar,OverlayScrollbars,FluentOverlayScrollbar"],
    ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}),
  });
});
after(async () => { await browser?.close(); });

function record(name, value) {
  fs.appendFileSync(path.join(evidenceDir, `scroll-layout-${phase}.jsonl`),
    `${JSON.stringify({ name, ...value })}\n`);
}

async function preview(viewport, hasTouch = false) {
  const page = await browser.newPage({ viewport, hasTouch });
  page.testErrors = [];
  page.on("pageerror", error => page.testErrors.push(error.message));
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto(`${baseURL}?nativePreview=1`);
  await page.waitForFunction(() => window.__SILLYCLIENT_TEST__
    && document.querySelectorAll("[data-card-running]").length === 2);
  await page.waitForTimeout(1000);
  const classicGutter = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:-1000px;top:0;width:80px;height:20px;overflow:scroll";
    document.body.append(probe);
    const gutter = probe.offsetWidth - probe.clientWidth;
    probe.remove();
    return gutter;
  });
  assert.ok(classicGutter > 0, "The browser must expose classic, space-consuming scrollbars");
  record(`classic-${viewport.width}`, { classicGutter });
  return page;
}

async function openWizard(page) {
  await page.getByRole("button", { name: /新建实例 设置新的酒馆环境/ }).click();
  const wizard = page.locator(".ios-task-surface").filter({ has: page.getByPlaceholder("我的酒馆") });
  await wizard.waitFor();
  await page.waitForTimeout(650);
  return wizard;
}

async function metrics(page, wizard) {
  const home = await page.evaluate(() => {
    const launcher = document.querySelector("div.min-h-screen.overflow-y-auto");
    const search = document.querySelector("input[placeholder='搜索并打开实例']");
    const main = document.querySelector("main");
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, clientWidth: node.clientWidth };
    };
    const chrome = node => ({
      width: getComputedStyle(node).scrollbarWidth,
      webkit: getComputedStyle(node, "::-webkit-scrollbar").display,
      overflowY: getComputedStyle(node).overflowY,
      gutter: node.offsetWidth - node.clientWidth,
    });
    return {
      documentWidth: document.documentElement.clientWidth,
      documentChrome: chrome(document.documentElement),
      bodyChrome: chrome(document.body),
      launcher: rect(launcher),
      launcherChrome: chrome(launcher),
      main: rect(main),
      search: rect(search),
      scrollTop: document.scrollingElement.scrollTop,
    };
  });
  if (!wizard) return home;
  const form = await wizard.evaluate(surface => {
    const scroll = surface.querySelector(".flex-1.overflow-y-auto");
    const name = surface.querySelector("input[placeholder='我的酒馆']");
    const rect = node => {
      const box = node.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, clientWidth: node.clientWidth };
    };
    return {
      surface: rect(surface),
      scroll: rect(scroll),
      name: rect(name),
      chrome: {
        width: getComputedStyle(scroll).scrollbarWidth,
        webkit: getComputedStyle(scroll, "::-webkit-scrollbar").display,
        overflowY: getComputedStyle(scroll).overflowY,
        gutter: scroll.offsetWidth - scroll.clientWidth,
      },
      maxScroll: scroll.scrollHeight - scroll.clientHeight,
      scrollTop: scroll.scrollTop,
    };
  });
  return { ...home, form };
}

function stable(values, label) {
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread <= 1, `${label} changed by ${spread}px: ${values.join(", ")}`);
}

function hidden(chrome, label) {
  assert.equal(chrome.width, "none", `${label}: scrollbar-width`);
  assert.equal(chrome.webkit, "none", `${label}: WebKit scrollbar display`);
  assert.equal(chrome.gutter, 0, `${label}: visible scrollbar gutter`);
}

async function footerReachable(page, wizard, viewport) {
  const cancel = wizard.getByRole("button", { name: "取消", exact: true });
  const box = await cancel.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= viewport.height, "Footer must remain in the viewport");
  const hit = await cancel.evaluate(button => {
    const box = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
  });
  assert.equal(hit, true, "Footer must remain clickable");
}

for (const viewport of viewports) {
  test(`wizard overflow stays stable and natively scrollable at ${viewport.width}px`, async () => {
    const page = await preview(viewport);
    try {
      const wizard = await openWizard(page);
      const snapshots = [{ step: "collapsed", value: await metrics(page, wizard) }];
      const toggle = wizard.getByRole("button", { name: "预设安装", exact: true });
      await toggle.click();
      await page.waitForTimeout(750);
      snapshots.push({ step: "expanded", value: await metrics(page, wizard) });
      const theme = wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" });
      const themeBefore = await theme.boundingBox();
      await theme.click();
      await page.waitForTimeout(650);
      const themeAfter = await theme.boundingBox();
      snapshots.push({ step: "theme-details", value: await metrics(page, wizard) });
      await footerReachable(page, wizard, viewport);
      await toggle.click();
      await page.waitForTimeout(750);
      snapshots.push({ step: "collapsed-again", value: await metrics(page, wizard) });
      await wizard.getByRole("button", { name: "远程连接", exact: true }).click();
      await page.waitForTimeout(650);
      snapshots.push({ step: "remote", value: await metrics(page, wizard) });
      assert.equal(await wizard.getByRole("button", { name: "预设安装", exact: true }).count(), 0);
      const inactive = await wizard.locator("[aria-label^='预安装']").evaluateAll(controls =>
        controls.every(control => !!control.closest("[inert]")));
      assert.equal(inactive, true);
      await wizard.getByRole("button", { name: "数据迁移", exact: true }).click();
      await page.waitForTimeout(650);
      await wizard.getByPlaceholder("选择文件夹或 ZIP 文件路径").fill("D:\\Synthetic\\Old");
      await wizard.getByRole("button", { name: "预设安装", exact: true }).click();
      await wizard.locator("button[title='重要提示：点击查看私有凭据说明']:visible").click();
      await page.waitForTimeout(750);
      snapshots.push({ step: "copy-expanded", value: await metrics(page, wizard) });
      record(`wizard-geometry-${viewport.width}`, { snapshots, themeBefore, themeAfter });
      await page.screenshot({ path: path.join(evidenceDir, `${phase}-scroll-wizard-${viewport.width}.png`) });
      const scroll = wizard.locator(".flex-1.overflow-y-auto");
      const overflow = await scroll.evaluate(node => node.scrollHeight - node.clientHeight);
      assert.ok(overflow > 0, "The real copy form must overflow for the scrolling checks");
      await scroll.evaluate(node => { node.scrollTop = 0; });
      const scrollBox = await scroll.boundingBox();
      await page.mouse.move(scrollBox.x + scrollBox.width - 10, scrollBox.y + scrollBox.height / 2);
      await page.mouse.wheel(0, 1000);
      await page.waitForFunction(() => {
        const input = document.querySelector("input[placeholder='我的酒馆']");
        return input.closest(".ios-task-surface").querySelector(".flex-1.overflow-y-auto").scrollTop > 0;
      });
      const wheelTop = await scroll.evaluate(node => node.scrollTop);
      assert.ok(wheelTop > 0);
      const finalSwitch = wizard.getByRole("switch", { name: "预安装 骰子", exact: true });
      await finalSwitch.scrollIntoViewIfNeeded();
      assert.equal(await finalSwitch.evaluate(button => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      }), true, "Last control must be reachable");
      await footerReachable(page, wizard, viewport);
      await scroll.evaluate(node => { node.scrollTop = 0; });
      await wizard.getByPlaceholder("我的酒馆").focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("PageDown");
      await page.waitForFunction(() => {
        const input = document.querySelector("input[placeholder='我的酒馆']");
        return input.closest(".ios-task-surface").querySelector(".flex-1.overflow-y-auto").scrollTop > 0;
      });
      const keyboardTop = await scroll.evaluate(node => node.scrollTop);
      await page.keyboard.press("Control+Home");
      await scroll.evaluate(node => { node.scrollTop = 0; });
      assert.equal(await wizard.getByPlaceholder("我的酒馆").evaluate(input => {
        const box = input.getBoundingClientRect();
        return input.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      }), true, "First field must remain reachable");
      record(`wizard-${viewport.width}`, { snapshots, themeBefore, themeAfter, wheelTop, keyboardTop });
      stable(snapshots.map(item => item.value.documentWidth), "Document width");
      stable(snapshots.map(item => item.value.launcher.clientWidth), "Launcher client width");
      stable(snapshots.map(item => item.value.form.surface.width), "Wizard outer width");
      stable(snapshots.map(item => item.value.form.scroll.clientWidth), "Wizard scroll client width");
      stable(snapshots.map(item => item.value.form.name.right), "Name field right edge");
      stable([themeBefore.x + themeBefore.width, themeAfter.x + themeAfter.width], "Theme switch right edge");
      hidden(snapshots[0].value.documentChrome, "Document");
      hidden(snapshots[0].value.launcherChrome, "Launcher");
      hidden(snapshots.at(-1).value.form.chrome, "Wizard");
      assert.equal(snapshots.at(-1).value.form.chrome.overflowY, "auto");
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  });

  test(`pull refresh and reload keep launcher width stable at ${viewport.width}px`, async () => {
    const page = await preview(viewport, true);
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      const snapshots = [{ step: "idle", value: await metrics(page) }];
      const session = await page.context().newCDPSession(page);
      const point = y => [{ x: 8, y, id: 1, radiusX: 1, radiusY: 1, force: 1 }];
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(120) });
      for (const y of [170, 230, 310, 410, 520]) {
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(y) });
        await page.waitForTimeout(40);
      }
      await page.waitForFunction(() => document.querySelector("main").style.transform.includes("translate3d"));
      snapshots.push({ step: "pulling", value: await metrics(page) });
      await page.screenshot({ path: path.join(evidenceDir, `${phase}-scroll-launcher-${viewport.width}.png`) });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(100);
      snapshots.push({ step: "refreshing", value: await metrics(page) });
      await page.waitForTimeout(1100);
      snapshots.push({ step: "settled", value: await metrics(page) });
      await session.detach();
      await page.reload();
      await page.waitForFunction(() => window.__SILLYCLIENT_TEST__);
      await page.waitForTimeout(1000);
      snapshots.push({ step: "reloaded", value: await metrics(page) });
      record(`launcher-${viewport.width}`, { snapshots });
      stable(snapshots.map(item => item.value.documentWidth), "Document width");
      stable(snapshots.map(item => item.value.launcher.clientWidth), "Launcher client width");
      stable(snapshots.map(item => item.value.main.width), "Main width");
      stable(snapshots.map(item => item.value.search.right), "Search field right edge");
      for (const snapshot of snapshots) {
        hidden(snapshot.value.documentChrome, "Document");
        hidden(snapshot.value.bodyChrome, "Body");
        hidden(snapshot.value.launcherChrome, "Launcher");
        assert.equal(snapshot.value.launcherChrome.overflowY, "auto");
      }
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  });
}
