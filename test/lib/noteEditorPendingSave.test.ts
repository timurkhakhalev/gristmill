const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/lib/noteEditorPendingSave.js");

interface SourceNote {
  id: number;
  title: string;
  content: string;
  enhanced_content: string | null;
}

function note(id: number, content: string, enhancedContent: string | null = null): SourceNote {
  return {
    id,
    title: `Note ${id}`,
    content,
    enhanced_content: enhancedContent,
  };
}

test("applies title, content, and enhanced mutations only for the draft owner", async () => {
  const { applyNoteDraftMutation } = await load();
  const original = {
    noteId: 1,
    title: "Original title",
    content: "Original body",
    enhancedContent: "Original enhancement",
  };

  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "title",
      value: "Edited title",
    }),
    { ...original, title: "Edited title", dirtyTitle: true }
  );
  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "content",
      value: "Edited body",
    }),
    { ...original, content: "Edited body", dirtyContent: true }
  );
  assert.deepEqual(
    applyNoteDraftMutation(original, {
      sourceNoteId: 1,
      field: "enhancedContent",
      value: "Edited enhancement",
    }),
    { ...original, enhancedContent: "Edited enhancement" }
  );
  assert.deepEqual(original, {
    noteId: 1,
    title: "Original title",
    content: "Original body",
    enhancedContent: "Original enhancement",
  });
});

test("rejects foreign and stale source-note mutations without changing the draft", async () => {
  const { applyNoteDraftMutation } = await load();
  const draftA = {
    noteId: 1,
    title: "A title",
    content: "A body",
    enhancedContent: "A enhancement",
  };

  for (const mutation of [
    { sourceNoteId: 2, field: "title", value: "B title" },
    { sourceNoteId: 2, field: "content", value: "B body" },
    { sourceNoteId: 2, field: "enhancedContent", value: "B enhancement" },
  ] as import("../../src/lib/noteEditorPendingSave.js").NoteDraftMutation[]) {
    assert.equal(applyNoteDraftMutation(draftA, mutation), null);
  }
  assert.equal(
    applyNoteDraftMutation(null, {
      sourceNoteId: 1,
      field: "content",
      value: "No owner",
    }),
    null
  );
  assert.deepEqual(draftA, {
    noteId: 1,
    title: "A title",
    content: "A body",
    enhancedContent: "A enhancement",
  });

  const draftB = { ...draftA, noteId: 2 };
  assert.equal(
    applyNoteDraftMutation(draftB, {
      sourceNoteId: 1,
      field: "content",
      value: "Stale A callback",
    }),
    null
  );
});

test("collects document and enhanced writes under their captured owner", async () => {
  const { collectPendingNoteWrites } = await load();
  const documentA = { noteId: 1, title: "A title", content: "A body" };
  const enhancedA = { noteId: 1, enhancedContent: "A enhancement" };

  assert.deepEqual(collectPendingNoteWrites(null, null), []);
  assert.deepEqual(collectPendingNoteWrites(documentA, null), [
    {
      noteId: 1,
      updates: { title: "A title", content: "A body" },
    },
  ]);
  assert.deepEqual(collectPendingNoteWrites(null, enhancedA), [
    {
      noteId: 1,
      updates: { enhanced_content: "A enhancement" },
    },
  ]);
  assert.deepEqual(collectPendingNoteWrites(documentA, enhancedA), [
    {
      noteId: 1,
      updates: {
        title: "A title",
        content: "A body",
        enhanced_content: "A enhancement",
      },
    },
  ]);
});

test("keeps document and enhanced writes with different owners separate", async () => {
  const { collectPendingNoteWrites } = await load();

  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 1, title: "A title", content: "0" },
      { noteId: 2, enhancedContent: null }
    ),
    [
      {
        noteId: 1,
        updates: { title: "A title", content: "0" },
      },
      {
        noteId: 2,
        updates: { enhanced_content: null },
      },
    ]
  );
});

test("models B's editor event before the A-to-B parent transition, then returns to A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "A body", "A enhancement");
  const noteB = note(2, "B body", "B enhancement");

  let draft = planNoteTransition(noteA, null, null).nextDraft!;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 2,
      field: "content",
      value: "B early mount event",
    }),
    null
  );

  const toB = planNoteTransition(noteB, null, null);
  assert.deepEqual(toB.writes, []);
  assert.deepEqual(toB.nextDraft, {
    noteId: 2,
    title: "Note 2",
    content: "B body",
    enhancedContent: "B enhancement",
  });

  draft = toB.nextDraft!;
  assert.equal(
    applyNoteDraftMutation(draft, {
      sourceNoteId: 1,
      field: "content",
      value: "A stale callback",
    }),
    null
  );

  const backToA = planNoteTransition(noteA, null, null);
  assert.deepEqual(backToA.writes, []);
  assert.deepEqual(backToA.nextDraft, {
    noteId: 1,
    title: "Note 1",
    content: "A body",
    enhancedContent: "A enhancement",
  });
});

