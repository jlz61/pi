import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SweBenchEvalSuite } from "../src/eval.ts";
import { NodeHarness } from "../src/node/harness.ts";
import { createBuiltinTools, createWorkspaceNavigationTools } from "../src/node/tools.ts";
import { TraceStore } from "../src/node/trace-store.ts";
import { PiRuntimeAdapterFactory } from "../src/runtime.ts";
import type { RuntimeAdapterFactory } from "../src/types.ts";
import {
	GitRepositoryCache,
	resolveSweBenchPython,
	SweBenchBridge,
	SweBenchRunner,
	type BridgeCases,
	type BridgeInspection,
	type SweBenchDataBridge,
} from "../src/swebench.ts";
import { fauxRuntime, tempDir } from "./helpers.ts";

describe("SWE-bench bridge", () => {
	it("honors Python executable precedence", () => {
		const cwd = tempDir("swebench-python-");
		mkdirSync(join(cwd, ".venv-swebench", "bin"), { recursive: true });
		writeFileSync(join(cwd, ".venv-swebench", "bin", "python"), "");
		expect(resolveSweBenchPython({ cwd, configValue: "config-python", env: {} })).toBe("config-python");
		expect(resolveSweBenchPython({ cwd, configValue: "config-python", env: { HARNESS_PYTHON: "env-python" } })).toBe(
			"env-python",
		);
		expect(
			resolveSweBenchPython({ cwd, cliValue: "cli-python", env: { HARNESS_PYTHON: "env-python" } }),
		).toBe("cli-python");
		expect(resolveSweBenchPython({ cwd, env: {} })).toBe(join(cwd, ".venv-swebench", "bin", "python"));
	});

	it("rejects invalid bridge JSON and times out", async () => {
		const root = tempDir("swebench-bridge-");
		const invalid = join(root, "invalid.js");
		writeFileSync(invalid, 'process.stdout.write("not-json");\n');
		await expect(new SweBenchBridge({ pythonExecutable: process.execPath, bridgePath: invalid }).inspect("case.parquet"))
			.rejects.toThrow("invalid JSON");

		const hanging = join(root, "hanging.js");
		writeFileSync(hanging, "setInterval(() => {}, 1000);\n");
		await expect(
			new SweBenchBridge({ pythonExecutable: process.execPath, bridgePath: hanging, timeoutMs: 25 }).inspect(
				"case.parquet",
			),
		).rejects.toThrow("timed out");
	});
});

describe("bounded workspace tools", () => {
	it("paginates reads and searches a single file", async () => {
		const root = tempDir("swebench-tools-");
		const path = join(root, "large.txt");
		writeFileSync(path, Array.from({ length: 500 }, (_, index) => `line-${index + 1}`).join("\n"));
		const readTool = createBuiltinTools(root).find((item) => item.tool.name === "read");
		const searchTool = createWorkspaceNavigationTools(root).find((item) => item.tool.name === "search");
		expect(readTool).toBeDefined();
		expect(searchTool).toBeDefined();
		const firstPage = await readTool!.tool.execute("read", { path: "large.txt" });
		const firstText = firstPage.content[0]?.type === "text" ? firstPage.content[0].text : "";
		expect(firstText).toContain("[lines 1-300 of 500]");
		expect(firstText).toContain("continue with offset=301");
		expect(firstText).not.toContain("line-500");
		const search = await searchTool!.tool.execute("search", { path: "large.txt", query: "line-499" });
		const searchText = search.content[0]?.type === "text" ? search.content[0].text : "";
		expect(searchText).toBe("large.txt:499:line-499");
	});

	it("reviews workspace changes without exposing shell execution", async () => {
		const root = tempDir("swebench-git-diff-");
		git(["init"], root);
		git(["config", "user.email", "test@example.com"], root);
		git(["config", "user.name", "Test"], root);
		writeFileSync(join(root, "source.py"), "old\n");
		git(["add", "source.py"], root);
		git(["commit", "-m", "base"], root);
		writeFileSync(join(root, "source.py"), "new\n");
		const tool = createWorkspaceNavigationTools(root).find((item) => item.tool.name === "git_diff");
		expect(tool).toBeDefined();
		const result = await tool!.tool.execute("git-diff", {});
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";
		expect(text).toContain("M source.py");
		expect(text).toContain("+new");
		expect(text).toContain("-old");
	});
});

