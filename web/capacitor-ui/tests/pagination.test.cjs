const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { loadSource } = require("./load-source.cjs");
const {
  paginationCenter, paginationEase, samplePaginationPose, paginationDotOpacity,
  createPaginationMotion, PAGINATION_DURATION, PAGINATION_REST_WIDTH,
} = loadSource(path.join(__dirname, "../src/lib/pagination-motion.ts"));

function harness(index = 0) {
  let now = 0;
  let id = 0;
  const pending = new Map();
  const poses = [];
  let requested = 0;
  let cancelled = 0;
  const motion = createPaginationMotion(index, pose => poses.push({ ...pose }), {
    now: () => now,
    request(callback) {
      requested++;
      pending.set(++id, callback);
      return id;
    },
    cancel(frame) {
      cancelled++;
      pending.delete(frame);
    },
  });
  return {
    motion, poses, pending,
    get requested() { return requested; },
    get cancelled() { return cancelled; },
    frame(time) {
      now = time;
      const callbacks = Array.from(pending.values());
      pending.clear();
      callbacks.forEach(callback => callback(time));
    },
  };
}

test("22px slots retain exact centered 18px resting geometry", () => {
  assert.equal(PAGINATION_REST_WIDTH, 18);
  assert.equal(PAGINATION_DURATION, 260);
  assert.deepEqual([0, 1, 2, 20].map(paginationCenter), [11, 33, 55, 451]);
  const h = harness(2);
  assert.deepEqual(h.poses, [{ center: 55, width: 18 }]);
  assert.equal(h.pending.size, 0);
});

test("standard strong ease-out is bounded, monotone and endpoint exact", () => {
  assert.equal(paginationEase(-1), 0);
  assert.equal(paginationEase(0), 0);
  assert.equal(paginationEase(1), 1);
  assert.equal(paginationEase(2), 1);
  let prior = 0;
  for (let step = 0; step <= 100; step++) {
    const p = paginationEase(step / 100);
    assert.ok(p >= prior && p <= 1);
    prior = p;
  }
  assert.ok(Math.abs(paginationEase(0.5) - 0.96598) < 0.001);
});

test("elongation is centered, bounded and ends exactly at the target", () => {
  for (const start of [{ center: 11, width: 18 }, { center: 97, width: 35 }, { center: 451, width: 38 }]) {
    for (const target of [11, 55, 451]) {
      assert.deepEqual({ ...samplePaginationPose(start, target, 0) }, start);
      assert.deepEqual({ ...samplePaginationPose(start, target, 1) }, { center: target, width: 18 });
      for (let step = 0; step <= 100; step++) {
        const pose = samplePaginationPose(start, target, step / 100);
        assert.ok(pose.width >= 18 && pose.width <= 38);
        assert.ok(pose.center >= Math.min(start.center, target) && pose.center <= Math.max(start.center, target));
      }
    }
  }
});

test("coverage suppresses all overlapping footprints, with gentle recovery outside", () => {
  for (let center = 11; center <= 55; center += 0.5) {
    for (let width = 18; width <= 38; width += 1) {
      const pose = { center, width };
      for (const dot of [11, 33, 55]) {
        const opacity = paginationDotOpacity(dot, pose);
        assert.ok(opacity >= 0 && opacity <= 1);
        if (Math.abs(dot - center) <= width / 2 + 4) assert.equal(opacity, 0);
      }
    }
  }
  assert.equal(paginationDotOpacity(33, { center: 11, width: 18 }), 1);
  assert.equal(paginationDotOpacity(33, { center: 18, width: 18 }), 0.5);
});

test("rapid reversals start from both currently rendered coordinates without a jump", () => {
  const h = harness();
  h.motion.to(2);
  h.frame(70);
  const rendered = h.poses.at(-1);
  h.motion.to(1);
  assert.equal(h.cancelled, 1);
  assert.equal(h.pending.size, 1);
  h.frame(70);
  assert.deepEqual(h.poses.at(-1), rendered);
  h.frame(330);
  assert.deepEqual(h.poses.at(-1), { center: 33, width: 18 });
  assert.equal(h.pending.size, 0);
});

test("repeat targets do not restart, and settled controllers request no idle frames", () => {
  const h = harness();
  h.motion.to(0);
  assert.equal(h.requested, 0);
  h.motion.to(2);
  h.frame(65);
  const requests = h.requested;
  h.motion.to(2);
  assert.equal(h.requested, requests);
  h.frame(260);
  assert.equal(h.pending.size, 0);
  h.frame(1000);
  assert.equal(h.requested, requests);
  assert.deepEqual(h.poses.at(-1), { center: 55, width: 18 });
});

