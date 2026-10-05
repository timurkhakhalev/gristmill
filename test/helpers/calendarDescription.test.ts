const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const { calendarDescriptionText } = require("../../src/helpers/calendarDescription");

test("Google's HTML description becomes readable plain text", () => {
  assert.equal(
    calendarDescriptionText(
      'Agenda:<br><ul><li>Intro</li><li>Q&amp;A</li></ul><a href="https://zoom.us/j/1">Join Zoom</a>'
    ),
    "Agenda:\n• Intro\n• Q&A\nJoin Zoom (https://zoom.us/j/1)"
  );
});

test("a link whose text is its address is kept once", () => {
  assert.equal(
    calendarDescriptionText(
      '<a href="https://meet.google.com/abc">https://meet.google.com/abc</a>'
    ),
    "https://meet.google.com/abc"
  );
});

test("plain text passes through and empty descriptions become null", () => {
  assert.equal(calendarDescriptionText("Room 4\n\n\n\nBring slides"), "Room 4\n\nBring slides");
  assert.equal(calendarDescriptionText("<p> </p>"), null);
  assert.equal(calendarDescriptionText(null), null);
});
