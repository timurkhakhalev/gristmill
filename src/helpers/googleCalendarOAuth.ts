import { net } from "electron";
import { runOAuthLoopbackFlow, OAuthFlowError } from "./oauthLoopbackFlow.js";
import type { GoogleTokenRow } from "./database.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly";

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
  saveGoogleTokens(tokens: {
    google_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): unknown;
}

function isConfiguredError(): Error & { code: string } {
  return Object.assign(new Error("Google Calendar OAuth is not configured"), {
    code: "CALENDAR_NOT_CONFIGURED",
  });
}

export class GoogleCalendarOAuth {
  private readonly databaseManager: GoogleOAuthDb;

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
    if (!this.isConfigured()) {
      throw isConfiguredError();
    }
    return runOAuthLoopbackFlow({
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: this.getClientId() as string,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CALENDAR_SCOPE,
          access_type: "offline",
          prompt: "consent",
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
            const payload = JSON.parse(
              Buffer.from(tokenData.id_token.split(".")[1] as string, "base64url").toString()
            ) as { email?: string };
            email = payload.email ?? null;
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

        this.databaseManager.saveGoogleTokens({
          google_email: email,
          access_token: tokenData.access_token as string,
          refresh_token: tokenData.refresh_token as string,
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
    const body = new URLSearchParams({
      code,
      client_id: this.getClientId() as string,
      client_secret: this.getClientSecret() as string,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString();

    return this._httpsPost(GOOGLE_TOKEN_URL, body);
  }

  async refreshAccessToken(refreshToken: string): Promise<GoogleTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.getClientId() as string,
      client_secret: this.getClientSecret() as string,
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
    if (tokens.expires_at - fiveMinutes < Date.now()) {
      const refreshed = await this.refreshAccessToken(tokens.refresh_token);
      if (refreshed.error) {
        throw new Error(
          `Token refresh failed: ${refreshed.error_description || refreshed.error}`
        );
      }

      const newExpiresAt = Date.now() + (refreshed.expires_in ?? 0) * 1000;
      this.databaseManager.saveGoogleTokens({
        google_email: tokens.google_email,
        access_token: refreshed.access_token as string,
        refresh_token: tokens.refresh_token,
        expires_at: newExpiresAt,
        scope: tokens.scope,
      });

      return refreshed.access_token as string;
    }

    return tokens.access_token;
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
    const response = await net.fetch(urlString, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    } as RequestInit);
    const text = await response.text();
    try {
      return JSON.parse(text) as GoogleTokenResponse;
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = GoogleCalendarOAuth;
