import type { FetchImplementation } from "@/utils";

/**
 * Generic normalized auth state for OAuth-backed providers.
 */
export interface OAuthAuthState {
  status: "idle" | "authenticated";
  error?: string;
}

/**
 * In-memory auth record shape used by OAuth helpers.
 */
export interface OAuthAuthRecord {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountId?: string;
}

/**
 * Result returned by provider-specific refresh implementations.
 */
export interface OAuthTokenRefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  accountId?: string;
}

/**
 * Request options for OAuth-backed chat/completions APIs.
 */
export interface OAuthRequestOptions {
  model?: string;
  signal?: AbortSignal;
  fetchImpl?: FetchImplementation;
}

/**
 * OpenAI-compatible non-streaming chat response used by chat model adapters.
 */
export interface OAuthChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
  created?: number;
  id?: string;
}

/**
 * OpenAI-compatible streaming chunk shape used by chat model adapters.
 */
export interface OAuthStreamChunk {
  choices: Array<{
    index: number;
    delta: {
      content?: string | null;
      role?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model?: string;
  created?: number;
  id?: string;
}

/**
 * Contract expected by the shared OAuth chat model base.
 */
export interface OAuthChatProvider {
  sendChatMessage(
    messages: Array<{ role: string; content: string }>,
    options?: OAuthRequestOptions,
  ): Promise<OAuthChatResponse>;
  sendChatMessageStream(
    messages: Array<{ role: string; content: string }>,
    options?: OAuthRequestOptions,
  ): AsyncGenerator<OAuthStreamChunk>;
  getProviderModelNamespace(): string;
  getProviderType(): string;
}
