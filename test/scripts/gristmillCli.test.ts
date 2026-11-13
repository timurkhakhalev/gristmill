const test: typeof import("node:test") = require("node:test");

const assert: typeof import("node:assert/strict") = require("node:assert/strict");

const fs: typeof import("node:fs") = require("node:fs");

const os: typeof import("node:os") = require("node:os");

const path: typeof import("node:path") = require("node:path");

const http: typeof import("node:http") = require("node:http");

const { spawnSync, spawn }: typeof import("node:child_process") = require("node:child_process");

const cli = path.resolve("scripts/gristmill-cli.cts");

const {
  formatHuman,
}: {
  formatHuman: (resource: string, value: unknown, title?: string) => string;
} = require("../../scripts/gristmill-cli.cts");

test("CLI help and argument errors have distinct output contracts", () => {
  const help = spawnSync(process.execPath, [cli, "notes", "transcript", "show", "--help"], {
    encoding: "utf8",
    cwd: os.tmpdir(),
  });

  assert.equal(help.status, 0);
  assert.match(help.stdout, /--plain-text/);

  const invalid = spawnSync(process.execPath, [cli, "notes", "show", "bad"], {
    encoding: "utf8",
    cwd: os.tmpdir(),
  });

  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.equal(JSON.parse(invalid.stderr).error.code, "invalid_arguments");

  const conflict = spawnSync(
    process.execPath,
    [cli, "--json", "notes", "transcript", "show", "42", "--plain-text"],
    { encoding: "utf8", cwd: os.tmpdir() }
  );

  assert.equal(conflict.status, 2);
  assert.equal(JSON.parse(conflict.stderr).error.code, "invalid_arguments");
});

test("CLI recognizes dev profile aliases without opening a real profile", (t: import("node:test").TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  for (const profile of ["dev", "DEV", "development"]) {
    const child = spawnSync(process.execPath, [cli, "--profile", profile, "doctor"], {
      encoding: "utf8",
      cwd: os.tmpdir(),
      env: { ...process.env, HOME: home },
    });

    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stdout).profile, "development");
    assert.equal(JSON.parse(child.stdout).error.code, "app_unavailable");
  }
});

test("CLI formats terminal list, transcript search and missing transcript clearly", () => {
  assert.equal(formatHuman("list", { notes: [] }), "No Notes.\n");
  assert.match(
    formatHuman("list", {
      notes: [
        {
          id: 42,
          created_at: "2026-09-29T18:00:00+03:00",
          transcript_status: "ready",
          title: "Planning",
        },
      ],
    }),
    /#42.*ready.*Planning/
  );

  const search = formatHuman("search", {
    notes: [],
    transcripts: [
      {
        note_id: 42,
        title: "Planning",
        matches: [{ start_ms: 72000, speaker_name: "Owner", snippet: "release plan" }],
      },
    ],
  });

  assert.match(
    search,
    /TRANSCRIPTS[\s\S]*Note #42 · Planning[\s\S]*00:01:12\.000 · Owner: release plan/
  );

  const transcript = formatHuman(
    "transcript",
    { note_id: 42, status: "absent", diagnostics: [], speakers: [], segments: null, text: null },
    "Planning"
  );

  assert.match(transcript, /Transcript: absent[\s\S]*No transcript text\./);
});

test("CLI reads a profile-scoped connection and prints one JSON response", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer test-token");
    assert.equal(request.url, "/v1/notes/42/content");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ note_id: 42, content: "saved words" }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Unexpected server address");
  fs.writeFileSync(
    path.join(directory, ".cli-read-connection.json"),
    JSON.stringify({ port: address.port, token: "test-token" }),
    { mode: 0o600 }
  );

  const child = spawn(
    process.execPath,
    [cli, "--profile", directory, "notes", "content", "show", "42"],
    { stdio: ["ignore", "pipe", "pipe"], cwd: os.tmpdir() }
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.deepEqual(JSON.parse(stdout), { note_id: 42, content: "saved words" });
});

test(
  "CLI exits quietly when head closes the transcript pipe early",
  { timeout: 10000 },
  async (t: import("node:test").TestContext) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-pipe-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

    const server = http.createServer((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ note_id: 42, text: "x".repeat(4 * 1024 * 1024) }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const address = server.address();

    if (!address || typeof address === "string") throw new Error("Unexpected server address");
    fs.writeFileSync(
      path.join(directory, ".cli-read-connection.json"),
      JSON.stringify({ port: address.port, token: "test-token" }),
      { mode: 0o600 }
    );

    const child = spawn(
      "/bin/bash",
      [
        "-o",
        "pipefail",
        "-c",
        '"$1" "$2" --profile "$3" notes transcript show 42 | head -c 20000',
        "cli-pipe",
        process.execPath,
        cli,
        directory,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: os.tmpdir(),
      }
    );

    t.after(() => child.kill());
    let bytes = 0;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });

    assert.equal(stderr, "");
    assert.equal(code, 0);
    assert.equal(bytes, 20000);
  }
);

