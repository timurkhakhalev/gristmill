import http from "http";
import crypto from "crypto";
import { openExternalUrl } from "./externalUrlOpener.js";

const OAUTH_TIMEOUT_MS = 120000;

/** Thrown by handleCallback so callers can distinguish callback failures. */
export class OAuthFlowError extends Error {
  readonly redirectCode: string;

  constructor(redirectCode: string, message: string) {
    super(message);
    this.redirectCode = redirectCode;
  }
}

export interface OAuthFlowResult {
  success: boolean;
  email: string;
}

export interface LoopbackFlowHandlers<T = OAuthFlowResult> {
  buildAuthUrl(redirectUri: string, state: string, codeChallenge: string): string;
  handleCallback(code: string, redirectUri: string, codeVerifier: string): Promise<T>;
}

interface MinimalServerResponse {
  writeHead(statusCode: number, headers: Record<string, string>): void;
  end(body?: string): void;
}

function respond(res: MinimalServerResponse, statusCode: number, message: string): void {
  const safeMessage = String(message)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

  res.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><body><h3>${safeMessage}</h3></body></html>`);
}

// Runs a PKCE auth-code flow through an ephemeral 127.0.0.1 server:
// - buildAuthUrl(redirectUri, state, codeChallenge) → provider authorize URL
// - handleCallback(code, redirectUri, codeVerifier) → resolves the flow result;
//   called once with a state-validated code, throws (OAuthFlowError for a
//   specific callback-page code) to reject.
export function runOAuthLoopbackFlow<T = OAuthFlowResult>({
  buildAuthUrl,
  handleCallback,
}: LoopbackFlowHandlers<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url").slice(0, 43);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(32).toString("hex");
    let callbackClaimed = false;

    const server = http.createServer((req, res) => {
      void (async () => {
        // Accepted requests can outlive server.close(), so only the first
        // terminal callback may settle the flow or exchange a code.
        if (callbackClaimed) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<html><body><h3>Invalid request.</h3></body></html>");

          return;
        }

        try {
          const url = new URL(req.url ?? "/", `http://127.0.0.1`);
          const returnedState = url.searchParams.get("state");
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (returnedState !== state) {
            respond(res, 400, "Invalid request.");

            // A real callback with a code but the wrong state is a failed
            // attempt (stale tab, CSRF). Fail the flow now. A request with no
            // code (favicon / bare GET) must keep waiting for the redirect.
            if (code) {
              callbackClaimed = true;
              cleanup();
              reject(new Error("OAuth state mismatch"));
            }

            return;
          }

          if (error) {
            callbackClaimed = true;
            respond(res, 400, `OAuth error: ${error}`);
            cleanup();
            reject(new Error(`OAuth error: ${error}`));

            return;
          }

          if (!code) {
            respond(res, 400, "Invalid request.");

            return;
          }

          callbackClaimed = true;
          const address = server.address();
          const redirectUri = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
          const result = await handleCallback(code, redirectUri, codeVerifier);

          respond(res, 200, "Calendar connected. You can close this window.");
          cleanup();
          resolve(result);
        } catch (err) {
          callbackClaimed = true;
          respond(
            res,
            400,
            `OAuth error: ${(err as OAuthFlowError).redirectCode || "server_error"}`
          );
          cleanup();
          reject(err);
        }
      })();
    });

    let timeoutId: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timeoutId);
      server.close();
    };

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const redirectUri = `http://127.0.0.1:${port}`;
      // Fire-and-forget like the shell.openExternal call it replaced: a failed
      // browser launch surfaces as the flow timeout.
      openExternalUrl(buildAuthUrl(redirectUri, state, codeChallenge)).catch(() => {});
    });

    timeoutId = setTimeout(() => {
      callbackClaimed = true;
      server.close();
      reject(new Error("OAuth flow timed out"));
    }, OAUTH_TIMEOUT_MS);

    server.on("error", (err) => {
      cleanup();
      reject(err);
    });
  });
}

// CommonJS passthrough: original module shape with OAuthFlowError reachable
// from the same exports object every require site uses.
module.exports = { runOAuthLoopbackFlow, OAuthFlowError };
