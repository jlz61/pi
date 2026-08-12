import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	compareEvalReports,
	EvalRunner,
	readEvalSuite,
	type EvalReport,
	type EvalSuite,
} from "../src/eval.ts";
import { NodeHarness } from "../src/node/harness.ts";
import { fauxRuntime, tempDir } from "./helpers.ts";

describe("EvalRunner", () => {
	it("isolates and grades ten coding fixtures", async () => {
		const root = tempDir("harness-eval-");
		const suite: EvalSuite = {
			name: "ten-case-smoke",
			cases: Array.from({ length: 10 }, (_, index) => ({
				id: `case-${index + 1}`,
				input: "create output.txt",
				timeoutMs: 5_000,
				tags: ["smoke"],
				graders: [
					{ type: "file" as const, path: "output.txt", contains: "ok" },
					{ type: "command" as const, command: "test -f output.txt" },
					{ type: "trace" as const, toolCalled: "write", maxTurns: 2 },
				],
			})),
		};
		const runner = new EvalRunner({
			resultsDir: join(root, "results"),
			createHarness: async (cwd, dataDir) => {
				const runtime = fauxRuntime([
					fauxAssistantMessage(fauxToolCall("write", { path: "output.txt", content: "ok" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				]);
				return NodeHarness.create({
					cwd,
					dataDir,
					model: runtime.model,
					streamFn: runtime.streamFn,
					permissionRules: [{ tool: "write", resource: "*", action: "allow" }],
				});
			},
		});
		const report = await runner.run(suite);
		expect(report.cases).toHaveLength(10);
		expect(report.successRate).toBe(1);
		expect(report.cases.every((result) => result.workspaceChanges.added.includes("output.txt"))).toBe(true);
	});

	it("reports per-case regressions", () => {
		const base = report("base", true);
		const candidate = report("candidate", false);
		const comparison = compareEvalReports(base, candidate);
		expect(comparison.successRateDelta).toBe(-1);
		expect(comparison.regressions).toEqual(["case: pass -> fail"]);
	});

	it("loads a strict SWE-bench suite and resolves its Parquet path", async () => {
		const root = tempDir("harness-swebench-suite-");
		const path = join(root, "suite.json");
		writeFileSync(
			path,
			JSON.stringify({
				type: "swebench",
				name: "lite",
				dataset: { path: "dev.parquet", split: "dev", instanceIds: ["owner__repo-1"] },
				timeoutMs: 1,
				maxTurns: 1,
				maxTokens: 1,
				maxCost: 1,
				tags: ["lite"],
			}),
		);
		const suite = await readEvalSuite(path);
		expect(suite.type).toBe("swebench");
		if (suite.type === "swebench") expect(suite.dataset.path).toBe(join(root, "dev.parquet"));
		writeFileSync(path, JSON.stringify({ type: "swebench", name: "lite", dataset: {}, unknown: true }));
		await expect(readEvalSuite(path)).rejects.toThrow("unknown fields");
	});

	it("allows SWE-bench suites to omit turn and token budgets", async () => {
		const root = tempDir("harness-swebench-unbounded-suite-");
		const path = join(root, "suite.json");
		writeFileSync(
			path,
			JSON.stringify({
				type: "swebench",
				name: "lite",
				dataset: { path: "dev.parquet", split: "dev", instanceIds: ["owner__repo-1"] },
				timeoutMs: 1,
				maxCost: 1,
				tags: ["lite"],
			}),
		);
		const suite = await readEvalSuite(path);
		expect(suite).not.toHaveProperty("maxTurns");
		expect(suite).not.toHaveProperty("maxTokens");
	});

	it("rejects SWE-bench comparisons with different instance sets", () => {
		const baseline = generationReport("base", "key-one");
		const candidate = generationReport("candidate", "key-two");
		expect(() => compareEvalReports(baseline, candidate)).toThrow("different dataset, split, or instance sets");
	});

	it("compares resolution reports but rejects generation-to-resolution comparisons", () => {
		const generation = generationReport("generation", "same-key");
		const baseline: EvalReport = {
			...generationReport("base", "same-key"),
			metricKind: "resolution",
			successRate: 0,
			benchmark: {
				...generationReport("base-metadata", "same-key").benchmark!,
				gradingStatus: "completed",
				resolutionRate: 0,
			},
		};
		const candidate: EvalReport = { ...baseline, id: "candidate", successRate: 1 };
		expect(compareEvalReports(baseline, candidate).successRateDelta).toBe(1);
		expect(() => compareEvalReports(generation, candidate)).toThrow("metric kinds");
	});
});

function report(id: string, passed: boolean): EvalReport {
	return {
		id,
		suite: "suite",
		startedAt: 0,
		endedAt: 1,
		successRate: passed ? 1 : 0,
		averageCost: 0,
		p95LatencyMs: 1,
		config: {},
		cases: [
			{
				caseId: "case",
				passed,
				hardFailure: false,
				durationMs: 1,
				cost: 0,
				graders: [],
				workspaceChanges: { added: [], modified: [], deleted: [] },
			},
		],
	};
}

function generationReport(id: string, comparisonKey: string): EvalReport {
	return {
		...report(id, true),
		metricKind: "generation",
		generationRate: 1,
		benchmark: {
			datasetChecksum: "checksum",
			split: "dev",
			instanceIds: ["owner__repo-1"],
			bridgeVersion: "1",
			gradingStatus: "not_run",
			resolutionRate: null,
			comparisonKey,
		},
	};
}
