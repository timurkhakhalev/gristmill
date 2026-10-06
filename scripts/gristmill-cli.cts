#!/usr/bin/env node
// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const fs = require("node:fs") as typeof import("node:fs");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const os = require("node:os") as typeof import("node:os");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const path = require("node:path") as typeof import("node:path");

// SAFETY: CJS require seam; Node's strip-only TypeScript loader cannot run this script as ESM.
const { z } = require("zod") as typeof import("zod");

type NoteReadService = import("../src/helpers/noteReadService.ts").NoteReadService;

type NoteTranscript = import("../src/contracts/noteRead.ts").NoteTranscript;

type ListResult = ReturnType<NoteReadService["list"]>;

type SearchResult = ReturnType<NoteReadService["search"]>;

type ShowResult = ReturnType<NoteReadService["show"]>;

type ContentResult = ReturnType<NoteReadService["content"]>;

type SummaryResult = ReturnType<NoteReadService["summary"]>;

// The decoded body of a CLI request. request<T> returns the route's declared
// shape; formatHuman receives that shape and the resource that produced it.
type CliResponse =
  | ListResult
  | SearchResult
  | ShowResult
  | ContentResult
  | SummaryResult
  | NoteTranscript;

// The read-connection file and error bodies are external JSON written by the
// app; these schemas are the boundary that decodes them before use.
const readConnectionSchema = z.looseObject({
  port: z.number().int(),
  token: z.string(),
});

const errorBodySchema = z.looseObject({
  error: z.looseObject({ message: z.string().optional(), code: z.string().optional() }).optional(),
});

type Parsed =
  | { help: string }
  | { profile: string; doctor: true }
  | { profile: string; url: URL; plainText: boolean; resource: string };

interface HelpTexts {
  [key: string]: string;
}

const help: HelpTexts = {
  "": "Gristmill Notes CLI\nUsage: gristmill [--profile NAME] [--json] notes <command> | doctor\nCommands: notes list, notes search QUERY, notes show ID, notes content show ID, notes summary show ID, notes transcript show ID, doctor\nInteractive output is readable text. Redirected output is JSON; --json forces JSON in a terminal. Errors use the same output mode on stderr (exit 1); invalid arguments exit 2.\nInside a Gristmill BB workspace, commands use the workspace profile. Elsewhere the installed launcher defaults to its app channel: production or development. --profile dev is shorthand for development; GRISTMILL_PROFILE also selects a profile. Dates use local calendar days in the selected profile's machine time zone.\nExamples: gristmill notes list; gristmill --profile dev notes search release; gristmill --json notes transcript show 42 --from 00:12:00 --to 00:13:00",
  notes:
    "Usage: gristmill notes list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--with-transcript]\n       gristmill notes search QUERY [--note ID] [--from YYYY-MM-DD] [--to YYYY-MM-DD]\n       gristmill notes show ID\n       gristmill notes content show ID\n       gristmill notes summary show ID\n       gristmill notes transcript show ID [--from HH:MM:SS[.mmm]] [--to HH:MM:SS[.mmm]] [--speaker ID] [--plain-text]\nAdd --json for machine-readable output in a terminal. Redirected output is JSON. No result limit is applied. Empty lists and absent content are successful.",
  transcript:
    "Usage: gristmill notes transcript show ID [--from HH:MM:SS[.mmm]] [--to HH:MM:SS[.mmm]] [--speaker ID] [--plain-text]\nTimes use the concatenated Note recording timeline; intentional pauses are excluded. Interval filters include intersecting segments. --plain-text forces text when output is redirected.\nExample: gristmill notes transcript show 42 --from 00:12:00 --speaker speaker_2",
  list: 'Usage: gristmill notes list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--with-transcript]\nLists all Notes, newest first. Dates are inclusive local calendar days. Empty archives print No Notes. in a terminal or {"notes":[]} as JSON.',
  search:
    "Usage: gristmill notes search QUERY [--note ID] [--from YYYY-MM-DD] [--to YYYY-MM-DD]\nSearches title, user notes, Summary and every current Note transcript. JSON output has notes and transcripts arrays.",
  show: "Usage: gristmill notes show ID\nReturns Note metadata, participant names and content availability. Read content, summary and transcript separately.",
  content:
    "Usage: gristmill notes content show ID\nReturns exact user notes Markdown; an empty Note returns an empty string.",
  summary:
    "Usage: gristmill notes summary show ID\nReturns saved Summary Markdown or status absent; never generates content.",
};

const jsonOutput = process.argv.includes("--json") || !process.stdout.isTTY;

