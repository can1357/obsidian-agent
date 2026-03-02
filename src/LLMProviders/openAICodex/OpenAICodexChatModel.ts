import {
  OAuthChatModelBase,
  OAuthChatModelBaseParams,
} from "@/LLMProviders/oauth/OAuthChatModelBase";
import { OAuthChatProvider } from "@/LLMProviders/oauth/types";
import { OpenAICodexProvider } from "@/LLMProviders/openAICodex/OpenAICodexProvider";

export interface OpenAICodexChatModelParams extends OAuthChatModelBaseParams {}

/**
 * LangChain BaseChatModel implementation for OpenAI Codex (Mode B OAuth).
 */
export class OpenAICodexChatModel extends OAuthChatModelBase {
  lc_namespace = ["langchain", "chat_models", "openai_codex"];

  protected provider: OAuthChatProvider;

  constructor(fields: OpenAICodexChatModelParams) {
    super(fields);
    this.provider = OpenAICodexProvider.getInstance();
  }

  _llmType(): string {
    return "openai-codex";
  }
}
