/** @jsxImportSource @opentui/react */

import React from "react";

import { createTextAttributes } from "@opentui/core";

// Side-effect import: registers the <fermiComposer> intrinsic element + JSX types.
import "../composer/composer-element.js";

const ATTRS_BOLD = createTextAttributes({ bold: true });
import type { FermiComposerRenderable } from "../composer/composer-renderable.js";
import type { ConversationPalette } from "../components/conversation-types.js";
import type { ActivityPhase } from "../display/types.js";
import { formatCompactTokensShort } from "../display/utils/format.js";
import { formatElapsed } from "../presentation/use-turn-timer.js";
import {
  useSpinner,
  WORKING_SPINNER_FRAMES,
  WORKING_SPINNER_INTERVAL,
  ASKING_SPINNER_FRAMES,
  ASKING_SPINNER_INTERVAL,
} from "../presentation/use-spinner.js";

/**
 * Text color per agent mode; also tints the input border. `default` is
 * deliberately absent — default mode renders exactly as before (dim border,
 * no mode label), keeping the common case zero-noise.
 */
const MODE_COLORS: Record<string, string> = {
  vibe: "#56B6C2",
  scale: "#b4a0ec",
  auto: "#D19A66",
};

function formatGoalElapsedShort(createdAt: number): string {
  const totalMin = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}m` : `${m}m`;
}

interface InputAreaProps {
  inputRef: React.RefObject<FermiComposerRenderable | null>;
  processing: boolean;
  pendingAsk: boolean;
  selectedChildId: string | null;
  hasQueuedUserInput?: boolean;
  phase: ActivityPhase;
  modelName: string;
  /** Thinking level suffix shown after the model name in dim color, e.g. "(high)". Empty string = hidden. */
  thinkingSuffix: string;
  modelColor: string;
  elapsed: number;
  cwd: string;
  permissionMode?: string;
  /** Agent mode; "default" renders nothing (zero-noise). */
  agentMode?: string;
  /** Open the /mode picker. */
  onModeClick?: () => void;
  /** Active goal creation timestamp; null/undefined = no goal indicator. */
  goalCreatedAt?: number | null;
  /** Open the /goal picker. */
  onGoalClick?: () => void;
  hint: string | null;
  contextTokens: number;
  contextLimit: number | undefined;
  cacheReadTokens: number;
  /**
   * Pre-formatted one-line usage indicator (e.g. "5h: 90% left | wk: 80% left"
   * or "month: 300/300 left"). When null, the indicator is hidden entirely.
   * Only shown when cwd + usage + context all fit inside contentWidth.
   */
  usageText: string | null;
  /** Width of the content column (terminal width minus screen padding). */
  contentWidth: number;
  colors: ConversationPalette;
  maxInputLines: number;
  onSubmit: () => void;
  onModelClick: () => void;
  onPermissionClick?: () => void;
  commandOverlayVisible: boolean;
  commandPicker: boolean;
  checkboxPicker: boolean;
  promptSelect: boolean;
  promptSecret: boolean;
  /** Number of running child agents. */
  runningAgentCount?: number;
  /** Number of idle child agents. */
  idleAgentCount?: number;
  /** Number of archived child agents. */
  archivedAgentCount?: number;
  /** Number of open (non-done) todo items. */
  todoOpenCount?: number;
  /** Number of done todo items. */
  todoDoneCount?: number;
  /** Whether the todo panel is currently expanded. */
  todoPanelOpen?: boolean;
  /** Toggle the todo panel. */
  onTodoClick?: () => void;
  /** Number of RUNNING background shells (async only — sync bash never shows here). */
  shellRunningCount?: number;
  /** Open the shells picker. */
  onShellsClick?: () => void;
  /** Whether the agents panel is currently expanded. */
  agentsPanelOpen?: boolean;
  /** Toggle the agents panel. */
  onAgentsPanelClick?: () => void;
}

function getPhaseSpinnerConfig(phase: ActivityPhase): { frames: readonly string[]; interval: number } {
  if (phase === "Asking") return { frames: ASKING_SPINNER_FRAMES, interval: ASKING_SPINNER_INTERVAL };
  return { frames: WORKING_SPINNER_FRAMES, interval: WORKING_SPINNER_INTERVAL };
}

function getPhaseColor(phase: ActivityPhase, colors: ConversationPalette): string {
  if (phase === "Asking") return colors.dim;
  return "#56B6C2";
}

/**
 * Decide whether the usage indicator fits on the bottom row alongside cwd
 * and context. `hint` is NOT reserved — it has flexShrink={1} + truncate,
 * so it collapses to whatever space is left. If the fixed-shrink parts
 * (cwd + usage + context + separators) fit inside contentWidth, we show
 * the usage indicator; otherwise it's hidden entirely.
 */
function shouldShowUsage(
  contentWidth: number,
  cwdLen: number,
  usageLen: number,
  contextLen: number,
): boolean {
  const inner = contentWidth - 2; // paddingLeft=1 + paddingRight=1
  const fixedWidth = cwdLen + usageLen + contextLen + 4; // "  " × 2 separators
  return inner >= fixedWidth;
}

function InputAreaInner(props: InputAreaProps): React.ReactNode {
  const {
    inputRef,
    processing,
    pendingAsk,
    selectedChildId,
    hasQueuedUserInput = false,
    phase,
    modelName,
    modelColor,
    elapsed,
    cwd,
    permissionMode,
    agentMode,
    onModeClick,
    goalCreatedAt,
    onGoalClick,
    hint,
    contextTokens,
    contextLimit,
    cacheReadTokens,
    usageText,
    contentWidth,
    colors,
    maxInputLines,
    onSubmit,
    onModelClick,
    onPermissionClick,
    commandOverlayVisible,
    commandPicker,
    checkboxPicker,
    promptSelect,
    promptSecret,
    runningAgentCount = 0,
    idleAgentCount = 0,
    archivedAgentCount = 0,
    todoOpenCount = 0,
    todoDoneCount = 0,
    todoPanelOpen = false,
    onTodoClick,
    agentsPanelOpen = false,
    onAgentsPanelClick,
    shellRunningCount = 0,
    onShellsClick,
  } = props;

  const placeholder = pendingAsk
    ? "ask pending..."
    : selectedChildId
      ? "Esc/^C close or interrupt · Opt+←→ switch tabs · Opt+↑ main"
      : hasQueuedUserInput
        ? "↑ to edit the queued message"
        : "message or /command";

  const focused = phase !== "closing" && !pendingAsk && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !selectedChildId;

  const spinnerConfig = getPhaseSpinnerConfig(phase);
  const activeSpinner = useSpinner(spinnerConfig.frames, spinnerConfig.interval, processing);
  const phaseColor = getPhaseColor(phase, colors);

  const cacheLabel = cacheReadTokens > 0 ? ` (${formatCompactTokensShort(cacheReadTokens)} cached)` : "";
  const contextText = contextLimit
    ? `${formatCompactTokensShort(contextTokens)}/${formatCompactTokensShort(contextLimit)}${cacheLabel}`
    : `${formatCompactTokensShort(contextTokens)}${cacheLabel}`;

  // Mode tint: non-default modes color the border and their bottom-row label.
  // Default keeps the dim border, and its label falls back to the normal text
  // color — readable, but the absence of a tint is itself the "no special
  // mode" signal (the dim gray is reserved for the keyboard-hint suffixes).
  const modeColor = agentMode ? MODE_COLORS[agentMode] : undefined;

  const permissionColor = permissionMode === "yolo"
    ? colors.red
    : permissionMode === "read_only" ? "#2dd4a8" : colors.accent;
  const permissionLabel = permissionMode === "yolo"
    ? "Full auto"
    : permissionMode === "read_only" ? "Read-only" : "Reversible";
  // Fixed-width estimate of the bottom-left cluster for the usage-fits check:
  // permission + " (Shift+Tab)" + " · " + mode + " (Tab)" (+ goal segment).
  const bottomLeftLen =
    permissionLabel.length + 12 +
    (agentMode ? agentMode.length + 3 + 6 : 0) +
    (goalCreatedAt ? formatGoalElapsedShort(goalCreatedAt).length + 8 : 0);

  return (
    <box flexDirection="column" gap={0} flexShrink={0}>
      {/* Top row: activity indicator (left) + agent indicator (center) + model name (right) */}
      <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
        {processing ? (
          <box flexDirection="row" flexShrink={0}>
            <text fg={phaseColor} content={`${activeSpinner} ${phase}`} />
            {elapsed > 0 ? (
              <text fg={colors.dim} content={` ${formatElapsed(elapsed)}`} />
            ) : null}
          </box>
        ) : null}

        {/* Agent indicator: show whenever agents exist */}
        {(runningAgentCount + idleAgentCount + archivedAgentCount) > 0 && !selectedChildId ? (
          <>
          {processing ? <box width={2} /> : null}
          <box
            flexDirection="row"
            flexShrink={0}
            cursor="pointer"
            backgroundColor={agentsPanelOpen ? "#3a3058" : "#2a2640"}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onAgentsPanelClick?.(); }}
          >
            <text fg="#b4a0ec" content={(() => {
              const parts: string[] = [];
              if (runningAgentCount > 0) parts.push(`${runningAgentCount} running`);
              const doneAgents = idleAgentCount + archivedAgentCount;
              if (doneAgents > 0) parts.push(`${doneAgents} done`);
              return ` Agents (${parts.join(", ")}) `;
            })()} />
          </box>
          </>
        ) : null}

        {/* Shells indicator: running background shells only (sync bash never appears here) */}
        {shellRunningCount > 0 && !selectedChildId ? (
          <>
          {((runningAgentCount + idleAgentCount + archivedAgentCount) > 0 || processing) ? <box width={1} /> : null}
          <box
            flexDirection="row"
            flexShrink={0}
            cursor="pointer"
            backgroundColor="#1a3325"
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onShellsClick?.(); }}
          >
            <text fg="#8fd9a8" content={` Shells (${shellRunningCount} running) `} />
          </box>
          </>
        ) : null}

        {/* Todo indicator: show whenever checkpoints exist */}
        {(todoOpenCount + todoDoneCount) > 0 && !selectedChildId ? (
          <>
          {((runningAgentCount + idleAgentCount + archivedAgentCount) > 0 || shellRunningCount > 0 || processing) ? <box width={1} /> : null}
          <box
            flexDirection="row"
            flexShrink={0}
            cursor="pointer"
            backgroundColor={todoPanelOpen ? "#1a3838" : "#1a2a2e"}
            onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onTodoClick?.(); }}
          >
            <text fg="#86ded4" content={(() => {
              const parts: string[] = [];
              if (todoOpenCount > 0) parts.push(`${todoOpenCount} pending`);
              if (todoDoneCount > 0) parts.push(`${todoDoneCount} done`);
              return ` Todos (${parts.join(", ")}) `;
            })()} />
          </box>
          </>
        ) : null}

        <box flexGrow={1} />
        <box
          flexDirection="row"
          flexShrink={0}
          cursor="pointer"
          onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModelClick(); }}
        >
          <text fg={modelColor} content={modelName} />
          {props.thinkingSuffix ? (
            <text fg={colors.dim} content={` ${props.thinkingSuffix}`} />
          ) : null}
        </box>
      </box>

      {/* Input box with round border.
          paddingRight reserves one cell for the cursor's "next position"
          past the last character — without it, long lines push the cursor
          onto the right border before the textarea wraps. */}
      <box
        flexDirection="row"
        width="100%"
        flexShrink={0}
        border={true}
        borderStyle="rounded"
        borderColor={modeColor ?? colors.dim}
        paddingRight={1}
      >
        <text fg="#d4d4d4" attributes={ATTRS_BOLD} content="❯ " flexShrink={0} />
        <fermiComposer
          ref={(node: any) => {
            (inputRef as any).current = node;
            // The reconciler's setProperty special-cases the name "onSubmit"
            // for native classes and silently drops it for custom ones (only
            // the constructor options would see it, freezing the mount-time
            // closure). Wiring through the inline ref keeps it fresh: the
            // callback identity changes every render, so React re-runs it.
            if (node) node.onSubmit = onSubmit;
          }}
          focused={focused}
          placeholder={placeholder}
          textColor={selectedChildId ? colors.muted : colors.text}
          placeholderColor={colors.muted}
          tokenColor={colors.accent}
          cursorColor="#ffffff"
          flexGrow={1}
          minHeight={1}
          maxHeight={maxInputLines}
          maxLines={maxInputLines}
        />
      </box>

      {/* Bottom row: permission/hint (left, mutually exclusive) + usage + context (right) */}
      {!commandOverlayVisible && !commandPicker && !checkboxPicker && !promptSelect && !promptSecret && !pendingAsk ? (
        <box flexDirection="row" width="100%" paddingLeft={1} paddingRight={1}>
          <box
            flexDirection="row"
            flexShrink={1}
            flexGrow={0}
            cursor={!hint && onPermissionClick ? "pointer" : undefined}
            onMouseDown={!hint && onPermissionClick ? (e: any) => { e.stopPropagation(); e.preventDefault(); onPermissionClick(); } : undefined}
          >
            {hint ? (
              <text fg={colors.dim} content={hint} truncate />
            ) : (
              <>
                <text fg={permissionColor} content={permissionLabel} />
                <text fg={colors.dim} content=" (Shift+Tab)" />
              </>
            )}
          </box>
          {!hint && agentMode ? (
            <box
              flexDirection="row"
              flexShrink={0}
              cursor="pointer"
              onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onModeClick?.(); }}
            >
              <text fg={colors.dim} content=" · " />
              <text fg={modeColor ?? colors.text} content={agentMode} />
              <text fg={colors.dim} content=" (Tab)" />
            </box>
          ) : null}
          {!hint && goalCreatedAt ? (
            <box
              flexShrink={0}
              cursor="pointer"
              onMouseDown={(e: any) => { e.stopPropagation(); e.preventDefault(); onGoalClick?.(); }}
            >
              <text fg={colors.dim} content={` · goal ${formatGoalElapsedShort(goalCreatedAt)}`} />
            </box>
          ) : null}
          <box flexGrow={1} />
          {usageText && shouldShowUsage(contentWidth, bottomLeftLen, usageText.length, contextText.length) ? (
            <text fg={colors.dim} content={`  ${usageText}`} flexShrink={0} />
          ) : null}
          <text fg={colors.dim} content={`  ${contextText}`} flexShrink={0} />
        </box>
      ) : null}
    </box>
  );
}

export const InputArea = React.memo(InputAreaInner);
