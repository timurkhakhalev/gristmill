const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const test: typeof import("node:test") = require("node:test");

const load = () => import("../../src/utils/i18nDocument.ts");

function createI18n(language: string) {
  const listeners = new Set<(language: string) => void>();

  return {
    language,
    resolvedLanguage: language,
    dir: (value: any) => (value.toLowerCase().startsWith("ar") ? "rtl" : "ltr"),
    on(event: unknown, listener: (language: string) => void) {
      assert.equal(event, "languageChanged");
      listeners.add(listener);
    },
    off(event: unknown, listener: (language: string) => void) {
      assert.equal(event, "languageChanged");
      listeners.delete(listener);
    },
    emit(nextLanguage: any) {
      this.language = nextLanguage;
      this.resolvedLanguage = nextLanguage;

      for (const listener of listeners) listener(nextLanguage);
    },
    listenerCount: () => listeners.size,
  };
}

test("document language binding initializes and updates both lang and dir", async () => {
  const { bindDocumentLanguage } = await load();
  const i18n = createI18n("ar");
  const root = { lang: "", dir: "" };

  const dispose = bindDocumentLanguage(i18n, root);
  assert.deepEqual(root, { lang: "ar", dir: "rtl" });

  i18n.emit("en-US");
  assert.deepEqual(root, { lang: "en-US", dir: "ltr" });

  dispose();
  assert.equal(i18n.listenerCount(), 0);
});

test("HMR disposal removes the exact language listener and remains idempotent", async () => {
  const { bindDocumentLanguage } = await load();
  const i18n = createI18n("en");
  const root = { lang: "", dir: "" };
  let hotDispose: (() => void) | undefined;

  const hot = {
    dispose(callback: () => void) {
      hotDispose = callback;
    },
  };

  const dispose = bindDocumentLanguage(i18n, root, hot);
  assert.equal(i18n.listenerCount(), 1);
  assert.equal(typeof hotDispose, "function");

  const registeredDispose = () => hotDispose;
  const callback = registeredDispose();
  assert.ok(callback);
  callback();
  dispose();
  assert.equal(i18n.listenerCount(), 0);
  i18n.emit("ar");
  assert.deepEqual(root, { lang: "en", dir: "ltr" });
});
