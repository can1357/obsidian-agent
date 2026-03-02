import { Buffer } from "buffer";
import { createParser, type ParsedEvent, type ReconnectInterval } from "eventsource-parser";
import type { IncomingMessage, ServerResponse } from "http";
import { Platform, RequestUrlResponse, requestUrl } from "obsidian";
import { getDecryptedKey } from "@/encryptionService";
import { OAuthAuthCancelledError } from "@/LLMProviders/oauth/errors";
import { OAuthProviderBase } from "@/LLMProviders/oauth/OAuthProviderBase";
import {
  OAuthAuthRecord,
  OAuthChatProvider,
  OAuthChatResponse,
  OAuthRequestOptions,
  OAuthStreamChunk,
  OAuthTokenRefreshResult,
} from "@/LLMProviders/oauth/types";
import { getSettings, setSettings } from "@/settings/model";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const DEVICE_AUTH_USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_AUTH_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const OAUTH_TOKEN_URL = `${ISSUER}/oauth/token`;
const DEVICE_AUTH_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const CODEX_DEVICE_VERIFICATION_URI = `${ISSUER}/codex/device`;
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const BROWSER_OAUTH_PORT = 1455;
const BROWSER_OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;
const DEFAULT_DEVICE_POLL_INTERVAL_MS = 5000;
const DEFAULT_DEVICE_CODE_EXPIRES_IN_SECONDS = 600;
const MAX_REFRESH_ATTEMPTS = 3;
const DEFAULT_CODEX_INSTRUCTIONS = "You are a helpful assistant.";

const STATIC_CODEX_MODELS = [
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "gpt-5.1-codex-max",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex",
  "gpt-5.2",
];

const HTTP_STATUS_MESSAGES: Record<number, string> = {
  401: "Authentication failed - Codex OAuth token may be expired",
  403: "Access denied - verify your ChatGPT subscription and account scope",
  429: "Rate limited - please wait before retrying",
};

interface OpenAIDeviceAuthInitResponse {
  device_auth_id?: string;
  user_code?: string;
  interval?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface OpenAIDeviceAuthPollResponse {
  authorization_code?: string;
  code_verifier?: string;
  error?: string;
  error_description?: string;
}

interface OpenAIBrowserOauthCallbackResponse {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface OpenAITokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface CodexResponsesApiEvent {
  type?: string;
  delta?: string;
  text?: string;
  error?: {
    message?: string;
    code?: string;
  };
  response?: {
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
    model?: string;
    id?: string;
  };
}

export interface OpenAICodexDeviceCodeResponse {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresIn: number;
}

export interface OpenAICodexModelResponse {
  object: string;
  data: Array<{ id: string; object: string; name: string }>;
}

interface PkceCodes {
  verifier: string;
  challenge: string;
}

/**
 * OAuth provider implementation for OpenAI Codex via ChatGPT backend endpoint.
 */
export class OpenAICodexProvider extends OAuthProviderBase implements OAuthChatProvider {
  private static instance: OpenAICodexProvider;
  private abortController: AbortController | null = null;
  private browserAuthServerStop: (() => void) | null = null;
  private browserAuthCompletionPromise: Promise<void> | null = null;
  private browserAuthResolve: (() => void) | null = null;
  private browserAuthReject: ((error: Error) => void) | null = null;
  private browserAuthTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private constructor() {
    super({ maxRefreshAttempts: MAX_REFRESH_ATTEMPTS });
  }

  /**
   * Return singleton provider instance.
   */
  static getInstance(): OpenAICodexProvider {
    if (!OpenAICodexProvider.instance) {
      OpenAICodexProvider.instance = new OpenAICodexProvider();
    }
    return OpenAICodexProvider.instance;
  }

  /**
   * Namespace used in LangChain metadata.
   */
  getProviderModelNamespace(): string {
    return "openai_codex";
  }

  /**
   * Human-readable provider type for diagnostics.
   */
  getProviderType(): string {
    return "openai-codex";
  }

