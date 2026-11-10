const test: typeof import("node:test") = require("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const { normalizeTelegramUsername, contactEmailSchema } = require("../../../../src/contracts/contactIdentity.ts");

test("Telegram basic usernames normalize only the four agreed forms", () => {
  for (const value of ["Sample_337", "@Sample_337", "t.me/Sample_337", "t.me/Sample_337/", "https://t.me/Sample_337", "https://t.me/Sample_337/"]) assert.equal(normalizeTelegramUsername(` ${value} `), "Sample_337");
  assert.equal(normalizeTelegramUsername(" "), null);
  assert.equal(normalizeTelegramUsername(null), null);
  for (const value of ["a".repeat(5), "a".repeat(32)]) assert.equal(normalizeTelegramUsername(value), value);
  for (const value of ["a".repeat(4), "a".repeat(33), "@@sample", "sam ple", "https://t.me", "t.me", "https://t.me/user_name?x=1", "https://t.me/user_name#x", "https://t.me:443/user_name", "https://x@t.me/user_name", "http://t.me/user_name", "https://other.example/user_name", "t.me/+12345", "t.me/user_name/12", "t.me/user_name//", "юзернейм"]) assert.throws(() => normalizeTelegramUsername(value), value);
});

test("all absent email representations become null and present emails normalize", () => {
  for (const value of [null, undefined, "", " ", "\t"]) assert.equal(contactEmailSchema.parse(value), null);
  assert.equal(contactEmailSchema.parse(" Sample@Example.com "), "sample@example.com");
});
