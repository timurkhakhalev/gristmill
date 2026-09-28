const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const load = () => import("../../src/utils/calendarAttendees.js");
type CalendarEvent = import("../../src/contracts/calendar.js").CalendarEvent;

const makeEvent = (overrides: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "evt",
  attendees: null,
  attendees_count: 0,
  ...overrides,
} as CalendarEvent);

const attendee = (email: string, self = false) => ({
  email,
  displayName: null,
  responseStatus: "accepted",
  self,
});

test("hasOtherAttendees hides events with nobody invited", async () => {
  const { hasOtherAttendees } = await load();
  assert.equal(hasOtherAttendees(makeEvent()), false);
  assert.equal(hasOtherAttendees(makeEvent({ attendees: "[]", attendees_count: 0 })), false);
});

test("hasOtherAttendees hides events where the user is the only attendee", async () => {
  const { hasOtherAttendees } = await load();
  const solo = makeEvent({
    attendees: JSON.stringify([attendee("me@example.com", true)]),
    attendees_count: 1,
  });
  assert.equal(hasOtherAttendees(solo), false);
});

test("hasOtherAttendees keeps events with at least one other person", async () => {
  const { hasOtherAttendees } = await load();
  const meeting = makeEvent({
    attendees: JSON.stringify([attendee("me@example.com", true), attendee("them@example.com")]),
    attendees_count: 2,
  });
  assert.equal(hasOtherAttendees(meeting), true);
});

test("hasOtherAttendees falls back to attendees_count when the list is missing or malformed", async () => {
  const { hasOtherAttendees } = await load();
  assert.equal(hasOtherAttendees(makeEvent({ attendees: null, attendees_count: 3 })), true);
  assert.equal(hasOtherAttendees(makeEvent({ attendees: "{not json", attendees_count: 3 })), true);
  assert.equal(hasOtherAttendees(makeEvent({ attendees: null, attendees_count: 1 })), false);
});

test("parseAttendees returns an empty list for malformed JSON", async () => {
  const { parseAttendees } = await load();
  assert.deepEqual(parseAttendees(makeEvent({ attendees: "nope" })), []);
  assert.deepEqual(parseAttendees(makeEvent({ attendees: '{"a":1}' })), []);
});