  /**
   * Start browser-based PKCE auth flow and return authorization URL.
   * @returns Authorization URL that should be opened in a browser.
   */
  async startBrowserAuthFlow(): Promise<string> {
    if (!Platform.isDesktop) {
      throw new Error("Browser OAuth flow is only supported on desktop.");
    }

    this.cancelBrowserAuthFlow();
    const redirectUri = `http://localhost:${BROWSER_OAUTH_PORT}/auth/callback`;
    const pkce = await this.generatePKCE();
    const state = this.generateState();

    await this.startBrowserCallbackServer(redirectUri, state, pkce.verifier);
    return this.buildAuthorizeUrl(redirectUri, pkce.challenge, state);
  }

  /**
   * Wait for browser OAuth callback to complete.
   */
  async waitForBrowserAuthCompletion(): Promise<void> {
    if (!this.browserAuthCompletionPromise) {
      throw new Error("No browser OAuth flow in progress.");
    }
    await this.browserAuthCompletionPromise;
  }

  /**
   * Cancel active browser OAuth flow and cleanup callback server.
   */
  cancelBrowserAuthFlow(): void {
    if (this.browserAuthReject) {
      this.browserAuthReject(new OAuthAuthCancelledError());
    }
    this.cleanupBrowserAuthState();
  }

  /**
   * Start Codex device auth flow and return user code details.
   */
  async startDeviceAuthFlow(): Promise<OpenAICodexDeviceCodeResponse> {
    const res = await requestUrl({
      url: DEVICE_AUTH_USER_CODE_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ client_id: CLIENT_ID }),
      throw: false,
    });

    const data = this.getRequestUrlJson(res) as OpenAIDeviceAuthInitResponse;

    if (res.status !== 200) {
      const detail = this.getOauthErrorDetail(data);
      throw new Error(
        detail
          ? `Failed to start Codex device auth flow: ${detail}`
          : `Failed to start Codex device auth flow: HTTP ${res.status}`,
      );
    }

    if (!data.device_auth_id || !data.user_code) {
      throw new Error("Invalid Codex device auth response: missing device_auth_id or user_code");
    }

    const intervalSecondsRaw = Number(data.interval);
    const intervalMs =
      Number.isFinite(intervalSecondsRaw) && intervalSecondsRaw > 0
        ? intervalSecondsRaw * 1000
        : DEFAULT_DEVICE_POLL_INTERVAL_MS;

    const expiresIn =
      typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : DEFAULT_DEVICE_CODE_EXPIRES_IN_SECONDS;

    return {
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      verificationUri: CODEX_DEVICE_VERIFICATION_URI,
      intervalMs,
      expiresIn,
    };
  }

  /**
   * Poll OpenAI device auth endpoint until an authorization code is available.
   * @param deviceAuthId - Device auth id from startDeviceAuthFlow.
   * @param userCode - User code shown to user.
   * @param intervalMs - Polling interval in milliseconds.
   * @param expiresInSeconds - Device code expiration window in seconds.
   * @param onPoll - Optional callback invoked on each poll attempt.
   */
  async pollForTokens(
    deviceAuthId: string,
    userCode: string,
    intervalMs: number,
    expiresInSeconds: number,
    onPoll?: (attempt: number) => void,
  ): Promise<void> {
    this.abortPolling();

    const controller = new AbortController();
    this.abortController = controller;

    const deadline = Date.now() + expiresInSeconds * 1000;
    let attempt = 0;

    try {
      while (Date.now() < deadline) {
        if (controller.signal.aborted) {
          throw new OAuthAuthCancelledError();
        }

        attempt++;
        onPoll?.(attempt);

        const res = await requestUrl({
          url: DEVICE_AUTH_TOKEN_URL,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            device_auth_id: deviceAuthId,
            user_code: userCode,
          }),
          throw: false,
        });

        if (controller.signal.aborted) {
          throw new OAuthAuthCancelledError();
        }

        if (res.status === 200) {
          const data = this.getRequestUrlJson(res) as OpenAIDeviceAuthPollResponse;
          if (!data.authorization_code || !data.code_verifier) {
            throw new Error(
              "Invalid Codex device auth token response: missing authorization_code or code_verifier",
            );
          }

          await this.exchangeAuthorizationCodeForTokens(
            data.authorization_code,
            data.code_verifier,
            DEVICE_AUTH_REDIRECT_URI,
          );
          return;
        }

        if (res.status !== 403 && res.status !== 404) {
          const data = this.getRequestUrlJson(res) as OpenAIDeviceAuthPollResponse;
          const detail = this.getOauthErrorDetail(data);
          throw new Error(
            detail
              ? `Codex device auth polling failed: ${detail}`
              : `Codex device auth polling failed: HTTP ${res.status}`,
          );
        }

        await this.delay(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, controller.signal);
      }

