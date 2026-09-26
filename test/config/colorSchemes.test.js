const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/config/colorSchemes.ts");
const css = fs.readFileSync(path.join(__dirname, "../../src/index.css"), "utf8");

const block = (selector) => {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return null;
  return css.slice(start, css.indexOf("}", start));
};

test("every non-default scheme has a light and a dark block with the full knob set", async () => {
  const { COLOR_SCHEME_IDS, DEFAULT_COLOR_SCHEME } = await load();

  for (const id of COLOR_SCHEME_IDS.filter((id) => id !== DEFAULT_COLOR_SCHEME)) {
    const light = block(`[data-color-scheme="${id}"]`);
    const dark = block(`.dark[data-color-scheme="${id}"]`);
    assert.ok(light, `${id}: light block`);
    assert.ok(dark, `${id}: dark block`);
    for (const knob of ["--n-h", "--n-c", "--a-h", "--a-c", "--a-l", "--brand-l"]) {
      assert.match(light, new RegExp(`${knob}:`), `${id}: light ${knob}`);
    }
    // .dark sets these for the default scheme; a scheme that skips them in its
    // dark block would inherit its light values in dark mode.
    for (const knob of ["--a-l", "--brand-l"]) {
      assert.match(dark, new RegExp(`${knob}:`), `${id}: dark ${knob}`);
    }
  }
});

test("the default scheme lives in :root and .dark", async () => {
  const { DEFAULT_COLOR_SCHEME } = await load();

  assert.equal(block(`[data-color-scheme="${DEFAULT_COLOR_SCHEME}"]`), null);
  assert.match(block(":root"), /--a-h:/);
});

test("unknown stored values fall back to the default scheme", async () => {
  const { normalizeColorScheme, DEFAULT_COLOR_SCHEME } = await load();

  assert.equal(normalizeColorScheme("lime"), "lime");
  assert.equal(normalizeColorScheme("neon"), DEFAULT_COLOR_SCHEME);
  assert.equal(normalizeColorScheme(null), DEFAULT_COLOR_SCHEME);
});
