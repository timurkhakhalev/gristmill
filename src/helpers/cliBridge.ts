import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import debugLogger from "./debugLogger.js";
import { isPortAvailable } from "../utils/serverUtils.js";
import { saveNoteArgsSchema, updateNoteArgsSchema } from "../contracts/notes.js";
import type { NoteWriteService } from "./noteWriteService.js";
import { sendDictionaryUpdated, sendSnippetsUpdated } from "./vocabularyEvents.js";
import { sendFolderCreated } from "./containerEvents.js";
import type { NoteRow, FolderRow, TranscriptionRow } from "./database.js";
import type { NoteItem } from "../contracts/notes.js";
import type {
  TranscriptionOptions,
  TranscriptionResponse,
} from "../contracts/localFileTranscription.js";
import { NoteReadService } from "./noteReadService.js";
import { NoteReadError } from "../contracts/noteRead.js";

const PORT_RANGE_START = 8200;

const PORT_RANGE_END = 8219;

const HOST = "127.0.0.1";

const BRIDGE_FILE_VERSION = 1;

const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function getBridgeFilePath(userData: string): string {
  return path.join(userData, ".cli-read-connection.json");
}

async function findPortInRange(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }

  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

// The JSON values the bridge can place on the wire: every response payload is
// built from these and serialized with JSON.stringify.
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

// A single decoded JSON body field. The routes narrow each value through the
// helpers below before it reaches a domain call, so the body itself stays the
// honest JSON boundary type.
type JsonField = JsonValue;

// The narrow operations the CLI adapter runs on top of — the same notes/
// dictionary/snippets operations and event senders the IPC handlers use. The
// input types mirror DatabaseManager; only the read surfaces the CLI returns
// differ (whole rows for notes and transcriptions).
export interface CliBridgeOperations {
  databaseManager: {
    getNotes(
      noteType?: string | null,
      limit?: number,
      folderId?: number | null,
      spaceId?: number | null
    ): NoteRow[];
    searchNotes(
      query: string,
      limit?: number,
      spaceId?: number | null,
      folderId?: number | null
    ): NoteRow[];
    getNote(id: number | bigint): NoteRow | null;
    getFolders(spaceId?: number | null): FolderRow[];
    createFolder(
      name: string | null | undefined,
      spaceId?: number | null
    ): { success: boolean; error?: string; folder?: FolderRow };
    getDictionary(): string[];
    applyDictionaryChanges(delta: { add?: string[]; remove?: string[] }): {
      success: boolean;
      added: number;
      removed: number;
    };
    getSnippets(): Array<{ trigger: string; replacement: string }>;
    setSnippets(snippets: Array<{ trigger: string; replacement: string }>): {
      success: boolean;
    };
    getTranscriptions(limit?: number): TranscriptionRow[];
    getTranscriptionById(id: number | bigint): TranscriptionRow | null;
    updateTranscriptionAudio(
      id: number,
      audio: {
        hasAudio?: boolean | number;
        audioDurationMs?: number | null;
        provider?: string | null;
        model?: string | null;
      }
    ): { success: boolean };
  };
  deleteNoteInternal(id: number): Promise<{ success: boolean }>;
  deleteTranscriptionInternal(id: number): { success: boolean };
  noteWrites: Pick<NoteWriteService, "saveNote" | "updateNote">;
  approveAudioPath(filePath: string): void;
  transcribeLocalFile(
    filePath: string,
    options?: TranscriptionOptions
  ): Promise<TranscriptionResponse>;
  listLocalTranscriptionModels(): Array<{
    model: string;
    default?: boolean;
    downloaded?: boolean;
    provider?: string;
  }>;
  audioStorageManager: { deleteAudio(id: number): { success: boolean } };
  noteReadService?: NoteReadService;
}

interface CodedRouteError extends Error {
  code?: string;
}

function routeError(message: string, code: string): CodedRouteError {
  return Object.assign(new Error(message), { code });
}

function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

function isJsonObject<T>(value: T): value is T & JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray<T>(value: T): value is T & string[] {
  return Array.isArray(value) && value.every((entry) => isString(entry));
}

function isNumber<T>(value: T): value is T & number {
  return typeof value === "number";
}

