const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const React = require("react");
const { createRoot } = require("react-dom/client");
const { createRendererServer, installBrowserGlobals, installHookDom } = require("../../../lib/rendererTestHarness.ts");
type T = import("node:test").TestContext;

function all(node: any): any[] { return [node, ...(node.childNodes ?? []).flatMap(all)]; }
function props(node: any): any { return Object.entries(node).find(([key]) => key.startsWith("__reactProps$"))?.[1] ?? {}; }

async function mount(t: T, path: string, initial: any, api: any) {
  let root: any;
  t.after(async () => { if (root) await React.act(async () => root.unmount()); });
  installBrowserGlobals(t, { window: { electronAPI: api } });
  const container = installHookDom(t);
  const vite = await createRendererServer(t, { noExternal: ["react-i18next"], mockModules: {
    "react-i18next": `export function useTranslation(){ return {t:(key)=>key}; }`,
    "/stores/noteStore": `export function runInBackground(p){p?.catch(()=>{});}`,
    "/stores/meetingRecordingStore": `export function syncSessionExpectedCountFromParticipants(){}`,
    "/hooks/useUiLocale": `export function useUiLocale(){return 'en';}`,
    "/hooks/useDateTimePreferences": `export function useDateTimePreferences(){return {dateFormat:'locale',timeFormat:'locale'};}`,
    "/ui/PersonAvatar": `import React from 'react'; export default function Avatar(p){return React.createElement('span',{'data-contact-id':p.contactId});}`,
    "/ui/popover": `import React from 'react';const C=React.createContext(()=>{});export function Popover(p){return React.createElement(C.Provider,{value:p.onOpenChange??(()=>{})},p.children);}export function PopoverTrigger(p){const set=React.useContext(C);return React.cloneElement(p.children,{onClick:()=>set(true)});}export function PopoverAnchor(p){return p.children;}export function PopoverContent(p){return React.createElement('div',null,p.children);}`,
  }});
  const Component = (await vite.ssrLoadModule(path)).default;
  root = createRoot(container);
  const act = async (fn: () => void) => React.act(async () => { fn(); await new Promise((resolve) => setImmediate(resolve)); });
  const render = async (next: any) => act(() => root.render(React.createElement(Component, next)));
  await render(initial);
  const nodes = () => all(container);
  const find = (predicate: (node: any) => boolean) => { const found = nodes().find(predicate); assert.ok(found); return found; };
  return { act, render, nodes, find, text: () => container.textContent, input: (index: number) => nodes().filter((node) => node.tagName === "INPUT")[index], change: async (index: number, value: string) => act(() => props(nodes().filter((node) => node.tagName === "INPUT")[index]).onChange({ target: { value } })), submit: async () => act(() => props(find((node) => node.tagName === "FORM")).onSubmit({ preventDefault() {} })), click: async (label: string) => act(() => props(find((node) => node.tagName === "BUTTON" && (node.textContent === label || props(node)["aria-label"] === label))).onClick()) };
}

const person = (id = 7) => ({ id, display_name: "Casey Synthetic", email: null, telegram_username: null, photo_url: null });
const formPath = "/components/notes/ContactDetailsForm.tsx";

const listPath = "/components/notes/NoteParticipants.tsx";

test("a search with no exact match offers one-click creation that adds the saved contact once", async (t) => {
  let calls = 0;
  const noteWrites: any[] = [];
  let finish!: (value: any) => void;
  const pending = new Promise((resolve) => { finish = resolve; });
  const api = { searchContacts: async () => ({ success: true, contacts: [{ ...person(8), display_name: "Casey Other" }] }), getContactProfiles: async () => [person()], createContact: async (input: any) => { calls++; assert.deepEqual(input, { displayName: "Casey Synthetic", email: null, telegramUsername: null }); return pending; }, updateNote: async (...args: any[]) => { noteWrites.push(args); return { success: true }; } };
  const ui = await mount(t, listPath, { noteId: 1, participants: [], canRenameContacts: true }, api);
  await ui.click("notes.participants.addAttendees");
  assert.equal(ui.nodes().some((node) => node.tagName === "BUTTON" && node.textContent === "notes.participants.createNamed"), false);
  await ui.change(0, "Casey Synthetic");
  await ui.click("notes.participants.createNamed");
  await ui.click("notes.participants.createNamed");
  assert.equal(calls, 1);
  await ui.act(() => finish({ success: true, contact: person() }));
  assert.equal(noteWrites.length, 1);
  assert.deepEqual(JSON.parse(noteWrites[0][1].participants).map((entry: any) => entry.contactId), [7]);
});

test("an exact name match hides the creation row", async (t) => {
  const api = { searchContacts: async () => ({ success: true, contacts: [person()] }), getContactProfiles: async () => [person()] };
  const ui = await mount(t, listPath, { noteId: 1, participants: [], canRenameContacts: true }, api);
  await ui.click("notes.participants.addAttendees");
  await ui.change(0, "casey synthetic");
  assert.equal(ui.nodes().some((node) => node.tagName === "BUTTON" && node.textContent === "notes.participants.createNamed"), false);
});

