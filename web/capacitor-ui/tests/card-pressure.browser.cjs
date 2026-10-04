const assert = require("node:assert/strict");
const fs = require("node:fs");
const { test, before, after } = require("node:test");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");

const baseURL = process.env.PREVIEW_URL || "http://127.0.0.1:8767/";
const slot = index => `.carousel-scrollbar-hidden > [data-card-index="${index}"]`;
let browser;

before(async () => {
  const chrome = process.env.CHROME_EXECUTABLE || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  browser = await chromium.launch({
    headless: true,
    ...(fs.existsSync(chrome) ? { executablePath: chrome } : {}),
  });
});
after(async () => { await browser?.close(); });

async function preview(options = {}) {
  const page = await browser.newPage({
    viewport: options.viewport || { width: 1280, height: 900 },
    hasTouch: !!options.touch,
    reducedMotion: options.reduced ? "reduce" : "no-preference",
  });
  page.testErrors = [];
  page.on("pageerror", error => page.testErrors.push(error.message));
  await page.addInitScript(() => {
    window.__SILLYCLIENT_PREVIEW_FIXTURE__ = {
      status: {
        serverReady: true, mode: "launcher", instanceId: "preview-local",
        operationId: "pressure-fixture", url: "http://127.0.0.1:8000/",
      },
    };
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const motion = { requested: 0, fired: 0, cancelled: 0, pending: new Set() };
    window.__CARD_PRESSURE_FRAMES__ = motion;
    window.requestAnimationFrame = callback => {
      const isMotion = callback.toString().includes("pressMoving(state)")
        && callback.toString().includes("hoverReturn");
      let id;
      id = nativeRequest(time => {
        if (isMotion) {
          motion.pending.delete(id);
          motion.fired++;
        }
        callback(time);
      });
      if (isMotion) {
        motion.requested++;
        motion.pending.add(id);
      }
      return id;
    };
    window.cancelAnimationFrame = id => {
      if (motion.pending.delete(id)) motion.cancelled++;
      nativeCancel(id);
    };
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto(`${baseURL}?nativePreview=1`);
  await page.waitForFunction(() => window.__SILLYCLIENT_TEST__
    && document.querySelectorAll("[data-card-motion-managed]").length === 3
    && document.querySelector("[data-card-running='true']"));
  await page.waitForTimeout(1800);
  return page;
}

async function center(page, index) {
  await page.evaluate(selector => {
    window.dispatchEvent(new Event("blur"));
    document.activeElement?.blur();
    document.getSelection()?.removeAllRanges();
    document.querySelector(selector).scrollIntoView({ inline: "center", block: "nearest", behavior: "instant" });
  }, slot(index));
  await page.waitForTimeout(120);
  const rect = await page.locator(slot(index)).boundingBox();
  assert.ok(rect);
  return rect;
}

async function pose(page, index) {
  return page.locator(slot(index)).evaluate(card => {
    const transform = card.style.transform;
    const value = (name, fallback = 0) => {
      const match = transform.match(new RegExp(`${name}\\(([-\\d.]+)`));
      return match ? Number(match[1]) : fallback;
    };
    const computed = getComputedStyle(card);
    const matrix = new DOMMatrixReadOnly(computed.transform);
    const neutral = ["m11", "m22", "m33", "m44"].every(key => Math.abs(matrix[key] - 1) < 0.0001)
      && ["m12", "m13", "m21", "m23", "m31", "m32", "m41", "m42"].every(key => Math.abs(matrix[key]) < 0.0001)
      && Math.abs(matrix.m43) < 0.02;
    const track = card.parentElement;
    return {
      rx: value("rotateX"), ry: value("rotateY"), z: value("translateZ"), scale: value("scale", 1),
      transform, computed: computed.transform, neutral, duration: card.style.getPropertyValue("--tilt-dur"),
      pressure: card.hasAttribute("data-card-pressure"),
      pressureLock: window.SillyClientCarouselSnap.has(track, "pressure"),
      tiltLock: window.SillyClientCarouselSnap.has(track, "tilt"),
      dragLock: window.SillyClientCarouselSnap.has(track, "drag"),
      snap: track.style.scrollSnapType,
    };
  });
}

async function frames(page) {
  return page.evaluate(() => {
    const motion = window.__CARD_PRESSURE_FRAMES__;
    return {
      requested: motion.requested, fired: motion.fired,
      cancelled: motion.cancelled, pending: motion.pending.size,
    };
  });
}

async function pointer(page, index, type, options = {}) {
  return page.locator(slot(index)).evaluate((card, args) => {
    const rect = card.getBoundingClientRect();
    const event = new PointerEvent(args.type, {
      bubbles: true, cancelable: true, pointerType: "touch", pointerId: 41,
      isPrimary: true, button: 0, buttons: args.type === "pointerup" ? 0 : 1,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
      ...args.options,
    });
    (args.options.global ? window : card).dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, options });
}

async function assertIdle(page) {
  const before = await frames(page);
  await page.waitForTimeout(150);
  const after = await frames(page);
  assert.equal(after.pending, 0);
  assert.equal(after.requested, before.requested);
  assert.equal(after.fired, before.fired);
  assert.deepEqual(page.testErrors, []);
}

test("untransformed slot geometry agrees with the real neutral bounds within one pixel", async () => {
  const page = await preview();
  try {
    const geometry = await page.evaluate(() => Array.from(
      document.querySelectorAll(".carousel-scrollbar-hidden > [data-card-index]")
    ).map(card => {
      const parent = card.offsetParent;
      const parentRect = parent.getBoundingClientRect();
      let left = parentRect.left + parent.clientLeft + card.offsetLeft;
      let top = parentRect.top + parent.clientTop + card.offsetTop;
      for (let ancestor = card.parentElement; ancestor; ancestor = ancestor.parentElement) {
        left -= ancestor.scrollLeft;
        top -= ancestor.scrollTop;
        if (ancestor === parent) break;
      }
      const actual = card.getBoundingClientRect();
      return { index: card.dataset.cardIndex, dx: left - actual.left, dy: top - actual.top };
    }));
    assert.equal(geometry.length, 3);
    for (const item of geometry) {
      assert.ok(Math.abs(item.dx) <= 1 && Math.abs(item.dy) <= 1, JSON.stringify(item));
    }
    for (const index of [0, 1, 2]) {
      const rect = await center(page, index);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
      const value = await pose(page, index);
      assert.ok(Math.abs(value.rx) < 0.04 && Math.abs(value.ry) < 0.04, JSON.stringify(value));
      await page.mouse.move(20, 20);
      await page.waitForTimeout(450);
    }
  } finally { await page.close(); }
});

test("real mouse presses respond at left, right, top, bottom and center without moving adjacent cards", async () => {
  const page = await preview();
  try {
    for (const [u, v] of [[-0.75, 0], [0.75, 0], [0, -0.75], [0, 0.75], [0, 0]]) {
      const rect = await center(page, 2);
      const x = rect.x + rect.width * (u + 1) / 2;
      const y = rect.y + rect.height * (v + 1) / 2;
      await page.mouse.move(x, y);
      const hover = await pose(page, 2);
      await page.mouse.down();
      await page.waitForTimeout(150);
      const down = await pose(page, 2);
      assert.equal(down.pressure, true);
      assert.ok(down.z <= -4 && down.z >= -5, JSON.stringify(down));
      assert.ok(down.scale >= 0.985 && down.scale <= 0.988);
      const dy = down.ry - hover.ry;
      const dx = down.rx - hover.rx;
      assert.ok(Math.abs(dy) <= 3.01 && Math.abs(dx) <= 3.01);
      if (u) assert.ok(dy * u > 1.2, JSON.stringify({ u, dy }));
      else assert.ok(Math.abs(dy) < 0.04);
      if (v) assert.ok(dx * v < -1.2, JSON.stringify({ v, dx }));
      else assert.ok(Math.abs(dx) < 0.04);
      assert.equal((await pose(page, 0)).neutral, true);
      assert.equal((await pose(page, 1)).neutral, true);
      await page.mouse.up();
      await page.mouse.move(20, 20);
      await page.waitForTimeout(650);
      const released = await pose(page, 2);
      assert.equal(released.neutral, true, JSON.stringify(released));
      assert.equal(released.pressureLock, false);
      assert.equal(released.tiltLock, false);
    }
    assert.ok((await frames(page)).fired > 0);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("corner pressure is radially normalized and touch release has only a restrained rebound", async () => {
  const page = await preview();
  try {
    const rect = await center(page, 2);
    await pointer(page, 2, "pointerdown", {
      clientX: rect.x + rect.width - 4, clientY: rect.y + rect.height - 4,
    });
    await page.waitForTimeout(160);
    const down = await pose(page, 2);
    assert.ok(down.ry > 1.8 && down.rx < -1.8);
    assert.ok(Math.hypot(down.ry, down.rx) <= 3.01);
    await pointer(page, 2, "pointerup");
    const samples = [];
    for (let index = 0; index < 12; index++) {
      await page.waitForTimeout(40);
      samples.push(await pose(page, 2));
    }
    for (const sample of samples) {
      assert.ok(sample.z >= -5 && sample.z <= 0.3, JSON.stringify(sample));
      assert.ok(sample.scale >= 0.985 && sample.scale <= 1.001);
      assert.ok(Math.abs(sample.rx) <= 3 && Math.abs(sample.ry) <= 3);
      assert.equal(sample.tiltLock, false);
    }
    await page.waitForTimeout(180);
    assert.equal((await pose(page, 2)).neutral, true);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("quick and repeated presses preserve the in-flight pose instead of restarting at neutral", async () => {
  const page = await preview();
  try {
    const rect = await center(page, 1);
    const contact = { clientX: rect.x + 35, clientY: rect.y + 35 };
    await pointer(page, 1, "pointerdown", contact);
    await page.waitForTimeout(25);
    await pointer(page, 1, "pointerup", contact);
    await page.waitForTimeout(35);
    const prior = await pose(page, 1);
    assert.ok(prior.z < -0.1);
    await pointer(page, 1, "pointerdown", contact);
    const restarted = await pose(page, 1);
    assert.ok(restarted.z < -0.1);
    assert.ok(Math.abs(restarted.z - prior.z) < 1.2);
    await page.waitForTimeout(160);
    const held = await pose(page, 1);
    await pointer(page, 1, "pointerup", contact);
    const immediate = await pose(page, 1);
    assert.ok(Math.abs(immediate.z - held.z) < 0.8);
    await page.waitForTimeout(650);
    assert.equal((await pose(page, 1)).neutral, true, JSON.stringify(await pose(page, 1)));
    await assertIdle(page);
  } finally { await page.close(); }
});

test("a returning card cannot release another card's pressure snap lock during rapid cross-card presses", async () => {
  const page = await preview();
  try {
    await center(page, 1);
    await pointer(page, 1, "pointerdown");
    await page.waitForTimeout(140);
    await pointer(page, 1, "pointerup");
    await page.waitForTimeout(150);
    await pointer(page, 2, "pointerdown");
    await page.waitForTimeout(450);
    const first = await pose(page, 1);
    const second = await pose(page, 2);
    assert.equal(first.neutral, true, JSON.stringify(first));
    assert.equal(second.pressure, true);
    assert.equal(second.pressureLock, true);
    assert.equal(second.snap, "none");
    await pointer(page, 2, "pointerup");
    await page.waitForTimeout(650);
    assert.equal((await pose(page, 2)).pressureLock, false);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("small movement follows pressure, while movement past four pixels cancels within one frame", async () => {
  const page = await preview();
  try {
    const rect = await center(page, 2);
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.waitForTimeout(140);
    await page.mouse.move(x + 3, y);
    await page.waitForTimeout(100);
    const small = await pose(page, 2);
    assert.equal(small.pressure, true);
    assert.ok(small.ry > 0.025);
    await page.mouse.move(x + 6, y);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const cancelled = await pose(page, 2);
    assert.equal(cancelled.neutral, true);
    assert.equal(cancelled.duration, "0ms");
    assert.equal(cancelled.pressureLock, false);
    assert.equal(cancelled.tiltLock, false);
    assert.equal(cancelled.dragLock, true);
    await page.mouse.move(x + 20, y);
    assert.equal((await pose(page, 2)).neutral, true);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const released = await pose(page, 2);
    assert.equal(released.dragLock, false);
    assert.equal(released.snap, "");
    await assertIdle(page);
  } finally { await page.close(); }
});

test("ordinary mouse leave keeps hover ownership until the preserved 400ms neutral return ends", async () => {
  const page = await preview();
  try {
    const rect = await center(page, 1);
    await page.mouse.move(rect.x + 25, rect.y + 25);
    assert.equal((await pose(page, 1)).tiltLock, true);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(50);
    const returning = await pose(page, 1);
    assert.equal(returning.tiltLock, true);
    assert.equal(returning.neutral, false);
    await page.waitForTimeout(430);
    const rest = await pose(page, 1);
    assert.equal(rest.neutral, true, JSON.stringify(rest));
    assert.equal(rest.duration, "400ms");
    assert.equal(rest.tiltLock, false);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("pointercancel and blur immediately clean frames and locks, and cancelled pointer IDs can be reused", async () => {
  const page = await preview();
  try {
    await center(page, 1);
    await pointer(page, 1, "pointerdown");
    await page.waitForTimeout(100);
    await pointer(page, 1, "pointercancel", { global: true });
    assert.equal((await pose(page, 1)).neutral, true);
    assert.equal((await frames(page)).pending, 0);
    await pointer(page, 1, "pointerdown");
    await page.waitForTimeout(100);
    assert.equal((await pose(page, 1)).pressure, true);
    assert.ok((await pose(page, 1)).z < -3);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    assert.equal((await pose(page, 1)).neutral, true);
    assert.equal((await pose(page, 1)).pressureLock, false);
    assert.equal((await frames(page)).pending, 0);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("leaving untouched, interrupted and reduced-motion cards is harmless with no active state", async () => {
  const page = await preview();
  try {
    await pointer(page, 2, "pointerout", { relatedTarget: null });
    const rect = await center(page, 1);
    await page.mouse.move(rect.x + 40, rect.y + 25);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await pointer(page, 1, "pointerout", { relatedTarget: null });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(50);
    await pointer(page, 0, "pointerout", { relatedTarget: null });
    await assertIdle(page);
  } finally { await page.close(); }
});

test("touch and pen use passive press events with global release and no synthetic hover or pointer capture", async () => {
  const page = await preview();
  try {
    await center(page, 2);
    await page.evaluate(() => {
      const capture = Element.prototype.setPointerCapture;
      window.__PRESSURE_CAPTURE_CALLS__ = 0;
      Element.prototype.setPointerCapture = function(id) {
        window.__PRESSURE_CAPTURE_CALLS__++;
        return capture.call(this, id);
      };
    });
    for (const pointerType of ["touch", "pen"]) {
      assert.equal(await pointer(page, 2, "pointerdown", { pointerType }), false);
      await page.waitForTimeout(150);
      assert.equal((await pose(page, 2)).pressure, true);
      assert.equal((await pose(page, 2)).tiltLock, false);
      assert.equal(await pointer(page, 2, "pointerup", { pointerType, global: true }), false);
      await page.waitForTimeout(650);
      assert.equal((await pose(page, 2)).neutral, true);
      assert.equal((await pose(page, 2)).pressureLock, false);
      assert.equal((await pose(page, 2)).tiltLock, false);
    }
    assert.equal(await page.evaluate(() => window.__PRESSURE_CAPTURE_CALLS__), 0);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("non-primary and multiple pointers cancel pressure and do not steal an independent drag owner", async () => {
  const page = await preview();
  try {
    await center(page, 1);
    await pointer(page, 1, "pointerdown");
    await page.waitForTimeout(100);
    await page.locator(slot(1)).evaluate(card => window.SillyClientCarouselSnap.set(card.parentElement, "drag", true));
    await pointer(page, 1, "pointerdown", { pointerId: 42, isPrimary: false });
    const cancelled = await pose(page, 1);
    assert.equal(cancelled.neutral, true);
    assert.equal(cancelled.pressureLock, false);
    assert.equal(cancelled.dragLock, true);
    assert.equal(cancelled.snap, "none");
    await pointer(page, 1, "pointerup", { pointerId: 42 });
    await pointer(page, 1, "pointerup");
    await page.locator(slot(1)).evaluate(card => window.SillyClientCarouselSnap.set(card.parentElement, "drag", false));
    assert.equal((await pose(page, 1)).snap, "");
    await assertIdle(page);
  } finally { await page.close(); }
});

test("running and stopped faces exclude local controls and log selection while keeping header hover", async () => {
  const page = await preview();
  try {
    const rect = await center(page, 1);
    await page.mouse.move(rect.x + 60, rect.y + 25);
    assert.equal((await pose(page, 1)).tiltLock, true);
    const input = page.locator(`${slot(1)} [aria-hidden="false"] input`);
    const button = page.locator(`${slot(1)} [aria-hidden="false"] button`).first();
    const log = page.locator(`${slot(1)} [aria-hidden="false"] [data-native-log-list]`);
    assert.equal(await input.count(), 1);
    assert.equal(await log.count(), 1);
    for (const control of [input, button, log]) {
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await control.dispatchEvent("pointerdown", {
        pointerType: "touch", pointerId: 41, isPrimary: true, button: 0, bubbles: true,
      });
      await page.waitForTimeout(30);
      assert.equal((await pose(page, 1)).pressure, false);
      assert.equal((await pose(page, 1)).pressureLock, false);
      await control.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 41, isPrimary: true, bubbles: true });
    }
    await input.focus();
    await page.mouse.move(rect.x + 70, rect.y + 25);
    assert.equal((await pose(page, 1)).neutral, true);
    await input.evaluate(node => node.blur());
    await log.evaluate(node => {
      node.textContent = "pressure log selection fixture";
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
    await page.waitForTimeout(30);
    await page.mouse.move(rect.x + 80, rect.y + 25);
    assert.equal((await pose(page, 1)).neutral, true);
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await page.mouse.move(rect.x + 90, rect.y + 25);
    assert.equal((await pose(page, 1)).tiltLock, true);
    await page.mouse.move(20, 20);
    await page.waitForTimeout(450);
    await center(page, 2);
    await page.locator(`${slot(2)} [aria-hidden="false"] button`).first().dispatchEvent("pointerdown", {
      pointerType: "touch", pointerId: 41, isPrimary: true, button: 0, bubbles: true,
    });
    assert.equal((await pose(page, 2)).pressure, false);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await assertIdle(page);
  } finally { await page.close(); }
});

test("all card types have one transform owner and retain their original click actions", async () => {
  const page = await preview();
  try {
    for (const index of [0, 1, 2]) {
      const rect = await center(page, index);
      await page.mouse.move(rect.x + rect.width / 2, rect.y + 25);
      assert.equal((await pose(page, index)).tiltLock, true);
      await page.mouse.down();
      await page.waitForTimeout(150);
      assert.equal((await pose(page, index)).pressure, true);
      const nested = await page.locator(`${slot(index)} .motion-instance-card`).evaluateAll(nodes =>
        nodes.map(node => new DOMMatrixReadOnly(getComputedStyle(node).transform).isIdentity));
      assert.ok(nested.every(Boolean), JSON.stringify(nested));
      await page.mouse.up();
      if (index === 0) {
        await page.getByPlaceholder("我的酒馆").waitFor();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        await page.waitForTimeout(650);
      }
      if (index === 2) {
        await page.getByRole("button", { name: "启动", exact: true }).waitFor();
      }
      await page.mouse.move(20, 20);
      await page.waitForTimeout(650);
    }
    const actions = await page.evaluate(() => window.__SILLYCLIENT_TEST__.calls.filter(
      call => ["provisionAndStart", "closeTavern", "enterImmersive"].includes(call.method)));
    assert.deepEqual(actions, []);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("reduced motion works from startup and runtime changes interrupt spatial motion without disabling clicks", async () => {
  const page = await preview({ reduced: true });
  try {
    const rect = await center(page, 0);
    await page.mouse.move(rect.x + 30, rect.y + 30);
    await page.mouse.down();
    await page.waitForTimeout(120);
    assert.equal((await pose(page, 0)).neutral, true);
    assert.equal((await pose(page, 0)).pressure, true);
    assert.equal((await frames(page)).requested, 0);
    const opacity = await page.locator(slot(0)).evaluate(card => Number(getComputedStyle(card).opacity));
    assert.ok(opacity < 1);
    await page.mouse.up();
    await page.getByPlaceholder("我的酒馆").waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.waitForTimeout(350);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const running = await center(page, 1);
    await page.mouse.move(running.x + 50, running.y + 25);
    await page.mouse.down();
    await page.waitForTimeout(100);
    assert.equal((await pose(page, 1)).neutral, false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(50);
    const cancelled = await pose(page, 1);
    assert.equal(cancelled.neutral, true, JSON.stringify(cancelled));
    assert.equal(cancelled.pressureLock, false);
    assert.equal(cancelled.tiltLock, false);
    assert.equal((await frames(page)).pending, 0);
    await page.mouse.up();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(50);
    await page.mouse.move(running.x + 60, running.y + 25);
    assert.equal((await pose(page, 1)).tiltLock, true);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await assertIdle(page);
  } finally { await page.close(); }
});

test("detached active slots and hidden documents release their frames and snap owners", async () => {
  const page = await preview();
  try {
    await center(page, 1);
    await pointer(page, 1, "pointerdown");
    await page.waitForTimeout(80);
    const detached = await page.locator(slot(1)).evaluate(async card => {
      const track = card.parentElement;
      card.remove();
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        pressure: window.SillyClientCarouselSnap.has(track, "pressure"),
        tilt: window.SillyClientCarouselSnap.has(track, "tilt"),
        snap: track.style.scrollSnapType,
        transform: card.style.transform,
      };
    });
    assert.deepEqual(detached, { pressure: false, tilt: false, snap: "", transform: "none" });
    assert.equal((await frames(page)).pending, 0);
    await pointer(page, 2, "pointerdown");
    await page.waitForTimeout(60);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal((await pose(page, 2)).neutral, true);
    assert.equal((await pose(page, 2)).pressureLock, false);
    await assertIdle(page);
  } finally { await page.close(); }
});

test("native touch scrolling remains enabled, releases pressure on pan and keeps inertia after release", async () => {
  const page = await preview({ viewport: { width: 390, height: 844 }, touch: true });
  const session = await page.context().newCDPSession(page);
  try {
    const rect = await center(page, 1);
    const x = rect.x + rect.width / 2;
    const y = rect.y + 22;
    const before = await page.locator(".carousel-scrollbar-hidden").evaluate(track => ({
      scroll: track.scrollLeft, action: getComputedStyle(track).touchAction,
    }));
    assert.equal(before.action, "pan-x");
    await page.evaluate(() => {
      window.__PRESSURE_TOUCH_EVENTS__ = [];
      for (const type of ["pointerdown", "pointerup", "pointercancel"]) document.addEventListener(type, event => {
        window.__PRESSURE_TOUCH_EVENTS__.push({
          type, target: event.target.className, pointerType: event.pointerType,
          id: event.pointerId, primary: event.isPrimary, x: event.clientX, y: event.clientY,
        });
      });
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y, id: 7 }],
    });
    await page.waitForTimeout(120);
    assert.equal((await pose(page, 1)).pressure, true, JSON.stringify({
      pose: await pose(page, 1), events: await page.evaluate(() => window.__PRESSURE_TOUCH_EVENTS__),
      rect,
    }));
    for (let index = 1; index <= 5; index++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x - index * 20, y, id: 7 }],
      });
      await page.waitForTimeout(12);
    }
    const moved = await page.locator(".carousel-scrollbar-hidden").evaluate(track => track.scrollLeft);
    assert.ok(moved - before.scroll > 30, JSON.stringify({ before, moved }));
    assert.equal((await pose(page, 1)).pressureLock, false);
    assert.equal((await pose(page, 1)).tiltLock, false);
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    const released = await page.locator(".carousel-scrollbar-hidden").evaluate(track => track.scrollLeft);
    await page.waitForTimeout(100);
    const inertia = await page.locator(".carousel-scrollbar-hidden").evaluate(track => track.scrollLeft);
    assert.ok(Math.abs(inertia - released) > 1, JSON.stringify({ released, inertia }));
    await page.waitForTimeout(800);
    for (const index of [0, 1, 2]) {
      assert.equal((await pose(page, index)).neutral, true);
      assert.equal((await pose(page, index)).pressureLock, false);
    }
    await assertIdle(page);
  } finally {
    await session.detach();
    await page.close();
  }
});
