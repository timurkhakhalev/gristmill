const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// The contract is renderer/main-neutral; loading it under plain node only needs
// zod to resolve, so no electron stub is required. The probe helper reuses the
// compiler-program approach of test/scripts/mainBuild.test.js.
const root = path.resolve(__dirname, "../..");
const ts = require("typescript");

function compileWithProbe(probeSource, probeName) {
  const configPath = path.join(root, "src", "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.join(root, "src"));
  const probe = path.join(root, "src", probeName);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, probeSource, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (d) => d.file && d.file.fileName === probe
  );
  const before = fs.existsSync(probe);
  try {
    return { codes: diagnostics.map((d) => d.code), messageText: diagnostics[0]?.messageText };
  } finally {
    if (!before) fs.rmSync(probe, { force: true });
  }
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
    noteAddedUpdatedPayloadSchema.safeParse({ id: 1, title: "T", content: "", note_type: "personal", created_at: "", updated_at: "", space_id: 1, source_file: null, audio_duration_seconds: null, enhanced_content: null, enhancement_prompt: null, enhanced_at_content_hash: null, folder_id: null, transcript: null, calendar_event_id: null, participants: null, diarization_enabled: null, expected_speaker_count: null }).success,
    true
  );
  assert.equal(noteDeletedPayloadSchema.safeParse({ id: 3 }).success, true);
  assert.equal(noteDeletedPayloadSchema.safeParse({}).success, false);
});

test("type probe: a cloud-only update key is rejected at compile time", () => {
  const { codes } = compileWithProbe(
    `import type { NoteUpdate } from "./contracts/notes";
const bad: NoteUpdate = { left_team: 1 };
export { bad };
`,
    "notes-type-probe.ts"
  );
  assert.deepEqual(codes, [2353]);
});

test("type probe: an incomplete NoteItem is rejected at compile time", () => {
  const { codes } = compileWithProbe(
    `import type { NoteItem } from "./contracts/notes";
const bad: NoteItem = { id: 1, title: "T" };
export { bad };
`,
    "notes-type-probe.ts"
  );
  assert.deepEqual(codes, [2739]);
});

test("type probe: wrong argument type on saveNote is rejected at compile time", () => {
  const { codes } = compileWithProbe(
    `import type { NotesApi } from "./contracts/notes";
const api: NotesApi = {} as NotesApi;
const bad = api.saveNote(123, "content");
export { bad };
`,
    "notes-type-probe.ts"
  );
  assert.deepEqual(codes, [2345]);
});

test("type probe: correct usage compiles cleanly", () => {
  const { codes } = compileWithProbe(
    `import type { NotesApi, NoteItem } from "./contracts/notes";
const api: NotesApi = {} as NotesApi;
async function ok(): Promise<NoteItem | null> {
  return api.getNote(17);
}
export { ok };
`,
    "notes-type-probe.ts"
  );
  assert.deepEqual(codes, []);
});

// The main boundary probe compiles against tsconfig.main.json (strict, Node)
// because that is where registerNotesHandlers runs. It pins the P2 fix: the
// handler listener takes unknown[] and only schema-derived values reach deps,
// so swapped or wrong-typed arguments fail compilation.
function compileMainWithProbe(probeSource, probeName) {
  const configPath = path.join(root, "tsconfig.main.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const probe = path.join(root, probeName);
  const host = ts.createCompilerHost(parsed.options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, ...args) =>
    file === probe
      ? ts.createSourceFile(file, probeSource, languageVersion, true)
      : readSource(file, languageVersion, ...args);
  const program = ts.createProgram([probe], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter(
    (d) => d.file && d.file.fileName === probe
  );
  return { codes: diagnostics.map((d) => d.code) };
}

test("main boundary probe: wrong-typed deps fail strict compilation", () => {
  const { codes } = compileMainWithProbe(
    `import { registerNotesHandlers } from "./src/helpers/notesIpcHandlers.js";
registerNotesHandlers(
  { handle() {} },
  {
    // saveNote's first parameter must be a string, not a number: the handler
    // passes schema-parsed values, so a swap cannot compile through.
    saveNote: (title: number) => null,
    getNote: (id: number) => null,
    getNotes: () => null,
    getNotesForSpace: () => null,
    updateNote: () => null,
    deleteNoteInternal: () => null,
    searchNotes: () => null,
    asyncMirrorWrite: () => {},
    tryAutoLabelOneOnOne: () => {},
    refreshMeetingSpeakerConfigFromNote: () => {},
  }
);
`,
    "notes-main-probe.ts"
  );
  assert.deepEqual(codes, [2322]);
});

test("main boundary probe: correctly typed deps compile cleanly", () => {
  const { codes } = compileMainWithProbe(
    `import { registerNotesHandlers, type NotesHandlerDeps } from "./src/helpers/notesIpcHandlers.js";
const deps: NotesHandlerDeps = {
  saveNote: () => null,
  getNote: () => null,
  getNotes: () => null,
  getNotesForSpace: () => null,
  updateNote: () => null,
  deleteNoteInternal: () => null,
  searchNotes: () => null,
  asyncMirrorWrite: () => {},
  tryAutoLabelOneOnOne: () => {},
  refreshMeetingSpeakerConfigFromNote: () => {},
};
registerNotesHandlers({ handle() {} }, deps);
`,
    "notes-main-probe.ts"
  );
  assert.deepEqual(codes, []);
});

test("renderer probe: NotesApi exposes the error discriminant on update results", () => {
  const { codes } = compileWithProbe(
    `import type { NotesApi } from "./contracts/notes";
// The renderer tsconfig is not strict, so narrow with "=== false": truthiness
// checks on the literal discriminant only narrow under strictNullChecks.
async function check(api: NotesApi): Promise<string | undefined> {
  const result = await api.updateNote(1, { title: "T" });
  if (result.success === false) return result.error;
  return result.note.title ? undefined : undefined;
}
export { check };
`,
    "notes-type-probe.ts"
  );
  assert.deepEqual(codes, []);
});