function failure(code: string, message: string, exitCode = 1) {
  process.stderr.write(
    jsonOutput ? JSON.stringify({ error: { code, message } }) + "\n" : `Error: ${message}\n`
  );
  process.exitCode = exitCode;
}

function parseTime(value: string) {
  const match = /^(\d{2,}):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(value);

  if (!match) throw new Error("Time must use HH:MM:SS[.mmm]");

  return (
    (Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])) * 1000 +
    Number((match[4] || "").padEnd(3, "0"))
  );
}

function parseArgs(argv: string[]): Parsed {
  const args = [...argv];
  const cwd = process.cwd();
  const workspaceProfile = path.basename(cwd) === "bb-agent" ? path.dirname(cwd) : null;

  let profile =
    process.env.GRISTMILL_PROFILE ||
    workspaceProfile ||
    process.env.GRISTMILL_CLI_DEFAULT_PROFILE ||
    "production";

  const jsonAt = args.indexOf("--json");

  if (jsonAt !== -1) args.splice(jsonAt, 1);
  const at = args.indexOf("--profile");

  if (at !== -1) {
    if (!args[at + 1]) throw new Error("--profile requires a name");
    profile = args[at + 1];
    args.splice(at, 2);
  }

  if (/^dev$/i.test(profile) || /^development$/i.test(profile)) profile = "development";
  else if (/^production$/i.test(profile)) profile = "production";

  if (profile !== "production" && !/^[a-z][a-z0-9-]*$/.test(profile) && !path.isAbsolute(profile)) {
    throw new Error("Invalid profile name");
  }

  if (args.includes("--help") || args.includes("-h")) {
    const text = args[0] === "notes" ? help[args[1]] || help.notes : help[""];

    return { help: text };
  }

  const command = args.shift();

  if (command === "doctor" && args.length === 0) return { profile, doctor: true };

  if (command !== "notes") throw new Error("Expected notes or doctor. Run gristmill --help");
  const resource = args.shift() || "";
  let pathname = "";
  let id;
  let query;

  if (resource === "list") pathname = "/v1/notes";
  else if (resource === "search") {
    query = args.shift();

    if (!query || query.startsWith("--")) throw new Error("search requires QUERY");
    pathname = "/v1/notes/search";
  } else if (resource === "show") pathname = "/v1/notes/";
  else if (["content", "summary", "transcript"].includes(resource) && args.shift() === "show")
    pathname = `/v1/notes/`;
  else throw new Error("Unknown notes command. Run gristmill notes --help");

  if (resource !== "list" && resource !== "search") {
    id = args.shift();

    if (!/^[1-9]\d*$/.test(id || "") || !Number.isSafeInteger(Number(id)))
      throw new Error("Expected positive note ID");
    pathname += id + (resource === "show" ? "" : `/${resource}`);
  }

  const url = new URL(pathname, "http://127.0.0.1");

  if (query) url.searchParams.set("q", query);
  let plainText = false;

  const allowed =
    resource === "list"
      ? ["from", "to", "with-transcript"]
      : resource === "search"
        ? ["note", "from", "to"]
        : resource === "transcript"
          ? ["from", "to", "speaker", "plain-text"]
          : [];

  while (args.length) {
    const flag = args.shift();

    if (flag === undefined) break;

    if (!flag.startsWith("--") || !allowed.includes(flag.slice(2)))
      throw new Error(`Unknown option ${flag}`);

    if (["--with-transcript", "--plain-text"].includes(flag)) {
      if (flag === "--plain-text") plainText = true;
      else url.searchParams.set("with_transcript", "true");
      continue;
    }

    const value = args.shift();

    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);

    if (["--from", "--to"].includes(flag) && resource === "transcript")
      url.searchParams.set(flag.slice(2) + "_ms", String(parseTime(value)));
    else if (
      ["--from", "--to"].includes(flag) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    )
      throw new Error("Date must use a valid YYYY-MM-DD");
    else if (
      flag === "--note" &&
      (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    )
      throw new Error("Invalid note ID");
    else url.searchParams.set(flag.slice(2), value);
  }

  const fromMs = url.searchParams.get("from_ms");
  const toMs = url.searchParams.get("to_ms");

  if (fromMs !== null && toMs !== null && Number(fromMs) >= Number(toMs))
    throw new Error("--from must be before --to");

  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  if (fromParam !== null && toParam !== null && fromParam > toParam)
    throw new Error("--from must be before --to");

  if (plainText && jsonAt !== -1) throw new Error("--json and --plain-text cannot be combined");

  return { profile, url, plainText, resource };
}

function profileDir(profile: string) {
  if (path.isAbsolute(profile)) return profile;

  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    profile === "production" ? "Gristmill" : `Gristmill-${profile}`
  );
}