describe("SWE-bench runner", () => {
	it("prepares a cached repository and exports a patch with locked permissions", async () => {
		const root = tempDir("swebench-runner-");
		const source = join(root, "source");
		mkdirSync(source);
		git(["init"], source);
		git(["config", "user.email", "test@example.com"], source);
		git(["config", "user.name", "Test"], source);
		writeFileSync(join(source, "target.txt"), "old\n");
		git(["add", "target.txt"], source);
		git(["commit", "-m", "base"], source);
		const baseCommit = git(["rev-parse", "HEAD"], source).trim();
		const datasetPath = join(root, "dev.parquet");
		writeFileSync(datasetPath, "fixture dataset identity");

		const bridge = new FakeBridge({
			instanceId: "owner__repo-1",
			repo: "owner/repo",
			baseCommit,
			problemStatement: "Change old to fixed",
			version: "1.0",
		});
		const runtime = fauxRuntime([
			fauxAssistantMessage(fauxToolCall("list", { path: ".", depth: 1 }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("search", { path: ".", query: "old" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("edit", { path: "target.txt", oldText: "old", newText: "fixed" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const delegate = new PiRuntimeAdapterFactory();
		let registeredToolNames: string[] = [];
		const runtimeFactory: RuntimeAdapterFactory = {
			create(options) {
				registeredToolNames = options.tools.map((tool) => tool.name);
				return delegate.create(options);
			},
		};
		const resultsDir = join(root, "results");
		let registeredSystemPrompt = "";
		const runner = new SweBenchRunner({
			resultsDir,
			bridge,
			modelName: "faux/faux",
			repositoryUrl: () => source,
			createHarness: (cwd, dataDir, options) => {
				registeredSystemPrompt = options.systemPrompt;
				return NodeHarness.create({
					cwd,
					dataDir,
					model: runtime.model,
					streamFn: runtime.streamFn,
					tools: options.tools,
					permissionRules: options.permissionRules,
					systemPrompt: options.systemPrompt,
					disabledBuiltinTools: options.disabledBuiltinTools,
					runtimeFactory,
				});
			},
		});
		const suite: SweBenchEvalSuite = {
			type: "swebench",
			name: "swebench-test",
			dataset: { path: datasetPath, split: "dev", instanceIds: ["owner__repo-1"] },
			timeoutMs: 10_000,
			maxTurns: 10,
			maxTokens: 20_000,
			maxCost: 1,
			tags: ["swebench"],
		};
		const report = await runner.run(suite);
		expect(report.metricKind).toBe("generation");
		expect(report.generationRate).toBe(1);
		expect(report.benchmark).toMatchObject({ gradingStatus: "not_run", resolutionRate: null });
		const caseDir = join(resultsDir, report.id, "owner__repo-1");
		expect(readFileSync(join(caseDir, "model.patch"), "utf8")).toContain("+fixed");
		const prediction = JSON.parse(readFileSync(join(caseDir, "prediction.json"), "utf8")) as {
			model_patch: string;
		};
		expect(prediction.model_patch).toContain("target.txt");
		expect(readFileSync(join(resultsDir, report.id, "predictions.jsonl"), "utf8")).toContain(
			'"instance_id":"owner__repo-1"',
		);
		const runId = report.cases[0]?.runId;
		expect(runId).toBeDefined();
		expect(registeredToolNames).toContain("list");
		expect(registeredToolNames).toContain("search");
		expect(registeredToolNames).toContain("git_diff");
		expect(registeredToolNames).not.toContain("exec");
		expect(registeredSystemPrompt).toContain("Preserve behavior outside that scope");
		expect(registeredSystemPrompt).toContain("do not modify them merely to make your change appear correct");
		const evalStore = new TraceStore(join(resultsDir, "eval.sqlite"));
		try {
			expect(evalStore.getEvalReport(report.id)).toMatchObject({
				metricKind: "generation",
				generationRate: 1,
				benchmark: { comparisonKey: report.benchmark?.comparisonKey },
				cases: [{ benchmark: { generationStatus: "generated" } }],
			});
		} finally {
			evalStore.close();
		}
	});

	it("reuses a mirror and checks out the requested commit", async () => {
		const root = tempDir("swebench-git-");
		const source = join(root, "source");
		mkdirSync(source);
		git(["init"], source);
		git(["config", "user.email", "test@example.com"], source);
		git(["config", "user.name", "Test"], source);
		writeFileSync(join(source, "value.txt"), "one\n");
		git(["add", "value.txt"], source);
		git(["commit", "-m", "one"], source);
		const first = git(["rev-parse", "HEAD"], source).trim();
		writeFileSync(join(source, "value.txt"), "two\n");
		git(["commit", "-am", "two"], source);
		const cache = new GitRepositoryCache({ root: join(root, "cache"), repositoryUrl: () => source });
		const firstWorkspace = join(root, "first");
		await cache.prepare("owner/repo", first, firstWorkspace);
		expect(readFileSync(join(firstWorkspace, "value.txt"), "utf8")).toBe("one\n");
		const secondWorkspace = join(root, "second");
		await cache.prepare("owner/repo", first, secondWorkspace);
		expect(readFileSync(join(secondWorkspace, "value.txt"), "utf8")).toBe("one\n");
	});
});

class FakeBridge implements SweBenchDataBridge {
	readonly pythonExecutable = "fake-python";
	private readonly item: BridgeCases["cases"][number];

	constructor(item: BridgeCases["cases"][number]) {
		this.item = item;
	}

	async inspect(): Promise<BridgeInspection> {
		return {
			bridgeVersion: "test",
			rowCount: 1,
			columns: ["instance_id", "repo", "base_commit", "problem_statement", "version"],
			instanceIds: [this.item.instanceId],
		};
	}

	async loadCases(_path: string, instanceIds: string[]): Promise<BridgeCases> {
		if (instanceIds.length !== 1 || instanceIds[0] !== this.item.instanceId) throw new Error("unknown case");
		return { bridgeVersion: "test", cases: [this.item] };
	}
}

function git(args: string[], cwd: string): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}
