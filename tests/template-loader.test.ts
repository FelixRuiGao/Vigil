import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { Config } from "../src/config.js";
import { loadTemplate, validateTemplate } from "../src/templates/loader.js";
import { buildToolGuidelinesSection } from "../src/tools/tool-docs.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfig(): Config {
  const cfg = new Config({});
  cfg.upsertModelRaw("test-model", {
    provider: "openai",
    model: "gpt-5.2",
    api_key: "dummy-key",
  });
  return cfg;
}

describe("template type validation", () => {
  it("documents autonomous summarize user-message restrictions in the main agent's prompt", () => {
    // What the model actually sees: the generated summarize_context guide
    // plus main's hand-written policy file.
    const guide = buildToolGuidelinesSection(["summarize_context"]);
    const policy = readFileSync(
      join(process.cwd(), "agent_templates", "main", "policy.md"),
      "utf-8",
    );
    const combined = guide + "\n\n" + policy;

    expect(combined).toContain("Never summarize context groups that contain the user's own messages.");
    expect(combined).toContain("never summarize ranges that contain the user's own messages on your own initiative");
    expect(combined).toContain("<user-message>");
    expect(combined).not.toContain("<summarize-request>");
    expect(combined).not.toContain("user-requested mode");
    expect(combined).toContain("`summarize_context`");
  });

  it("rejects templates without type: agent", () => {
    const dir = makeTempDir("fermi-template-type-missing-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "name: bad-template",
          "system_prompt: hello",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toContain("type: agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects templates with non-agent type", () => {
    const dir = makeTempDir("fermi-template-type-invalid-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: worker",
          "name: bad-template",
          "system_prompt: hello",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toContain("Invalid template type");
      expect(err).toContain("agent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts valid type and can load the template", () => {
    const dir = makeTempDir("fermi-template-type-valid-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: good-template",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );

      expect(validateTemplate(dir)).toBeNull();
      const agent = loadTemplate(dir, makeConfig());
      expect(agent.name).toBe("good-template");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses fallbackModel only when a template has no explicit model", () => {
    const dir = makeTempDir("fermi-template-fallback-model-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: fallback-template",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );
      const cfg = makeConfig();
      cfg.upsertModelRaw("fallback-model", {
        provider: "deepseek",
        model: "deepseek-chat",
        api_key: "fallback-key",
      });

      const agent = loadTemplate(dir, cfg, undefined, undefined, undefined, "fallback-model");
      expect(agent.modelConfig.name).toBe("fallback-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps an explicit template model ahead of fallbackModel", () => {
    const dir = makeTempDir("fermi-template-explicit-model-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: explicit-template",
          "model: test-model",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 100",
          "",
        ].join("\n"),
        "utf-8",
      );
      const cfg = makeConfig();
      cfg.upsertModelRaw("fallback-model", {
        provider: "deepseek",
        model: "deepseek-chat",
        api_key: "fallback-key",
      });

      const agent = loadTemplate(dir, cfg, undefined, undefined, undefined, "fallback-model");
      expect(agent.modelConfig.name).toBe("test-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects max_tool_rounds below 100", () => {
    const dir = makeTempDir("fermi-template-rounds-low-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: bad-rounds",
          "system_prompt: hello",
          "tool_tier: read_only",
          "max_tool_rounds: 15",
          "",
        ].join("\n"),
        "utf-8",
      );

      const err = validateTemplate(dir);
      expect(err).toContain("max_tool_rounds");
      expect(err).toContain(">= 100");
      expect(() => loadTemplate(dir, makeConfig())).toThrow(/max_tool_rounds/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
