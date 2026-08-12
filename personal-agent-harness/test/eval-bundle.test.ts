import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	exportSweBenchGradingBundle,
	importSweBenchGradingResult,
	type SweBenchGradingBundleManifest,
} from "../src/eval-bundle.ts";
import { persistEvalReport, type EvalReport, type SweBenchPrediction } from "../src/eval.ts";
import { TraceStore } from "../src/node/trace-store.ts";
import { tempDir } from "./helpers.ts";

describe("SWE-bench grading bundle", () => {
	it("exports a portable archive and imports matching official results", async () => {
		const root = tempDir("eval-bundle-");
		const resultsDir = join(root, "results");
		const report = createReport();
		await prepareReport(resultsDir, report);
		const outputPath = join(root, "bundle with spaces.tar.gz");
		const exported = await exportSweBenchGradingBundle({ resultsDir, report, outputPath });
		const manifest = JSON.parse(
			execFileSync("tar", ["-xOf", outputPath, "./manifest.json"], { encoding: "utf8" }),
		) as SweBenchGradingBundleManifest;
		expect(manifest).toMatchObject({
			kind: "swebench-grading-bundle",
			bundleId: exported.bundleId,
			evalId: report.id,
			dataset: { split: "dev", instanceIds: ["owner__repo-1"] },
			cases: [{ patchSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
		});
		expect(manifest.config).toEqual({ provider: "faux", model: "faux", benchmarkVersion: "v2" });
		expect(execFileSync("tar", ["-tzf", outputPath], { encoding: "utf8" })).toContain(
			"./patches/owner__repo-1.patch",
		);

		const resultPath = join(root, "grading-result.json");
		writeFileSync(
			resultPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "swebench-grading-result",
				bundleId: exported.bundleId,
				evalId: report.id,
				graderVersion: "4.1.0",
				gradeId: "server-grade-1",
				startedAt: 10,
				endedAt: 20,
				artifactsDir: "remote/server-grade-1",
				cases: [
					{
						instanceId: "owner__repo-1",
						status: "resolved",
						reportPath: "remote/report.json",
						testOutputPath: "remote/test_output.txt",
					},
				],
			}),
		);
		const imported = await importSweBenchGradingResult({ resultsDir, report, resultPath });
		expect(imported.summary).toMatchObject({ resolutionRate: 1, resolved: 1, unresolved: 0, errors: 0 });
		const store = new TraceStore(join(resultsDir, "eval.sqlite"));
		try {
			expect(store.getEvalReport(report.id)).toMatchObject({
				metricKind: "resolution",
				successRate: 1,
				benchmark: { gradingStatus: "completed", officialGrading: { gradeId: "server-grade-1" } },
				cases: [{ passed: true, benchmark: { officialGrading: { status: "resolved" } } }],
			});
		} finally {
			store.close();
		}
	});

	it("rejects a grading result for a different bundle", async () => {
		const root = tempDir("eval-bundle-mismatch-");
		const resultsDir = join(root, "results");
		const report = createReport();
		await prepareReport(resultsDir, report);
		const resultPath = join(root, "grading-result.json");
		writeFileSync(
			resultPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "swebench-grading-result",
				bundleId: "wrong",
				evalId: report.id,
				graderVersion: "4.1.0",
				gradeId: "server-grade-1",
				startedAt: 10,
				endedAt: 20,
				artifactsDir: "remote",
				cases: [
					{
						instanceId: "owner__repo-1",
						status: "unresolved",
						reportPath: "report.json",
						testOutputPath: "test_output.txt",
					},
				],
			}),
		);
		await expect(importSweBenchGradingResult({ resultsDir, report, resultPath })).rejects.toThrow("bundleId");
	});
});

function createReport(): EvalReport {
	return {
		id: "eval-generation",
		suite: "swebench-lite-dev",
		startedAt: 1,
		endedAt: 2,
		successRate: 1,
		averageCost: 0.1,
		p95LatencyMs: 10,
		config: { provider: "faux", model: "faux", benchmarkVersion: "v2", apiKey: "must-not-export" },
		metricKind: "generation",
		generationRate: 1,
		cases: [
			{
				caseId: "owner__repo-1",
				passed: true,
				hardFailure: false,
				durationMs: 10,
				cost: 0.1,
				graders: [{ type: "swebench", passed: true, hardFailure: false, message: "generated" }],
				workspaceChanges: { added: [], modified: ["source.py"], deleted: [] },
				benchmark: {
					type: "swebench",
					instanceId: "owner__repo-1",
					repo: "owner/repo",
					baseCommit: "a".repeat(40),
					predictionPath: "eval-generation/owner__repo-1/prediction.json",
					patchPath: "eval-generation/owner__repo-1/model.patch",
					generationStatus: "generated",
				},
			},
		],
		benchmark: {
			datasetChecksum: "checksum",
			split: "dev",
			instanceIds: ["owner__repo-1"],
			bridgeVersion: "1",
			gradingStatus: "not_run",
			resolutionRate: null,
			comparisonKey: "comparison",
		},
	};
}

async function prepareReport(resultsDir: string, report: EvalReport): Promise<void> {
	const caseDir = join(resultsDir, report.id, report.cases[0]!.caseId);
	mkdirSync(caseDir, { recursive: true });
	const patch = "diff --git a/source.py b/source.py\n--- a/source.py\n+++ b/source.py\n@@ -1 +1 @@\n-old\n+new\n";
	const prediction: SweBenchPrediction = {
		instance_id: report.cases[0]!.caseId,
		model_name_or_path: "faux/faux",
		model_patch: patch,
	};
	writeFileSync(join(caseDir, "model.patch"), patch);
	writeFileSync(join(caseDir, "prediction.json"), JSON.stringify(prediction));
	writeFileSync(join(resultsDir, report.id, "predictions.jsonl"), `${JSON.stringify(prediction)}\n`);
	writeFileSync(join(caseDir, "result.json"), JSON.stringify(report.cases[0]));
	await persistEvalReport(resultsDir, report);
}
