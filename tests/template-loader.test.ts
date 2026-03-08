import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";
import { loadTemplate, validateTemplate } from "../src/templates/loader.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeConfig(): Config {
  return new Config({
    raw: {
      default_model: "test-model",
      models: {
        "test-model": {
          provider: "openai",
          model: "gpt-5",
          api_key: "dummy-key",
        },
      },
    },
  });
}

describe("template type validation", () => {
  it("rejects templates without type: agent", () => {
    const dir = makeTempDir("longeragent-template-type-missing-");
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
    const dir = makeTempDir("longeragent-template-type-invalid-");
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
    const dir = makeTempDir("longeragent-template-type-valid-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: good-template",
          "system_prompt: hello",
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

  it("rejects max_tool_rounds below 100", () => {
    const dir = makeTempDir("longeragent-template-rounds-low-");
    try {
      writeFileSync(
        join(dir, "agent.yaml"),
        [
          "type: agent",
          "name: bad-rounds",
          "system_prompt: hello",
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