test("keyboard and reduced-motion targets snap with immediate coverage and no frames", () => {
  const h = harness();
  h.motion.to(2);
  h.frame(80);
  h.motion.to(1, false);
  assert.deepEqual(h.poses.at(-1), { center: 33, width: 18 });
  assert.equal(h.pending.size, 0);
  assert.equal(paginationDotOpacity(33, h.poses.at(-1)), 0);
});

test("visibility or preference changes snap pending geometry; disposal cancels work", () => {
  const h = harness();
  h.motion.to(2);
  h.frame(60);
  h.motion.snap();
  assert.deepEqual(h.poses.at(-1), { center: 55, width: 18 });
  assert.equal(h.pending.size, 0);
  h.motion.to(0);
  const count = h.poses.length;
  h.motion.dispose();
  h.frame(1000);
  h.motion.to(1);
  h.motion.snap();
  assert.equal(h.poses.length, count);
  assert.equal(h.pending.size, 0);
});

test("component delegates clamped navigation to the scroll controller and scopes geometry and theme ownership", () => {
  const component = fs.readFileSync(path.join(__dirname, "../src/components/instance/InstanceCarousel.tsx"), "utf8");
  const helper = fs.readFileSync(path.join(__dirname, "../src/lib/pagination-motion.ts"), "utf8");
  const styles = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  const cards = [0, 1, 2].map(index => ({ index, hasAttribute: name => name === "data-slot" }));
  const carouselRef = { current: { children: [{ hasAttribute: () => false }, ...cards] } };
  const activeSlideRef = { current: 0 };
  const animatePaginationRef = { current: true };
  const isProgrammaticScrollingRef = { current: false };
  const requests = [];
  let snaps = 0;
  const context = {
    carouselRef, activeSlideRef, animatePaginationRef, isProgrammaticScrollingRef,
    totalSlides: cards.length,
    useCallback: callback => callback,
    setActiveSlide: index => { activeSlideRef.current = index; },
    paginationMotionRef: { current: { snap: () => { snaps++; } } },
    scrollLeftForCard: (element, card) => card.index * 240,
    settleScrollTo: (element, target, velocity) => requests.push({ element, target, velocity }),
  };
  const start = component.indexOf("const goToSlide = useCallback(");
  const end = component.indexOf("useImperativeHandle(", start);
  assert.ok(start >= 0 && end > start);
  const navigation = ts.transpileModule(component.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(navigation + "\nthis.navigate = goToSlide;", context);
  context.navigate(20, false, 0.75);
  assert.equal(activeSlideRef.current, 2);
  assert.equal(animatePaginationRef.current, false);
  assert.equal(isProgrammaticScrollingRef.current, true);
  assert.deepEqual(requests.at(-1), { element: carouselRef.current, target: 480, velocity: 0.75 });
  context.navigate(2, false);
  assert.equal(snaps, 1);
  context.navigate(-20);
  assert.equal(activeSlideRef.current, 0);
  assert.equal(requests.at(-1).target, 0);
  carouselRef.current = null;
  const count = requests.length;
  context.navigate(1);
  assert.equal(requests.length, count);
  assert.ok(component.includes('goToSlide(activeSlideRef.current - 1, false)'));
  assert.ok(component.includes('goToSlide(activeSlideRef.current + 1, false)'));
  assert.ok(component.includes('media.addEventListener("change", onReducedMotion)'));
  assert.ok(component.includes('document.addEventListener("visibilitychange", onVisibility)'));
  assert.ok(component.includes('media.removeEventListener("change", onReducedMotion)'));
  assert.ok(component.includes('document.removeEventListener("visibilitychange", onVisibility)'));
  assert.ok(!component.includes("pillWidth") && !component.includes("stretchTimeoutRef"));
  assert.ok(!helper.includes("getBoundingClientRect") && !helper.includes("getComputedStyle"));
  assert.match(styles, /\.carousel-pagination\s*\{\s*color: #fff;/);
  assert.match(styles, /\.carousel-pagination\.is-light\s*\{\s*color: #1a1625;/);
  assert.match(styles, /\.carousel-pagination__mover\s*\{[^}]*transition: none;/);
  assert.match(styles, /\.motion-panel-stack\s*\{[^}]*transition: height var\(--motion-dissolve\)/);
  assert.match(styles, /\.carousel-pagination__dot-coverage\s*\{\s*transition: none;/);
});
