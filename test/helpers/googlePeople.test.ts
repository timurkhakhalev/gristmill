const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const Module = require("node:module");

const originalLoad = Module._load;

function load() {
  Module._load = function loadWithMocks(request: string, parent: unknown, isMain: boolean) {
    if (request === "electron") return { net: {} };

    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("../../src/helpers/googlePeople") as typeof import("../../src/helpers/googlePeople");
  } finally {
    Module._load = originalLoad;
  }
}

const people = load();

const { PEOPLE_SCOPES, lacksPeopleAccess } = people;

const person = (email: string, name?: string, photo?: { url: string; default?: boolean }) => ({
  names: name ? [{ displayName: name, metadata: { primary: true } }] : [],
  emailAddresses: [{ value: email }],
  photos: photo ? [{ ...photo, metadata: { primary: true } }] : [],
});

function fakeApi(responses: Record<string, unknown>) {
  const requested: string[] = [];

  const apiGet = async (url: string) => {
    requested.push(url);
    const match = Object.keys(responses).find((path) => url.includes(path));

    if (!match) throw new Error(`unexpected ${url}`);
    const response = responses[match];

    if (response instanceof Error) throw response;

    return response;
  };

  return { apiGet, requested };
}

test("only the sources whose scopes were granted are read", async () => {
  const { apiGet, requested } = fakeApi({
    "/otherContacts": { otherContacts: [person("eli.rum@example.com", "Eli Rum")] },
    "/people/me?": person("me@x.com", "Timur"),
  });

  const profiles = await people.fetchGooglePeople(
    apiGet,
    `openid ${PEOPLE_SCOPES.otherContacts}`,
    () => {}
  );

  assert.equal(
    requested.some((url) => url.includes("connections")),
    false
  );
  assert.equal(
    requested.some((url) => url.includes("listDirectoryPeople")),
    false
  );
  assert.deepEqual(profiles.map((p) => [p.email, p.displayName]).sort(), [
    ["eli.rum@example.com", "Eli Rum"],
    ["me@x.com", "Timur"],
  ]);
});

test("directory names win over contacts, and a Google placeholder photo counts as none", async () => {
  const scope = Object.values(PEOPLE_SCOPES).join(" ");

  const { apiGet } = fakeApi({
    "/otherContacts": { otherContacts: [person("k@x.com", "k", { url: "https://lh3/other.jpg" })] },
    "/people/me/connections": { connections: [person("k@x.com", "Kostya")] },
    listDirectoryPeople: {
      people: [
        person("k@x.com", "Konstantin Doronin", { url: "https://lh3/default.jpg", default: true }),
      ],
    },
    "/people/me?": person("me@x.com"),
  });

  const [profile] = await people.fetchGooglePeople(apiGet, scope, () => {});

  assert.deepEqual(profile, {
    email: "k@x.com",
    displayName: "Konstantin Doronin",
    photoUrl: "https://lh3/other.jpg",
  });
});

test("a failing source is reported and the others still load", async () => {
  const scope = `${PEOPLE_SCOPES.directory} ${PEOPLE_SCOPES.contacts}`;
  const failures: string[] = [];

  const { apiGet } = fakeApi({
    listDirectoryPeople: new Error("personal account"),
    "/people/me/connections": { connections: [person("a@x.com", "Ann")] },
    "/people/me?": person("me@x.com"),
  });

  const profiles = await people.fetchGooglePeople(apiGet, scope, (source) => failures.push(source));

  assert.deepEqual(failures, ["directory"]);
  assert.deepEqual(
    profiles.map((p) => p.email),
    ["a@x.com"]
  );
});

test("pages are followed until the last one", async () => {
  let calls = 0;

  const apiGet = async (url: string) => {
    if (url.includes("/people/me?")) return {};
    calls++;

    return url.includes("pageToken=p2")
      ? { otherContacts: [person("b@x.com", "Bo")] }
      : { otherContacts: [person("a@x.com", "Ann")], nextPageToken: "p2" };
  };

  const profiles = await people.fetchGooglePeople(apiGet, PEOPLE_SCOPES.otherContacts, () => {});

  assert.equal(calls, 2);
  assert.deepEqual(profiles.map((p) => p.email).sort(), ["a@x.com", "b@x.com"]);
});

test("tokens granted before People access ask for a reconnect", () => {
  assert.equal(
    lacksPeopleAccess("openid email https://www.googleapis.com/auth/calendar.events.readonly"),
    true
  );
  assert.equal(lacksPeopleAccess(null), true);
  assert.equal(lacksPeopleAccess(`openid ${PEOPLE_SCOPES.directory}`), false);
});
