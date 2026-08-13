import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createRenderer, DEFAULT_VIEWS_ROOT } from "../src/infrastructure/rendering/renderer.ts";

function makeRoot(context: TestContext): string {
  const root = mkdtempSync(
    join(process.platform === "win32" ? process.env.TEMP! : "/tmp", "tapboard-view-"),
  );
  context.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

void test("file rendering uses a layout and partial while escaping hostile values", () => {
  const renderer = createRenderer();
  const hostile = '<script>alert("x")</script>&';
  const html = renderer.render("pages/foundation", { title: hostile, message: hostile });

  assert.match(html, /<!doctype html>/);
  assert.match(html, /data-foundation="render-proof"/);
  assert.match(html, /data-foundation="partial"/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
  assert.match(html, /&quot;x&quot;/);
});

void test("the default view root is module-relative rather than current-working-directory-relative", () => {
  assert.match(DEFAULT_VIEWS_ROOT, /[/\\]views[/\\]?$/);
  assert.notEqual(DEFAULT_VIEWS_ROOT, join(process.cwd(), "src", "views"));
});

void test("missing templates fail without exposing rendered fallback content", () => {
  const renderer = createRenderer();
  assert.throws(() => renderer.render("pages/does-not-exist", {}), /does-not-exist/);
});

void test("an injectable view root supports isolated file rendering", (context) => {
  const root = makeRoot(context);
  writeFileSync(join(root, "proof.eta"), "Hello <%= it.name %>", "utf8");
  const renderer = createRenderer({ viewsRoot: root });
  assert.equal(renderer.render("proof", { name: "<unsafe>" }), "Hello &lt;unsafe&gt;");
});
