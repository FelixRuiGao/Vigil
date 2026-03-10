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

    const opts = cmd!.options!({ session });
    const anthropic = opts.find((o) => o.value === "anthropic");
    const kimiGlobal = opts.find((o) => o.value === "kimi");
    const openai = opts.find((o) => o.value === "openai");

    expect(anthropic).toBeTruthy();
    expect(kimiGlobal).toBeTruthy();
    expect(openai).toBeTruthy();
    expect(anthropic!.children?.some((c) => c.label.includes("claude-haiku-4-5"))).toBe(true);
    expect(anthropic!.children?.some((c) => c.label.includes("claude-sonnet-4-6  (current)"))).toBe(true);
    expect(anthropic!.children?.some((c) => c.label.includes("claude-sonnet-4-6  (1M context beta)"))).toBe(true);
    expect(
      openai!.children?.some((c) => c.label.includes("gpt-5.2  (key missing: run longeragent init)")),
    ).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.1"))).toBe(false);
    expect(openai!.children?.some((c) => c.label.includes("gpt-4o"))).toBe(false);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.4"))).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.2-codex"))).toBe(true);
    expect(openai!.children?.some((c) => c.label.includes("gpt-5.3-codex"))).toBe(true);
  });

  it("groups OpenRouter models by vendor prefix into three-level hierarchy", () => {
    const registry = buildDefaultRegistry();
    const cmd = registry.lookup("/model");
    expect(cmd?.options).toBeTruthy();

    const session = {
      config: {
        modelNames: [],
        listModelEntries: () => [],
      },
      primaryAgent: {
        modelConfig: {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-anthropic",
        },
      },
    };

    const opts = cmd!.options!({ session });
    const openrouter = opts.find((o) => o.value === "openrouter");
    expect(openrouter).toBeTruthy();

    // OpenRouter children are now vendor sub-groups.
    const vendorAnthro = openrouter!.children?.find((c) => c.value === "openrouter-anthropic");
    const vendorOpenAI = openrouter!.children?.find((c) => c.value === "openrouter-openai");
    const vendorKimi = openrouter!.children?.find((c) => c.value === "openrouter-moonshotai");
    const vendorMiniMax = openrouter!.children?.find((c) => c.value === "openrouter-minimax");
    const vendorGLM = openrouter!.children?.find((c) => c.value === "openrouter-z-ai");

    expect(vendorAnthro).toBeTruthy();
    expect(vendorAnthro!.label).toBe("Anthropic");
    expect(vendorAnthro!.children?.some((c) => c.label.startsWith("openrouter/claude-haiku-4.5"))).toBe(true);
    expect(vendorAnthro!.children?.some((c) => c.label.includes("openrouter/claude-sonnet-4.6  (1M context)"))).toBe(true);

    expect(vendorOpenAI).toBeTruthy();
    expect(vendorOpenAI!.label).toBe("OpenAI");
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("openrouter/gpt-5.4"))).toBe(true);
    expect(vendorOpenAI!.children?.some((c) => c.label.startsWith("openrouter/gpt-5.3-codex"))).toBe(true);

    expect(vendorKimi).toBeTruthy();
    expect(vendorKimi!.label).toBe("Kimi");
    expect(vendorKimi!.children?.some((c) => c.label.startsWith("openrouter/kimi-k2.5"))).toBe(true);

    expect(vendorMiniMax).toBeTruthy();
    expect(vendorMiniMax!.label).toBe("MiniMax");
    expect(vendorMiniMax!.children?.some((c) => c.label.startsWith("openrouter/minimax-m2.1"))).toBe(true);

    expect(vendorGLM).toBeTruthy();
    expect(vendorGLM!.label).toBe("GLM / Zhipu");
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
    await cmd!.handler(ctx, "openai:gpt-5.4");

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
          model: "gpt-5.2-codex",
          contextLength: 400000,
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
    await cmd!.handler(ctx, "openai:gpt-5.2-codex key=sk-inline");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5-2-codex",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.2-codex",
        api_key: "sk-inline",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5-2-codex");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
    expect(ctx.resetUiState as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(ctx.autoSave as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
  });

  it("preserves preset-specific overrides for Anthropic 1M variants", async () => {
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
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "anthropic:claude-sonnet-4-6-1m key=sk-inline");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-anthropic-claude-sonnet-4-6-1m",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api_key: "sk-inline",
        context_length: 1_000_000,
        betas: ["context-1m-2025-08-07"],
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-anthropic-claude-sonnet-4-6-1m");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
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
            model: "gpt-5.2",
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
          model: "gpt-5.2-codex",
          contextLength: 400000,
          apiKey: "sk-openai",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openai:gpt-5.2-codex");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openai-gpt-5-2-codex",
      expect.objectContaining({
        provider: "openai",
        model: "gpt-5.2-codex",
        api_key: "${OPENAI_API_KEY}",
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openai-gpt-5-2-codex");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });

  it("maps OpenRouter Anthropic aliases to the official 1M preset config", async () => {
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
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4.6",
          contextLength: 1_000_000,
          apiKey: "sk-inline",
        };
      },
      resetForNewSession,
      primaryAgent: {
        modelConfig: {
          name: "my-openai",
          provider: "openai",
          model: "gpt-5.2",
          contextLength: 400000,
          apiKey: "sk-openai",
        },
      },
    };

    const ctx = makeContext(registry, session);
    await cmd!.handler(ctx, "openrouter:anthropic/claude-sonnet-4-6 key=sk-inline");

    expect(upsertModelRaw).toHaveBeenCalledWith(
      "runtime-openrouter-anthropic-claude-sonnet-4-6",
      expect.objectContaining({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        api_key: "sk-inline",
        context_length: 1_000_000,
      }),
    );
    expect(switchModel).toHaveBeenCalledWith("runtime-openrouter-anthropic-claude-sonnet-4-6");
    expect(resetForNewSession).toHaveBeenCalledTimes(1);
  });
});
