import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isBrokenPipeError, runCli, type CliIo } from "../src/cli-app.ts";
import { persistEvalReport, type EvalReport } from "../src/eval.ts";
import { TraceStore } from "../src/node/trace-store.ts";
import { tempDir } from "./helpers.ts";

describe("CLI", () => {
	it("renders latest trace in Chinese and JSON without jq", async () => {
		const cwd = tempDir("cli-trace-");
		const dataDir = join(cwd, "data");
		const store = new TraceStore(join(dataDir, "harness.sqlite"));
		store.startRun(
			{
				runId: "run-latest",
				sessionId: "session",
				status: "running",
				startedAt: 1,
				modelProvider: "faux",
				modelId: "faux",
				totalTokens: 0,
				cost: 0,
			},
			{},
		);
		store.finishRun({
			runId: "run-latest",
			sessionId: "session",
			status: "completed",
			startedAt: 1,
			endedAt: 2,
			durationMs: 1,
			modelProvider: "faux",
			modelId: "faux",
			totalTokens: 2,
			cost: 0,
		});
		store.close();

		const human = captureIo(cwd);
		expect(await runCli(["trace", "show", "latest", "--data-dir", dataDir], human.io)).toBe(0);
		expect(human.stdout()).toContain("状态：完成");

		const json = captureIo(cwd);
		expect(await runCli(["trace", "show", "latest", "--data-dir", dataDir, "--format", "json"], json.io)).toBe(0);
		expect(JSON.parse(json.stdout())).toMatchObject({ run: { runId: "run-latest" } });
	});

	it("queries evals, saves a baseline, and compares it with latest", async () => {
		const cwd = tempDir("cli-eval-");
		const resultsDir = join(cwd, "results");
		const store = new TraceStore(join(resultsDir, "eval.sqlite"));
		const report = createReport();
		store.saveEvalRun(
			{
				id: report.id,
				suite: report.suite,
				startedAt: report.startedAt,
				endedAt: report.endedAt,
				successRate: report.successRate,
				averageCost: report.averageCost,
				p95LatencyMs: report.p95LatencyMs,
				config: report.config,
			},
			[],
		);
		store.close();

		const save = captureIo(cwd);
		expect(
			await runCli(
				["eval", "baseline", "save", "latest", "--name", "main", "--results-dir", resultsDir],
				save.io,
			),
		).toBe(0);
		expect(save.stdout()).toContain("main");

		const compare = captureIo(cwd);
		expect(
			await runCli(["eval", "compare", "baseline:main", "latest", "--results-dir", resultsDir], compare.io),
		).toBe(0);
		expect(compare.stdout()).toContain("回归：0");
	});

	it("emits structured JSON errors and recognizes EPIPE", async () => {
		const capture = captureIo(tempDir("cli-error-"));
		expect(await runCli(["trace", "show", "missing", "--format", "json"], capture.io)).toBe(1);
		expect(JSON.parse(capture.stdout())).toMatchObject({ ok: false, error: { code: "CLI_ERROR" } });
		expect(isBrokenPipeError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(true);
	});

	it("routes official SWE-bench grading and treats unresolved as a successful command", async () => {
		const cwd = tempDir("cli-swebench-grade-");
		const resultsDir = join(cwd, "results");
		const binDir = join(cwd, "bin");
		mkdirSync(binDir, { recursive: true });
		const graderPython = join(binDir, "grader-python");
		writeFileSync(
			graderPython,
			`#!/bin/sh
if [ "$1" = "-c" ]; then
  printf '4.1.0\\n'
  exit 0
fi
exec node "$(dirname "$0")/fake-evaluator.cjs" "$@"
`,
		);
		writeFileSync(
			join(binDir, "fake-evaluator.cjs"),
			`const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const runId = args[args.indexOf("--run_id") + 1];
const first = args.indexOf("--instance_ids") + 1;
const last = args.indexOf("--namespace");
for (const id of args.slice(first, last)) {
  const dir = path.join(process.cwd(), "logs", "run_evaluation", runId, "fake__model", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ [id]: { resolved: false } }));
  fs.writeFileSync(path.join(dir, "test_output.txt"), "not resolved");
}
`,
		);
		chmodSync(graderPython, 0o755);
		const docker = join(binDir, "docker");
		writeFileSync(docker, "#!/bin/sh\nprintf '27.0.0\\n'\n");
		chmodSync(docker, 0o755);

		const report = createSweBenchReport();
		mkdirSync(join(resultsDir, report.id), { recursive: true });
		writeFileSync(
			join(resultsDir, report.id, "predictions.jsonl"),
			`${JSON.stringify({ instance_id: "owner__repo-1", model_name_or_path: "fake/model", model_patch: "diff --git a/a b/a\n" })}\n`,
		);
		await persistEvalReport(resultsDir, report);
		const capture = captureIo(cwd, { PATH: `${binDir}:${process.env.PATH ?? ""}` });
		const exitCode = await runCli(
				[
					"eval",
					"swebench",
					"grade",
					"latest",
					"--grader-python",
					graderPython,
					"--results-dir",
					resultsDir,
				],
				capture.io,
			);
		expect(exitCode, capture.stderr()).toBe(0);
		expect(capture.stdout()).toContain("官方评分：完成");
		expect(capture.stdout()).toContain("[未解决]");
	});

	it("exports a grading bundle and imports a matching server result", async () => {
		const cwd = tempDir("cli-eval-bundle-");
		const resultsDir = join(cwd, "results");
		const report = createSweBenchReport();
		const caseDir = join(resultsDir, report.id, report.cases[0]!.caseId);
		mkdirSync(caseDir, { recursive: true });
		const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n";
		const prediction = { instance_id: "owner__repo-1", model_name_or_path: "fake/model", model_patch: patch };
		writeFileSync(join(caseDir, "model.patch"), patch);
		writeFileSync(join(caseDir, "prediction.json"), JSON.stringify(prediction));
		writeFileSync(join(caseDir, "result.json"), JSON.stringify(report.cases[0]));
		writeFileSync(join(resultsDir, report.id, "predictions.jsonl"), `${JSON.stringify(prediction)}\n`);
		await persistEvalReport(resultsDir, report);

		const outputPath = join(cwd, "grading-bundle.tar.gz");
		const exported = captureIo(cwd);
		expect(
			await runCli(
				["eval", "export", "latest", "--output", outputPath, "--results-dir", resultsDir, "--format", "json"],
				exported.io,
			),
		).toBe(0);
		const exportResult = JSON.parse(exported.stdout()) as { bundleId: string; evalId: string };
		expect(exportResult.evalId).toBe(report.id);

		const resultPath = join(cwd, "grading-result.json");
		writeFileSync(
			resultPath,
			JSON.stringify({
				schemaVersion: 1,
				kind: "swebench-grading-result",
				bundleId: exportResult.bundleId,
				evalId: report.id,
				graderVersion: "4.1.0",
				gradeId: "remote-grade",
				startedAt: 10,
				endedAt: 20,
				artifactsDir: "remote/remote-grade",
				cases: [
					{
						instanceId: "owner__repo-1",
						status: "unresolved",
						reportPath: "remote/report.json",
						testOutputPath: "remote/test_output.txt",
					},
				],
			}),
		);
		const imported = captureIo(cwd);
		expect(await runCli(["eval", "import", resultPath, "--results-dir", resultsDir], imported.io)).toBe(0);
		expect(imported.stdout()).toContain("评分结果已导入");
		expect(imported.stdout()).toContain("Resolved/Unresolved/Error：0/1/0");
	});
});

function captureIo(cwd: string, env: NodeJS.ProcessEnv = {}): { io: CliIo; stdout: () => string; stderr: () => string } {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		io: {
			cwd,
			env,
			stdout: { write: (value) => stdout.push(value) },
			stderr: { write: (value) => stderr.push(value) },
		},
		stdout: () => stdout.join(""),
		stderr: () => stderr.join(""),
	};
}

function createSweBenchReport(): EvalReport {
	return {
		id: "eval-swebench",
		suite: "swebench-lite-dev",
		startedAt: 1,
		endedAt: 2,
		successRate: 1,
		averageCost: 0.1,
		p95LatencyMs: 10,
		config: {},
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
				workspaceChanges: { added: [], modified: ["a"], deleted: [] },
				benchmark: {
					type: "swebench",
					instanceId: "owner__repo-1",
					repo: "owner/repo",
					baseCommit: "a".repeat(40),
					predictionPath: "eval-swebench/owner__repo-1/prediction.json",
					patchPath: "eval-swebench/owner__repo-1/model.patch",
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

function createReport(): EvalReport {
	return {
		id: "eval-latest",
		suite: "smoke",
		startedAt: 1,
		endedAt: 2,
		successRate: 1,
		averageCost: 0.1,
		p95LatencyMs: 10,
		config: {},
		cases: [],
	};
}
