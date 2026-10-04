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

async function preview(width = 1280, reduced = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: reduced ? "reduce" : "no-preference" });
  page.testErrors = [];
  page.on("pageerror", error => page.testErrors.push(error.message));
  await page.addInitScript(() => {
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const motion = { requested: 0, fired: 0, cancelled: 0, pending: new Set() };
    window.__PAGINATION_FRAMES__ = motion;
    window.requestAnimationFrame = callback => {
      const pagination = callback.name === "advancePagination";
      let id;
      id = request(time => {
        if (pagination) {
          motion.pending.delete(id);
          motion.fired++;
        }
        callback(time);
      });
      if (pagination) {
        motion.requested++;
        motion.pending.add(id);
      }
      return id;
    };
    window.cancelAnimationFrame = id => {
      if (motion.pending.delete(id)) motion.cancelled++;
      cancel(id);
    };
  });
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) ? route.continue() : route.abort();
  });
  await page.goto(`${baseURL}?nativePreview=1`);
  await page.waitForFunction(() => window.__SILLYCLIENT_TEST__
    && document.querySelectorAll("[data-card-running]").length === 2
    && document.querySelector(".carousel-pagination__capsule"));
  await page.waitForTimeout(1800);
  return page;
}

async function state(page) {
  return page.evaluate(() => {
    const root = document.querySelector(".carousel-pagination");
    const mover = root.querySelector(".carousel-pagination__mover");
    const capsule = root.querySelector(".carousel-pagination__capsule");
    const r = capsule.getBoundingClientRect();
    const track = root.getBoundingClientRect();
    const styles = element => {
      const css = getComputedStyle(element);
      return {
        color: css.color, background: css.backgroundColor,
        opacity: Number(css.opacity), transition: css.transition,
        duration: css.transitionDuration, property: css.transitionProperty,
      };
    };
    return {
      active: Array.from(root.querySelectorAll("button")).findIndex(b => b.getAttribute("aria-current") === "true"),
      center: r.x + r.width / 2 - track.x,
      width: r.width,
      root: styles(root),
      mover: styles(mover),
      capsule: styles(capsule),
      offset: [mover.offsetWidth, mover.offsetHeight, capsule.offsetWidth, capsule.offsetHeight],
      buttons: Array.from(root.querySelectorAll("button")).map(b => [b.offsetWidth, b.offsetHeight]),
      dots: Array.from(root.querySelectorAll(".carousel-pagination__dot-coverage")).map(d => ({
        opacity: Number(getComputedStyle(d).opacity),
        wrapperTransition: getComputedStyle(d).transitionProperty,
        inner: styles(d.firstElementChild),
      })),
      frames: {
        requested: window.__PAGINATION_FRAMES__.requested,
        fired: window.__PAGINATION_FRAMES__.fired,
        pending: window.__PAGINATION_FRAMES__.pending.size,
      },
    };
  });
}

async function motionSamples(page, steps, duration = 450) {
  return page.evaluate(async ({ steps, duration }) => {
    const root = document.querySelector(".carousel-pagination");
    const capsule = root.querySelector(".carousel-pagination__capsule");
    const buttons = Array.from(root.querySelectorAll("button"));
    const dots = Array.from(root.querySelectorAll(".carousel-pagination__dot-coverage"));
    const samples = [];
    const events = [];
    let next = 0;
    const start = performance.now();
    await new Promise(resolve => {
      function samplePagination(time) {
        const elapsed = Math.max(0, time - start);
        const rect = capsule.getBoundingClientRect();
        const center = rect.x + rect.width / 2;
        const active = buttons.findIndex(b => b.getAttribute("aria-current") === "true");
        const overlaps = dots.map((dot, index) => {
          const d = dot.getBoundingClientRect();
          return {
            index,
            overlaps: Math.abs(d.x + d.width / 2 - center) < (rect.width + d.width) / 2,
            opacity: Number(getComputedStyle(dot).opacity),
          };
        });
        samples.push({
          ms: elapsed, center: center - root.getBoundingClientRect().x,
          width: rect.width, active, overlaps,
          color: getComputedStyle(capsule).backgroundColor,
          source: getComputedStyle(root).color,
          dotColor: getComputedStyle(dots[0].firstElementChild).backgroundColor,
        });
        while (next < steps.length && elapsed >= steps[next].ms) {
          const step = steps[next++];
          const before = { center, width: rect.width };
          if (step.index !== undefined) {
            buttons[step.index].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
          } else {
            Array.from(document.querySelectorAll("button")).find(b => b.textContent.trim() === step.theme).click();
          }
          const after = capsule.getBoundingClientRect();
          events.push({ ms: elapsed, before, after: { center: after.x + after.width / 2, width: after.width } });
        }
        if (elapsed < duration) requestAnimationFrame(samplePagination);
        else resolve();
      }
      requestAnimationFrame(samplePagination);
    });
    return { samples, events };
  }, { steps, duration });
}

