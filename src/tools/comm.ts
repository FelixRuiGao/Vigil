/**
 * Communication and orchestration tools.
 *
 * Tool definitions for the context-centric runtime.
 * Detailed usage guidance is in agent_templates/main/system_prompt.md.
 * Tool executors are created at runtime by Session.
 */

import type { ToolDef } from "../providers/base.js";
import { toolBrief } from "./tool-docs.js";

export const SPAWN_TOOL: ToolDef = {
  name: "spawn",
  description: toolBrief("spawn"),
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique agent ID.",
      },
      template: {
        type: "string",
        description: "Pre-defined template name, e.g. 'explorer', 'reviewer'.",
      },
      template_path: {
        type: "string",
        description: "Path to a custom template directory relative to {SESSION_ARTIFACTS}.",
      },
      task: {
        type: "string",
        description: "Task description for the agent.",
      },
      mode: {
        type: "string",
        enum: ["oneshot", "persistent"],
        description: "Agent mode: 'oneshot' (single turn) or 'persistent' (stays alive, receives messages via send).",
      },
      model_level: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Model tier for this sub-agent. If omitted, the sub-agent inherits the parent model. Tiers must be configured by the user.",
      },
    },
    required: ["id", "task", "mode"],
  },
  summaryTemplate: "{agent} is spawning sub-agent {id}",
  tuiPolicy: { partialReveal: { completeArgs: ["id"] } },
};

export const KILL_AGENT_TOOL: ToolDef = {
  name: "kill_agent",
  description: toolBrief("kill_agent"),
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "IDs of the sub-agents to kill.",
      },
    },
    required: ["ids"],
  },
  summaryTemplate: "{agent} is killing sub-agents",
  tuiPolicy: { partialReveal: "closed" },
};

export const ASK_TOOL: ToolDef = {
  name: "ask",
  description: toolBrief("ask"),
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
  tuiPolicy: { partialReveal: "closed" },
};

export const SHOW_CONTEXT_TOOL: ToolDef = {
  name: "show_context",
  description: toolBrief("show_context"),
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  summaryTemplate: "{agent} is inspecting context",
  tuiPolicy: { partialReveal: "immediate" },
};

export const SUMMARIZE_CONTEXT_TOOL: ToolDef = {
  name: "summarize_context",
  description: toolBrief("summarize_context"),
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Each operation summarizes a contiguous range of context groups into a preserved summary.",
        items: {
          type: "object",
          properties: {
            from: {
              type: "string",
              description: "Start context ID of the range (inclusive).",
            },
            to: {
              type: "string",
              description: "End context ID of the range (inclusive). Same as `from` for a single group.",
            },
            content: {
              type: "string",
              description: "Summary content preserving decisions, key facts, file paths, code references, and unresolved issues. Length should match the information density of the original — preserve everything you'd look back at.",
            },
            reason: {
              type: "string",
              description: "Brief reason for summarizing this group.",
            },
          },
          required: ["from", "to", "content"],
        },
      },
    },
    required: ["operations"],
  },
  summaryTemplate: "{agent} is summarizing context",
  tuiPolicy: { partialReveal: "immediate" },
};

export const CHECK_STATUS_TOOL: ToolDef = {
  name: "check_status",
  description: toolBrief("check_status"),
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is checking status",
  tuiPolicy: { partialReveal: "immediate" },
};

export const AWAIT_EVENT_TOOL: ToolDef = {
  name: "await_event",
  description: toolBrief("await_event"),
  parameters: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "How long to await runtime events (minimum 10, wall-clock timeout).",
      },
    },
    required: ["seconds"],
  },
  summaryTemplate: "{agent} is awaiting runtime events",
  tuiPolicy: { partialReveal: { completeArgs: ["seconds"] } },
};

export const SEND_TOOL: ToolDef = {
  name: "send",
  description: toolBrief("send"),
  parameters: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Target child agent ID.",
      },
      content: {
        type: "string",
        description: "Message content.",
      },
    },
    required: ["to", "content"],
  },
  summaryTemplate: "{agent} sent message to {to}",
  tuiPolicy: { partialReveal: { completeArgs: ["to"] } },
};

export const RELOAD_TOOL: ToolDef = {
  name: "reload",
  description: toolBrief("reload"),
  parameters: {
    type: "object",
    properties: {},
  },
  summaryTemplate: "{agent} is reloading configuration",
  tuiPolicy: { partialReveal: "immediate" },
};