test("BB commands use their workspace profile regardless of the installing app channel", async (t: import("node:test").TestContext) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-profiles-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const profiles = ["production", "development", "isolated"].map((name) =>
    path.join(directory, name)
  );

  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/v1/notes/42/content");
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ content: request.headers.authorization }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Unexpected server address");

  for (const [index, profile] of profiles.entries()) {
    fs.mkdirSync(path.join(profile, "bb-agent"), { recursive: true });
    fs.writeFileSync(
      path.join(profile, ".cli-read-connection.json"),
      JSON.stringify({ port: address.port, token: `test-${index}` }),
      { mode: 0o600 }
    );
  }

  async function run(cwd: string, args: string[] = [], explicitProfile = "") {
    const child = spawn(process.execPath, [cli, ...args, "notes", "content", "show", "42"], {
      cwd,
      env: {
        ...process.env,
        GRISTMILL_PROFILE: explicitProfile,
        GRISTMILL_CLI_DEFAULT_PROFILE: profiles[1],
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });

    return { code, stdout, stderr };
  }

  for (const [index, profile] of profiles.entries()) {
    const result = await run(path.join(profile, "bb-agent"));
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { content: `Bearer test-${index}` });
  }

  assert.deepEqual(JSON.parse((await run(directory)).stdout), { content: "Bearer test-1" });
  assert.deepEqual(
    JSON.parse((await run(path.join(profiles[0]!, "bb-agent"), [], profiles[1])).stdout),
    { content: "Bearer test-1" }
  );
  assert.deepEqual(
    JSON.parse(
      (await run(path.join(profiles[0]!, "bb-agent"), ["--profile", profiles[2]!], profiles[1]))
        .stdout
    ),
    { content: "Bearer test-2" }
  );
  fs.rmSync(path.join(profiles[0]!, ".cli-read-connection.json"));
  const unavailable = await run(path.join(profiles[0]!, "bb-agent"));
  assert.equal(unavailable.code, 1, "a closed workspace profile must not read another profile");
  assert.equal(JSON.parse(unavailable.stderr).error.code, "app_unavailable");
});

test("CLI transcript human output identifies the concrete platform behind a name", () => {
  const text = formatHuman(
    "transcript",
    {
      note_id: 42,
      status: "ready",
      diagnostics: [],
      speakers: [
        {
          id: "system:guest",
          name: "Guest",
          email: null,
          source: "system",
          name_source: "platform",
          name_platform: "google-meet",
        },
      ],
      segments: [],
      text: "Hello",
    },
    "Meeting"
  );

  assert.match(text, /Guest.*system.*Google Meet/);
});

test("CLI prints bundled skills as Markdown even when output is redirected", () => {
  const run = (args: string[]) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: os.tmpdir() });

  const list = run(["skills", "list"]);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /^ {2}core +Read Gristmill calls/);

  const core = run(["skills", "get", "core"]);
  assert.equal(core.status, 0, core.stderr);
  assert.match(core.stdout, /^---\nname: core\ndescription: .+\n---\n\n# Gristmill CLI/);
  assert.match(core.stdout, /gristmill-dev:\/\/notes\/42/);
  assert.doesNotMatch(core.stdout, /## Command reference/);

  const full = run(["skills", "get", "core", "--full"]);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /## Command reference[\s\S]*Usage: gristmill notes transcript show REF/);

  const json = run(["--json", "skills", "get", "core"]);
  assert.equal(json.status, 0, json.stderr);
  const [skill] = JSON.parse(json.stdout).skills;
  assert.equal(skill.name, "core");
  assert.equal(skill.content, core.stdout);

  const unknown = run(["skills", "get", "missing"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.equal(JSON.parse(unknown.stderr).error.code, "invalid_arguments");
});

test("CLI reads a shared call link from the profile that the link names", async (t: import("node:test").TestContext) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "gristmill-cli-link-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const requests: string[] = [];

  const server = http.createServer((request, response) => {
    requests.push(`${request.headers.authorization} ${request.url}`);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ content: "ok", notes: [], transcripts: [] }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();

  if (!address || typeof address === "string") throw new Error("Unexpected server address");

  for (const [folder, token] of [
    ["Gristmill", "production"],
    ["Gristmill-development", "development"],
  ]) {
    const profile = path.join(home, "Library", "Application Support", folder!);
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, ".cli-read-connection.json"),
      JSON.stringify({ port: address.port, token }),
      { mode: 0o600 }
    );
  }

  async function run(args: string[]) {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        HOME: home,
        GRISTMILL_PROFILE: "",
        GRISTMILL_CLI_DEFAULT_PROFILE: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("close", resolve);
      child.on("error", reject);
    });

    return { code, stdout, stderr };
  }

  const linked = await run(["notes", "content", "show", "gristmill-dev://notes/42"]);
  assert.equal(linked.code, 0, linked.stderr);
  assert.deepEqual(requests, ["Bearer development /v1/notes/42/content"]);

  const matching = await run(["--profile", "dev", "notes", "show", "gristmill-dev://notes/7/"]);
  assert.equal(matching.code, 0, matching.stderr);

  const search = await run(["notes", "search", "pricing", "--note", "gristmill://notes/9"]);
  assert.equal(search.code, 0, search.stderr);
  assert.deepEqual(requests.slice(1), [
    "Bearer development /v1/notes/7",
    "Bearer production /v1/notes/search?q=pricing&note=9",
  ]);

  for (const args of [
    ["--profile", "production", "notes", "show", "gristmill-dev://notes/42"],
    ["notes", "show", "other-app://notes/42"],
    ["notes", "show", "gristmill://notes/0"],
  ]) {
    const rejected = await run(args);
    assert.equal(rejected.code, 2, args.join(" "));
    assert.equal(JSON.parse(rejected.stderr).error.code, "invalid_arguments");
  }

  assert.equal(requests.length, 3, "a rejected link must not reach any profile");
});
