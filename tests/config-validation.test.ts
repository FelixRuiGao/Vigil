import { describe, expect, it } from "vitest";

import { Config } from "../src/config.js";

describe("Config model validation", () => {
  it("throws a clear error when provider is missing", () => {
    const cfg = new Config({
      raw: {
        models: {
          bad: {
            model: "gpt-5",
            api_key: "sk-test",
          },
        },
      },
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'provider'",
    );
  });

  it("throws a clear error when model is missing", () => {
    const cfg = new Config({
      raw: {
        models: {
          bad: {
            provider: "openai",
            api_key: "sk-test",
          },
        },
      },
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'model'",
    );
  });

  it("throws a clear error when api_key is missing or empty", () => {
    const cfg = new Config({
      raw: {
        models: {
          bad: {
            provider: "openai",
            model: "gpt-5",
            api_key: "",
          },
        },
      },
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': missing required string field 'api_key'",
    );
  });

  it("throws a typed error for invalid optional numeric fields", () => {
    const cfg = new Config({
      raw: {
        models: {
          bad: {
            provider: "openai",
            model: "gpt-5",
            api_key: "sk-test",
            temperature: "hot",
          },
        },
      },
    });

    expect(() => cfg.getModel("bad")).toThrowError(
      "Invalid model config 'bad': field 'temperature' must be a number",
    );
  });
});

