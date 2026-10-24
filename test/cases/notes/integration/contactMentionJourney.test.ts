const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createHash } = require("node:crypto");
const { createRendererServer, installBrowserGlobals, installHookDom } = require("../../../lib/rendererTestHarness.ts");

test("mention selection binds equal-name contacts separately and preserves ID and legacy Markdown/HTML attributes", async (t) => {
  const vite = await createRendererServer(t, { mockModules: { "@tiptap/react": `import React from 'react'; export function NodeViewWrapper(p){return React.createElement('span',null,p.children);} export const ReactNodeViewRenderer=()=>null; export class ReactRenderer {}` } });
  const { createMentionExtension, toSuggestionItems } = await vite.ssrLoadModule("/components/ui/RichTextEditorMention.tsx");
  const people = [{ contactId: 7, name: "Casey Synthetic", email: null }, { contactId: 8, name: "Casey Synthetic", email: null }, { contactId: null, name: "Unbound Synthetic", email: null }];
  const items = toSuggestionItems([...people, people[0]], "");
  assert.deepEqual(items.map((item: any) => item.contactId), [7, 8, null]);
  const extension = createMentionExtension(() => people);
  const inserted: any[] = [];
  const editor = { chain() { return { focus() { return this; }, insertContentAt(_range: any, content: any) { inserted.push(content); return this; }, run() {} }; } };
  for (const props of items) extension.options.suggestion.command({ editor, range: { from: 0, to: 1 }, props });
  assert.deepEqual(inserted.slice(0, 2).map((content) => content[0].attrs.contactId), [7, 8]);
  assert.deepEqual(inserted[2], { type: "text", text: "@Unbound Synthetic " });
  const serialize = extension.config.addStorage.call(extension).markdown.serialize;
  const parse = extension.config.parseHTML.call(extension)[0].getAttrs;
  const render = extension.config.renderHTML;
  for (const attrs of inserted.slice(0, 2).map((content) => content[0].attrs)) {
    const html = render.call(extension, { node: { attrs }, HTMLAttributes: {} });
    const reloaded = parse({ textContent: html[2], getAttribute: () => html[1].href });
    assert.equal(reloaded.contactId, attrs.contactId);
    assert.equal(reloaded.label, "Casey Synthetic");
    let markdown = "";
    serialize({ write: (text: string) => { markdown += text; } }, { attrs: reloaded });
    assert.equal(markdown, `[@Casey Synthetic](mention:contact:${attrs.contactId})`);
  }
  for (const href of ["mention:old%40example.com", "mention:Unbound%20Synthetic", "mention:%broken", "mention:contact:-1", "mention:spaced%40example.com"]) {
    const label = href.includes("spaced") ? " Saved Synthetic " : "Saved Synthetic";
    const original = `[@${label}](${href})`;
    const attrs = parse({ textContent: `@${label}`, getAttribute: () => href });
    assert.equal(render.call(extension, { node: { attrs }, HTMLAttributes: {} })[1].href, href);
    let markdown = "";
    serialize({ write: (text: string) => { markdown += text; } }, { attrs });
    assert.equal(markdown, original);
    assert.equal(createHash("sha256").update(markdown).digest("hex"), createHash("sha256").update(original).digest("hex"));
  }
});

test("mounted chips resolve ID avatars, prefer old-email snapshots and batch exact legacy lookups without writes", async (t) => {
  let root: any;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  const lookups: string[][] = [], profiles: number[][] = [];
  installBrowserGlobals(t, { window: { electronAPI: {
    getContactProfiles: async (ids: number[]) => { profiles.push(ids); return ids.map((id) => ({ id, display_name: "Current Synthetic", email: null, telegram_username: null, photo_url: `https://example.com/avatar-${id}.png` })); },
    resolveLegacyMentionContacts: async (emails: string[]) => { lookups.push(emails); return emails.map((email) => ({ email, contactId: email === "current@example.com" ? 8 : null })); },
  } } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { mockModules: { "@tiptap/react": `import React from 'react'; export function NodeViewWrapper(p){return React.createElement('span',null,p.children);}` } });
  const { default: Chip } = await vite.ssrLoadModule("/components/ui/MentionChip.tsx");
  const { MentionParticipantsContext } = await vite.ssrLoadModule("/components/ui/mentionContext.ts");
  const snapshots = [{ contactId: 7, email: "old@example.com" }, { contactId: 7, email: "ambiguous@example.com" }, { contactId: 8, email: "ambiguous@example.com" }];
  const attrs = [
    { label: "Saved Seven", contactId: 7, href: "mention:contact:7" },
    { label: "Saved Eight", contactId: 8, href: "mention:contact:8" },
    { label: "Old Email", contactId: null, href: "mention:old%40example.com" },
    { label: "Current Email", contactId: null, href: "mention:current%40example.com" },
    { label: "Missing", contactId: null, href: "mention:missing%40example.com" },
    { label: "Ambiguous", contactId: null, href: "mention:ambiguous%40example.com" },
    { label: "Unbound", contactId: null, href: "mention:Unbound" },
    { label: "Malformed", contactId: null, href: "mention:%broken" },
  ];
  const before = JSON.stringify(attrs);
  root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(MentionParticipantsContext.Provider, { value: snapshots }, attrs.map((entry, index) => React.createElement(Chip, { key: index, node: { attrs: entry } }))));
    await new Promise((resolve) => setImmediate(resolve));
  });
  assert.deepEqual(lookups, [["current@example.com", "missing@example.com"]]);
  assert.deepEqual([...new Set(profiles.flat())].sort(), [7, 8]);
  assert.equal(JSON.stringify(attrs), before);
  for (const entry of attrs) assert.ok(container.textContent.includes(entry.label));
  assert.doesNotMatch(container.textContent, /Current Synthetic/);
  const all = (node: any): any[] => [node, ...(node.childNodes ?? []).flatMap(all)];
  const images = all(container).filter((node) => node.tagName === "IMG");
  assert.equal(images.length, 4);
});

test("pending legacy lookup restarts after a contact edit and ignores its stale response", async (t) => {
  let root: any;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  const pending: Array<(rows: any[]) => void> = [];
  installBrowserGlobals(t, { window: { electronAPI: {
    getContactProfiles: async () => [],
    resolveLegacyMentionContacts: () => new Promise((resolve) => pending.push(resolve)),
  } } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t);
  const { useLegacyMentionContactId, refreshPersonProfile } = await vite.ssrLoadModule("/hooks/usePersonProfile.ts");
  function Probe() { return React.createElement("span", null, String(useLegacyMentionContactId("pending@example.com", []))); }
  root = createRoot(container);
  await React.act(async () => { root.render(React.createElement(Probe)); await new Promise((resolve) => setImmediate(resolve)); });
  assert.equal(pending.length, 1);
  await React.act(async () => { refreshPersonProfile({ id: 7, display_name: "Edited Synthetic", email: null, telegram_username: null, photo_url: null }); await new Promise((resolve) => setImmediate(resolve)); });
  assert.equal(pending.length, 2);
  await React.act(async () => { pending[1]([{ email: "pending@example.com", contactId: 8 }]); });
  assert.equal(container.textContent, "8");
  await React.act(async () => { pending[0]([{ email: "pending@example.com", contactId: 7 }]); });
  assert.equal(container.textContent, "8");
});
