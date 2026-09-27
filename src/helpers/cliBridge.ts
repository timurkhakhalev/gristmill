import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import debugLogger from "./debugLogger.js";
import { isPortAvailable } from "../utils/serverUtils.js";
import { sendNoteAdded, sendNoteUpdated } from "./notesEvents.js";
import { sendDictionaryUpdated, sendSnippetsUpdated } from "./vocabularyEvents.js";
import { sendFolderCreated } from "./containerEvents.js";
import type { NoteRow, FolderRow } from "./database.js";
import type { TranscriptionResponse } from "../contracts/localFileTranscription.js";

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function getBridgeFilePath(): string {
  return path.join(os.homedir(), ".openhercules", "cli-bridge.json");
}

async function findPortInRange(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

// The narrow operations the CLI adapter runs on top of — the same notes/
// dictionary/snippets operations and event senders the IPC handlers use.
export interface CliBridgeOperations {
  databaseManager: {
    getNotes(noteType?: string | null, limit?: number, folderId?: number | null, spaceId?: number | null): NoteRow[];
    searchNotes(query: unknown, limit?: number, spaceId?: number | null, folderId?: number | null): NoteRow[];
    getNote(id: number | bigint): NoteRow | null;
    saveNote(
      title: string,
      content: string,
      noteType?: string,
      sourceFile?: string | null,
      audioDuration?: number | null,
      folderId?: number | null
    ): { success: boolean; note: NoteRow | null };
    updateNote(id: number, updates: Record<string, unknown>): { success: boolean; error?: string; note?: NoteRow | null };
    getFolders(spaceId?: number | null): FolderRow[];
    createFolder(name: unknown, spaceId?: number | null): { success: boolean; error?: string; folder?: FolderRow };
    getDictionary(): string[];
    applyDictionaryChanges(delta: { add?: unknown; remove?: unknown }): { success: boolean; added: number; removed: number };
    getSnippets(): Array<{ trigger: string; replacement: string }>;
    setSnippets(snippets: unknown): { success: boolean };
    getTranscriptions(limit?: number): Array<Record<string, unknown>>;
    getTranscriptionById(id: number | bigint): Record<string, unknown> | null;
    updateTranscriptionAudio(
      id: number,
      audio: { hasAudio?: boolean | number; audioDurationMs?: number | null; provider?: string | null; model?: string | null }
    ): { success: boolean };
  };
  deleteNoteInternal(id: number): Promise<{ success: boolean }>;
  deleteTranscriptionInternal(id: number): { success: boolean };
  mirrorWriteNote(note: NoteRow): unknown;
  approveAudioPath(filePath: string): void;
  transcribeLocalFile(filePath: string, options?: Record<string, unknown>): Promise<TranscriptionResponse>;
  listLocalTranscriptionModels(): Array<{
    model: string;
    default?: boolean;
    downloaded?: boolean;
    provider?: string;
  }>;
  audioStorageManager: { deleteAudio(id: number): { success: boolean } };
}

interface CodedRouteError extends Error {
  code?: string;
}

function routeError(message: string, code: string): CodedRouteError {
  return Object.assign(new Error(message), { code });
}
void routeError;

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Buffer the raw chunks and decode once at the end: decoding per chunk
    // corrupts multibyte sequences split across chunk boundaries.
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let rejected = false;
    req.on("data", (chunk) => {
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
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
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

function unwrapMutationResult<T>(result: unknown, label: string): T {
  const record = (typeof result === "object" && result !== null ? result : {}) as Record<
    string,
    unknown
  >;
  if (!record.success || !record[label]) {
    throw new Error((record.error as string) || `Failed to write ${label}`);
  }
  return record[label] as T;
}

interface RouteParams {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

interface RouteEntry {
  method: string;
  match(pathname: string): Record<string, string> | null;
  handler(context: RouteParams): unknown;
  status?: number;
}

// 204 responses have no body; this sentinel routes them apart from payloads.
const NO_CONTENT = Symbol("CliBridge.NoContent");
type RouteResult = unknown;

export class CliBridge {
  private readonly ops: CliBridgeOperations;
  private server: http.Server | null = null;
  private port: number | null = null;
  private token: string | null = null;
  private readonly bridgeFilePath: string;
  private readonly routes: RouteEntry[];

  constructor(operations: CliBridgeOperations) {
    this.ops = operations;
    this.bridgeFilePath = getBridgeFilePath();
    this.routes = this._buildRouteTable();
  }

  async start(): Promise<void> {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await findPortInRange();
    const server = this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: (err as Error).message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server = null;
        reject(err);
      };
      server.once("error", onError);
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
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile(): void {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: (err as Error).message }, "cli-bridge");
    }
  }

  _removeBridgeFile(): void {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: (err as Error).message }, "cli-bridge");
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
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    let body: Record<string, unknown> = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", (err as Error).message);
        return;
      }
    }

    try {
      const result: RouteResult = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err as CodedRouteError);
    }
  }

  _sendError(res: http.ServerResponse, err: CodedRouteError): void {
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

  _matchRoute(method: string | undefined, pathname: string): (RouteEntry & { params: Record<string, string> }) | null {
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
      handler: (context: RouteParams) => unknown,
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
      handler: (context: RouteParams) => unknown,
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

    const requireId = (params: Record<string, string>, label: string): number => {
      const id = parseIdParam(params.id);
      if (id == null) throw routeError(`Invalid ${label} id`, "NOT_FOUND");
      return id;
    };

    const requireWordList = (value: unknown, field: string): string[] => {
      if (value === undefined || value === null) return [];
      if (!Array.isArray(value) || value.some((w) => typeof w !== "string")) {
        throw routeError(`'${field}' must be an array of strings`, "VALIDATION");
      }
      return value;
    };

    const requireSnippetList = (value: unknown): Array<{ trigger: string; replacement: string }> => {
      if (value === undefined || value === null) return [];
      const valid =
        Array.isArray(value) &&
        value.every(
          (s) =>
            s &&
            typeof (s as { trigger?: unknown }).trigger === "string" &&
            (s as { trigger: string }).trigger.trim() &&
            typeof (s as { replacement?: unknown }).replacement === "string" &&
            (s as { replacement: string }).replacement.trim()
        );
      if (!valid) {
        throw routeError(
          "'add' must be an array of { trigger, replacement } strings",
          "VALIDATION"
        );
      }
      return value as Array<{ trigger: string; replacement: string }>;
    };

    const requireAudioFile = (value: unknown): string => {
      if (typeof value !== "string" || !value.trim()) {
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
      requested: unknown
    ) => {
      if (requested !== undefined && typeof requested !== "string") {
        throw routeError("'model' must be a string", "VALIDATION");
      }
      const match = requested
        ? models.find((m) => m.model === requested)
        : models.find((m) => m.default);
      if (!match) {
        throw routeError(
          requested
            ? `Unknown model '${requested}'. Available: ${models.map((m) => m.model).join(", ")}`
            : "No local transcription model is selected. Choose one in OpenHercules under Settings → Transcription, or pass 'model'.",
          "VALIDATION"
        );
      }
      if (!match.downloaded) {
        throw routeError(
          `Model '${match.model}' is not downloaded. Open OpenHercules and download it under Settings → Transcription.`,
          "VALIDATION"
        );
      }
      return match;
    };

    const requireSuccess = (result: { success?: boolean; error?: string } | null | undefined, message: string): void => {
      if (!result?.success) {
        throw routeError(result?.error || message, "NOT_FOUND");
      }
    };

    return [
      exact("GET", "/v1/health", () => ({ data: { ok: true, version: 1 } })),
      exact("GET", "/v1/notes/list", ({ query }) => {
        const noteType = query.get("note_type") || null;
        const limit = query.get("limit") ? Number(query.get("limit")) : 100;
        const folderId = query.get("folder_id") ? Number(query.get("folder_id")) : null;
        const notes = db.getNotes(noteType, limit, folderId);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      exact("GET", "/v1/notes/search", ({ query }) => {
        const q = query.get("q") || "";
        if (!q.trim()) {
          throw routeError("Search query is required", "VALIDATION");
        }
        const limit = query.get("limit") ? Number(query.get("limit")) : 20;
        const notes = db.searchNotes(q, limit);
        return { data: notes, has_more: false, next_cursor: null };
      }),
      param("GET", "/v1/notes/", "", "id", ({ params }) => {
        const id = requireId(params, "note");
        const note = db.getNote(id);
        if (!note) {
          throw routeError(`Note ${id} not found`, "NOT_FOUND");
        }
        return { data: note };
      }),
      exact(
        "POST",
        "/v1/notes/create",
        ({ body }) => {
          const result = db.saveNote(
            (body.title as string) ?? "Untitled Note",
            (body.content as string) ?? "",
            (body.note_type as string) ?? "personal",
            (body.source_file as string) ?? null,
            (body.audio_duration_seconds as number) ?? null,
            (body.folder_id as number) ?? null
          );
          const note = unwrapMutationResult<NoteRow>(result, "note");
          setImmediate(() => sendNoteAdded(note));
          ipc.mirrorWriteNote(note);
          return { data: note };
        },
        201
      ),
      param("PATCH", "/v1/notes/", "", "id", ({ params, body }) => {
        const id = requireId(params, "note");
        const result = db.updateNote(id, body || {});
        const note = unwrapMutationResult<NoteRow>(result, "note");
        setImmediate(() => sendNoteUpdated(note));
        ipc.mirrorWriteNote(note);
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
          const result = db.createFolder(body?.name);
          const folder = unwrapMutationResult<FolderRow>(result, "folder");
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
        const add = requireWordList(body?.add, "add");
        const remove = requireWordList(body?.remove, "remove");
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
        const add = requireSnippetList(body?.add);
        const remove = requireWordList(body?.remove, "remove");
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
        const real = requireAudioFile(body?.path);
        const selected = requireLocalModel(
          ipc.listLocalTranscriptionModels(),
          body?.model
        );
        const language =
          typeof body?.language === "string" && body.language ? body.language : undefined;
        ipc.approveAudioPath(real);
        const result = await ipc.transcribeLocalFile(real, {
          provider: selected.provider,
          model: selected.model,
          language,
        });
        if (!result?.success) {
          if (result.code === "NO_SPEECH_DETECTED" || result.message === "No audio detected") {
            return {
              data: { text: "", provider: selected.provider, model: selected.model, warning: "No speech detected" },
            };
          }
          throw new Error(result.error || result.message || "Local transcription failed");
        }
        return { data: { text: result.text as string, provider: selected.provider, model: selected.model } };
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
module.exports.CliBridge = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