function assertCoverage(result, label) {
  for (const sample of result.samples) {
    assert.ok(sample.width >= 17.99 && sample.width <= 38.01, `${label}: width ${sample.width}`);
    for (const dot of sample.overlaps) {
      if (dot.overlaps) assert.equal(dot.opacity, 0, `${label}: dot ${dot.index} under capsule at ${sample.ms}ms`);
    }
    assert.equal(sample.color, sample.source, `${label}: capsule theme source differs`);
    assert.equal(sample.dotColor, sample.source, `${label}: dot theme source differs`);
  }
}

test("unframed pagination keeps exact hit/layout dimensions and rest states at 320/390/1280px", async () => {
  for (const width of [320, 390, 1280]) {
    const page = await preview(width);
    try {
      const initial = await state(page);
      assert.equal(initial.active, 0);
      assert.equal(initial.center, 11);
      assert.equal(initial.width, 18);
      assert.deepEqual(initial.offset, [18, 6, 18, 6]);
      assert.deepEqual(initial.buttons, [[22, 28], [22, 28], [22, 28]]);
      assert.equal(initial.root.background, "rgba(0, 0, 0, 0)");
      assert.equal(initial.dots[0].opacity, 0);
      assert.equal(initial.dots[1].opacity, 1);
      assert.equal(initial.dots[2].opacity, 1);
      for (const index of [1, 2, 0]) {
        await page.getByRole("button", { name: `切换到第 ${index + 1} 张卡片`, exact: true }).click();
        await page.waitForTimeout(350);
        const current = await state(page);
        assert.equal(current.active, index);
        assert.equal(current.center, index * 22 + 11);
        assert.equal(current.width, 18);
        assert.equal(current.dots[index].opacity, 0);
        assert.deepEqual(current.offset, initial.offset);
        assert.deepEqual(current.buttons, initial.buttons);
        assert.equal(current.mover.property, "none");
        assert.equal(current.capsule.property, "opacity");
        assert.ok(!/width|left|top/.test(current.root.transition + current.mover.transition + current.capsule.transition));
      }
      assert.deepEqual(page.testErrors, []);
    } finally { await page.close(); }
  }
});

test("jump, immediate reversal and repeated target keep continuous coverage and bounded finite motion", async () => {
  const page = await preview();
  try {
    const result = await motionSamples(page, [{ ms: 0, index: 2 }, { ms: 80, index: 1 }], 420);
    assertCoverage(result, "rapid reversal");
    for (const event of result.events) assert.deepEqual(event.after, event.before);
    const final = await state(page);
    assert.equal(final.center, 33);
    assert.equal(final.width, 18);
    assert.equal(final.frames.pending, 0);
    assert.ok(final.frames.fired > 0);
    const repeated = await motionSamples(page, [{ ms: 0, index: 2 }, { ms: 90, index: 2 }], 330);
    assertCoverage(repeated, "repeat target");
    assert.equal(repeated.samples.at(-1).width, 18);
    assert.equal(repeated.samples.at(-1).center, 55);
    const idle = await state(page);
    await page.waitForTimeout(400);
    assert.deepEqual((await state(page)).frames, idle.frames);
  } finally { await page.close(); }
});

