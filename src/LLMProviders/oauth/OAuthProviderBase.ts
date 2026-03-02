import {
  OAuthAuthRecord,
  OAuthAuthState,
  OAuthTokenRefreshResult,
} from "@/LLMProviders/oauth/types";

interface StatusResponse {
  status: number;
}

interface OAuthProviderBaseOptions {
  tokenRefreshBufferMs?: number;
  maxRefreshAttempts?: number;
}

/**
 * Shared reliability logic for OAuth-backed providers.
 * Providers only implement token read/write/refresh details.
 */
export abstract class OAuthProviderBase {
  protected readonly tokenRefreshBufferMs: number;
  protected readonly maxRefreshAttempts: number;

  private refreshPromise: Promise<string> | null = null;
  private refreshAttempts = 0;

  constructor(options: OAuthProviderBaseOptions = {}) {
    this.tokenRefreshBufferMs = options.tokenRefreshBufferMs ?? 60 * 1000;
    this.maxRefreshAttempts = options.maxRefreshAttempts ?? 3;
  }

  /**
   * Read current auth record from provider storage.
   */
  protected abstract readAuthRecord(): Promise<OAuthAuthRecord>;

  /**
   * Persist updated auth fields to provider storage.
   * @param updates - Partial auth fields to write.
   */
  protected abstract writeAuthRecord(updates: Partial<OAuthAuthRecord>): void;

  /**
   * Refresh access token using provider-specific OAuth semantics.
   * @param record - Current auth record.
   */
  protected abstract refreshAccessToken(record: OAuthAuthRecord): Promise<OAuthTokenRefreshResult>;

  /**
   * Returns whether current auth record can be refreshed.
   * @param record - Current auth record.
   */
  protected canRefresh(record: OAuthAuthRecord): boolean {
    return Boolean(record.refreshToken);
  }

  /**
   * Clear the current access token to force refresh on next request.
   */
  protected clearAccessToken(): void {
    this.writeAuthRecord({ accessToken: "", expiresAt: 0 });
  }

  /**
   * Clear full provider auth state.
   */
  protected abstract clearProviderAuthState(): void;

  /**
   * Return normalized auth state for UI.
   */
  async getAuthState(): Promise<OAuthAuthState> {
    const record = await this.readAuthRecord();
    const expiresAt = record.expiresAt ?? 0;
    const hasAccessToken = Boolean(record.accessToken);
    const hasKnownExpiry = expiresAt > 0;
    const isExpired = !hasKnownExpiry || expiresAt < Date.now();

    if ((hasAccessToken && !isExpired) || (hasAccessToken && this.canRefresh(record))) {
      return { status: "authenticated" };
    }

    if (this.canRefresh(record)) {
      return { status: "authenticated" };
    }

    return { status: "idle" };
  }

  /**
   * Return whether provider currently has usable auth.
   */
  async isAuthenticated(): Promise<boolean> {
    const state = await this.getAuthState();
    return state.status === "authenticated";
  }

  /**
   * Resolve a non-expired access token, refreshing if required.
   */
  async getValidAccessToken(): Promise<string> {
    const record = await this.readAuthRecord();
    const expiresAt = record.expiresAt ?? 0;
    const hasKnownExpiry = expiresAt > 0;
    const isExpired = !hasKnownExpiry || expiresAt < Date.now() + this.tokenRefreshBufferMs;

    if (record.accessToken && !isExpired) {
      this.refreshAttempts = 0;
      return record.accessToken;
    }

    if (!this.canRefresh(record)) {
      throw new Error("Not authenticated. Please set up OAuth authentication first.");
    }

    if (this.refreshAttempts >= this.maxRefreshAttempts) {
      this.refreshAttempts = 0;
      throw new Error("Failed to refresh OAuth token after multiple attempts. Please reconnect.");
    }

    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshAttempts++;
    this.refreshPromise = this.performRefresh(record).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Execute request with automatic unauthorized retry.
   * @param doRequest - Request callback receiving a valid access token.
   * @param onUnauthorized - Optional hook to cleanup first 401 response resources.
   */
  protected async executeWithTokenRetry<T extends StatusResponse>(
    doRequest: (token: string) => Promise<T>,
    onUnauthorized?: (response: T) => Promise<void> | void,
  ): Promise<T> {
    let token = await this.getValidAccessToken();
    let response = await doRequest(token);

    if (response.status === 401) {
      if (onUnauthorized) {
        await onUnauthorized(response);
      }
      this.clearAccessToken();
      token = await this.getValidAccessToken();
      response = await doRequest(token);
    }

    return response;
  }

  /**
   * Reset provider auth and in-flight refresh state.
   */
  resetAuth(): void {
    this.refreshPromise = null;
    this.refreshAttempts = 0;
    this.clearProviderAuthState();
  }

  /**
   * Perform refresh and persist new token fields.
   * @param record - Current auth record.
   */
  private async performRefresh(record: OAuthAuthRecord): Promise<string> {
    const refreshed = await this.refreshAccessToken(record);
    this.writeAuthRecord({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || record.refreshToken,
      expiresAt: refreshed.expiresAt,
      accountId: refreshed.accountId || record.accountId,
    });
    return refreshed.accessToken;
  }
}