test("creation failures keep the typed name and report which step failed", async (t) => {
  let creates = 0, fail = true;
  const api = { searchContacts: async () => ({ success: true, contacts: [] }), getContactProfiles: async () => [person()], createContact: async () => (creates++ === 0 ? { success: false, error: "invalid_name" } : { success: true, contact: person() }), updateNote: async () => ({ success: !fail }) };
  const ui = await mount(t, listPath, { noteId: 1, participants: [], canRenameContacts: true }, api);
  await ui.click("notes.participants.addAttendees");
  await ui.change(0, "Casey Synthetic");
  await ui.click("notes.participants.createNamed");
  assert.match(ui.text(), /contactSaveFailed/);
  assert.equal(props(ui.input(0)).value, "Casey Synthetic");
  await ui.click("notes.participants.createNamed");
  assert.match(ui.text(), /participantSaveFailed/);
  assert.equal(props(ui.input(0)).value, "Casey Synthetic");
  fail = false;
});

test("edit validation and conflicts preserve drafts and links, and Escape cancels", async (t) => {
  let writes = 0, cancelled = 0;
  const saved = { ...person(), email: "saved@example.com" };
  const ui = await mount(t, formPath, { contact: saved, onSaved: async () => true, onCancel: () => cancelled++ }, { updateContact: async (_id: number, input: any) => { writes++; assert.equal(input.telegramUsername, "Sample_337"); return { success: false, error: "email_conflict", existingContactId: 8 }; }, getContactProfiles: async () => [person(8)] });
  await ui.change(2, "https://t.me");
  await ui.submit();
  assert.equal(writes, 0);
  assert.match(ui.text(), /invalidTelegram/);
  await ui.change(2, "https://t.me/Sample_337/");
  await ui.change(1, "occupied@example.com");
  await ui.submit();
  assert.equal(writes, 1);
  assert.match(ui.text(), /editEmailConflict/);
  assert.equal(props(ui.input(1)).value, "occupied@example.com");
  assert.equal(ui.nodes().some((node) => node.tagName === "BUTTON" && node.textContent === "notes.participants.selectExisting"), false);
  assert.equal(saved.email, "saved@example.com");
  await ui.act(() => props(ui.find((node) => node.tagName === "FORM")).onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
  assert.equal(cancelled, 1);
});

test("shared cards refresh metadata without note writes and open the saved HTTPS Telegram link", async (t) => {
  let saved = { ...person(), telegram_username: "Sample_337" };
  const links: string[] = [], noteWrites: any[] = [];
  const participant = { contactId: 7, displayName: "Frozen Synthetic", email: null, responseStatus: null, self: false };
  const initial = { noteId: 1, participants: [participant], canRenameContacts: true };
  const ui = await mount(t, "/components/notes/NoteParticipants.tsx", initial, { getContactProfiles: async () => [saved], searchContacts: async () => ({ success: true, contacts: [] }), updateContact: async (_id: number, input: any) => ({ success: true, contact: saved = { ...saved, display_name: input.displayName, telegram_username: input.telegramUsername } }), updateNote: async (...args: any[]) => { noteWrites.push(args); return { success: true }; }, openExternal: async (url: string) => { links.push(url); } });
  await ui.click("@Sample_337");
  assert.deepEqual(links, ["https://t.me/Sample_337"]);
  await ui.click("notes.participants.editContact");
  const inputs = ui.nodes().filter((node) => node.tagName === "INPUT");
  await ui.change(inputs.findIndex((node) => props(node).value === "Casey Synthetic"), "Updated Synthetic");
  await ui.submit();
  assert.match(ui.text(), /Updated Synthetic/);
  assert.equal(noteWrites.length, 0);
  assert.equal(participant.displayName, "Frozen Synthetic");
  await ui.render({ ...initial, noteId: 2 });
  assert.match(ui.text(), /Updated Synthetic/);
});

test("search ignores stale results after query and note changes", async (t) => {
  const pending: Array<{ query: string; finish(value: any): void }> = [];
  const initial = { noteId: 1, participants: [], canRenameContacts: true };
  const ui = await mount(t, "/components/notes/NoteParticipants.tsx", initial, { searchContacts: (query: string) => new Promise((finish) => pending.push({ query, finish })), getContactProfiles: async () => [] });
  await ui.click("notes.participants.addAttendees");
  await ui.change(0, "older");
  await ui.change(0, "newer");
  await ui.act(() => pending.find((request) => request.query === "older")!.finish({ success: true, contacts: [{ ...person(), display_name: "Old Synthetic" }] }));
  assert.doesNotMatch(ui.text(), /Old Synthetic/);
  await ui.render({ ...initial, noteId: 2 });
  await ui.act(() => pending.find((request) => request.query === "newer")!.finish({ success: true, contacts: [{ ...person(), display_name: "New Synthetic" }] }));
  assert.doesNotMatch(ui.text(), /New Synthetic/);
});
