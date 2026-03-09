/**
 * Communication and orchestration tools.
 *
 * Tool definitions for the context-centric runtime.
 * Detailed usage guidance is in agent_templates/main/system_prompt.md.
 * Tool executors are created at runtime by Session.
 */

import type { ToolDef } from "../providers/base.js";

export const SPAWN_AGENT_TOOL: ToolDef = {
  name: "spawn_agent",
  description:
    "Spawn sub-agents from a YAML call file written to {SESSION_ARTIFACTS}. " +
    "Check pre-defined templates (e.g. 'explorer') before creating custom ones. " +
    "See system prompt for available templates and their capabilities.",
  parameters: {
    type: "object",
    properties: {
      file: {
        type: "string",
        description:
          "Filename of the YAML call file (relative to {SESSION_ARTIFACTS}).",
      },
    },
    required: ["file"],
  },
  summaryTemplate: "{agent} is spawning sub-agents",
};

export const KILL_AGENT_TOOL: ToolDef = {
  name: "kill_agent",
  description: "Kill one or more running sub-agents by ID.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the sub-agents to kill",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is killing sub-agents",
};

export const ASK_TOOL: ToolDef = {
  name: "ask",
  description:
    "Ask the user 1-4 structured questions with 1-4 options each.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array", minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            options: {
              type: "array", minItems: 1, maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  summaryTemplate: "{agent} is asking the user a question",
};

export const SHOW_CONTEXT_TOOL: ToolDef = {
  name: "show_context",
  description:
    "Display the context distribution of the current active window. " +
    "Returns a Context Map showing all context groups with their sizes and types. " +
    "Also causes detailed annotations to appear inline until the next summarize_context call or show_context(dismiss=true), " +
    "showing exactly what each context ID covers and the approximate size of each part.",
  parameters: {
    type: "object",
    properties: {
      dismiss: {
        type: "boolean",
        description:
          "If true, dismiss the currently active context annotations without showing new ones.",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is inspecting context",
};

export const SUMMARIZE_CONTEXT_TOOL: ToolDef = {
  name: "summarize_context",
  description:
    "Compress groups of spatially contiguous contexts into summaries. " +
    "If you need to inspect the current context distribution first, call show_context.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Each operation summarizes a group of contiguous context_ids.",
        items: {
          type: "object",
          properties: {
            context_ids: {
              type: "array",
              items: { type: "string" },
              description: "Spatially contiguous context IDs to merge.",
            },
            summary: {
              type: "string",
              description: "Summary preserving decisions, key facts, file paths, and unresolved issues. Match length to the information density of the original content.",
            },
            reason: {
              type: "string",
              description: "Brief reason for summarizing.",
            },
          },
          required: ["context_ids", "summary"],
        },
      },
      file: {
        type: "string",
        description: "Path to a .yaml file containing the operations. Resolved relative to session artifacts directory. Use this for complex multi-context summarizations.",
      },
    },
    required: [],
  },
  summaryTemplate: "{agent} is summarizing context",
};

export const CHECK_STATUS_TOOL: ToolDef = {
  name: "check_status",
  description:
    "Check for new messages, sub-agent status, and background shell status. " +
    "Returns user messages, system notifications, sub-agent reports, and tracked shell summaries.",
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is checking status",
};

export const BASH_BACKGROUND_TOOL: ToolDef = {
  name: "bash_background",
  description:
    "Start a background shell command tracked by the Session. " +
    "Use for dev servers, watchers, and long-running commands whose output you want to inspect later.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute in the background." },
      cwd: { type: "string", description: "Optional working directory for the command." },
      id: {
        type: "string",
        description: "Optional stable shell ID. If omitted, the Session generates one.",
      },
    },
    required: ["command"],
  },
  summaryTemplate: "{agent} is starting a background shell",
};

export const BASH_OUTPUT_TOOL: ToolDef = {
  name: "bash_output",
  description:
    "Read output from a tracked background shell. " +
    "By default, returns unread output since the last bash_output call for that shell. " +
    "Use tail_lines to inspect recent output without advancing the unread cursor.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Tracked shell ID." },
      tail_lines: {
        type: "integer",
        description: "Optional: return the last N lines without advancing unread state.",
      },
      max_chars: {
        type: "integer",
        description: "Optional max characters to return (default 8000).",
      },
    },
    required: ["id"],
  },
  summaryTemplate: "{agent} is reading background shell output",
};

export const KILL_SHELL_TOOL: ToolDef = {
  name: "kill_shell",
  description:
    "Terminate one or more tracked background shells. " +
    "Use when a watcher or dev server is no longer needed, or a command is stuck.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Tracked shell IDs to terminate.",
      },
      signal: {
        type: "string",
        description: "Optional signal name (default TERM).",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is terminating background shells",
};

export const WAIT_TOOL: ToolDef = {
  name: "wait",
  description:
    "Block until a tracked worker changes state, a new message arrives, or the timeout expires. " +
    "Tracked workers include sub-agents and background shells. Returns status report with any new messages. " +
    "Preferred over check_status when you have nothing else to do.",
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description:
          "How long to wait (minimum 15). " +
          "Without 'agent': wall-clock timeout. " +
          "With 'agent': that agent's actual work time.",
      },
      agent: {
        type: "string",
        description:
          "Optional agent ID. When set, 'seconds' tracks that agent's work time only.",
      },
      shell: {
        type: "string",
        description:
          "Optional shell ID. When set, wait monitors that background shell in addition to normal message delivery.",
      },
    },
    required: ["seconds"],
  },
  summaryTemplate: "{agent} is waiting",
};

export const PLAN_TOOL: ToolDef = {
  name: "plan",
  description:
    "Manage an execution plan with tracked checkpoints. " +
    "Submit a plan file, check off completed items, or finish the plan.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["submit", "check", "finish"],
        description:
          "Action to perform: 'submit' to activate a plan, 'check' to mark a checkpoint done, 'finish' to dismiss.",
      },
      file: {
        type: "string",
        description:
          "Path to the .md plan file (required for 'submit'). Resolved relative to session artifacts directory.",
      },
      item: {
        type: "number",
        description:
          "0-based index of the checkpoint to mark as done (required for 'check').",
      },
    },
    required: ["action"],
  },
  summaryTemplate: "{agent} is managing plan ({action})",
};
