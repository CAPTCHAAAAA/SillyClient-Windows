const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/carousel-snap-lock.js"), "utf8"), { window });
const snap = window.SillyClientCarouselSnap;

test("tilt release cannot unlock a still-dragging track", () => {
  const track = { style: { scrollSnapType: "x mandatory" } };
  snap.set(track, "tilt", true);
  snap.set(track, "drag", true);
  snap.set(track, "tilt", false);
  assert.equal(track.style.scrollSnapType, "none");
  snap.set(track, "drag", false);
  assert.equal(track.style.scrollSnapType, "x mandatory");
});

test("repeated hover writes are idempotent and independent across tracks", () => {
  const a = { style: { scrollSnapType: "" } };
  const b = { style: { scrollSnapType: "" } };
  snap.set(a, "tilt", true);
  snap.set(a, "tilt", true);
  snap.set(b, "drag", true);
  snap.set(a, "tilt", false);
  assert.equal(a.style.scrollSnapType, "");
  assert.equal(b.style.scrollSnapType, "none");
  snap.set(b, "drag", false);
});
