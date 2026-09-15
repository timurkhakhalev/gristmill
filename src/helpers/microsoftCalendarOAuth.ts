import { net } from "electron";
import { runOAuthLoopbackFlow, OAuthFlowError } from "./oauthLoopbackFlow.js";
import type { MicrosoftTokenRow } from "./database.js";

// The "common" tenant covers both work/school (M365) and personal
// (outlook.com) accounts. Desktop apps are public clients: PKCE, no secret.
const MICROSOFT_AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
// "profile" puts preferred_username in the id_token and User.Read allows the
// GET /me fallback — work accounts often omit the "email" claim.
const CALENDAR_SCOPE =
  "openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Calendars.Read";

interface MicrosoftTokenResponse {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

export interface MicrosoftOAuthDb {
  getMicrosoftTokensByEmail(email: string): MicrosoftTokenRow | null;
  saveMicrosoftTokens(tokens: {
    microsoft_email: string;
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope: string;
  }): unknown;
}

export class MicrosoftCalendarOAuth {
  private readonly databaseManager: MicrosoftOAuthDb;
  private readonly _refreshInFlight = new Map<string, Promise<string>>();

  constructor(databaseManager: MicrosoftOAuthDb) {
    this.databaseManager = databaseManager;
  }

  getClientId(): string | undefined {
    return process.env.MICROSOFT_CALENDAR_CLIENT_ID;
  }

  isConfigured(): boolean {
    return Boolean(this.getClientId());
  }

  startOAuthFlow(): Promise<{ success: boolean; email: string }> {
    if (!this.isConfigured()) {
      // Fail fast instead of opening the browser on a client_id=undefined URL
      // and hanging until the loopback flow times out.
      throw Object.assign(new Error("Microsoft Calendar OAuth is not configured"), {
        code: "CALENDAR_NOT_CONFIGURED",
      });
    }
    return runOAuthLoopbackFlow({
      buildAuthUrl: (redirectUri, state, codeChallenge) => {
        const params = new URLSearchParams({
          client_id: this.getClientId() as string,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: CALENDAR_SCOPE,
          // Without this, SSO silently re-links the signed-in account when
          // the user tries to add another one.
          prompt: "select_account",
          state,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
        });
        return `${MICROSOFT_AUTH_URL}?${params.toString()}`;
      },
      handleCallback: async (code, redirectUri, codeVerifier) => {
        const tokenData = await this.exchangeCodeForTokens(code, redirectUri, codeVerifier);

        if (tokenData.error) {
          throw new OAuthFlowError(
            "token_exchange_failed",
            `Token exchange failed: ${tokenData.error_description || tokenData.error}`
          );
        }

        const email = await this._resolveEmail(tokenData);
        if (!email) {
          throw new OAuthFlowError(
            "no_email",
            "Could not extract email from Microsoft OAuth response"
          );
        }

        this._saveTokens(email, tokenData);
        return { success: true, email };
      },
    });
  }

  async exchangeCodeForTokens(
    code: string,
    redirectUri: string,
    codeVerifier: string
  ): Promise<MicrosoftTokenResponse> {
    const body = new URLSearchParams({
      code,
      client_id: this.getClientId() as string,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }).toString();

    return this._httpsPost(MICROSOFT_TOKEN_URL, body);
  }

  async refreshAccessToken(refreshToken: string): Promise<MicrosoftTokenResponse> {
    const body = new URLSearchParams({
      client_id: this.getClientId() as string,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: CALENDAR_SCOPE,
    }).toString();

    return this._httpsPost(MICROSOFT_TOKEN_URL, body);
  }

  async getValidAccessToken(accountEmail: string): Promise<string> {
    const tokens = this.databaseManager.getMicrosoftTokensByEmail(accountEmail);
    if (!tokens) throw new Error(`No Microsoft tokens found for ${accountEmail}`);

    const fiveMinutes = 5 * 60 * 1000;
    if (tokens.expires_at - fiveMinutes >= Date.now()) {
      return tokens.access_token;
    }

    // Microsoft rotates refresh tokens on every refresh, so concurrent
    // refreshes (focus sync racing the interval sync) would persist competing
    // rotations; share one in-flight refresh per account instead.
    let refreshPromise = this._refreshInFlight.get(accountEmail);
    if (!refreshPromise) {
      refreshPromise = this._refreshAndSaveTokens(tokens).finally(() => {
        this._refreshInFlight.delete(accountEmail);
      });
      this._refreshInFlight.set(accountEmail, refreshPromise);
    }
    return refreshPromise;
  }

  private async _refreshAndSaveTokens(tokens: MicrosoftTokenRow): Promise<string> {
    const refreshed = await this.refreshAccessToken(tokens.refresh_token);
    if (refreshed.error) {
      throw new Error(
        `Token refresh failed: ${refreshed.error_description || refreshed.error}`
      );
    }

    // Persist the rotated refresh token or the old one stops working within 24h.
    this._saveTokens(tokens.microsoft_email, {
      ...refreshed,
      refresh_token: refreshed.refresh_token || tokens.refresh_token,
      scope: refreshed.scope || tokens.scope,
    });

    return refreshed.access_token as string;
  }

  private _saveTokens(email: string, tokenData: MicrosoftTokenResponse): void {
    this.databaseManager.saveMicrosoftTokens({
      microsoft_email: email,
      access_token: tokenData.access_token as string,
      refresh_token: tokenData.refresh_token as string,
      expires_at: Date.now() + (tokenData.expires_in ?? 0) * 1000,
      scope: tokenData.scope || CALENDAR_SCOPE,
    });
  }

  // Work accounts often omit the id_token "email" claim; fall back to
  // preferred_username, then Graph /me.
  private async _resolveEmail(tokenData: MicrosoftTokenResponse): Promise<string | null> {
    if (tokenData.id_token) {
      try {
        const payload = JSON.parse(
          Buffer.from(tokenData.id_token.split(".")[1] as string, "base64url").toString()
        ) as { email?: string; preferred_username?: string };
        if (payload.email) return payload.email;
        if (payload.preferred_username?.includes("@")) return payload.preferred_username;
      } catch {
        // Fall through to the Graph /me probe.
      }
    }

    try {
      const response = await net.fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
        signal: AbortSignal.timeout(10000),
        useSessionCookies: false,
      } as RequestInit);
      const me = (await response.json()) as { mail?: string; userPrincipalName?: string };
      return me.mail || me.userPrincipalName || null;
    } catch {
      return null;
    }
  }

  private async _httpsPost(urlString: string, body: string): Promise<MicrosoftTokenResponse> {
    const response = await net.fetch(urlString, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(10000),
      useSessionCookies: false,
    } as RequestInit);
    const text = await response.text();
    try {
      return JSON.parse(text) as MicrosoftTokenResponse;
    } catch {
      throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
    }
  }
}

module.exports = MicrosoftCalendarOAuth;
module.exports.MicrosoftCalendarOAuth = MicrosoftCalendarOAuth;