interface ReadConnection {
  port: number;
  token: string;
}

// CLI failures carry an exit classification alongside the message; a named
// class keeps the code readable at every catch without widening Error.
class CliError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

function parseConnection(raw: string): ReadConnection | null {
  const parsed: unknown = JSON.parse(raw);
  const result = readConnectionSchema.safeParse(parsed);

  return result.success ? result.data : null;
}

function connection(profile: string): ReadConnection {
  const file = path.join(profileDir(profile), ".cli-read-connection.json");
  let stat;

  try {
    stat = fs.lstatSync(file);
  } catch {
    const message =
      profile === "production"
        ? "No Notes CLI connection for production. Update or restart Gristmill, or use --profile dev for Gristmill Dev"
        : profile === "development"
          ? "No Notes CLI connection for development. Open Gristmill Dev and retry"
          : "No Notes CLI connection for this profile. Open Gristmill with the selected profile and retry";

    throw new CliError(message, "app_unavailable");
  }

  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new CliError("Read connection file is not private", "read_access_unavailable");
  }

  const value = parseConnection(fs.readFileSync(file, "utf8"));

  if (value === null) throw new CliError("Invalid read connection file", "read_access_unavailable");

  return value;
}

function time(ms: number | null) {
  if (ms === null) return "??:??:??.???";
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");

  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

function plain(value: NoteTranscript, title: string) {
  const out = [
    `Note #${value.note_id} · ${title}`,
    `Transcript: ${value.status}`,
    "Times: concatenated Note recording timeline",
  ];

  if (value.diagnostics.length) out.push(`Incomplete: ${value.diagnostics.join(", ")}`);
  out.push("");

  for (const speaker of value.speakers)
    out.push(
      `${speaker.id} — ${speaker.name || "unknown"}${speaker.email ? ` <${speaker.email}>` : ""} · ${speaker.source || "unknown source"}${speaker.name_platform ? ` · ${speaker.name_platform === "google-meet" ? "Google Meet" : "Zoom"}` : ""}`
    );
  out.push("");
  const names = new Map(value.speakers.map((speaker) => [speaker.id, speaker.name || speaker.id]));

  if (value.segments)
    for (const segment of value.segments)
      out.push(
        `[${time(segment.start_ms)}–${time(segment.end_ms)}] ${names.get(segment.speaker_id || "") || "unknown"}\n${segment.text}`
      );
  else if (value.text) out.push(value.text);

  if (!value.text) out.push("No transcript text.");

  return out.join("\n") + "\n";
}

function formatHuman(resource: string, input: CliResponse, title = "") {
  if (resource === "list") {
    // SAFETY: the list request's body is the list route's own shape; the local
    // app writes it, and the resource branch selects that shape.
    const value = input as ListResult;

    if (!value.notes.length) return "No Notes.\n";

    return (
      value.notes
        .map((note) => `#${note.id}\t${note.created_at}\t${note.transcript_status}\t${note.title}`)
        .join("\n") + "\n"
    );
  }

  if (resource === "search") {
    // SAFETY: the search request's body is the search route's own shape.
    const value = input as SearchResult;
    const out = [];

    if (value.notes.length) {
      out.push("NOTES");

      for (const hit of value.notes) {
        out.push(`Note #${hit.note_id} · ${hit.title}`);

        for (const match of hit.matches) out.push(`  ${match.source}: ${match.snippet}`);
      }
    }

    if (value.transcripts.length) {
      if (out.length) out.push("");
      out.push("TRANSCRIPTS");

      for (const hit of value.transcripts) {
        out.push(`Note #${hit.note_id} · ${hit.title}`);

        for (const match of hit.matches)
          out.push(
            `  ${match.start_ms === null ? "time unknown" : time(match.start_ms)}${match.speaker_name ? ` · ${match.speaker_name}` : ""}: ${match.snippet}`
          );
      }
    }

    return out.length ? out.join("\n") + "\n" : "No matches.\n";
  }

  if (resource === "show") {
    // SAFETY: the show request's body is the show route's own shape.
    const value = input as ShowResult;

    const out = [
      `Note #${value.note_id} · ${value.title}`,
      `Created: ${value.created_at}`,
      `User notes: ${value.has_user_notes ? "available" : "absent"}`,
      `Summary: ${value.has_summary ? "available" : "absent"}`,
      `Transcript: ${value.transcript_status}`,
    ];

    if (value.participants.length) {
      out.push("Participants:");

      for (const person of value.participants)
        out.push(`  ${person.name || "Unknown"}${person.email ? ` <${person.email}>` : ""}`);
    }

    return out.join("\n") + "\n";
  }

  if (resource === "content") {
    // SAFETY: the content request's body is the content route's own shape.
    const value = input as ContentResult;

    return value.content ? value.content + "\n" : "No user notes.\n";
  }

  if (resource === "summary") {
    // SAFETY: the summary request's body is the summary route's own shape.
    const value = input as SummaryResult;

    return value.summary ? value.summary + "\n" : "No saved Summary.\n";
  }

  if (resource === "transcript") {
    // SAFETY: the transcript request's body is the transcript route's own shape.
    const value = input as NoteTranscript;

    return plain(value, title);
  }

  throw new Error(`Unknown output type: ${resource}`);
}

interface ErrorBody {
  error?: { message?: string; code?: string };
}

function parseErrorBody(raw: string): ErrorBody {
  const parsed: unknown = JSON.parse(raw);
  const result = errorBodySchema.safeParse(parsed);

  return result.success ? { error: result.data.error } : {};
}

async function request<T>(profile: string, url: URL): Promise<T> {
  const { port, token } = connection(profile);

  const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10000),
  });

  const text = await response.text();

  if (!response.ok) {
    const detail = parseErrorBody(text);

    throw new CliError(
      detail.error?.message || `HTTP ${response.status}`,
      detail.error?.code || "http_error"
    );
  }

  // SAFETY: the local app returns the route's declared JSON shape; the caller
  // selects T to match the route it requested.
  return JSON.parse(text) as T;
}

