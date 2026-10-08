import { net } from "electron";
import { runOAuthLoopbackFlow, OAuthFlowError } from "./oauthLoopbackFlow.js";
import type { GoogleTokenRow } from "./database.js";
import { PEOPLE_SCOPES } from "./googlePeople.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const CALENDAR_SCOPE = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  PEOPLE_SCOPES.contacts,
  PEOPLE_SCOPES.otherContacts,
  PEOPLE_SCOPES.directory,
].join(" ");

// Google token-endpoint payload: success fields or the error/description pair.
interface GoogleTokenResponse {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export interface GoogleOAuthDb {
  getGoogleTokens(): GoogleTokenRow | null;
  getGoogleTokensByEmail(email: string): GoogleTokenRow | null;
  getAllGoogleTokens(): GoogleTokenRow[];
  refreshGoogleTokens(
    accountId: number,
    tokens: Pick<GoogleTokenRow, "access_token" | "refresh_token" | "expires_at" | "scope">
  ): { success: boolean };
  saveGoogleTokens(tokens: {
    google_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): void;
}

function isConfiguredError(): Error & { code: string } {
  return Object.assign(new Error("Google Calendar OAuth is not configured"), {
    code: "CALENDAR_NOT_CONFIGURED",
  });
}

export class GoogleCalendarOAuth {
  private readonly databaseManager: GoogleOAuthDb;
  private readonly _refreshInFlight = new Map<number, Promise<string>>();

  constructor(databaseManager: GoogleOAuthDb) {
    this.databaseManager = databaseManager;
  }

  getClientId(): string | undefined {
    return process.env.GOOGLE_CALENDAR_CLIENT_ID;
  }

  getClientSecret(): string | undefined {
    return process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  }

  isConfigured(): boolean {
    return Boolean(this.getClientId() && this.getClientSecret());
  }

  startOAuthFlow(): Promise<{ success: boolean; email: string }> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    if (!clientId || !clientSecret) {
      throw isConfiguredError();
    }

    return runOAuthLoopbackFlow({
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CALENDAR_SCOPE,
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });

        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

        if (tokenData.error) {
          throw new OAuthFlowError(
            "token_exchange_failed",
            `Token exchange failed: ${tokenData.error_description || tokenData.error}`
          );
        }

        let email: string | null = null;

        if (tokenData.id_token) {
          try {
            const segment = tokenData.id_token.split(".")[1];

            if (segment) {
              // SAFETY: a JWT payload segment decodes to a JSON object; the
              // optional email read degrades to the no_email flow error.
              const payload = JSON.parse(Buffer.from(segment, "base64url").toString()) as {
                email?: string;
              };

              email = payload.email ?? null;
            }
          } catch {
            // A malformed id_token falls through to the no_email error.
          }
        }

        if (!email) {
          throw new OAuthFlowError(
            "no_email",
            "Could not extract email from Google OAuth response"
          );
        }

        const { access_token: accessToken, refresh_token: refreshToken } = tokenData;

        if (!accessToken || !refreshToken) {
          throw new OAuthFlowError("token_exchange_failed", "Token response missing tokens");
        }

        this.databaseManager.saveGoogleTokens({
          google_email: email,
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Date.now() + (tokenData.expires_in ?? 0) * 1000,
          scope: tokenData.scope || CALENDAR_SCOPE,
        });

        return { success: true, email };
      },
    });
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<GoogleTokenResponse> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    if (!clientId || !clientSecret) throw isConfiguredError();

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString();

    return this._httpsPost(GOOGLE_TOKEN_URL, body);
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const clientId = this.getClientId();
    const clientSecret = this.getClientSecret();

    if (!clientId || !clientSecret) throw isConfiguredError();

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString();

    return this._httpsPost(GOOGLE_TOKEN_URL, body);
  }

  async getValidAccessToken(accountEmail: string | null = null): Promise<string> {
    const tokens = accountEmail
      ? this.databaseManager.getGoogleTokensByEmail(accountEmail)
      : this.databaseManager.getGoogleTokens();

    if (!tokens)
      throw new Error(`No Google tokens found${accountEmail ? ` for ${accountEmail}` : ""}`);

    const fiveMinutes = 5 * 60 * 1000;

    if (tokens.expires_at - fiveMinutes >= Date.now()) return tokens.access_token;
    let pending = this._refreshInFlight.get(tokens.id);

    if (!pending) {
      pending = this._refreshAndSaveTokens(tokens).finally(() =>
        this._refreshInFlight.delete(tokens.id)
      );
      this._refreshInFlight.set(tokens.id, pending);
    }

    return pending;
  }

  private async _refreshAndSaveTokens(tokens: GoogleTokenRow): Promise<string> {
    const refreshed = await this.refreshAccessToken(tokens.refresh_token);

    const accessToken = refreshed.access_token;

    if (refreshed.error || !accessToken) {
      throw new Error(`Token refresh failed: ${refreshed.error_description || refreshed.error}`);
    }

    const result = this.databaseManager.refreshGoogleTokens(tokens.id, {
      access_token: accessToken,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      expires_at: Date.now() + (refreshed.expires_in ?? 0) * 1000,
      scope: refreshed.scope || tokens.scope,
    });

    if (!result.success) throw new Error("Google account changed during token refresh");

    return accessToken;
  }

  async revokeToken(token: string): Promise<void> {
    const body = new URLSearchParams({ token }).toString();

    try {
      await this._httpsPost("https://oauth2.googleapis.com/revoke", body);
    } catch {
      // Best-effort — token may already be revoked or network unavailable
    }
  }

  async _httpsPost(urlString: string, body: string): Promise<GoogleTokenResponse> {
    // Electron's RequestInit typing predates useSessionCookies; the runtime
    // honors it, and a typed variable carries the extra flag past excess-property
    // checks without a cast.
    const fetchInit: RequestInit & { useSessionCookies?: boolean } = {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    };

    const response = await net.fetch(urlString, fetchInit);

    const text = await response.text();

    // SAFETY: the token endpoint answers JSON on both success and error;
    // the optional response fields are probed below, not shape-assumed.
    try {
      // SAFETY: the token endpoint answers JSON on both success and error;
      // the optional response fields are probed below, not shape-assumed.
      return JSON.parse(text) as GoogleTokenResponse;
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = GoogleCalendarOAuth;

// Named export must stay reachable through the CJS surface for the
// emitted interop requires used by the migrated managers.
Object.assign(module.exports, { GoogleCalendarOAuth });
