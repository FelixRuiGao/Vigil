import { describe, expect, it, vi } from "vitest";
import { buildDefaultRegistry, type CommandContext } from "../src/commands.js";

function makeContext(
  registry: ReturnType<typeof buildDefaultRegistry>,
  session: Record<string, unknown>,
): CommandContext {
  return {
    session,
    showMessage: vi.fn(),
    autoSave: vi.fn(),
    resetUiState: vi.fn(),
    commandRegistry: registry,
  };
}

describe("/model command", () => {
  it("shows all preset models and marks models that require API key", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
        ]),
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!(session);
    const anthropic = opts.find((o) => o.value === "anthropic");
    const openai = opts.find((o) => o.value === "openai");

    expect(anthropic).toBeTruthy();
    expect(openai).toBeTruthy();
    expect(anthropic!.children?.some((c) => c.label.includes("claude-sonnet-4-6  (current)"))).toBe(true);
    expect(
      openai!.children?.some((c) => c.label.includes("gpt-5  (key missing: run longeragent init)")),
    ).toBe(true);
  });

  it("blocks switching to provider:model when provider API key is missing", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const switchModel = vi.fn();
    const session = {
      config: {
        modelNames: ["my-claude"],
        listModelEntries: () => ([
          {
            name: "my-claude",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            apiKeyRaw: "sk-anthropic",
            hasResolvedApiKey: true,
          },
        ]),
      },
      switchModel,
      resetForNewSession: vi.fn(),
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5");

    const rendered = (ctx.showMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(rendered).toContain("Missing API key for provider 'openai'");
    expect(switchModel).not.toHaveBeenCalled();
  });

  it("accepts inline API key and creates runtime model config", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5",
          contextLength: 272000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-claude",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 200000,
          apiKey: "sk-anthropic",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5 key=sk-inline");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
        api_key: "sk-inline",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
    expect(ctx.resetUiState as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(ctx.autoSave as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("reuses provider key from existing model when switching to another model in same provider", async () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd).toBeTruthy();

    const upsertModelRaw = vi.fn();
    const switchModel = vi.fn();
    const resetForNewSession = vi.fn();
    const session = {
      config: {
        modelNames: ["my-openai"],
        listModelEntries: () => ([
          {
            name: "my-openai",
            provider: "openai",
            model: "gpt-4o",
            apiKeyRaw: "${OPENAI_API_KEY}",
            hasResolvedApiKey: true,
          },
        ]),
        upsertModelRaw,
      },
      switchModel: (name: string) => {
        switchModel(name);
        (session.primaryAgent as any).modelConfig = {
          name,
          provider: "openai",
          model: "gpt-5",
          contextLength: 272000,
          apiKey: "sk-openai",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-4o",
          contextLength: 128000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5",
        api_key: "${OPENAI_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });
});