function isBoolean<T>(value: T): value is T & boolean {
  return typeof value === "boolean";
}

function errorMessage<T>(error: T): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode<T>(error: T): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) return undefined;
  const code: unknown = error.code;

  return isString(code) ? code : undefined;
}

// Decodes one JSON field the routes read from a request body. Missing fields
// resolve to undefined; a wrong-typed field is kept as-is so each route's own
// validation rejects it with its existing message.
function bodyField(body: JsonObject, key: string): JsonField {
  return body[key];
}

// createFolder coerces its input with `String(name || "")`. This reproduces
// that coercion for a JSON body field, including the falsy cases (0/false/null)
// that become an empty name and are rejected.
function folderNameValue(value: JsonField): string {
  if (isString(value)) return value;

  if (isNumber(value) || isBoolean(value)) return String(value || "");

  if (Array.isArray(value)) return value.map((entry) => folderNameValue(entry)).join(",");

  if (value === null || value === undefined) return "";

  return "[object Object]";
}

function readJsonBody(req: http.IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    // Buffer the raw chunks and decode once at the end: decoding per chunk
    // corrupts multibyte sequences split across chunk boundaries.
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;
    req.on("data", (chunk: Buffer | string) => {
      if (rejected) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;

      if (receivedBytes > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        reject(new Error("Request body too large"));
        req.destroy();

        return;
      }

      chunks.push(buffer);
    });
    req.on("end", () => {
      if (rejected) return;
      const raw = Buffer.concat(chunks, receivedBytes).toString("utf8");

      if (!raw) return resolve({});

      try {
        const parsed: unknown = JSON.parse(raw);

        // The routes below validate every field they read, so a non-object
        // body degrades to the empty record the same way a missing one does.
        resolve(isJsonObject(parsed) ? parsed : {});
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson<T>(res: http.ServerResponse, statusCode: number, payload: T): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res: http.ServerResponse): void {
  res.writeHead(204);
  res.end();
}

function sendV1Error(
  res: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string
): void {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value: string | undefined): number | null {
  const id = Number(value);

  if (!Number.isInteger(id) || id <= 0) return null;

  return id;
}

// Each note/folder mutation returns its domain row through one `success` flag
// plus the named field; a failed mutation carries an optional message.
interface NoteMutationLike {
  success?: boolean;
  error?: string;
  note?: NoteItem | null;
}

interface FolderMutationLike {
  success?: boolean;
  error?: string;
  folder?: FolderRow | null;
}

function unwrapNote(result: NoteMutationLike): NoteItem {
  if (!result.success || !result.note) {
    throw new Error(result.error || "Failed to write note");
  }

  return result.note;
}

function unwrapFolder(result: FolderMutationLike): FolderRow {
  if (!result.success || !result.folder) {
    throw new Error(result.error || "Failed to write folder");
  }

  return result.folder;
}

interface RouteParams {
  params: Record<string, string>;
  query: URLSearchParams;
  body: JsonObject;
}

interface RouteEntry {
  method: string;
  match(pathname: string): Record<string, string> | null;
  handler(context: RouteParams): RouteResult | Promise<RouteResult>;
  status?: number;
}

// 204 responses have no body; this sentinel routes them apart from payloads.
const NO_CONTENT = Symbol("CliBridge.NoContent");

// Every route returns a serializable value: a domain row/envelope object, a
// list of them, or a primitive. The union names that wire contract without
// widening any handler to `unknown`.
type RouteResult =
  | object
  | readonly object[]
  | string
  | readonly string[]
  | number
  | boolean
  | null
  | typeof NO_CONTENT;

export class CliBridge {
  private readonly ops: CliBridgeOperations;
  private server: http.Server | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private readToken: string | null = null;
  private readonly bridgeFilePath: string;
  private readonly routes: RouteEntry[];

  constructor(operations: CliBridgeOperations, userData: string) {
    this.ops = operations;
    this.bridgeFilePath = getBridgeFilePath(userData);
    this.routes = this._buildRouteTable();
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.readToken = crypto.randomBytes(32).toString("hex");
    this.port = await findPortInRange();

    const server = (this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: errorMessage(err) }, "cli-bridge");

        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    }));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };

      server.once("error", onError);
      // SAFETY: findPortInRange resolved a port before this call, so it is set.
      server.listen(this.port as number, HOST, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  getConnection(): { port: number; token: string } | null {
    return this.server && this.port && this.token ? { port: this.port, token: this.token } : null;
  }

  async stop(): Promise<void> {
    const server = this.server;

    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this.readToken = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile(): void {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });

    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.readToken,
    });

    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });

    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: errorMessage(err) }, "cli-bridge");
    }
  }

  _removeBridgeFile(): void {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (errorCode(err) !== "ENOENT") {
        debugLogger.debug(
          "CLI bridge file removal failed",
          { error: errorMessage(err) },
          "cli-bridge"
        );
      }
    }
  }

  async _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const remote = req.socket?.remoteAddress;

    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");

      return;
    }

    const auth = req.headers["authorization"] || "";

    const authenticated = (token: string | null) => {
      const expected = `Bearer ${token}`;

      return (
        token !== null &&
        auth.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
      );
    };

    const writeAccess = authenticated(this.token);

    if (!writeAccess && !authenticated(this.readToken)) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");

      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);

    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");

      return;
    }

    const readRoute =
      req.method === "GET" &&
      (url.pathname === "/v1/health" ||
        url.pathname === "/v1/notes" ||
        url.pathname === "/v1/notes/search" ||
        /^\/v1\/notes\/\d+(?:\/(?:content|summary|transcript))?$/.test(url.pathname));

    if (!writeAccess && !readRoute) {
      sendV1Error(res, 403, "read_only", "Read-only token cannot access this route");

      return;
    }

    let body: JsonObject = {};

    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", errorMessage(err));

        return;
      }
    }

    try {
      // Handlers may be synchronous or return a promise; awaiting a plain value
      // resolves to that value, matching the prior synchronous callback support.
      const result: RouteResult = await Promise.resolve(
        route.handler({ params: route.params, query: url.searchParams, body })
      );

      if (result === NO_CONTENT) {
        sendNoContent(res);

        return;
      }

      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      // SAFETY: route handlers throw routeError()-built errors (or NoteReadError)
      // whose `code` is read by _sendError; any other Error falls through to the
      // 500 branch there.
      this._sendError(res, err as CodedRouteError);
    }
  }

  // SAFETY: a thrown route value is an Error subclass or an Error carrying the
  // conventional `code` field; the branches below read only those fields.
  _sendError(res: http.ServerResponse, err: CodedRouteError): void {
    if (err.code === "NOTE_NOT_FOUND") {
      sendV1Error(res, 404, "note_not_found", err.message);

      return;
    }

    if (err instanceof NoteReadError) {
      sendV1Error(res, 400, err.code, err.message);

      return;
    }

    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);

      return;
    }

    if (err.code === "VALIDATION") {
      sendV1Error(res, 400, "validation_error", err.message);

      return;
    }

    debugLogger.error("CLI bridge route error", { error: err.message }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", err.message || "Internal server error");
  }

  _matchRoute(
    method: string | undefined,
    pathname: string
  ): (RouteEntry & { params: Record<string, string> }) | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);

      if (params) return { ...route, params };
    }

    return null;
  }

  _buildRouteTable(): RouteEntry[] {
    const exact = (
      method: string,
      routePath: string,
      handler: (context: RouteParams) => RouteResult,
      status?: number
    ): RouteEntry => ({
      method,
      match: (p) => (p === routePath ? {} : null),
      handler,
      status,
    });

    const param = (
      method: string,
      prefix: string,
      suffix: string,
      paramName: string,
      handler: (context: RouteParams) => RouteResult,
      status?: number
    ): RouteEntry => ({
      method,
      match: (p) => {
        if (!p.startsWith(prefix)) return null;
        const rest = p.slice(prefix.length);

        if (suffix) {
          if (!rest.endsWith(suffix)) return null;
          const value = rest.slice(0, rest.length - suffix.length);

          if (!value || value.includes("/")) return null;

          return { [paramName]: value };
        }

        if (rest.includes("/")) return null;

        return { [paramName]: rest };
      },
      handler,
      status,
    });

    const db = this.ops.databaseManager;
    const ipc = this.ops;
    const reader = this.ops.noteReadService;

    const requireReader = () => {
      if (!reader) throw routeError("Note reader unavailable", "UNAVAILABLE");

      return reader;
    };

    const scope = (query: URLSearchParams) => {
      const from = query.get("from") ?? undefined;
      const to = query.get("to") ?? undefined;

      if (
        [from, to].some(
          (date) =>
            date &&
            (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
              Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ||
              new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
        )
      ) {
        throw routeError("Dates must use YYYY-MM-DD", "VALIDATION");
      }

      if (from && to && from > to) throw routeError("'from' must be before 'to'", "VALIDATION");
      const rawNote = query.get("note");
      const note = rawNote === null ? undefined : Number(rawNote);

      if (note !== undefined && (!Number.isSafeInteger(note) || note < 1))
        throw routeError("Invalid note id", "VALIDATION");

      return { from, to, note };
    };

    const requireNote = (id: number): NoteRow => {
      const note = db.getNote(id);

      if (!note) throw routeError(`Note ${id} not found`, "NOTE_NOT_FOUND");

      return note;
    };

    const requireId = (params: Record<string, string>, label: string): number => {
      const id = parseIdParam(params.id);

      if (id == null) throw routeError(`Invalid ${label} id`, "NOT_FOUND");

      return id;
    };

    const requireWordList = (value: JsonField, field: string): string[] => {
      if (value === undefined || value === null) return [];

      if (!isStringArray(value)) {
        throw routeError(`'${field}' must be an array of strings`, "VALIDATION");
      }

      return value;
    };

    const isSnippetField = (
      value: JsonField
    ): value is { trigger: string; replacement: string } => {
      if (!isJsonObject(value)) return false;
      const trigger = value.trigger;
      const replacement = value.replacement;

      return (
        isString(trigger) &&
        trigger.trim().length > 0 &&
        isString(replacement) &&
        replacement.trim().length > 0
      );
    };

    const requireSnippetList = (
      value: JsonField
    ): Array<{ trigger: string; replacement: string }> => {
      if (value === undefined || value === null) return [];

      if (!Array.isArray(value) || !value.every(isSnippetField)) {
        throw routeError(
          "'add' must be an array of { trigger, replacement } strings",
          "VALIDATION"
        );
      }

      return value;
    };

    const requireAudioFile = (value: JsonField): string => {
      if (!isString(value) || !value.trim()) {
        throw routeError("'path' must be the path of an audio file", "VALIDATION");
      }

      let stat: fs.Stats;

      try {
        stat = fs.statSync(value);
      } catch {
        throw routeError(`No file at ${value}`, "NOT_FOUND");
      }

      if (!stat.isFile()) {
        throw routeError("'path' must point to a file, not a directory", "VALIDATION");
      }

      return fs.realpathSync(value);
    };

    // Picks the requested model, or the one the app is set to use, and refuses
    // anything not on disk so the engines' own errors stay genuine failures.
    const requireLocalModel = (
      models: Array<{ model: string; default?: boolean; downloaded?: boolean; provider?: string }>,
      requested: JsonField
    ) => {
      if (requested !== undefined && !isString(requested)) {
        throw routeError("'model' must be a string", "VALIDATION");
      }

      const match = requested
        ? models.find((m) => m.model === requested)
        : models.find((m) => m.default);

      if (!match) {
        throw routeError(
          requested
            ? `Unknown model '${requested}'. Available: ${models.map((m) => m.model).join(", ")}`
            : "No local transcription model is selected. Choose one in Gristmill under Settings → Transcription, or pass 'model'.",
          "VALIDATION"
        );
      }

      if (!match.downloaded) {
        throw routeError(
          `Model '${match.model}' is not downloaded. Open Gristmill and download it under Settings → Transcription.`,
          "VALIDATION"
        );
      }

      return match;
    };

    const requireSuccess = (
      result: { success?: boolean; error?: string } | null | undefined,
      message: string
    ): void => {
      if (!result?.success) {
        throw routeError(result?.error || message, "NOT_FOUND");
      }
    };

    return [
      exact("GET", "/v1/health", () => ({ data: { ok: true, version: 1 } })),
      exact("GET", "/v1/notes", ({ query }) =>
        requireReader().list({
          ...scope(query),
          withTranscript: query.get("with_transcript") === "true",
        })
      ),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = query.get("q") || "";

        if (!q.trim()) throw routeError("Search query is required", "VALIDATION");

        return requireReader().search(q, scope(query));
      }),
      param("GET", "/v1/notes/", "/content", "id", ({ params }) => {
        const id = requireId(params, "note");

        return requireReader().content(requireNote(id));
      }),
      param("GET", "/v1/notes/", "/summary", "id", ({ params }) => {
        const id = requireId(params, "note");

        return requireReader().summary(requireNote(id));
      }),
      param("GET", "/v1/notes/", "/transcript", "id", ({ params, query }) => {
        const id = requireId(params, "note");
        requireNote(id);
        const fromMs = query.has("from_ms") ? Number(query.get("from_ms")) : undefined;
        const toMs = query.has("to_ms") ? Number(query.get("to_ms")) : undefined;

        if (
          [fromMs, toMs].some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 0)) ||
          (fromMs !== undefined && toMs !== undefined && fromMs >= toMs)
        ) {
          throw routeError("Invalid transcript interval", "VALIDATION");
        }

        return requireReader().transcript(id, {
          fromMs,
          toMs,
          speaker: query.get("speaker") ?? undefined,
        });
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");

        return requireReader().show(requireNote(id));
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const args = saveNoteArgsSchema.safeParse([
            bodyField(body, "title") ?? "Untitled Note",
            bodyField(body, "content") ?? "",
            bodyField(body, "note_type") ?? "personal",
            bodyField(body, "source_file") ?? null,
            bodyField(body, "audio_duration_seconds") ?? null,
            bodyField(body, "folder_id") ?? null,
            null,
          ]);

          if (!args.success) throw routeError("Invalid Note creation fields", "VALIDATION");

          const note = unwrapNote(
            ipc.noteWrites.saveNote(
              args.data[0],
              args.data[1],
              args.data[2],
              args.data[3] ?? null,
              args.data[4] ?? null,
              args.data[5] ?? null,
              args.data[6] ?? null
            )
          );

          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const args = updateNoteArgsSchema.safeParse([id, body]);

        if (!args.success) throw routeError("Invalid Note update fields", "VALIDATION");
        const note = unwrapNote(ipc.noteWrites.updateNote(args.data[0], args.data[1]));

        return { data: note };
      }),
      param("DELETE", "/v1/notes/", "", "id", async ({ params }) => {
        const id = requireId(params, "note");
        const result = await ipc.deleteNoteInternal(id);
        requireSuccess(result, `Note ${id} not found`);

        return NO_CONTENT;
      }),
      exact("GET", "/v1/folders/list", () => {
        return { data: db.getFolders(), has_more: false, next_cursor: null };
      }),
      exact(
        "POST",
        "/v1/folders/create",
        ({ body }) => {
          const folder = unwrapFolder(db.createFolder(folderNameValue(bodyField(body, "name"))));
          setImmediate(() => sendFolderCreated(folder));

          return { data: folder };
        },
        201
      ),
      exact("GET", "/v1/dictionary/list", () => {
        return { data: db.getDictionary(), has_more: false, next_cursor: null };
      }),
      // Bulk edits without writing to SQLite by hand, which lost rows on the
      // next launch and never reached the cloud (#1295). Takes a delta, so an
      // import cannot delete words it didn't name.
      exact("POST", "/v1/dictionary/update", ({ body }) => {
        const add = requireWordList(bodyField(body, "add"), "add");
        const remove = requireWordList(bodyField(body, "remove"), "remove");

        if (add.length === 0 && remove.length === 0) {
          throw routeError("Provide at least one word in 'add' or 'remove'", "VALIDATION");
        }

        const result = db.applyDictionaryChanges({ add, remove });
        const words = db.getDictionary();
        setImmediate(() => sendDictionaryUpdated(words));

        return { data: { words, added: result.added, removed: result.removed } };
      }),
      exact("GET", "/v1/snippets/list", () => {
        return { data: db.getSnippets(), has_more: false, next_cursor: null };
      }),
      // Same delta shape as the dictionary route: an add with an existing
      // trigger replaces that snippet's text, and removes are by trigger.
      exact("POST", "/v1/snippets/update", ({ body }) => {
        const add = requireSnippetList(bodyField(body, "add"));
        const remove = requireWordList(bodyField(body, "remove"), "remove");

        if (add.length === 0 && remove.length === 0) {
          throw routeError(
            "Provide at least one snippet in 'add' or trigger in 'remove'",
            "VALIDATION"
          );
        }

        const lower = (trigger: string) => trigger.trim().toLowerCase();
        const removeKeys = new Set(remove.map(lower));
        const addKeys = new Set(add.map((s) => lower(s.trigger)));
        const current = db.getSnippets();

        const kept = current.filter(
          (s) => !removeKeys.has(lower(s.trigger)) && !addKeys.has(lower(s.trigger))
        );

        db.setSnippets([...kept, ...add]);
        const snippets = db.getSnippets();
        setImmediate(() => sendSnippetsUpdated(snippets));
        // setSnippets drops entries it cannot store (e.g. over-long triggers),
        // so count what landed rather than what was sent.
        const storedKeys = new Set(snippets.map((s) => lower(s.trigger)));

        return {
          data: {
            snippets,
            added: add.filter((s) => storedKeys.has(lower(s.trigger))).length,
            removed: current.filter((s) => removeKeys.has(lower(s.trigger))).length,
          },
        };
      }),
      exact("GET", "/v1/transcribe/models", () => ({ data: ipc.listLocalTranscriptionModels() })),
      // The CLI runs on this machine, so it sends a path and the app reads the
      // file itself: no audio crosses the bridge and the user's downloaded
      // models do the work.
      exact("POST", "/v1/transcribe", async ({ body }) => {
        const real = requireAudioFile(bodyField(body, "path"));

        const selected = requireLocalModel(
          ipc.listLocalTranscriptionModels(),
          bodyField(body, "model")
        );

        const rawLanguage = bodyField(body, "language");
        const language = isString(rawLanguage) && rawLanguage ? rawLanguage : undefined;

        ipc.approveAudioPath(real);

        const result = await ipc.transcribeLocalFile(real, {
          provider: selected.provider,
          model: selected.model,
          language,
        });

        if (!result?.success) {
          if (result.code === "NO_SPEECH_DETECTED" || result.message === "No audio detected") {
            return {
              data: {
                text: "",
                provider: selected.provider,
                model: selected.model,
                warning: "No speech detected",
              },
            };
          }

          throw new Error(result.error || result.message || "Local transcription failed");
        }

        return {
          data: {
            text: isString(result.text) ? result.text : "",
            provider: selected.provider,
            model: selected.model,
          },
        };
      }),
      exact("GET", "/v1/transcriptions/list", ({ query }) => {
        const limit = query.get("limit") ? Number(query.get("limit")) : 50;

        return {
          data: db.getTranscriptions(limit),
          has_more: false,
          next_cursor: null,
        };
      }),
      param("GET", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const transcription = db.getTranscriptionById(id);

        if (!transcription) {
          throw routeError(`Transcription ${id} not found`, "NOT_FOUND");
        }

        return { data: transcription };
      }),
      param("DELETE", "/v1/transcriptions/", "", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.deleteTranscriptionInternal(id);
        requireSuccess(result, `Transcription ${id} not found`);

        return NO_CONTENT;
      }),
      param("DELETE", "/v1/transcriptions/", "/audio", "id", ({ params }) => {
        const id = requireId(params, "transcription");
        const result = ipc.audioStorageManager.deleteAudio(id);

        if (!result?.success) {
          throw routeError(`Failed to delete audio for transcription ${id}`, "internal_error");
        }

        db.updateTranscriptionAudio(id, {
          hasAudio: false,
          audioDurationMs: null,
          provider: null,
          model: null,
        });

        return NO_CONTENT;
      }),
    ];
  }
}

// CommonJS passthrough matching the original module shape: the class itself
// plus the discovery-file path helper on the same exports object.
module.exports = CliBridge;

// Dual export: legacy requires read this module as the class itself, while the
// TS graph imports the named exports.
Object.assign(module.exports, { CliBridge, getBridgeFilePath });