test("edit A then immediately switch to B keeps empty, zero, and raw content owned by A", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "Original A");
  const noteB = note(2, "Original B");

  for (const content of ["", "0", "Edited raw A"]) {
    const draftA = planNoteTransition(noteA, null, null).nextDraft!;
    const editedA = applyNoteDraftMutation(draftA, {
      sourceNoteId: 1,
      field: "content",
      value: content,
    });
    assert.ok(editedA);
    const edited = editedA!;

    const pendingA = {
      noteId: edited.noteId,
      title: edited.title,
      content: edited.content,
    };
    assert.equal(
      applyNoteDraftMutation(edited, {
        sourceNoteId: 2,
        field: "content",
        value: "B early mount event",
      }),
      null
    );

    const toB = planNoteTransition(noteB, pendingA, null);
    assert.deepEqual(toB.writes, [
      {
        noteId: 1,
        updates: { title: "Note 1", content },
      },
    ]);
    assert.equal(toB.nextDraft!.noteId, 2);
    assert.equal(pendingA.noteId, 1);
  }
});

test("an enhanced A edit flushes only to A during an immediate B transition", async () => {
  const { applyNoteDraftMutation, planNoteTransition } = await load();
  const noteA = note(1, "A body", "Old enhanced A");
  const noteB = note(2, "B body", "Enhanced B");
  const draftA = planNoteTransition(noteA, null, null).nextDraft!;
  const editedA = applyNoteDraftMutation(draftA, {
    sourceNoteId: 1,
    field: "enhancedContent",
    value: "New enhanced A",
  });
  assert.ok(editedA);
  const edited = editedA!;

  const pendingEnhancedA = {
    noteId: edited.noteId,
    enhancedContent: edited.enhancedContent,
  };
  assert.equal(
    applyNoteDraftMutation(edited, {
      sourceNoteId: 2,
      field: "enhancedContent",
      value: "B early enhanced event",
    }),
    null
  );

  const toB = planNoteTransition(noteB, null, pendingEnhancedA);
  assert.deepEqual(toB.writes, [
    {
      noteId: 1,
      updates: { enhanced_content: "New enhanced A" },
    },
  ]);
  assert.equal(toB.nextDraft!.noteId, 2);
  assert.equal(pendingEnhancedA.noteId, 1);
});

test("an overview transition flushes captured owners and clears the draft", async () => {
  const { planNoteTransition } = await load();

  const transition = planNoteTransition(
    null,
    { noteId: 1, title: "A title", content: "A body" },
    { noteId: 2, enhancedContent: "B enhancement" }
  );

  assert.deepEqual(transition, {
    writes: [
      {
        noteId: 1,
        updates: { title: "A title", content: "A body" },
      },
      {
        noteId: 2,
        updates: { enhanced_content: "B enhancement" },
      },
    ],
    nextDraft: null,
  });
});

test("deleting inactive B does not cancel A's pending save", async () => {
  const { shouldCancelPendingSavesForDelete } = await load();

  assert.equal(shouldCancelPendingSavesForDelete(17, 23), false);
  assert.equal(shouldCancelPendingSavesForDelete(17, 17), true);
  assert.equal(shouldCancelPendingSavesForDelete(null, 17), false);
});

test("an event draft handoff replaces the fresh note's draft and appends to an existing one", async () => {
  const { applyEventDraftHandoff } = await load();

  // Fresh note: the typed draft wins outright.
  assert.deepEqual(
    applyEventDraftHandoff(
      { noteId: 1, title: "Event title", content: "early snapshot", enhancedContent: null },
      { noteId: 1, note: note(1, ""), mode: "replace", draft: { content: "early snapshot plus ABC" } }
    ),
    {
      noteId: 1,
      title: "Event title",
      content: "early snapshot plus ABC",
      enhancedContent: null,
      dirtyContent: true,
    }
  );

  // Existing note: the manual content is kept, the typed text appends.
  assert.deepEqual(
    applyEventDraftHandoff(
      { noteId: 2, title: "Manual title", content: "Manual content", enhancedContent: null },
      { noteId: 2, note: note(2, ""), mode: "append", draft: { content: "first input" } }
    ),
    {
      noteId: 2,
      title: "Manual title",
      content: "Manual content\n\nfirst input",
      enhancedContent: null,
      dirtyContent: true,
    }
  );

  // Untyped draft fields leave the note's values alone.
  assert.deepEqual(
    applyEventDraftHandoff(
      { noteId: 3, title: "T", content: "C", enhancedContent: null },
      { noteId: 3, note: note(3, ""), mode: "append", draft: {} }
    ),
    { noteId: 3, title: "T", content: "C", enhancedContent: null }
  );

  // A typed draft title is deliberate input and wins even over an existing
  // note's title.
  assert.deepEqual(
    applyEventDraftHandoff(
      { noteId: 4, title: "Manual title", content: "", enhancedContent: null },
      { noteId: 4, note: note(4, ""), mode: "append", draft: { title: "Typed title" } }
    ).title,
    "Typed title"
  );

  // No change returns the same draft object.
  const draft = { noteId: 5, title: "T", content: "C", enhancedContent: null };
  assert.equal(
    applyEventDraftHandoff(draft, { noteId: 5, note: note(5, ""), mode: "replace", draft: { title: "T", content: "C" } }),
    draft
  );
});

