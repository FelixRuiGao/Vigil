import { describe, expect, it } from "bun:test";

import { BASIC_TOOLS } from "../src/tools/basic.js";
import {
  SPAWN_TOOL,
  KILL_AGENT_TOOL,
  CHECK_STATUS_TOOL,
  AWAIT_EVENT_TOOL,
  SHOW_CONTEXT_TOOL,
  SUMMARIZE_CONTEXT_TOOL,
  ASK_TOOL,
  SEND_TOOL,
  RELOAD_TOOL,
} from "../src/tools/comm.js";
import {
  TOOL_DOCS,
  TOOL_GUIDELINE_ORDER,
  buildToolGuidelinesSection,
  parseToolDoc,
  toolBrief,
} from "../src/tools/tool-docs.js";
import {
  buildSkillToolDef,
  buildSkillsSection,
  commToolNamesForCapabilities,
} from "../src/tool-runtime.js";
import {
  ROOT_SESSION_CAPABILITIES,
  CHILD_SESSION_CAPABILITIES,
} from "../src/session-capabilities.js";
import type { SkillMeta } from "../src/skills/loader.js";

const PROMPT_VARIABLES = [
  "{PROJECT_ROOT}",
  "{SESSION_ARTIFACTS}",
  "{SYSTEM_DATA}",
  "{SHELL_NOTES}",
  "{INITIAL_MODEL}",
  "{SESSION_STARTED}",
];

function makeSkill(name: string, opts?: Partial<SkillMeta>): SkillMeta {
  return {
    name,
    description: `${name} description`,
    disableModelInvocation: false,
    userInvocable: true,
    dir: `/tmp/skills/${name}`,
    contentRaw: "body",
    ...opts,
  } as SkillMeta;
}

describe("tool docs", () => {
  it("every ordered tool has a doc with a non-empty brief", () => {
    for (const name of TOOL_GUIDELINE_ORDER) {
      expect(TOOL_DOCS[name], `missing doc for ${name}`).toBeDefined();
      expect(TOOL_DOCS[name]!.brief.length, `empty brief for ${name}`).toBeGreaterThan(0);
    }
  });

  it("briefs never contain prompt template variables (descriptions are not variable-rendered)", () => {
    for (const [name, doc] of Object.entries(TOOL_DOCS)) {
      for (const variable of PROMPT_VARIABLES) {
        expect(doc.brief.includes(variable), `${name} brief contains ${variable}`).toBe(false);
      }
    }
  });

  it("ToolDef descriptions are wired to the briefs", () => {
    for (const tool of BASIC_TOOLS) {
      if (tool.name === "bash") {
        // bash prepends a runtime shell-kind prefix to its brief.
        expect(tool.description.startsWith("Shell: ")).toBe(true);
        expect(tool.description).toContain(toolBrief("bash"));
        continue;
      }
      expect(tool.description).toBe(toolBrief(tool.name));
    }
    for (const tool of [
      SPAWN_TOOL, KILL_AGENT_TOOL, CHECK_STATUS_TOOL, AWAIT_EVENT_TOOL,
      SHOW_CONTEXT_TOOL, SUMMARIZE_CONTEXT_TOOL, ASK_TOOL, SEND_TOOL, RELOAD_TOOL,
    ]) {
      expect(tool.description).toBe(toolBrief(tool.name));
    }
  });

  it("parseToolDoc splits brief and guide", () => {
    const doc = parseToolDoc("<!-- brief -->\nBrief text.\n\n<!-- guide -->\nGuide text.\n");
    expect(doc.brief).toBe("Brief text.");
    expect(doc.guide).toBe("Guide text.");
  });

  it("parseToolDoc handles a missing guide segment", () => {
    const doc = parseToolDoc("<!-- brief -->\nBrief only.\n");
    expect(doc.brief).toBe("Brief only.");
    expect(doc.guide).toBe("");
  });

  it("buildToolGuidelinesSection includes only requested tools, in canonical order", () => {
    const section = buildToolGuidelinesSection(["grep", "read_file", "bash"]);
    expect(section.startsWith("# Tools\n\n")).toBe(true);
    const readIdx = section.indexOf("## `read_file`");
    const grepIdx = section.indexOf("## `grep`");
    const bashIdx = section.indexOf("## `bash`");
    expect(readIdx).toBeGreaterThan(-1);
    expect(grepIdx).toBeGreaterThan(readIdx);
    expect(bashIdx).toBeGreaterThan(grepIdx);
    expect(section.includes("## `spawn`")).toBe(false);
    expect(section.includes("## `write_file`")).toBe(false);
  });

  it("buildToolGuidelinesSection is deterministic and skips unknown/guideless tools", () => {
    const a = buildToolGuidelinesSection(["bash", "read_file", "mcp__srv__tool", "send"]);
    const b = buildToolGuidelinesSection(["read_file", "send", "mcp__srv__tool", "bash"]);
    expect(a).toBe(b);
    // send has an empty guide; MCP tools have no docs — neither appears.
    expect(a.includes("mcp__srv__tool")).toBe(false);
    expect(a.includes("## `send`")).toBe(false);
  });

  it("buildToolGuidelinesSection returns empty for no applicable tools", () => {
    expect(buildToolGuidelinesSection([])).toBe("");
    expect(buildToolGuidelinesSection(["mcp__srv__tool"])).toBe("");
  });
});

describe("skill tool and skills section", () => {
  it("skill tool description is static — no skill listing embedded", () => {
    const skills = new Map<string, SkillMeta>([
      ["alpha", makeSkill("alpha")],
      ["beta", makeSkill("beta")],
    ]);
    const def = buildSkillToolDef(skills);
    expect(def).not.toBeNull();
    expect(def!.description).toBe(toolBrief("skill"));
    expect(def!.description.includes("alpha")).toBe(false);
    // Adding a skill must not change the tool schema.
    skills.set("gamma", makeSkill("gamma"));
    const def2 = buildSkillToolDef(skills);
    expect(def2!.description).toBe(def!.description);
  });

  it("buildSkillToolDef still returns null with no model-invocable skills", () => {
    expect(buildSkillToolDef(new Map())).toBeNull();
    const onlyUser = new Map([["u", makeSkill("u", { disableModelInvocation: true })]]);
    expect(buildSkillToolDef(onlyUser)).toBeNull();
  });

  it("buildSkillsSection lists model-invocable skills and omits user-only ones", () => {
    const skills = new Map<string, SkillMeta>([
      ["alpha", makeSkill("alpha")],
      ["hidden", makeSkill("hidden", { disableModelInvocation: true })],
    ]);
    const section = buildSkillsSection(skills);
    expect(section.startsWith("# Available Skills")).toBe(true);
    expect(section).toContain("- alpha: alpha description");
    expect(section.includes("hidden")).toBe(false);
  });

  it("buildSkillsSection is empty with no skills", () => {
    expect(buildSkillsSection(new Map())).toBe("");
  });
});

describe("commToolNamesForCapabilities", () => {
  it("maps root capabilities to the full comm tool set", () => {
    const names = commToolNamesForCapabilities(ROOT_SESSION_CAPABILITIES);
    expect(names).toContain("spawn");
    expect(names).toContain("send");
    expect(names).toContain("summarize_context");
    expect(names).toContain("ask");
    expect(names).toContain("reload");
    expect(names).toContain("skill");
  });

  it("maps child capabilities to await_event only", () => {
    const names = commToolNamesForCapabilities(CHILD_SESSION_CAPABILITIES);
    expect(names).toEqual(["await_event"]);
  });
});
