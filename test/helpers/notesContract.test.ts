const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const path: typeof import("node:path") = require("node:path");

// The contract is renderer/main-neutral; loading it under plain node only needs
// zod to resolve, so no electron stub is required. The probe helper reuses the
// compiler-program approach of test/scripts/mainBuild.test.js.
const root = path.resolve(__dirname, "../..");
const ts: typeof import("typescript") = require("typescript");

const rendererProbes = {
  cloudKey: `import type { NoteUpdate } from "./contracts/notes";
const bad: NoteUpdate = { left_team: 1 };
export { bad };
`,
  incompleteNote: `import type { NoteItem } from "./contracts/notes";
const bad: NoteItem = { id: 1, title: "T" };
export { bad };
`,
  wrongSaveArg: `import type { NotesApi } from "./contracts/notes";
const api: NotesApi = {} as NotesApi;
const bad = api.saveNote(123, "content");
export { bad };
`,
  valid: `import type { NotesApi, NoteItem } from "./contracts/notes";
const api: NotesApi = {} as NotesApi;
async function ok(): Promise<NoteItem | null> {
  return api.getNote(17);
}
export { ok };
`,
  updateResult: `import type { NotesApi } from "./contracts/notes";
async function check(api: NotesApi): Promise<string | undefined> {
  const result = await api.updateNote(1, { title: "T" });
  if (result.success === false) return result.error;
  return result.note.title ? undefined : undefined;
}
export { check };
`,
};
let rendererProbeResults: Record<string, number[]> | undefined;

function compileRendererProbes() {
  if (rendererProbeResults) return rendererProbeResults;
  const configPath = path.join(root, "src", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, "src"));
  const sources = new Map(Object.entries(rendererProbes).map(([name, source]) => [
    path.join(root, "src", `notes-type-probe-${name}.ts`), source,
  ]));
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(file);
    return source !== undefined
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([...sources.keys()], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.filter((d) => !d.file || !sources.has(d.file.fileName)), []);
  rendererProbeResults = Object.fromEntries(Object.keys(rendererProbes).map((name) => [
    name,
    diagnostics.filter((d) => d.file?.fileName === path.join(root, "src", `notes-type-probe-${name}.ts`))
      .map((d) => d.code),
  ]));
  return rendererProbeResults;
}

test("noteUpdateSchema strips unknown keys and keeps known ones", async () => {
  const { noteUpdateSchema } = await import("../../src/contracts/notes.ts");
  const parsed = noteUpdateSchema.parse({
    title: "T",
    client_note_id: "strip-me",
    cloud_id: "strip-me-too",
  });
  assert.deepEqual(parsed, { title: "T" });
});

test("noteUpdateSchema rejects wrong value types before any DB call could run", async () => {
  const { noteUpdateSchema } = await import("../../src/contracts/notes.ts");
  assert.equal(noteUpdateSchema.safeParse({ title: 42 }).success, false);
  assert.equal(noteUpdateSchema.safeParse({ folder_id: "nope" }).success, false);
  assert.equal(noteUpdateSchema.safeParse({ audio_duration_seconds: "1.5" }).success, false);
});

test("saveNoteArgsSchema keeps the positional shape including nullability", async () => {
  const { saveNoteArgsSchema } = await import("../../src/contracts/notes.ts");
  assert.equal(
    saveNoteArgsSchema.safeParse(["T", "C", "personal", null, null, null, null]).success,
    true
  );
  assert.equal(saveNoteArgsSchema.safeParse(["T", "C"]).success, true);
  assert.equal(saveNoteArgsSchema.safeParse(["T", 5]).success, false);
  assert.equal(saveNoteArgsSchema.safeParse([5, "C"]).success, false);
});

test("getNotesArgsSchema accepts a numeric SQLite limit of -1", async () => {
  const { getNotesArgsSchema } = await import("../../src/contracts/notes.ts");
  assert.equal(getNotesArgsSchema.safeParse([null, -1, null, null]).success, true);
  assert.equal(getNotesArgsSchema.safeParse([null, "many"]).success, false);
});