// Issue #157: autosave must track dirty fields so a content-only edit never
// republishes a stale title over an externally-updated one, and vice versa.

test("external updates fill untouched fields and keep the user's dirty ones", async () => {
  const { acceptExternalNoteUpdate } = await load();

  // Content-only edit: the externally-generated title is accepted, the typed
  // content stays for the pending save.
  const contentEdit = {
    noteId: 1,
    title: "Old title",
    content: "Typed body",
    enhancedContent: null,
    dirtyContent: true,
  };
  const accepted = acceptExternalNoteUpdate(contentEdit, {
    title: "Generated title",
    content: "Ignored external content",
  });
  assert.deepEqual(accepted.draft, {
    noteId: 1,
    title: "Generated title",
    content: "Typed body",
    enhancedContent: null,
    dirtyContent: true,
    dirtyTitle: false,
  });
  assert.deepEqual(accepted.droppedDirty, { title: false, content: true });

  // Title-only edit: the externally-updated content is accepted.
  const titleEdit = {
    noteId: 2,
    title: "Typed title",
    content: "Old body",
    enhancedContent: null,
    dirtyTitle: true,
  };
  const acceptedTitle = acceptExternalNoteUpdate(titleEdit, {
    title: "Ignored external title",
    content: "Chat-tool content",
  });
  assert.deepEqual(acceptedTitle.draft, {
    noteId: 2,
    title: "Typed title",
    content: "Chat-tool content",
    enhancedContent: null,
    dirtyTitle: true,
    dirtyContent: false,
  });
  assert.deepEqual(acceptedTitle.droppedDirty, { title: true, content: false });

  // No dirty fields: the update replaces the complete draft (old behavior).
  const clean = acceptExternalNoteUpdate(
    { noteId: 3, title: "T", content: "C", enhancedContent: null },
    { title: "T2", content: "C2" }
  );
  assert.deepEqual(clean.draft, {
    noteId: 3,
    title: "T2",
    content: "C2",
    enhancedContent: null,
    dirtyTitle: false,
    dirtyContent: false,
  });

  // Empty external values are real values and clear the matching dirtiness.
  const empty = acceptExternalNoteUpdate(
    { noteId: 4, title: "T", content: "Typed", enhancedContent: null, dirtyContent: true },
    { content: "" }
  );
  assert.deepEqual(empty.draft, {
    noteId: 4,
    title: "T",
    content: "Typed",
    enhancedContent: null,
    dirtyContent: true,
  });
  const emptyClean = acceptExternalNoteUpdate(
    { noteId: 5, title: "T", content: "C", enhancedContent: null },
    { content: "" }
  );
  assert.equal(emptyClean.draft.content, "");
});

test("dirty-trimmed snapshots write only the fields the user edited", async () => {
  const { collectPendingNoteWrites } = await load();

  // A content-only edit writes only content: an external title survives.
  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 1, content: "Typed body" },
      null
    ),
    [{ noteId: 1, updates: { content: "Typed body" } }]
  );

  // A title-only edit writes only title: an external content survives.
  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 2, title: "Typed title" },
      null
    ),
    [{ noteId: 2, updates: { title: "Typed title" } }]
  );

  // Both fields dirty: both are written (the old full-document shape).
  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 3, title: "T", content: "C" },
      { noteId: 3, enhancedContent: null }
    ),
    [
      {
        noteId: 3,
        updates: { title: "T", content: "C", enhanced_content: null },
      },
    ]
  );

  // A different-owner enhanced write stays separate (unchanged policy).
  assert.deepEqual(
    collectPendingNoteWrites(
      { noteId: 1, content: "C" },
      { noteId: 2, enhancedContent: "E" }
    ),
    [
      { noteId: 1, updates: { content: "C" } },
      { noteId: 2, updates: { enhanced_content: "E" } },
    ]
  );

  // A fully clean snapshot flushes no document write at all.
  assert.deepEqual(collectPendingNoteWrites({ noteId: 9 }, null), [
    { noteId: 9, updates: {} },
  ]);
});
