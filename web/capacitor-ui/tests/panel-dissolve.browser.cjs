const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8767/";
const evidenceDir = process.env.PANEL_DISSOLVE_EVIDENCE
  || "D:/BACKUP/Project/SillyClient/Local/evidence/release-hardening-20261003/output/playwright";
const curve = "cubic-bezier(0.22, 1, 0.36, 1)";
const viewports = [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 720 }];
let browser;

before(async () => {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const chrome = process.env.CHROME_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}),
  });
});
after(async () => { await browser?.close(); });

function record(name, value) {
  fs.appendFileSync(path.join(evidenceDir, "panel-dissolve-after.jsonl"),
    `${JSON.stringify({ name, ...value })}\n`);
}

async function preview(viewport = viewports[0], reduced = false) {
  const page = await browser.newPage({ viewport, reducedMotion: reduced ? "reduce" : "no-preference" });
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
  return page;
}

async function openWizard(page) {
  await page.getByRole("button", { name: /新建实例 设置新的酒馆环境/ }).click();
  const surface = page.locator(".ios-task-surface").filter({ has: page.getByPlaceholder("我的酒馆") });
  await surface.waitFor();
  await page.waitForTimeout(650);
  return surface;
}

async function openSettings(page) {
  await page.locator("header button").last().click();
  const surface = page.locator(".app-settings-surface");
  await surface.waitFor();
  await page.waitForTimeout(650);
  return surface;
}

async function openBackground(page) {
  await page.locator("header button").nth(1).click();
  const surface = page.locator(".ios-floating-menu").filter({ hasText: "背景设置" });
  await surface.waitFor();
  await page.waitForTimeout(650);
  return surface;
}

async function choose(surface, label) {
  await surface.getByRole("button", { name: label, exact: true }).dispatchEvent("click");
}

async function sample(surface, fraction, hold = false) {
  return surface.evaluate((root, { progress, hold }) => {
    const stack = root.querySelector(".motion-panel-stack");
    const faces = Array.from(stack.children).filter(node => node.classList.contains("motion-panel-face"));
    const frozen = [];
    if (progress !== undefined) {
      for (const face of faces) {
        for (const animation of face.getAnimations()) {
          if (!["opacity", "transform", "filter", "visibility"].includes(animation.transitionProperty)) continue;
          animation.pause();
          animation.currentTime = 500 * progress;
          frozen.push(animation);
        }
      }
      for (const animation of stack.getAnimations()) {
        if (animation.transitionProperty !== "height") continue;
        animation.pause();
        animation.currentTime = 500 * progress;
        frozen.push(animation);
      }
    }
    const describe = node => {
      const css = getComputedStyle(node);
      const matrix = new DOMMatrixReadOnly(css.transform);
      return {
        active: node.classList.contains("is-active"), inert: node.inert,
        hidden: node.getAttribute("aria-hidden"), pointer: css.pointerEvents,
        opacity: Number(css.opacity), blur: Number(css.filter.match(/blur\(([\d.]+)px\)/)?.[1] || 0),
        transform: css.transform, y: matrix.m42, visibility: css.visibility,
        properties: css.transitionProperty, durations: css.transitionDuration, delays: css.transitionDelay,
        easing: css.transitionTimingFunction, height: node.offsetHeight,
        animations: node.getAnimations().filter(animation => animation.effect.target === node).map(animation => ({
          property: animation.transitionProperty, duration: animation.effect.getTiming().duration,
          delay: animation.effect.getTiming().delay, easing: animation.effect.getTiming().easing,
        })),
      };
    };
    const value = {
      stack: { height: stack.offsetHeight, style: stack.style.height, duration: getComputedStyle(stack).transitionDuration },
      faces: faces.map(describe),
    };
    if (!hold) {
      for (const animation of frozen) animation.play();
    }
    return value;
  }, { progress: fraction, hold });
}

function assertDissolve(value) {
  const entering = value.faces.find(face => face.active);
  const exiting = value.faces.find(face => !face.active && face.opacity > 0);
  assert.ok(entering && exiting, JSON.stringify(value));
  for (const face of [entering, exiting]) {
    assert.ok(face.opacity > 0.05 && face.opacity < 0.95, JSON.stringify(face));
    assert.ok(face.blur > 0 && face.blur < 3, JSON.stringify(face));
    assert.ok(face.y > 0 && face.y < 6, JSON.stringify(face));
    assert.equal(face.properties, "opacity, transform, filter, visibility");
    assert.equal(face.durations, "0.5s, 0.5s, 0.5s, 0s");
    for (const property of ["opacity", "filter", "transform"]) {
      const animation = face.animations.find(item => item.property === property);
      assert.ok(animation, `${property}: ${JSON.stringify(face)}`);
      assert.equal(animation.duration, 500);
      assert.equal(animation.easing, curve);
    }
  }
  assert.equal(entering.inert, false);
  assert.equal(entering.pointer, "auto");
  assert.equal(entering.visibility, "visible");
  assert.equal(exiting.inert, true);
  assert.equal(exiting.hidden, "true");
  assert.equal(exiting.pointer, "none");
  assert.equal(exiting.visibility, "visible");
  return entering;
}

