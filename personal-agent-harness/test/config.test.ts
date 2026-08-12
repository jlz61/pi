import { describe, expect, it } from "vitest";
import { parseHarnessConfig, resolveModelSelection } from "../src/node/config.ts";

describe("Harness config", () => {
	it("validates a strict config", () => {
		expect(
			parseHarnessConfig({
				provider: "deepseek",
				model: "deepseek-v4-pro",
				network: { proxy: "auto", connectTimeoutMs: 20_000 },
				swebench: {
					pythonExecutable: ".venv-swebench/bin/python",
					graderPythonExecutable: ".venv-swebench-grader/bin/python",
				},
			}),
		).toMatchObject({ provider: "deepseek", network: { proxy: "auto" } });
	});

	it("rejects unknown fields and credentials", () => {
		expect(() => parseHarnessConfig({ provider: "deepseek", apiKey: "secret" })).toThrow(/apiKey|property/u);
	});

	it("uses CLI, then environment, then file precedence", () => {
		const config = { provider: "file-provider", model: "file-model" };
		expect(resolveModelSelection(config, {}, { HARNESS_PROVIDER: "env-provider", HARNESS_MODEL: "env-model" })).toEqual({
			provider: "env-provider",
			modelId: "env-model",
		});
		expect(
			resolveModelSelection(
				config,
				{ provider: "cli-provider", model: "cli-model" },
				{ HARNESS_PROVIDER: "env-provider", HARNESS_MODEL: "env-model" },
			),
		).toEqual({ provider: "cli-provider", modelId: "cli-model" });
	});
});