async function main() {
  let parsed;

  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    failure("invalid_arguments", error instanceof Error ? error.message : String(error), 2);

    return;
  }

  if ("help" in parsed) {
    process.stdout.write(parsed.help + "\n");

    return;
  }

  if ("doctor" in parsed) {
    try {
      await request(parsed.profile, new URL("/v1/health", "http://127.0.0.1"));

      const result = {
        ok: true,
        profile: parsed.profile,
        app_reachable: true,
        read_access: "verified",
      };

      process.stdout.write(
        jsonOutput
          ? JSON.stringify(result) + "\n"
          : `Gristmill ${parsed.profile}: connected (read-only)\n`
      );
    } catch (error) {
      const code = error instanceof CliError ? error.code : "";
      const reachable = code === "unauthorized" || code === "read_only";

      const result = {
        ok: false,
        profile: parsed.profile,
        app_reachable: reachable,
        read_access: reachable ? "denied" : "unverified",
        error: {
          code: reachable ? "read_access_denied" : "app_unavailable",
          message: reachable
            ? "Gristmill denied read access"
            : error instanceof Error
              ? error.message
              : String(error),
          hint: reachable
            ? "Restart Gristmill and retry"
            : "Open the selected Gristmill profile and retry",
        },
      };

      process.stdout.write(
        jsonOutput
          ? JSON.stringify(result) + "\n"
          : `Gristmill ${parsed.profile}: ${result.error.message}\n`
      );
      process.exitCode = 1;
    }

    return;
  }

  try {
    const value = await request<NoteTranscript>(parsed.profile, parsed.url);

    const title =
      parsed.plainText || (!jsonOutput && parsed.resource === "transcript")
        ? (
            await request<{ title: string }>(
              parsed.profile,
              new URL(`/v1/notes/${value.note_id}`, "http://127.0.0.1")
            )
          ).title
        : "";

    process.stdout.write(
      parsed.plainText
        ? plain(value, title)
        : jsonOutput
          ? JSON.stringify(value) + "\n"
          : formatHuman(parsed.resource, value, title)
    );
  } catch (error) {
    const known = [
      "note_not_found",
      "validation_error",
      "speaker_not_found",
      "transcript_filter_unavailable",
      "read_access_unavailable",
      "app_unavailable",
      "read_only",
      "unauthorized",
    ];

    const code = error instanceof CliError ? error.code : "";

    failure(
      known.includes(code) ? code : "app_unavailable",
      (error instanceof Error ? error.message : String(error)).includes("token")
        ? "Gristmill read access is unavailable"
        : error instanceof Error
          ? error.message
          : String(error)
    );
  }
}

if (require.main === module) {
  process.stdout.on("error", (error) => {
    // SAFETY: the stdout stream emits a NodeJS.ErrnoException; only `code` is
    // read, and EPIPE just means the reader (e.g. `head`) closed early.
    if ((error as NodeJS.ErrnoException).code === "EPIPE") process.exit(0);
    throw error;
  });
  main().catch((error) => {
    process.stderr.write(`[gristmill] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

const api = { formatHuman };

module.exports = api;

export type API = typeof api;
