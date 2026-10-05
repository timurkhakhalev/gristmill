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
        matches: [{ start_ms: 72000, speaker_name: "Timur", snippet: "release plan" }],
      },
    ],
  });

  assert.match(
    search,
    /TRANSCRIPTS[\s\S]*Note #42 · Planning[\s\S]*00:01:12\.000 · Timur: release plan/
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