      throw new Error("Codex device auth timed out. Please restart authentication.");
    } finally {
      if (this.abortController === controller) {
        this.abortController = null;
      }
    }
  }

  /**
   * Exchange authorization code for OAuth tokens and persist them.
   * @param authorizationCode - One-time authorization code.
   * @param codeVerifier - PKCE verifier.
   */
  async exchangeAuthorizationCodeForTokens(
    authorizationCode: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<void> {
    const res = await requestUrl({
      url: OAUTH_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: authorizationCode,
        redirect_uri: redirectUri,
        client_id: CLIENT_ID,
        code_verifier: codeVerifier,
      }).toString(),
      throw: false,
    });

    const tokens = this.getRequestUrlJson(res) as OpenAITokenResponse;

    if (res.status !== 200) {
      const detail = this.getOauthErrorDetail(tokens);
      throw new Error(
        detail
          ? `Codex token exchange failed: ${detail}`
          : `Codex token exchange failed: ${res.status}`,
      );
    }

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("Invalid Codex token response: missing access_token or refresh_token");
    }

    const accountId = this.extractAccountId(tokens);

    setSettings({
      openAICodexAccessToken: tokens.access_token,
      openAICodexRefreshToken: tokens.refresh_token,
      openAICodexTokenExpiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      openAICodexAccountId: accountId || "",
    });
  }

  /**
   * List available Codex models.
   */
  async listModels(): Promise<OpenAICodexModelResponse> {
    return {
      object: "list",
      data: STATIC_CODEX_MODELS.map((id) => ({ id, object: "model", name: id })),
    };
  }

  /**
   * Send non-streaming chat request to Codex endpoint.
   */
  async sendChatMessage(
    messages: Array<{ role: string; content: string }>,
    options: OAuthRequestOptions = {},
  ): Promise<OAuthChatResponse> {
    let content = "";
    let finishReason: string | null | undefined = undefined;
    let usage: OAuthChatResponse["usage"] | undefined = undefined;
    let modelName: string | undefined = undefined;
    let responseId: string | undefined = undefined;
    let hasAnyChunk = false;

    for await (const chunk of this.sendChatMessageStream(messages, options)) {
      hasAnyChunk = true;
      const choice = chunk.choices?.[0];
      const deltaContent = choice?.delta?.content || "";
      if (deltaContent) {
        content += deltaContent;
      }
      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (chunk.usage) {
        usage = chunk.usage;
      }
      if (chunk.model) {
        modelName = chunk.model;
      }
      if (chunk.id) {
        responseId = chunk.id;
      }
    }

    if (!hasAnyChunk) {
      throw new Error("OpenAI Codex returned no chunks for non-stream request aggregation.");
    }

    return {
      id: responseId,
      model: modelName,
      choices: [
        {
          message: {
            role: "assistant",
            content,
          },
          finish_reason: finishReason ?? "stop",
        },
      ],
      usage,
    };
  }

  /**
   * Send streaming chat request to Codex endpoint.
   */
  async *sendChatMessageStream(
    messages: Array<{ role: string; content: string }>,
    options: OAuthRequestOptions = {},
  ): AsyncGenerator<OAuthStreamChunk> {
    const { model = "gpt-5.3-codex", signal, fetchImpl } = options;
    const fetchImplementation = fetchImpl ?? fetch;
    const requestBody = this.buildCodexResponsesBody(messages, model, true);

    const response = await this.executeWithTokenRetry(
      async (token) =>
        fetchImplementation(CODEX_API_ENDPOINT, {
          method: "POST",
          headers: {
            ...(await this.buildCodexHeaders(token)),
            Accept: "text/event-stream",
          },
          body: JSON.stringify(requestBody),
          signal,
        }),
      async (r) => {
        try {
          await r.body?.cancel();
        } catch {
          // intentionally ignored
        }
      },
    );

    if (!response.ok) {
      const payload = await this.readResponsePayload(response);
      throw new Error(this.buildHttpError(response.status, payload));
    }

    const contentType = response.headers.get("content-type") || "";
    if (
      contentType &&
      !contentType.includes("text/event-stream") &&
      !contentType.includes("application/json")
    ) {
      throw new Error(`Expected text/event-stream but received ${contentType}`);
    }

    if (!response.body) {
      throw new Error("Response body is not available for streaming");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunkQueue: OAuthStreamChunk[] = [];

    let rawResponsePreview = "";
    let yieldedChunks = 0;
    let receivedDone = false;
    let streamErrorMessage: string | null = null;

    const parser = createParser((event: ParsedEvent | ReconnectInterval) => {
      if (event.type !== "event") {
        return;
      }

      if (event.data === "[DONE]") {
        receivedDone = true;
        return;
      }

      try {
        const parsed = JSON.parse(event.data) as CodexResponsesApiEvent;
        if (parsed.type === "error") {
          streamErrorMessage = parsed.error?.message || "Codex streaming error";
          return;
        }
      } catch {
        // ignore JSON parse failure here and defer to normal chunk parser
      }

      const parsedChunk = this.parseStreamEventData(event.data);
      if (parsedChunk) {
        chunkQueue.push(parsedChunk);
      }
    });

    try {
      while (true) {
        if (receivedDone) break;

        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        if (rawResponsePreview.length < 500) {
          rawResponsePreview += text.slice(0, 500 - rawResponsePreview.length);
        }

        parser.feed(text);
        if (streamErrorMessage) {
          throw new Error(streamErrorMessage);
        }

        while (chunkQueue.length > 0) {
          const chunk = chunkQueue.shift();
          if (chunk) {
            yieldedChunks++;
            yield chunk;
          }
        }
      }

      const finalText = decoder.decode();
      if (finalText) {
        if (rawResponsePreview.length < 500) {
          rawResponsePreview += finalText.slice(0, 500 - rawResponsePreview.length);
        }
        parser.feed(finalText);
        if (streamErrorMessage) {
          throw new Error(streamErrorMessage);
        }
        while (chunkQueue.length > 0) {
          const chunk = chunkQueue.shift();
          if (chunk) {
            yieldedChunks++;
            yield chunk;
          }
        }
      }

      if (yieldedChunks === 0) {
        const preview = rawResponsePreview.slice(0, 200);
        throw new Error(
          `OpenAI Codex streaming produced no chunks. ` +
            `Content-Type: ${contentType || "(empty)"}, ` +
            `Response preview: ${preview || "(empty)"}`,
        );
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // intentionally ignored
      }
      reader.releaseLock();
    }
  }

  /**
   * Abort ongoing polling flow.
   */
  abortPolling(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * Reset auth state and stop ongoing polling.
   */
  override resetAuth(): void {
    this.abortPolling();
    this.cancelBrowserAuthFlow();
    super.resetAuth();
  }

  /**
   * Read/decrypt persisted auth record for OAuth base.
   */
  protected async readAuthRecord(): Promise<OAuthAuthRecord> {
    const settings = getSettings();

    const accessToken = settings.openAICodexAccessToken
      ? await getDecryptedKey(settings.openAICodexAccessToken)
      : "";

    const refreshToken = settings.openAICodexRefreshToken
      ? await getDecryptedKey(settings.openAICodexRefreshToken)
      : "";

    return {
      accessToken,
      refreshToken,
      expiresAt: settings.openAICodexTokenExpiresAt,
      accountId: settings.openAICodexAccountId || undefined,
    };
  }

  /**
   * Persist auth record updates for OAuth base.
   * @param updates - Partial auth fields.
   */
  protected writeAuthRecord(updates: Partial<OAuthAuthRecord>): void {
    setSettings({
      ...(updates.accessToken !== undefined ? { openAICodexAccessToken: updates.accessToken } : {}),
      ...(updates.refreshToken !== undefined
        ? { openAICodexRefreshToken: updates.refreshToken }
        : {}),
      ...(updates.expiresAt !== undefined ? { openAICodexTokenExpiresAt: updates.expiresAt } : {}),
      ...(updates.accountId !== undefined ? { openAICodexAccountId: updates.accountId || "" } : {}),
    });
  }

  /**
   * Refresh Codex OAuth access token.
   * @param record - Current auth record.
   */
  protected async refreshAccessToken(record: OAuthAuthRecord): Promise<OAuthTokenRefreshResult> {
    if (!record.refreshToken) {
      throw new Error("Missing Codex refresh token. Please reconnect.");
    }

    const res = await requestUrl({
      url: OAUTH_TOKEN_URL,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: record.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      throw: false,
    });

    const tokens = this.getRequestUrlJson(res) as OpenAITokenResponse;
    if (res.status !== 200) {
      const detail = this.getOauthErrorDetail(tokens);
      throw new Error(
        detail
          ? `Codex token refresh failed: ${detail}`
          : `Codex token refresh failed: ${res.status}`,
      );
    }

    if (!tokens.access_token) {
      throw new Error("Invalid Codex token refresh response: missing access_token");
    }

    const accountId = this.extractAccountId(tokens);

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || record.refreshToken,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId: accountId || record.accountId,
    };
  }

  /**
   * Clear provider auth state from settings.
   */
  protected clearProviderAuthState(): void {
    setSettings({
      openAICodexAccessToken: "",
      openAICodexRefreshToken: "",
      openAICodexTokenExpiresAt: 0,
      openAICodexAccountId: "",
    });
  }

  /**
   * Start localhost callback server for browser OAuth flow.
   * @param redirectUri - Redirect URI registered for browser flow.
   * @param expectedState - CSRF state token expected in callback.
   * @param codeVerifier - PKCE code verifier used in token exchange.
   */
  private async startBrowserCallbackServer(
    redirectUri: string,
    expectedState: string,
    codeVerifier: string,
  ): Promise<void> {
    const httpModule = await this.getNodeHttpModule();

    this.browserAuthCompletionPromise = new Promise<void>((resolve, reject) => {
      this.browserAuthResolve = resolve;
      this.browserAuthReject = reject;
    });

    this.browserAuthTimeoutId = setTimeout(() => {
      if (this.browserAuthReject) {
        this.browserAuthReject(new Error("Browser OAuth callback timed out. Please retry."));
      }
      this.cleanupBrowserAuthState();
    }, BROWSER_OAUTH_TIMEOUT_MS);

    await new Promise<void>((resolve, reject) => {
      const server = httpModule.createServer((req, res) => {
        void this.handleBrowserCallbackRequest(
          req.url || "",
          res,
          expectedState,
          codeVerifier,
          redirectUri,
        );
      });

      server.once("error", (error: Error) => {
        reject(error);
      });

      server.listen(BROWSER_OAUTH_PORT, "127.0.0.1", () => {
        this.browserAuthServerStop = () => {
          server.close();
        };
        resolve();
      });
    });
  }

  /**
   * Handle browser callback server requests.
   * @param requestUrl - Raw request URL.
   * @param response - Node HTTP response writer.
   * @param expectedState - Expected CSRF state.
   * @param codeVerifier - PKCE verifier.
   * @param redirectUri - Redirect URI for token exchange.
   */
  private async handleBrowserCallbackRequest(
    requestUrl: string,
    response: ServerResponse<IncomingMessage>,
    expectedState: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<void> {
    const url = new URL(requestUrl, `http://localhost:${BROWSER_OAUTH_PORT}`);

    if (url.pathname === "/cancel") {
      response.statusCode = 200;
      response.end("Login cancelled");
      if (this.browserAuthReject) {
        this.browserAuthReject(new OAuthAuthCancelledError());
      }
      this.cleanupBrowserAuthState();
      return;
    }

    if (url.pathname !== "/auth/callback") {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }

    const callbackPayload: OpenAIBrowserOauthCallbackResponse = {
      code: url.searchParams.get("code") || undefined,
      state: url.searchParams.get("state") || undefined,
      error: url.searchParams.get("error") || undefined,
      error_description: url.searchParams.get("error_description") || undefined,
    };

    response.setHeader("Content-Type", "text/html");

    if (callbackPayload.error) {
      const message = callbackPayload.error_description || callbackPayload.error;
      response.statusCode = 400;
      response.end(this.getBrowserErrorHtml(message));
      if (this.browserAuthReject) {
        this.browserAuthReject(new Error(message));
      }
      this.cleanupBrowserAuthState();
      return;
    }

    if (!callbackPayload.code) {
      response.statusCode = 400;
      response.end(this.getBrowserErrorHtml("Missing authorization code"));
      if (this.browserAuthReject) {
        this.browserAuthReject(new Error("Missing authorization code"));
      }
      this.cleanupBrowserAuthState();
      return;
    }

    if (!callbackPayload.state || callbackPayload.state !== expectedState) {
      response.statusCode = 400;
      response.end(this.getBrowserErrorHtml("Invalid state token"));
      if (this.browserAuthReject) {
        this.browserAuthReject(new Error("Invalid state token"));
      }
      this.cleanupBrowserAuthState();
      return;
    }

    try {
      await this.exchangeAuthorizationCodeForTokens(
        callbackPayload.code,
        codeVerifier,
        redirectUri,
      );
      response.statusCode = 200;
      response.end(this.getBrowserSuccessHtml());
      if (this.browserAuthResolve) {
        this.browserAuthResolve();
      }
      this.cleanupBrowserAuthState();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      response.statusCode = 500;
      response.end(this.getBrowserErrorHtml(message));
      if (this.browserAuthReject) {
        this.browserAuthReject(new Error(message));
      }
      this.cleanupBrowserAuthState();
    }
  }

  /**
   * Cleanup local server and promise handles for browser auth.
   */
  private cleanupBrowserAuthState(): void {
    if (this.browserAuthTimeoutId) {
      clearTimeout(this.browserAuthTimeoutId);
      this.browserAuthTimeoutId = null;
    }

    if (this.browserAuthServerStop) {
      this.browserAuthServerStop();
      this.browserAuthServerStop = null;
    }

    this.browserAuthCompletionPromise = null;
    this.browserAuthResolve = null;
    this.browserAuthReject = null;
  }

  /**
   * Build browser authorization URL.
   * @param redirectUri - OAuth redirect URI.
   * @param codeChallenge - PKCE code challenge.
   * @param state - CSRF state token.
   */
  private buildAuthorizeUrl(redirectUri: string, codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: "obsidian-copilot",
    });

    return `${ISSUER}/oauth/authorize?${params.toString()}`;
  }

  /**
   * Generate PKCE verifier/challenge pair.
   */
  private async generatePKCE(): Promise<PkceCodes> {
    const verifier = this.generateRandomString(43);
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const challenge = this.base64UrlEncode(new Uint8Array(hash));
    return { verifier, challenge };
  }

  /**
   * Generate random URL-safe string.
   * @param length - Desired output length.
   */
  private generateRandomString(length: number): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes)
      .map((b) => chars[b % chars.length])
      .join("");
  }

  /**
   * Generate OAuth state token.
   */
  private generateState(): string {
    return this.base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  }

  /**
   * Encode bytes as base64url.
   * @param bytes - Byte array to encode.
   */
  private base64UrlEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * Resolve Node's http module for desktop callback server support.
   */
  private async getNodeHttpModule(): Promise<{ createServer: typeof import("http").createServer }> {
    let resolvedModule: unknown;
    const globalRequire =
      (globalThis as { require?: (id: string) => unknown }).require ||
      (
        globalThis as {
          window?: {
            require?: (id: string) => unknown;
          };
        }
      ).window?.require;

    if (globalRequire) {
      try {
        resolvedModule = globalRequire("node:http");
      } catch {
        // ignore and try other paths
      }
    }

    if (!resolvedModule) {
      try {
        resolvedModule = globalRequire ? globalRequire("http") : require("http");
      } catch {
        // ignore and try dynamic import
      }
    }

    if (!resolvedModule && globalRequire) {
      try {
        const electron = globalRequire("electron") as {
          remote?: {
            require?: (id: string) => unknown;
          };
        };
        if (electron?.remote?.require) {
          try {
            resolvedModule = electron.remote.require("node:http");
          } catch {
            resolvedModule = electron.remote.require("http");
          }
        }
      } catch {
        // ignore and try dynamic import
      }
    }

    if (!resolvedModule) {
      try {
        resolvedModule = await import("node:http");
      } catch {
        // ignore and validate below
      }
    }

    const candidates = [
      resolvedModule,
      (resolvedModule as { default?: unknown } | undefined)?.default,
    ];

    for (const candidate of candidates) {
      if (
        candidate &&
        typeof (candidate as { createServer?: unknown }).createServer === "function"
      ) {
        return candidate as { createServer: typeof import("http").createServer };
      }
    }

    throw new Error(
      "Desktop Node http server is unavailable in this runtime; browser OAuth flow is unsupported.",
    );
  }

  /**
   * Success HTML rendered in browser callback window.
   */
  private getBrowserSuccessHtml(): string {
    return `<!doctype html><html><head><title>Codex Authorization Successful</title></head><body><h1>Authorization successful</h1><p>You can close this window.</p><script>setTimeout(() => window.close(), 1500)</script></body></html>`;
  }

  /**
   * Error HTML rendered in browser callback window.
   * @param message - Error message text.
   */
  private getBrowserErrorHtml(message: string): string {
    const escaped = message.replace(/[<>&'"]/g, (char) => {
      const map: Record<string, string> = {
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        "'": "&#39;",
        '"': "&quot;",
      };
      return map[char] || char;
    });
    return `<!doctype html><html><head><title>Codex Authorization Failed</title></head><body><h1>Authorization failed</h1><p>${escaped}</p></body></html>`;
  }

  /**
   * Build request headers for Codex API.
   * @param token - OAuth access token.
   */
  private async buildCodexHeaders(token: string): Promise<Record<string, string>> {
    const settings = getSettings();
    const decryptedAccountId = settings.openAICodexAccountId
      ? await getDecryptedKey(settings.openAICodexAccountId)
      : "";

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      originator: "obsidian-copilot",
    };

    if (decryptedAccountId) {
      headers["ChatGPT-Account-Id"] = decryptedAccountId;
    }

    return headers;
  }

  /**
   * Build a Responses API compatible request payload for Codex.
   * System messages are merged into `instructions` and non-system messages go into `input`.
   * @param messages - Normalized role/content messages.
   * @param model - Target model id.
   * @param stream - Whether to stream server events.
   */
  private buildCodexResponsesBody(
    messages: Array<{ role: string; content: string }>,
    model: string,
    stream: boolean,
  ): Record<string, unknown> {
    const instructions = messages
      .filter((message) => message.role === "system" && message.content.trim().length > 0)
      .map((message) => message.content.trim())
      .join("\n\n");

    const inputMessages = messages
      .filter((message) => message.role !== "system" && message.content.trim().length > 0)
      .map((message) => ({
        type: "message",
        role: message.role === "assistant" ? "assistant" : "user",
        content: [
          {
            type: "input_text",
            text: message.content,
          },
        ],
      }));

    return {
      model,
      instructions: instructions || DEFAULT_CODEX_INSTRUCTIONS,
      input:
        inputMessages.length > 0
          ? inputMessages
          : [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "" }],
              },
            ],
      store: false,
      stream,
    };
  }

  /**
   * Parse stream event payload to normalized stream chunk.
   * @param data - Raw SSE event data.
   */
  private parseStreamEventData(data: string): OAuthStreamChunk | null {
    try {
      const parsed = JSON.parse(data) as unknown;

      // OpenAI chat completions style chunk
      if (this.isOpenAIStyleStreamChunk(parsed)) {
        return parsed;
      }

      // Responses API style event
      const event = parsed as CodexResponsesApiEvent;
      if (event.type === "response.output_text.done" && typeof event.text === "string") {
        return {
          choices: [
            {
              index: 0,
              delta: {
                content: event.text,
              },
            },
          ],
        };
      }

      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        return {
          choices: [
            {
              index: 0,
              delta: {
                content: event.delta,
              },
            },
          ],
        };
      }

      if (event.type === "response.completed") {
        return {
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
          usage: event.response?.usage
            ? {
                prompt_tokens: event.response.usage.input_tokens || 0,
                completion_tokens: event.response.usage.output_tokens || 0,
                total_tokens: event.response.usage.total_tokens || 0,
              }
            : undefined,
          model: event.response?.model,
          id: event.response?.id,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Check whether parsed stream payload already matches OpenAI-style chunk format.
   * @param payload - Unknown parsed payload.
   */
  private isOpenAIStyleStreamChunk(payload: unknown): payload is OAuthStreamChunk {
    return (
      Boolean(payload) &&
      typeof payload === "object" &&
      Array.isArray((payload as Record<string, unknown>).choices)
    );
  }

  /**
   * Read payload from fetch response and parse JSON when possible.
   * @param response - Fetch response.
   */
  private async readResponsePayload(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /**
   * Build detailed HTTP error message using payload details.
   * @param status - HTTP status code.
   * @param payload - Parsed payload.
   */
  private buildHttpError(status: number, payload: unknown): string {
    const baseMessage = HTTP_STATUS_MESSAGES[status] || `Request failed: ${status}`;

    if (!payload) {
      return baseMessage;
    }

    if (typeof payload === "string") {
      return `${baseMessage}: ${payload}`;
    }

    if (typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const nestedError = record.error;
      if (nestedError && typeof nestedError === "object") {
        const nestedRecord = nestedError as Record<string, unknown>;
        if (typeof nestedRecord.message === "string") {
          return `${baseMessage}: ${nestedRecord.message}`;
        }
      }

      if (typeof record.message === "string") {
        return `${baseMessage}: ${record.message}`;
      }

      try {
        return `${baseMessage}: ${JSON.stringify(payload)}`;
      } catch {
        return baseMessage;
      }
    }

    return baseMessage;
  }

  /**
   * Parse useful OAuth error detail fields.
   * @param payload - OAuth response payload.
   */
  private getOauthErrorDetail(payload: { error?: string; error_description?: string }): string {
    if (typeof payload.error_description === "string" && payload.error_description) {
      return payload.error_description;
    }
    if (typeof payload.error === "string" && payload.error) {
      return payload.error;
    }
    return "";
  }

  /**
   * Parse jwt claims from id/access token payload.
   * @param token - JWT token string.
   */
  private parseJwtClaims(token: string): Record<string, unknown> | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return undefined;
    }

    try {
      return JSON.parse(Buffer.from(parts[1], "base64url").toString()) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract account id from token claims.
   * @param tokens - OAuth token response payload.
   */
  private extractAccountId(tokens: OpenAITokenResponse): string | undefined {
    if (tokens.id_token) {
      const claims = this.parseJwtClaims(tokens.id_token);
      const fromIdToken = this.extractAccountIdFromClaims(claims);
      if (fromIdToken) {
        return fromIdToken;
      }
    }

    if (tokens.access_token) {
      const claims = this.parseJwtClaims(tokens.access_token);
      return this.extractAccountIdFromClaims(claims);
    }

    return undefined;
  }

  /**
   * Extract account id from known claim locations.
   * @param claims - JWT claims map.
   */
  private extractAccountIdFromClaims(claims?: Record<string, unknown>): string | undefined {
    if (!claims) {
      return undefined;
    }

    const direct = claims.chatgpt_account_id;
    if (typeof direct === "string" && direct) {
      return direct;
    }

    const nested = claims["https://api.openai.com/auth"];
    if (nested && typeof nested === "object") {
      const nestedId = (nested as Record<string, unknown>).chatgpt_account_id;
      if (typeof nestedId === "string" && nestedId) {
        return nestedId;
      }
    }

    const organizations = claims.organizations;
    if (Array.isArray(organizations) && organizations.length > 0) {
      const first = organizations[0];
      if (first && typeof first === "object") {
        const orgId = (first as Record<string, unknown>).id;
        if (typeof orgId === "string" && orgId) {
          return orgId;
        }
      }
    }

    return undefined;
  }

  /**
   * Parse requestUrl JSON that can be an object or JSON string.
   * @param response - Obsidian requestUrl response.
   */
  private getRequestUrlJson(response: RequestUrlResponse): unknown {
    if (typeof response.json === "string") {
      try {
        return JSON.parse(response.json);
      } catch {
        return response.json;
      }
    }
    return response.json;
  }

  /**
   * Delay helper that can be cancelled by AbortSignal.
   * @param ms - Delay duration.
   * @param signal - Optional cancel signal.
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    if (signal.aborted) {
      return Promise.reject(new OAuthAuthCancelledError());
    }

    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(new OAuthAuthCancelledError());
      };

      const timeoutId = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
