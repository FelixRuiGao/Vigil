import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import type { Agent } from "../src/agents/agent.js";
import { Config } from "../src/config.js";
import { SubAgentFactory } from "../src/session/sub-agent-factory.js";
import { loadTemplate } from "../src/templates/loader.js";

function makeConfig(): Config {
  const cfg = new Config({});
  cfg.upsertModelRaw("test-model", {
    provider: "openai",
    model: "gpt-5.2",
    api_key: "dummy-key",
  });
  return cfg;
}

function makeFactory(cfg: Config, templates: Record<string, Agent>): SubAgentFactory {
  return new SubAgentFactory({
    getAgentTemplates: () => templates,
    getConfig: () => cfg,
    getMcpManager: () => undefined,
    getPromptsDirs: () => undefined,
    resolveSessionArtifacts: () => "/tmp/unused",
    getParentModelConfig: () => Object.values(templates)[0]!.modelConfig,
    resolvePinnedModel: () => {
      throw new Error("unused in this test");
    },
    resolveTierModel: () => {
      throw new Error("unused in this test");
    },
    appendStatus: () => {},
  });
}

describe("sub-agent tool/guideline alignment", () => {
  it("child prompt documents the post-constraint tool set, not the template's declared one", () => {
    const cfg = makeConfig();
    const workerDir = join(process.cwd(), "agent_templates", "worker");
    const templateAgent = loadTemplate(workerDir, cfg);

    // Load-time prompt is built from the declared tier (reversible), which
    // includes the background-shell tools the child never gets.
    expect(templateAgent.systemPrompt).toContain("## `bash_background`");

    const factory = makeFactory(cfg, { worker: templateAgent });
    const { agent } = factory.createFromPredefined("worker", "t1");

    // Constraints stripped the comm/background tools from the schema...
    const names = agent.tools.map((t) => t.name);
    expect(names).toContain("bash");
    expect(names).toContain("edit_file");
    expect(names).not.toContain("bash_background");
    expect(names).not.toContain("bash_output");
    expect(names).not.toContain("kill_shell");

    // ...and the reassembled prompt documents exactly what's left:
    expect(agent.systemPrompt).toContain("## `bash`");
    expect(agent.systemPrompt).toContain("## `edit_file`");
    expect(agent.systemPrompt).not.toContain("## `bash_background`");
    expect(agent.systemPrompt).not.toContain("## `bash_output`");
    expect(agent.systemPrompt).not.toContain("## `kill_shell`");

    // ...plus the comm tool the child session's capabilities grant later
    // (ensureCommTools adds await_event at child-session init).
    expect(agent.systemPrompt).toContain("## `await_event`");
    expect(names).not.toContain("await_event");
  });

  it("leaves the prompt alone for agents without a prompt recipe", () => {
    const cfg = makeConfig();
    const workerDir = join(process.cwd(), "agent_templates", "worker");
    const templateAgent = loadTemplate(workerDir, cfg);
    templateAgent.promptRecipe = undefined;
    const handWritten = "You are a hand-written agent.";
    templateAgent.systemPrompt = handWritten;

    const factory = makeFactory(cfg, { worker: templateAgent });
    const { agent } = factory.createFromPredefined("worker", "t2");

    expect(agent.systemPrompt).toBe(handWritten);
  });
});
