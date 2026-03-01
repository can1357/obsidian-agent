import { Brain, Check, Database, Globe, Pen, Sparkles, Wrench } from "lucide-react";
import React from "react";
import { ChainType } from "@/chainFactory";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { updateSetting } from "@/settings/model";

interface ChatToolControlsProps {
  // Tool toggle states
  vaultToggle: boolean;
  setVaultToggle: (value: boolean) => void;
  webToggle: boolean;
  setWebToggle: (value: boolean) => void;
  composerToggle: boolean;
  setComposerToggle: (value: boolean) => void;
  autonomousAgentToggle: boolean;
  setAutonomousAgentToggle: (value: boolean) => void;

  // Toggle-off callbacks for pill removal
  onVaultToggleOff?: () => void;
  onWebToggleOff?: () => void;
  onComposerToggleOff?: () => void;

  // Other props
  currentChain: ChainType;
}

const ChatToolControls: React.FC<ChatToolControlsProps> = ({
  vaultToggle,
  setVaultToggle,
  webToggle,
  setWebToggle,
  composerToggle,
  setComposerToggle,
  autonomousAgentToggle,
  setAutonomousAgentToggle,
  onVaultToggleOff,
  onWebToggleOff,
  onComposerToggleOff,
  currentChain,
}) => {
  const showAutonomousAgent = currentChain !== ChainType.PROJECT_CHAIN;

  const handleAutonomousAgentToggle = () => {
    const newValue = !autonomousAgentToggle;
    setAutonomousAgentToggle(newValue);
    updateSetting("enableAutonomousAgent", newValue);
  };

  const handleVaultToggle = () => {
    const newValue = !vaultToggle;
    setVaultToggle(newValue);
    // If toggling off, remove pills
    if (!newValue && onVaultToggleOff) {
      onVaultToggleOff();
    }
  };

  const handleWebToggle = () => {
    const newValue = !webToggle;
    setWebToggle(newValue);
    // If toggling off, remove pills
    if (!newValue && onWebToggleOff) {
      onWebToggleOff();
    }
  };

  const handleComposerToggle = () => {
    const newValue = !composerToggle;
    setComposerToggle(newValue);
    // If toggling off, remove pills
    if (!newValue && onComposerToggleOff) {
      onComposerToggleOff();
    }
  };

  return (
    <TooltipProvider delayDuration={0}>
      {/* Desktop view - show all icons when container is wide enough */}
      <div className="tw-hidden tw-items-center tw-gap-1.5 @[420px]/chat-input:tw-flex">
        {/* Autonomous Agent button - hidden in Projects mode */}
        {showAutonomousAgent && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost2"
                size="fit"
                onClick={handleAutonomousAgentToggle}
                className={cn(
                  "tw-text-muted hover:tw-text-accent",
                  autonomousAgentToggle && "tw-text-accent tw-bg-accent/10",
                )}
              >
                <Brain className="tw-size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="tw-px-1 tw-py-0.5">
              Toggle autonomous agent mode
            </TooltipContent>
          </Tooltip>
        )}

        {/* Toggle buttons for vault, web search, and composer - show when Autonomous Agent is off */}
        {!autonomousAgentToggle && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost2"
                  size="fit"
                  onClick={handleVaultToggle}
                  className={cn(
                    "tw-text-muted hover:tw-text-accent",
                    vaultToggle && "tw-text-accent tw-bg-accent/10",
                  )}
                >
                  <Database className="tw-size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="tw-px-1 tw-py-0.5">Toggle vault search</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost2"
                  size="fit"
                  onClick={handleWebToggle}
                  className={cn(
                    "tw-text-muted hover:tw-text-accent",
                    webToggle && "tw-text-accent tw-bg-accent/10",
                  )}
                >
                  <Globe className="tw-size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent className="tw-px-1 tw-py-0.5">Toggle web search</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost2"
                  size="fit"
                  onClick={handleComposerToggle}
                  className={cn(
                    "tw-text-muted hover:tw-text-accent",
                    composerToggle && "tw-text-accent tw-bg-accent/10",
                  )}
                >
                  <span className="tw-flex tw-items-center tw-gap-0.5">
                    <Sparkles className="tw-size-2" />
                    <Pen className="tw-size-3" />
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className="tw-px-1 tw-py-0.5">
                Toggle composer (note editing)
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {/* Mobile view - show overflow dropdown when container is narrow */}
      <div className="tw-flex tw-items-center tw-gap-0.5 @[420px]/chat-input:tw-hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost2" size="fit" className="tw-text-muted hover:tw-text-accent">
              <Wrench className="tw-size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="tw-w-56">
            {/* Autonomous Agent option - hidden in Projects mode */}
            {showAutonomousAgent && (
              <DropdownMenuItem
                onClick={handleAutonomousAgentToggle}
                className="tw-flex tw-items-center tw-justify-between"
              >
                <div className="tw-flex tw-items-center tw-gap-2">
                  <Brain className="tw-size-4" />
                  <span>Autonomous Agent</span>
                </div>
                {autonomousAgentToggle && <Check className="tw-size-4" />}
              </DropdownMenuItem>
            )}

            {/* Tool options - show when Autonomous Agent is off */}
            {!autonomousAgentToggle && (
              <>
                <DropdownMenuItem
                  onClick={handleVaultToggle}
                  className="tw-flex tw-items-center tw-justify-between"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <Database className="tw-size-4" />
                    <span>Vault Search</span>
                  </div>
                  {vaultToggle && <Check className="tw-size-4" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleWebToggle}
                  className="tw-flex tw-items-center tw-justify-between"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <Globe className="tw-size-4" />
                    <span>Web Search</span>
                  </div>
                  {webToggle && <Check className="tw-size-4" />}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleComposerToggle}
                  className="tw-flex tw-items-center tw-justify-between"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <span className="tw-flex tw-items-center tw-gap-0.5">
                      <Sparkles className="tw-size-2" />
                      <Pen className="tw-size-3" />
                    </span>
                    <span>Composer</span>
                  </div>
                  {composerToggle && <Check className="tw-size-4" />}
                </DropdownMenuItem>
              </>
            )}

            {/* Tool options - show when Autonomous Agent is on (disabled) */}
            {autonomousAgentToggle && (
              <>
                <DropdownMenuItem
                  disabled
                  className="tw-flex tw-items-center tw-justify-between tw-opacity-50"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <Database className="tw-size-4" />
                    <span>Vault Search</span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled
                  className="tw-flex tw-items-center tw-justify-between tw-opacity-50"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <Globe className="tw-size-4" />
                    <span>Web Search</span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled
                  className="tw-flex tw-items-center tw-justify-between tw-opacity-50"
                >
                  <div className="tw-flex tw-items-center tw-gap-2">
                    <span className="tw-flex tw-items-center tw-gap-0.5">
                      <Sparkles className="tw-size-2" />
                      <Pen className="tw-size-3" />
                    </span>
                    <span>Composer</span>
                  </div>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TooltipProvider>
  );
};

export { ChatToolControls };