test("event payload schemas reject malformed notes", async () => {
  const { noteAddedUpdatedPayloadSchema, noteDeletedPayloadSchema } = await import(
    "../../src/contracts/notes.ts"
  );
  assert.equal(noteAddedUpdatedPayloadSchema.safeParse({ id: 1 }).success, false);
  assert.equal(
    noteAddedUpdatedPayloadSchema.safeParse({ id: 1, title: "T", content: "", note_type: "personal", created_at: "", updated_at: "", space_id: 1, source_file: null, audio_duration_seconds: null, enhanced_content: null, enhancement_prompt: null, enhanced_at_content_hash: null, folder_id: null, folder_ids: [], transcript: null, calendar_event_id: null, participants: null, diarization_enabled: null, expected_speaker_count: null }).success,
    true
  );
  assert.equal(noteDeletedPayloadSchema.safeParse({ id: 3 }).success, true);
  assert.equal(noteDeletedPayloadSchema.safeParse({}).success, false);
});

test("type probe: a cloud-only update key is rejected at compile time", () => {
  assert.deepEqual(compileRendererProbes().cloudKey, [2353]);
});

test("type probe: an incomplete NoteItem is rejected at compile time", () => {
  // src/tsconfig.json is strict now: for zod-inferred object types the same
  // missing-properties rejection is reported as 2740 instead of 2739
  // (verified both ways; the rejection semantics are unchanged).
  assert.deepEqual(compileRendererProbes().incompleteNote, [2740]);
});

test("type probe: wrong argument type on saveNote is rejected at compile time", () => {
  assert.deepEqual(compileRendererProbes().wrongSaveArg, [2345]);
});

test("type probe: correct usage compiles cleanly", () => {
  assert.deepEqual(compileRendererProbes().valid, []);
});

// The main boundary probes compile under the strict Node config used by
// registerNotesHandlers. Both cases share one program but keep separate results.
const mainProbes = {
  wrongDeps: `import { registerNotesHandlers } from "./src/helpers/notesIpcHandlers.js";
registerNotesHandlers(
  { handle() {} },
  {
    noteWrites: { saveNote: (title: number) => ({ success: false }), updateNote: () => ({ success: false }) },
    getNote: (id: number) => null,
    getNotes: () => null,
    getNotesForSpace: () => null,
    deleteNoteInternal: () => null,
    searchNotes: () => null,
  }
);
`,
  validDeps: `import { registerNotesHandlers, type NotesHandlerDeps } from "./src/helpers/notesIpcHandlers.js";
const deps: NotesHandlerDeps = {
  noteWrites: { saveNote: () => ({ success: false }), updateNote: () => ({ success: false }) },
  getNote: () => null,
  getNotes: () => null,
  getNotesForSpace: () => null,
  deleteNoteInternal: () => null,
  searchNotes: () => null,
  searchNoteContent: () => null,
  searchNoteTranscripts: () => null,
  getNoteTranscript: () => null,
};
registerNotesHandlers({ handle() {} }, deps);
`,
};
let mainProbeResults: Record<string, number[]> | undefined;

function compileMainProbes() {
  if (mainProbeResults) return mainProbeResults;
  const configPath = path.join(root, "tsconfig.main.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const sources = new Map(Object.entries(mainProbes).map(([name, source]) => [
    path.join(root, `notes-main-probe-${name}.ts`), source,
  ]));
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = sources.get(file);
    return source !== undefined
      ? ts.createSourceFile(file, source, languageVersion, true)
      : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([...sources.keys()], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.filter((d) => !d.file || !sources.has(d.file.fileName)), []);
  mainProbeResults = Object.fromEntries(Object.keys(mainProbes).map((name) => [
    name,
    diagnostics.filter((d) => d.file?.fileName === path.join(root, `notes-main-probe-${name}.ts`))
      .map((d) => d.code),
  ]));
  return mainProbeResults;
}

test("main boundary probe: wrong-typed deps fail strict compilation", () => {
  assert.deepEqual(compileMainProbes().wrongDeps, [2322]);
});

test("main boundary probe: correctly typed deps compile cleanly", () => {
  assert.deepEqual(compileMainProbes().validDeps, []);
});

test("renderer probe: NotesApi exposes the error discriminant on update results", () => {
  assert.deepEqual(compileRendererProbes().updateResult, []);
});
