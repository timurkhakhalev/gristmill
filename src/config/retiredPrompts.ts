// Registry of default prompt texts the app has shipped over time, as SHA-256
// hashes. Old releases persisted the then-current default prompt into
// localStorage as a "custom" prompt (unedited Prompt Studio saves, plus the
// customUnifiedPrompt/customPrompts migrations), where it permanently shadows
// every default shipped since. The sweep below clears a stored override only
// when it byte-matches one of these retired defaults; anything a user edited,
// even by one character, hashes differently and is never touched.
//
// Extracted from every revision of src/config/promptData.json,
// src/locales/*/prompts.json, prompts.ts and ReasoningService.ts on main.
// When a shipped default changes: move its hash from
// CURRENT_DEFAULT_PROMPT_HASHES to RETIRED_DEFAULT_PROMPT_HASHES and add the
// new hash (the registry test walks the locale bundles and fails until both
// sides are updated).

export const RETIRED_DEFAULT_PROMPT_HASHES: ReadonlySet<string> = new Set([
  // Previous voice-assistant Chat default.
  "ca35b88c4f8a0e1fd0b2b6efea1b066c70b772e6a55033e0fca731b2e74fbf06",
  //    65ch 28ac9b59 ReasoningService.ts DEFAULT_PROMPTS.regular (+24 more)
  "79abaafa51ba1fe06614d5392d6879f458b3ffc1f9e727528d6a9c896c530365",
  //   173ch 88ce1814 promptData.json LEGACY_PROMPTS.regular (+6 more)
  "66b8adbc0beb6b22498e9dc00001d5f4c27d772890d2b1c7a98c0fdb8a92325f",
  //   931ch ed117e27 zh-TW cleanupPrompt (+1 more)
  "b58b5b339ea425b615bbb4cf40708ab2269ae6ba9d6ff9613b37c5c867b65962",
  //   937ch 2f0637ed zh-TW cleanupPrompt
  "555b20380886213031250560364f7c677abec1ebec883746d260d05fbcba580e",
  //   952ch 2f0637ed zh-CN cleanupPrompt
  "a14e00cf10e3f872e634d9d918cd07e6b8437356512759c49ed0fd544f6f1f61",
  //  1095ch a3c63ce1 pt cleanupPrompt
  "34024d7d3994248b76b043e80b301b63b9562b4ed5120fada5a0e076c2f70aae",
  //  1170ch a3c63ce1 it cleanupPrompt
  "296ca433abc59a1428d81d208795c5e12fbebad4d6bf726650ee036b75cd8faa",
  //  1207ch a3c63ce1 de cleanupPrompt
  "f9f802aaf81b440793cf607f54c20ef3e88a8782133541d51cc70a79ea170fcd",
  //  1239ch 1c1e3db1 ja cleanupPrompt
  "bc4344d2c952fde6085fb92efa96f14dc6446ed869bd41f26a1227b1ab53b0f2",
  //  1296ch a3c63ce1 fr cleanupPrompt
  "aea75b29c3fa9c0adfea20c3a940768fed02ec52422dfa4082a0d395059d4089",
  //  1418ch a3c63ce1 es cleanupPrompt
  "376aa65adbb640b236d8a1e96c657fd426b20e49de65a4e9914e420798b48e76",
  //  1517ch ea9fd583 promptData.json CLEANUP_PROMPT (+1 more)
  "0fc56bad8e19cfd523d436d5bbf8022ce41ace0de74be9205c08c44f3545c65b",
  //  1629ch 88ce1814 promptData.json CLEANUP_PROMPT (+1 more)
  "a6acdbe8005a320c802a2b72e0b779f6707207f7a4be4e797c39289ce63cd6df",
  //  1749ch 2804af04 en cleanupPrompt (+1 more)
  "6334e82181b678ca5d7670e1d101c032729509f4daf3e0f38206cb56e25b9fbe",
  //  2708ch 560f0973 promptData.json CLEANUP_PROMPT (+1 more)
  "774da7ce7c876581a95f408e1c0e2d698a3e2f40f3790dd4c190737199835a73",
  //  3040ch bb664542 ru cleanupPrompt
  "91f52cc9967b29ccb69f759adc2591b82105dfb0fd5cd1b47aaed588bf1e4102",
  // Previous localized cleanup defaults, retired when the English formatter shipped in every locale.
  "6f62d1802de5e49a38bb0a3dbb6bb18afd2b1cd6a9306519b05507014efcd41f",
  "89452bfcce253803ae9fd9b0e9fc3f50afbf9c8d89706ad92dfc48d1e29ec4af",
  "58ed65fbc679a7bac1483ef850c51ac7932a02d17fab9ca688f4d11f6aa9b7e6",
  "3a977c7d5435d799873a1003d68924b08a51d720386fe8cc9ac16304607df56d",
  "8e97d2a98decbba356733bfdd7fb4aff2ec157eab177ad4fd06003cecc32aa56",
  "cdc5472ffa032e9cb508fa8e25acb7f64d29840e0a248e7d97d90f6f6b9fc6f0",
  "fd8903a8ae80ab6baca57217b7505777378e4a2f7b15f31274deb4b52fcb0b8d",
  "2de91bc76da3682dc819297616966d1e90ba511ca8fcb5232691710e712da619",
  "caa4cb470101df0f494a2e323548aabe4bcc28318938ade7487f7d1507f6eb8e",
  "c38d3f454a576f6d5c3a22294215283cfc04da7b370d7bdb7e1b123d6e89f055",
  "9b586c6141f09263fdf9d06973b9bb9579fc325b2b6f906a0a7804f9418824be",
]);

