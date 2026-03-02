import {
  OAuthChatModelBase,
  OAuthChatModelBaseParams,
} from "@/LLMProviders/oauth/OAuthChatModelBase";
import { OAuthChatProvider } from "@/LLMProviders/oauth/types";
import { GitHubCopilotProvider } from "./GitHubCopilotProvider";

export interface GitHubCopilotChatModelParams extends OAuthChatModelBaseParams {}

/**
 * LangChain BaseChatModel implementation for GitHub Copilot.
 */
export class GitHubCopilotChatModel extends OAuthChatModelBase {
  lc_namespace = ["langchain", "chat_models", "github_copilot"];

  protected provider: OAuthChatProvider;

  constructor(fields: GitHubCopilotChatModelParams) {
    super(fields);
    this.provider = GitHubCopilotProvider.getInstance();
  }

  _llmType(): string {
    return "github-copilot";
  }
}