test("theme reversal during movement uses one continuous color source without restarting geometry", async () => {
  const page = await preview();
  try {
    await page.locator("header button").nth(1).click();
    await page.getByRole("button", { name: "自定义", exact: true }).click();
    await page.getByRole("button", { name: "白天", exact: true }).waitFor();
    await page.waitForTimeout(400);
    const result = await motionSamples(page, [
      { ms: 0, index: 2 }, { ms: 35, theme: "白天" }, { ms: 200, theme: "暗夜" },
    ], 650);
    assertCoverage(result, "theme reversal");
    for (const event of result.events) assert.deepEqual(event.after, event.before);
    const colors = new Set(result.samples.map(s => s.color));
    assert.ok(colors.size >= 3, "theme switches should interpolate, not jump");
    const final = await state(page);
    assert.equal(final.center, 55);
    assert.equal(final.width, 18);
    assert.equal(final.root.duration, "0.22s");
    assert.equal(final.capsule.duration, "0.22s");
    assert.equal(final.dots[0].inner.background, final.capsule.background);
    assert.equal(final.frames.pending, 0);
    assert.deepEqual(page.testErrors, []);
  } finally { await page.close(); }
});

test("hover intensity cannot reveal a geometrically suppressed active dot", async () => {
  const page = await preview();
  try {
    const first = page.getByRole("button", { name: "切换到第 1 张卡片", exact: true });
    await first.hover();
    await page.waitForTimeout(260);
    const hovered = await state(page);
    assert.equal(hovered.dots[0].opacity, 0);
    assert.equal(hovered.dots[0].inner.opacity, 0.4);
    assert.equal(hovered.center, 11);
    assert.equal(hovered.width, 18);
    assert.equal(hovered.frames.requested, 0);
  } finally { await page.close(); }
});

test("arrow keys, Enter and Space snap indicator geometry while retaining native card centering and the raw scroll contract", async t => {
  const page = await preview();
  try {
    await page.evaluate(() => {
      const track = document.querySelector(".carousel-scrollbar-hidden");
      const scrollTo = track.scrollTo.bind(track);
      window.__PAGINATION_SCROLL_CALLS__ = [];
      track.scrollTo = options => {
        const calls = window.__PAGINATION_SCROLL_CALLS__;
        const cards = Array.from(track.children).filter(c => c.hasAttribute("data-card-index"));
        const index = [1, 2, 1][calls.length];
        calls.push({
          options,
          expected: Math.max(0, cards[index].offsetLeft - (track.clientWidth - cards[index].offsetWidth) / 2),
        });
        scrollTo(options);
      };
    });
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(50);
    let current = await state(page);
    assert.equal(current.active, 1);
    assert.equal(current.center, 33);
    assert.equal(current.width, 18);
    assert.equal(current.frames.requested, 0);
    const last = page.getByRole("button", { name: "切换到第 3 张卡片", exact: true });
    await last.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(50);
    current = await state(page);
    assert.equal(current.active, 2);
    assert.equal(current.center, 55);
    assert.equal(current.frames.requested, 0);
    const previous = page.getByRole("button", { name: "上一页", exact: true });
    await previous.focus();
    await page.keyboard.press("Space");
    await page.waitForTimeout(850);
    current = await state(page);
    assert.equal(current.active, 1);
    assert.equal(current.center, 33);
    assert.equal(current.frames.requested, 0);
    const navigation = await page.evaluate(() => {
      const track = document.querySelector(".carousel-scrollbar-hidden");
      const card = track.querySelector("[data-card-index='1']");
      const tr = track.getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      const offsetParent = e => ({
        tag: e.offsetParent?.tagName, class: e.offsetParent?.className,
        x: e.offsetParent?.getBoundingClientRect().x,
      });
      return {
        calls: window.__PAGINATION_SCROLL_CALLS__, scroll: track.scrollLeft,
        track: { offsetLeft: track.offsetLeft, clientWidth: track.clientWidth, x: tr.x, width: tr.width, parent: offsetParent(track) },
        card: { offsetLeft: card.offsetLeft, width: card.offsetWidth, x: cr.x, parent: offsetParent(card) },
        realCenterDifference: cr.x + cr.width / 2 - tr.x - tr.width / 2,
        rawOffsetDifference: card.offsetLeft + card.offsetWidth / 2 - track.scrollLeft - track.clientWidth / 2,
        snap: getComputedStyle(track).scrollSnapType,
        locks: ["drag", "tilt", "pressure"].map(key => [key, window.SillyClientCarouselSnap.has(track, key)]),
      };
    });
    assert.equal(navigation.calls.length, 3);
    for (const call of navigation.calls) {
      assert.equal(call.options.behavior, "smooth");
      assert.equal(call.options.left, call.expected);
    }
    assert.ok(navigation.scroll > 0, "keyboard navigation must retain actual native card scrolling");
    assert.ok(Math.abs(navigation.realCenterDifference) <= 1, `physical native centering: ${navigation.realCenterDifference}px`);
    t.diagnostic(`Physical centering verified; raw offsets have a separate ancestor origin: ${JSON.stringify(navigation)}`);
  } finally { await page.close(); }
});