// Hashes of the defaults currently shipped, keyed by locale/bundle key. Not
// used by the sweep; the registry test compares these against the live locale
// bundles so a prompt change cannot land without updating the retired set.
export const CURRENT_DEFAULT_PROMPT_HASHES: Record<string, string> = {
  "ar/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "de/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "en/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "es/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "fr/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "it/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "ja/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "pt/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "ru/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "zh-CN/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  "zh-TW/cleanupPrompt": "1b3925e02b99c56cdb235f2356156054e7ecd553dffc51057ed4debb40e0bef2",
  chatAgent: "1099fe25bc3d89a14f80d09c351041a612f708478ce1a7dd9ff49372b05eb92c",
};

export async function hashPromptText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// localStorage-like storage: the exact surface the sweep reads and writes.
export interface PromptOverrideStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export async function isRetiredDefaultPrompt(text: unknown): Promise<boolean> {
  if (typeof text !== "string" || text.length === 0) return false;
  if (!globalThis.crypto?.subtle) return false;
  return RETIRED_DEFAULT_PROMPT_HASHES.has(await hashPromptText(text));
}

// Clears customPrompt.<kind> overrides that byte-match a retired shipped
// default, archiving each swept value under customPrompt.<kind>.retired.
// Safe to run on every startup: user-edited prompts never match, and a swept
// key is simply absent on the next run.
export async function sweepRetiredPromptOverrides(
  storage: PromptOverrideStorage,
  kinds: readonly string[]
): Promise<string[]> {
  const swept: string[] = [];
  for (const kind of kinds) {
    try {
      const key = `customPrompt.${kind}`;
      const value = storage.getItem(key);
      if (!value) continue;
      if (!(await isRetiredDefaultPrompt(value))) continue;
      // Re-read before removing: the user may have saved a new prompt while
      // the hash was being computed.
      if (storage.getItem(key) !== value) continue;
      storage.setItem(`${key}.retired`, value);
      storage.removeItem(key);
      swept.push(kind);
    } catch {
      // Storage failures skip this kind; the sweep retries on next startup.
    }
  }
  return swept;
}
