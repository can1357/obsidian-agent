import { type CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { ChatGeneration, ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import {
  OAuthChatProvider,
  OAuthRequestOptions,
  OAuthStreamChunk,
} from "@/LLMProviders/oauth/types";
import { extractTextFromChunk, FetchImplementation } from "@/utils";

const CHARS_PER_TOKEN = 4;

export interface OAuthChatModelBaseParams extends BaseChatModelParams {
  modelName: string;
  streaming?: boolean;
  fetchImplementation?: FetchImplementation;
}

/**
 * Shared LangChain BaseChatModel for OAuth-backed providers that expose OpenAI-style payloads.
 */
export abstract class OAuthChatModelBase extends BaseChatModel {
  lc_serializable = false;

  modelName: string;
  streaming: boolean;
  protected fetchImpl: FetchImplementation;

  protected abstract provider: OAuthChatProvider;

  constructor(fields: OAuthChatModelBaseParams) {
    super(fields);
    this.modelName = fields.modelName;
    this.streaming = fields.streaming ?? true;
    this.fetchImpl = fields.fetchImplementation ?? fetch;
  }

  /**
   * Convert LangChain message roles to API roles.
   * Tool/function messages are normalized to user.
   * @param messageType - LangChain message type.
   */
  protected convertMessageType(messageType: string): string {
    switch (messageType) {
      case "human":
        return "user";
      case "ai":
        return "assistant";
      case "system":
        return "system";
      case "tool":
      case "function":
      case "generic":
      default:
        return "user";
    }
  }

  /**
   * Convert LangChain messages to provider payload format.
   * @param messages - LangChain base messages.
   */
  protected toProviderMessages(messages: BaseMessage[]): Array<{ role: string; content: string }> {
    return messages.map((m) => ({
      role: this.convertMessageType(m._getType()),
      content: extractTextFromChunk(m.content),
    }));
  }

  /**
   * Build request options shared by stream and non-stream methods.
   * @param options - LangChain call options.
   */
  protected getRequestOptions(options: this["ParsedCallOptions"]): OAuthRequestOptions {
    return {
      model: this.modelName,
      fetchImpl: this.fetchImpl,
      signal: options?.signal,
    };
  }

  /**
   * Generate a non-streaming completion response.
   */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const requestOptions = this.getRequestOptions(options);
    const response = await this.provider.sendChatMessage(
      this.toProviderMessages(messages),
      requestOptions,
    );

    const choice = response.choices?.[0];
    const content = choice?.message?.content || "";
    const finishReason = choice?.finish_reason || undefined;

    const tokenUsage = response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined;

    const responseMetadata = {
      finish_reason: finishReason,
      tokenUsage,
      model: response.model,
    };

    const generation: ChatGeneration = {
      text: content,
      message: new AIMessage({
        content,
        response_metadata: responseMetadata,
      }),
      generationInfo: finishReason ? { finish_reason: finishReason } : undefined,
    };

    return {
      generations: [generation],
      llmOutput: {
        tokenUsage,
      },
    };
  }

  /**
   * Stream completion chunks from provider.
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    if (!this.streaming) {
      const result = await this._generate(messages, options, runManager);
      const generation = result.generations[0];
      if (!generation) return;

      const messageChunk = new AIMessageChunk({
        content: generation.text,
        response_metadata: generation.message.response_metadata,
      });

      const generationChunk = new ChatGenerationChunk({
        message: messageChunk,
        text: generation.text,
        generationInfo: generation.generationInfo,
      });

      if (runManager && generation.text) {
        await runManager.handleLLMNewToken(generation.text);
      }

      yield generationChunk;
      return;
    }

    let yieldedUsableChunk = false;
    const requestOptions = this.getRequestOptions(options);

    for await (const chunk of this.provider.sendChatMessageStream(
      this.toProviderMessages(messages),
      requestOptions,
    )) {
      const generationChunk = this.toGenerationChunk(chunk);
      if (!generationChunk) {
        continue;
      }

      if (runManager && generationChunk.text) {
        await runManager.handleLLMNewToken(generationChunk.text);
      }

      yieldedUsableChunk = true;
      yield generationChunk;
    }

    if (!yieldedUsableChunk) {
      throw new Error(
        `${this.provider.getProviderType()} streaming produced no usable chunks (no content, finish_reason, or usage)`,
      );
    }
  }

  /**
   * Estimate token count with character-based approximation.
   * @param content - Message content.
   */
  async getNumTokens(content: MessageContent): Promise<number> {
    const text = extractTextFromChunk(content);
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Map provider chunk format into LangChain generation chunk.
   * @param chunk - Provider streaming chunk.
   */
  private toGenerationChunk(chunk: OAuthStreamChunk): ChatGenerationChunk | null {
    const choice = chunk.choices?.[0];
    const content = choice?.delta?.content || "";

    const hasMetadata = choice?.finish_reason || chunk.usage || choice?.delta?.role;
    if (!content && !hasMetadata) {
      return null;
    }

    const responseMetadata: Record<string, unknown> = {};

    if (choice?.finish_reason) {
      responseMetadata.finish_reason = choice.finish_reason;
    }

    if (choice?.delta?.role) {
      responseMetadata.role = choice.delta.role;
    }

    if (chunk.usage) {
      responseMetadata.tokenUsage = {
        promptTokens: chunk.usage.prompt_tokens,
        completionTokens: chunk.usage.completion_tokens,
        totalTokens: chunk.usage.total_tokens,
      };
    }

    if (chunk.model) {
      responseMetadata.model = chunk.model;
    }

    const messageChunk = new AIMessageChunk({
      content,
      response_metadata: Object.keys(responseMetadata).length > 0 ? responseMetadata : undefined,
    });

    return new ChatGenerationChunk({
      message: messageChunk,
      text: content,
      generationInfo: choice?.finish_reason ? { finish_reason: choice.finish_reason } : undefined,
    });
  }
}