test("reduced motion snaps at startup and preference changes cancel in-flight work", async () => {
  const page = await preview(390, true);
  try {
    await page.getByRole("button", { name: "切换到第 3 张卡片", exact: true }).click();
    let current = await state(page);
    assert.equal(current.center, 55);
    assert.equal(current.width, 18);
    assert.equal(current.frames.requested, 0);
    assert.equal(current.root.duration, "0.12s");
    assert.equal(current.capsule.duration, "0.12s");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.waitForTimeout(50);
    await page.evaluate(() => document.querySelector(".carousel-pagination button")
      .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await page.waitForTimeout(50);
    current = await state(page);
    assert.ok(current.frames.requested > 0);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForTimeout(50);
    current = await state(page);
    assert.equal(current.center, 11);
    assert.equal(current.width, 18);
    assert.equal(current.dots[0].opacity, 0);
    assert.equal(current.frames.pending, 0);
    const idle = current.frames;
    await page.waitForTimeout(300);
    assert.deepEqual((await state(page)).frames, idle);
  } finally { await page.close(); }
});

test("document visibility changes snap pending geometry and theme-smoothing cannot override scoped transitions", async () => {
  const page = await preview();
  try {
    await page.evaluate(() => {
      const observer = new MutationObserver(() => document.documentElement.classList.remove("theme-smoothing"));
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
      document.documentElement.classList.add("theme-smoothing");
      const root = document.querySelector(".carousel-pagination");
      const capsule = root.querySelector(".carousel-pagination__capsule");
      const mover = root.querySelector(".carousel-pagination__mover");
      window.__PAGINATION_SCOPED_STYLE__ = {
        root: getComputedStyle(root).transition,
        capsule: getComputedStyle(capsule).transition,
        mover: getComputedStyle(mover).transitionProperty,
        coverage: getComputedStyle(root.querySelector(".carousel-pagination__dot-coverage")).transitionProperty,
      };
      observer.disconnect();
      root.querySelectorAll("button")[2].dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    const scoped = await page.evaluate(() => window.__PAGINATION_SCOPED_STYLE__);
    assert.match(scoped.root, /^color 0\.22s /);
    assert.match(scoped.capsule, /^opacity 0\.22s /);
    assert.equal(scoped.mover, "none");
    assert.equal(scoped.coverage, "none");
    await page.waitForTimeout(50);
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const current = await state(page);
    assert.equal(current.center, 55);
    assert.equal(current.width, 18);
    assert.equal(current.dots[2].opacity, 0);
    assert.equal(current.frames.pending, 0);
    const idle = current.frames;
    await page.waitForTimeout(300);
    assert.deepEqual((await state(page)).frames, idle);
  } finally { await page.close(); }
});
