import { ChevronDown, ChevronUp, Copy, Loader2 } from "lucide-react";
import { Notice } from "obsidian";
import React, { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible";
import { HelpTooltip } from "@/components/ui/help-tooltip";
import { ChatModelProviders } from "@/constants";
import { isOAuthAuthCancelledError } from "@/LLMProviders/oauth/errors";
import {
  OpenAICodexDeviceCodeResponse,
  OpenAICodexProvider,
} from "@/LLMProviders/openAICodex/OpenAICodexProvider";
import { useSettingsValue } from "@/settings/model";
import { ModelImporter } from "@/settings/v2/components/ModelImporter";

type AuthStep = "idle" | "pending" | "polling" | "done" | "error";
type AuthMode = "browser" | "headless";

/**
 * OpenAI Codex OAuth authentication component.
 */
export function OpenAICodexAuth() {
  const settings = useSettingsValue();
  const [codexProvider] = useState(() => OpenAICodexProvider.getInstance());
  const [authStep, setAuthStep] = useState<AuthStep>("idle");
  const [deviceCode, setDeviceCode] = useState<OpenAICodexDeviceCodeResponse | null>(null);
  const [pollCount, setPollCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("headless");
  const [browserAuthUrl, setBrowserAuthUrl] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const authRequestIdRef = useRef(0);
  const isMountedRef = useRef(true);

  /**
   * Refresh local auth step from provider auth state.
   */
  const syncAuthState = async () => {
    const state = await codexProvider.getAuthState();
    if (!isMountedRef.current) {
      return;
    }

    if (state.status === "authenticated") {
      if (authStep !== "pending" && authStep !== "polling") {
        setAuthStep("done");
      }
      return;
    }

    if (authStep === "done") {
      setAuthStep("idle");
    }
  };

  useEffect(() => {
    isMountedRef.current = true;

    void syncAuthState();

    return () => {
      isMountedRef.current = false;
      authRequestIdRef.current += 1;
      codexProvider.abortPolling();
      codexProvider.cancelBrowserAuthFlow();
    };
  }, [codexProvider]);

  useEffect(() => {
    void syncAuthState();
  }, [
    settings.openAICodexAccessToken,
    settings.openAICodexRefreshToken,
    settings.openAICodexTokenExpiresAt,
    codexProvider,
    authStep,
  ]);

  /**
   * Run polling flow using current device code details.
   * @param code - Device code payload.
   * @param requestId - Stable request identifier.
   */
  const runPollingFlow = async (code: OpenAICodexDeviceCodeResponse, requestId: number) => {
    await codexProvider.pollForTokens(
      code.deviceAuthId,
      code.userCode,
      code.intervalMs,
      code.expiresIn,
      (attempt) => {
        if (isMountedRef.current && requestId === authRequestIdRef.current) {
          setPollCount(attempt);
        }
      },
    );

    if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
      return;
    }

    setAuthStep("done");
    setDeviceCode(null);
    new Notice("OpenAI Codex connected successfully!");
  };

  /**
   * Run browser OAuth flow using localhost callback server.
   * @param requestId - Stable request identifier.
   */
  const runBrowserFlow = async (requestId: number) => {
    const authorizeUrl = await codexProvider.startBrowserAuthFlow();

    if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
      return;
    }

    setBrowserAuthUrl(authorizeUrl);
    setExpanded(true);
    setAuthStep("polling");

    window.open(authorizeUrl, "_blank", "noopener,noreferrer");
    await codexProvider.waitForBrowserAuthCompletion();

    if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
      return;
    }

    setAuthStep("done");
    setBrowserAuthUrl(null);
    new Notice("OpenAI Codex connected successfully!");
  };

  /**
   * Start Codex OAuth device flow.
   */
  const handleStartAuth = async () => {
    const requestId = ++authRequestIdRef.current;

    setAuthStep("pending");
    setError(null);
    setPollCount(0);
    setAuthMode("headless");
    setBrowserAuthUrl(null);

    try {
      const code = await codexProvider.startDeviceAuthFlow();

      if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
        return;
      }

      setDeviceCode(code);
      setAuthStep("polling");
      setExpanded(true);

      try {
        await runPollingFlow(code, requestId);
      } catch (pollError: unknown) {
        if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
          return;
        }

        if (isOAuthAuthCancelledError(pollError)) {
          return;
        }

        throw pollError;
      }
    } catch (e: unknown) {
      if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
        return;
      }

      const errorMessage = e instanceof Error ? e.message : String(e);
      setError(errorMessage);
      setAuthStep("error");
      new Notice(`Authentication failed: ${errorMessage}`);
    }
  };

  /**
   * Start browser OAuth flow with PKCE localhost callback.
   */
  const handleStartBrowserAuth = async () => {
    const requestId = ++authRequestIdRef.current;

    setAuthStep("pending");
    setError(null);
    setPollCount(0);
    setAuthMode("browser");

    try {
      await runBrowserFlow(requestId);
    } catch (e: unknown) {
      if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
        return;
      }

      if (isOAuthAuthCancelledError(e)) {
        return;
      }

      const errorMessage = e instanceof Error ? e.message : String(e);
      setError(errorMessage);
      setAuthStep("error");
      new Notice(`Authentication failed: ${errorMessage}`);
    }
  };

  /**
   * Reset Codex auth data.
   */
  const handleReset = () => {
    const isInAuthFlow =
      authStep === "pending" || authStep === "polling" || (authStep === "error" && deviceCode);

    authRequestIdRef.current += 1;
    codexProvider.resetAuth();

    setAuthStep("idle");
    setDeviceCode(null);
    setError(null);
    setPollCount(0);
    setBrowserAuthUrl(null);
    setExpanded(false);

    new Notice(isInAuthFlow ? "Authentication cancelled" : "OpenAI Codex disconnected");
  };

  /**
   * Copy helper.
   * @param text - Text to copy.
   */
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      new Notice("Copied to clipboard!");
    } catch {
      new Notice("Failed to copy to clipboard");
    }
  };

  /**
   * Retry polling current device code.
   */
  const handleRetryPolling = async () => {
    if (!deviceCode) return;

    const requestId = ++authRequestIdRef.current;
    setAuthStep("polling");
    setError(null);
    setPollCount(0);

    try {
      await runPollingFlow(deviceCode, requestId);
    } catch (e: unknown) {
      if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
        return;
      }

      if (isOAuthAuthCancelledError(e)) {
        return;
      }

      const errorMessage = e instanceof Error ? e.message : String(e);
      setError(errorMessage);
      setAuthStep("error");
      new Notice(`Authentication failed: ${errorMessage}`);
    }
  };

  /**
   * Retry browser OAuth callback wait with a fresh auth URL.
   */
  const handleRetryBrowser = async () => {
    const requestId = ++authRequestIdRef.current;
    setAuthStep("pending");
    setError(null);

    try {
      await runBrowserFlow(requestId);
    } catch (e: unknown) {
      if (!isMountedRef.current || requestId !== authRequestIdRef.current) {
        return;
      }

      if (isOAuthAuthCancelledError(e)) {
        return;
      }

      const errorMessage = e instanceof Error ? e.message : String(e);
      setError(errorMessage);
      setAuthStep("error");
      new Notice(`Authentication failed: ${errorMessage}`);
    }
  };

  const isAuthenticated = authStep === "done";
  const isAuthenticating = authStep === "pending" || authStep === "polling";
  const showDeviceCode = (authStep === "polling" || authStep === "error") && deviceCode !== null;

  return (
    <>
      <div className="tw-flex tw-flex-col tw-gap-2">
        <div className="tw-flex tw-items-center tw-gap-1 tw-font-medium">
          <div className="tw-truncate">OpenAI Codex</div>
          <HelpTooltip
            content={
              <div className="tw-max-w-[250px]">
                <div className="tw-font-semibold">Subscription OAuth Flow</div>
                <p className="tw-mt-1">
                  This connects through ChatGPT OAuth and Codex backend endpoints. It may change as
                  OpenAI evolves the service.
                </p>
              </div>
            }
            side="bottom"
          >
            <span className="tw-cursor-help tw-text-warning">⚠️</span>
          </HelpTooltip>
        </div>

        <div className="tw-flex tw-flex-col tw-gap-2 sm:tw-flex-row sm:tw-items-center">
          <div
            className={`tw-flex tw-h-9 tw-flex-1 tw-items-center tw-rounded-md tw-border tw-border-border tw-px-3 tw-text-sm ${
              isAuthenticated
                ? "tw-text-success"
                : isAuthenticating
                  ? "tw-text-warning"
                  : authStep === "error"
                    ? "tw-text-error"
                    : "tw-text-muted"
            }`}
          >
            {isAuthenticated
              ? "✓ Connected"
              : isAuthenticating
                ? "Authenticating..."
                : authStep === "error"
                  ? "Error - Click Setup to retry"
                  : "Not connected"}
          </div>

          <div className="tw-flex tw-items-center tw-gap-2">
            {isAuthenticated && (
              <Button
                onClick={handleReset}
                variant="ghost"
                className="tw-flex tw-flex-1 tw-items-center tw-justify-center tw-whitespace-nowrap tw-px-4 tw-py-2 tw-text-warning hover:tw-text-warning sm:tw-flex-none"
              >
                Disconnect
              </Button>
            )}
            {isAuthenticated ? (
              <Button
                onClick={() => setExpanded(!expanded)}
                variant="secondary"
                className="tw-flex tw-flex-1 tw-items-center tw-justify-center tw-gap-2 tw-whitespace-nowrap tw-px-4 tw-py-2 sm:tw-flex-none"
              >
                Add Model
                {expanded ? (
                  <ChevronUp className="tw-ml-1 tw-size-4" />
                ) : (
                  <ChevronDown className="tw-ml-1 tw-size-4" />
                )}
              </Button>
            ) : (
              <>
                <Button
                  onClick={() => void handleStartBrowserAuth()}
                  disabled={isAuthenticating}
                  variant="secondary"
                  className="tw-flex tw-flex-1 tw-items-center tw-justify-center tw-gap-2 tw-whitespace-nowrap tw-px-3 tw-py-2 sm:tw-flex-none"
                >
                  {isAuthenticating && authMode === "browser" ? (
                    <Loader2 className="tw-size-4 tw-animate-spin" />
                  ) : null}
                  Browser
                </Button>
                <Button
                  onClick={() => {
                    setAuthMode("headless");
                    void handleStartAuth();
                  }}
                  disabled={isAuthenticating}
                  variant="secondary"
                  className="tw-flex tw-flex-1 tw-items-center tw-justify-center tw-gap-2 tw-whitespace-nowrap tw-px-3 tw-py-2 sm:tw-flex-none"
                >
                  {isAuthenticating && authMode === "headless" ? (
                    <Loader2 className="tw-size-4 tw-animate-spin" />
                  ) : null}
                  Headless
                </Button>
              </>
            )}
          </div>
        </div>

        <div>
          <a
            href="https://chatgpt.com"
            target="_blank"
            rel="noopener noreferrer"
            className="tw-text-[10px] tw-text-accent hover:tw-text-accent-hover sm:tw-text-xs"
          >
            Open ChatGPT
          </a>
        </div>
      </div>

      <Collapsible open={expanded}>
        <CollapsibleContent className="tw-rounded-md tw-p-3">
          <div className="tw-flex tw-flex-col tw-gap-2">
            {authMode === "headless" && showDeviceCode && deviceCode && (
              <div className="tw-space-y-2.5 tw-rounded-lg tw-border tw-border-border tw-p-3.5 tw-bg-muted/10">
                <div className="tw-flex tw-items-center tw-gap-2 tw-text-xs">
                  <span className="tw-font-semibold">1.</span>
                  <span className="tw-text-muted">Go to:</span>
                  <a
                    href={deviceCode.verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="tw-break-all tw-text-accent tw-underline hover:tw-text-accent-hover"
                  >
                    {deviceCode.verificationUri}
                  </a>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyToClipboard(deviceCode.verificationUri)}
                    className="tw-size-5 tw-shrink-0 tw-p-0"
                    title="Copy URL"
                  >
                    <Copy className="tw-size-3.5" />
                  </Button>
                </div>

                <div className="tw-flex tw-items-center tw-gap-2 tw-text-xs">
                  <span className="tw-font-semibold">2.</span>
                  <span className="tw-text-muted">Enter code:</span>
                  <code className="tw-rounded-md tw-border-border tw-px-3 tw-py-1.5 tw-font-mono tw-text-base tw-font-bold tw-tracking-widest tw-bg-accent/10 tw-border-accent/30">
                    {deviceCode.userCode}
                  </code>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void copyToClipboard(deviceCode.userCode)}
                    className="tw-size-5 tw-shrink-0 tw-p-0"
                    title="Copy code"
                  >
                    <Copy className="tw-size-3.5" />
                  </Button>
                </div>

                <div className="tw-flex tw-flex-col tw-gap-2 tw-border-t tw-pt-2 tw-border-border/50">
                  {authStep === "polling" ? (
                    <>
                      <div className="tw-flex tw-items-center tw-justify-center tw-gap-2 tw-py-1 tw-text-xs tw-text-muted">
                        <Loader2 className="tw-size-3.5 tw-animate-spin" />
                        <span>
                          Waiting for authorization...{pollCount > 0 && ` (Attempt ${pollCount})`}
                        </span>
                      </div>
                      <Button onClick={handleReset} variant="ghost" size="sm" className="tw-w-full">
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <div className="tw-flex tw-items-center tw-justify-center tw-gap-2 tw-py-1 tw-text-xs tw-text-error">
                        <span>Polling failed - you can retry with the same code</span>
                      </div>
                      <div className="tw-flex tw-gap-2">
                        <Button
                          onClick={() => void handleRetryPolling()}
                          variant="secondary"
                          size="sm"
                          className="tw-flex-1"
                        >
                          Retry
                        </Button>
                        <Button
                          onClick={handleReset}
                          variant="ghost"
                          size="sm"
                          className="tw-flex-1"
                        >
                          Start Over
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}

            {authMode === "browser" && !isAuthenticated && (
              <div className="tw-space-y-2.5 tw-rounded-lg tw-border tw-border-border tw-p-3.5 tw-bg-muted/10">
                <div className="tw-flex tw-items-center tw-gap-2 tw-text-xs">
                  <span className="tw-font-semibold">Browser OAuth:</span>
                  <span className="tw-text-muted">
                    Complete the login in the opened browser tab and return here.
                  </span>
                </div>
                {browserAuthUrl && (
                  <div className="tw-flex tw-items-center tw-gap-2 tw-text-xs">
                    <span className="tw-text-muted">If browser did not open, use:</span>
                    <a
                      href={browserAuthUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="tw-break-all tw-text-accent tw-underline hover:tw-text-accent-hover"
                    >
                      Open authorization URL
                    </a>
                  </div>
                )}
                {authStep === "error" && (
                  <div className="tw-flex tw-gap-2">
                    <Button
                      onClick={() => void handleRetryBrowser()}
                      variant="secondary"
                      size="sm"
                      className="tw-flex-1"
                    >
                      Retry Browser
                    </Button>
                    <Button onClick={handleReset} variant="ghost" size="sm" className="tw-flex-1">
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}

            {isAuthenticated && (
              <ModelImporter
                provider={ChatModelProviders.OPENAI_CODEX}
                isReady={isAuthenticated}
                expanded={expanded}
                credentialVersion={`${settings.openAICodexAccessToken}|${settings.openAICodexRefreshToken}`}
              />
            )}

            {error && (
              <div className="tw-rounded-lg tw-border tw-border-border tw-p-3.5 tw-text-xs tw-text-error tw-bg-muted/10">
                {error}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