async function settled(surface) {
  await new Promise(resolve => setTimeout(resolve, 620));
  const value = await sample(surface);
  const entering = value.faces.find(face => face.active);
  assert.equal(entering.opacity, 1);
  assert.equal(entering.blur, 0);
  assert.equal(entering.y, 0);
  assert.ok(Math.abs(value.stack.height - entering.height) <= 1, JSON.stringify(value));
  for (const face of value.faces.filter(item => !item.active)) {
    assert.equal(face.visibility, "hidden");
    assert.equal(face.inert, true);
    assert.equal(face.pointer, "none");
    assert.equal(face.opacity, 0);
  }
  return value;
}

async function transition(page, surface, label, name) {
  await choose(surface, label);
  await page.waitForTimeout(50);
  const value = await sample(surface, 0.1);
  record(name, value);
  const entering = assertDissolve(value);
  await settled(surface);
  return entering;
}

for (const viewport of viewports) {
  test(`first and later panel switches match the settings baseline at ${viewport.width}px`, async () => {
    const page = await preview(viewport);
    try {
      const settings = await openSettings(page);
      const baseline = await transition(page, settings, "维护", `settings-first-${viewport.width}`);
      await transition(page, settings, "数据", `settings-later-${viewport.width}`);
      await settings.locator(".app-settings-header-actions button").click();
      await page.waitForTimeout(650);
      const wizard = await openWizard(page);
      const first = await transition(page, wizard, "远程连接", `wizard-first-${viewport.width}`);
      const later = await transition(page, wizard, "数据迁移", `wizard-later-${viewport.width}`);
      for (const value of [first, later]) {
        assert.ok(Math.abs(value.opacity - baseline.opacity) < 0.002);
        assert.ok(Math.abs(value.blur - baseline.blur) < 0.01);
        assert.ok(Math.abs(value.y - baseline.y) < 0.01);
      }
      await wizard.getByRole("button", { name: "取消", exact: true }).click();
      await page.waitForTimeout(650);
      const background = await openBackground(page);
      const bgFirst = await transition(page, background, "自定义", `background-first-${viewport.width}`);
      const bgLater = await transition(page, background, "基础", `background-later-${viewport.width}`);
      for (const value of [bgFirst, bgLater]) {
        assert.ok(Math.abs(value.opacity - baseline.opacity) < 0.002);
        assert.ok(Math.abs(value.blur - baseline.blur) < 0.01);
        assert.ok(Math.abs(value.y - baseline.y) < 0.01);
      }
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  });
}

test("migration main entry has one dissolve layer and submode changes keep the parent steady", async () => {
  const page = await preview();
  try {
    const wizard = await openWizard(page);
    await choose(wizard, "数据迁移");
    await page.waitForTimeout(50);
    const main = await sample(wizard, 0.1);
    assertDissolve(main);
    const nested = wizard.locator(".motion-panel-face .motion-panel-face");
    const child = await nested.evaluateAll(nodes => nodes.map(node => ({
      active: node.classList.contains("is-active"),
      opacity: Number(getComputedStyle(node).opacity), filter: getComputedStyle(node).filter,
      transform: getComputedStyle(node).transform, inert: node.inert,
      neutral: new DOMMatrixReadOnly(getComputedStyle(node).transform).isIdentity,
      spatialAnimations: node.getAnimations().filter(animation =>
        ["opacity", "filter", "transform"].includes(animation.transitionProperty)).length,
    })));
    const selected = child.find(face => face.active);
    assert.equal(selected.opacity, 1);
    assert.equal(selected.filter, "blur(0px)");
    assert.equal(selected.neutral, true);
    assert.equal(selected.spatialAnimations, 0);
    record("migration-one-layer", { main, child });
    await settled(wizard);
    await choose(wizard, "原地接管");
    await page.waitForTimeout(75);
    const parent = (await sample(wizard)).faces.find(face => face.active);
    assert.equal(parent.opacity, 1);
    assert.equal(parent.blur, 0);
    const sub = await nested.evaluateAll(nodes => nodes.map(node => ({
      opacity: Number(getComputedStyle(node).opacity),
      blur: Number(getComputedStyle(node).filter.match(/blur\(([\d.]+)px\)/)?.[1] || 0),
      inert: node.inert, pointer: getComputedStyle(node).pointerEvents,
      active: node.classList.contains("is-active"),
    })));
    for (const face of sub) {
      assert.ok(face.opacity > 0 && face.opacity < 1, JSON.stringify(sub));
      assert.ok(face.blur > 0 && face.blur < 3, JSON.stringify(sub));
    }
    assert.equal(sub.find(face => !face.active).inert, true);
    await settled(wizard);
    await choose(wizard, "本地实例");
    await page.waitForTimeout(20);
    const disabled = await nested.evaluateAll(nodes =>
      nodes.every(node => node.inert && node.getAttribute("aria-hidden") === "true"
        && getComputedStyle(node).pointerEvents === "none"));
    assert.equal(disabled, true);
    await settled(wizard);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("rapid reversal retargets opacity, blur and height from their current state", async () => {
  const page = await preview();
  try {
    const wizard = await openWizard(page);
    await choose(wizard, "远程连接");
    await page.waitForTimeout(65);
    const before = await sample(wizard, 0.13, true);
    await choose(wizard, "本地实例");
    const reversed = await sample(wizard, 0);
    for (let index = 0; index < 2; index++) {
      assert.ok(Math.abs(before.faces[index].opacity - reversed.faces[index].opacity) < 0.002,
        JSON.stringify({ before, reversed }));
      assert.ok(Math.abs(before.faces[index].blur - reversed.faces[index].blur) < 0.01);
      assert.ok(Math.abs(before.faces[index].y - reversed.faces[index].y) < 0.01);
    }
    assert.ok(Math.abs(before.stack.height - reversed.stack.height) <= 1);
    for (const label of ["远程连接", "数据迁移", "本地实例", "数据迁移", "远程连接"]) {
      await choose(wizard, label);
      await page.waitForTimeout(35);
    }
    const rest = await settled(wizard);
    assert.equal(rest.faces[1].active, true);
    const borderErrors = await page.evaluate(() => document.querySelectorAll(".motion-panel-face.is-active[inert]").length);
    assert.equal(borderErrors, 1, "Only the visually selected nested migration face is inert outside import");
    record("rapid-reversal", { before, reversed, rest });
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("exiting and hidden controls reject focus and hits immediately, including selected migration children", async () => {
  const page = await preview();
  try {
    const wizard = await openWizard(page);
    await choose(wizard, "数据迁移");
    await settled(wizard);
    await choose(wizard, "原地接管");
    await settled(wizard);
    await choose(wizard, "远程连接");
    const isolation = await wizard.evaluate(root => {
      const inactive = Array.from(root.querySelectorAll(".motion-panel-face[inert]"));
      return inactive.map(face => {
        const control = face.querySelector("input, button, select, textarea");
        if (!control) return { inert: face.inert, hidden: face.getAttribute("aria-hidden") };
        control.focus();
        const rect = control.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return {
          inert: face.inert, hidden: face.getAttribute("aria-hidden"),
          focused: document.activeElement === control, hit: !!hit && control.contains(hit),
        };
      });
    });
    for (const value of isolation) {
      assert.equal(value.inert, true);
      assert.equal(value.hidden, "true");
      assert.notEqual(value.focused, true);
      assert.notEqual(value.hit, true);
    }
    const input = wizard.getByPlaceholder("https://example.com");
    await input.focus();
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    await settled(wizard);
    const hit = await input.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    });
    assert.equal(hit, true);
    await choose(wizard, "本地实例");
    await settled(wizard);
    await wizard.getByRole("button", { name: "预设安装", exact: true }).click();
    await wizard.getByRole("switch", { name: "使用 SC Bordeaux 主题预设" }).click();
    await choose(wizard, "远程连接");
    await settled(wizard);
    const hiddenSwitches = await wizard.locator(
      "[aria-label^='预安装'], [aria-label='使用 SC Bordeaux 主题预设']"
    ).evaluateAll(nodes => nodes.length > 0 && nodes.every(node => !!node.closest("[inert]")));
    assert.equal(hiddenSwitches, true);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("initial and expanded heights exclude modal entry scale and leave all real content reachable", async () => {
  for (const viewport of viewports) {
    const page = await preview(viewport);
    try {
      const settings = await openSettings(page);
      const settingsHeight = await settled(settings);
      await settings.locator(".app-settings-header-actions button").click();
      await page.waitForTimeout(650);
      const wizard = await openWizard(page);
      const first = await settled(wizard);
      await wizard.getByRole("button", { name: "预设安装", exact: true }).click();
      await page.waitForTimeout(50);
      await choose(wizard, "远程连接");
      await page.waitForTimeout(70);
      await choose(wizard, "本地实例");
      await page.waitForTimeout(1000);
      const expanded = await settled(wizard);
      assert.ok(expanded.faces[0].height > first.faces[0].height);
      const last = wizard.getByRole("switch", { name: "预安装 骰子", exact: true });
      await last.scrollIntoViewIfNeeded();
      assert.equal(await last.evaluate(node => {
        const rect = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
      }), true);
      const cancel = await wizard.getByRole("button", { name: "取消", exact: true }).boundingBox();
      assert.ok(cancel && cancel.y >= 0 && cancel.y + cancel.height <= viewport.height);
      const width = await wizard.evaluate(root => {
        const scroll = root.querySelector(".flex-1.overflow-y-auto");
        return { client: scroll.clientWidth, scroll: scroll.scrollWidth, scrollbar: getComputedStyle(scroll).scrollbarWidth };
      });
      assert.ok(width.scroll <= width.client + 1);
      assert.equal(width.scrollbar, "none");
      record(`unscaled-height-${viewport.width}`, { settingsHeight, first, expanded, cancel, width });
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  }
});

test("shared faces and stacks keep their spatial properties under the temporary global color rule", async () => {
  const page = await preview();
  try {
    const wizard = await openWizard(page);
    const value = await wizard.evaluate(root => {
      const launcher = document.querySelector("#root > div");
      launcher.classList.add("theme-smoothing");
      const face = getComputedStyle(root.querySelector(".motion-panel-face"));
      const stack = getComputedStyle(root.querySelector(".motion-panel-stack"));
      const result = {
        faceProperties: face.transitionProperty, faceDuration: face.transitionDuration,
        stackProperties: stack.transitionProperty, stackDuration: stack.transitionDuration,
      };
      launcher.classList.remove("theme-smoothing");
      return result;
    });
    assert.equal(value.faceProperties, "opacity, transform, filter, visibility");
    assert.equal(value.faceDuration, "0.5s, 0.5s, 0.5s, 0s");
    assert.equal(value.stackProperties, "height");
    assert.equal(value.stackDuration, "0.5s");
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("reduced motion retains a 120ms opacity fade without blur, translation or animated height", async () => {
  const page = await preview(viewports[1], true);
  try {
    const wizard = await openWizard(page);
    await choose(wizard, "远程连接");
    const reduced = await sample(wizard);
    const entering = reduced.faces.find(face => face.active);
    assert.equal(entering.properties, "opacity, visibility");
    assert.equal(entering.durations, "0.12s, 0s");
    assert.equal(entering.transform, "none");
    assert.equal(entering.blur, 0);
    assert.equal(reduced.stack.duration, "0s");
    for (const face of reduced.faces) {
      assert.equal(face.transform, "none");
      assert.equal(face.blur, 0);
      assert.equal(face.animations.some(animation =>
        ["filter", "transform"].includes(animation.property)), false);
    }
    for (const face of reduced.faces.slice(0, 2)) {
      assert.equal(face.animations.find(animation => animation.property === "opacity")?.duration, 120);
    }
    await page.waitForTimeout(160);
    const rest = await sample(wizard);
    assert.equal(rest.faces[1].opacity, 1);
    assert.equal(rest.faces[0].visibility, "hidden");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(650);
    await transition(page, wizard, "本地实例", "reduced-restored");
    await choose(wizard, "远程连接");
    await page.waitForTimeout(50);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(160);
    const toggled = await sample(wizard);
    assert.equal(toggled.faces[1].transform, "none");
    assert.equal(toggled.faces[1].blur, 0);
    assert.equal(toggled.stack.duration, "0s");
    for (const face of toggled.faces) {
      assert.equal(face.animations.some(animation =>
        ["filter", "transform"].includes(animation.property)), false);
    }
    // Changing the media query cancels spatial motion; the existing opacity fade may finish.
    await page.waitForTimeout(350);
    assert.equal((await sample(wizard)).faces[1].opacity, 1);
    await choose(wizard, "本地实例");
    const fresh = await sample(wizard, 0.08);
    for (const face of fresh.faces.slice(0, 2)) {
      assert.equal(face.animations.find(animation => animation.property === "opacity")?.duration, 120);
      assert.ok(face.opacity > 0 && face.opacity < 1);
      assert.equal(face.inert, !face.active);
    }
    record("reduced-motion", { reduced, rest, toggled, fresh });
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("whole-page theme switching retains its existing 260ms background and 220ms color wash", async () => {
  const page = await preview();
  try {
    const background = await openBackground(page);
    await choose(background, "自定义");
    await settled(background);
    await choose(background, "白天");
    await page.waitForTimeout(30);
    const theme = await page.evaluate(() => ({
      rootDuration: getComputedStyle(document.querySelector("#root > div")).transitionDuration,
      washes: document.getElementById("preview-theme-wash")?.getAnimations().map(animation => ({
        duration: animation.effect.getTiming().duration,
        easing: animation.effect.getTiming().easing,
      })),
    }));
    assert.equal(theme.rootDuration, "0.26s");
    assert.ok(theme.washes.some(animation => animation.duration === 220 && animation.easing === curve), JSON.stringify(theme));
    record("theme-unchanged", theme);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});
