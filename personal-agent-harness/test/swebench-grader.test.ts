import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { persistEvalReport, type EvalReport, type SweBenchPrediction } from "../src/eval.ts";
import { TraceStore } from "../src/node/trace-store.ts";
import {
	resolveSweBenchGraderPython,
	SweBenchOfficialGrader,
	type GraderProcessRequest,
	type GraderProcessResult,
} from "../src/swebench-grader.ts";
import { tempDir } from "./helpers.ts";

const GIB = 1024 ** 3;

describe("SWE-bench official grader", () => {
	it("honors grader Python precedence", () => {
		const cwd = tempDir("swebench-grader-python-");
		mkdirSync(join(cwd, ".venv-swebench-grader", "bin"), { recursive: true });
		writeFileSync(join(cwd, ".venv-swebench-grader", "bin", "python"), "");
		expect(resolveSweBenchGraderPython({ cwd, configValue: "config", env: {} })).toBe("config");
		expect(
			resolveSweBenchGraderPython({
				cwd,
				configValue: "config",
				env: { HARNESS_SWEBENCH_GRADER_PYTHON: "env" },
			}),
		).toBe("env");
		expect(
			resolveSweBenchGraderPython({ cwd, cliValue: "cli", env: { HARNESS_SWEBENCH_GRADER_PYTHON: "env" } }),
		).toBe("cli");
		expect(resolveSweBenchGraderPython({ cwd, env: {} })).toBe(
			join(cwd, ".venv-swebench-grader", "bin", "python"),
		);
	});

	it("grades an unresolved patch and replaces the persisted report", async () => {
		const root = tempDir("swebench-official-");
		const resultsDir = join(root, "results with spaces");
		const report = createGenerationReport();
		await prepareGenerationReport(resultsDir, report);
		const requests: GraderProcessRequest[] = [];
		const grader = createGrader(resultsDir, async (request) => {
			requests.push(request);
			if (request.args[0] === "-c") return success("4.1.0\n");
			if (request.command === "docker") return success("27.0.0\n");
			writeOfficialResult(request.cwd, request.args, report.cases[0]!.caseId, false);
			return success("evaluation completed\n");
		});

		const graded = await grader.grade(report);
		expect(graded).toMatchObject({
			metricKind: "resolution",
			successRate: 0,
			generationRate: 1,
			benchmark: {
				gradingStatus: "completed",
				resolutionRate: 0,
				officialGrading: { graderVersion: "4.1.0", unresolvedIds: ["owner__repo-1"] },
			},
			cases: [{ passed: false, hardFailure: false, benchmark: { officialGrading: { status: "unresolved" } } }],
		});
		const evaluatorRequest = requests.find((request) => request.args.includes("swebench.harness.run_evaluation"));
		expect(evaluatorRequest).toBeDefined();
		expect(evaluatorRequest!.args).toContain(resolvePredictions(resultsDir, report.id));
		expect(evaluatorRequest!.args).toContain("owner__repo-1");
		expect(evaluatorRequest!.args.slice(evaluatorRequest!.args.indexOf("--namespace"), evaluatorRequest!.args.indexOf("--namespace") + 2)).toEqual([
			"--namespace",
			"none",
		]);
		const store = new TraceStore(join(resultsDir, "eval.sqlite"));
		try {
			expect(store.getEvalReport(report.id)).toMatchObject({
				metricKind: "resolution",
				benchmark: { gradingStatus: "completed" },
				cases: [{ passed: false }],
			});
		} finally {
			store.close();
		}
		expect(JSON.parse(readFileSync(join(resultsDir, report.id, "report.json"), "utf8"))).toMatchObject({
			metricKind: "resolution",
		});
	});

	it("reports evaluator error summaries instead of calling them missing reports", async () => {
		const root = tempDir("swebench-official-summary-error-");
		const resultsDir = join(root, "results");
		const report = createGenerationReport();
		await prepareGenerationReport(resultsDir, report);
		const grader = createGrader(resultsDir, async (request) => {
			if (request.args[0] === "-c") return success("4.1.0\n");
			if (request.command === "docker") return success("27.0.0\n");
			writeFileSync(
				join(request.cwd, "official-summary.json"),
				JSON.stringify({ submitted_ids: ["owner__repo-1"], error_ids: ["owner__repo-1"] }),
			);
			return success("evaluation completed with errors\n");
		});

		await expect(grader.grade(report)).rejects.toThrow("官方 evaluator 基础设施错误：owner__repo-1");
		expect(JSON.parse(readFileSync(join(resultsDir, report.id, "report.json"), "utf8"))).toMatchObject({
			metricKind: "generation",
			benchmark: { gradingStatus: "not_run" },
		});
	});

	it("preserves the generation report when evaluator infrastructure fails", async () => {
		const root = tempDir("swebench-official-failure-");
		const resultsDir = join(root, "results");
		const report = createGenerationReport();
		await prepareGenerationReport(resultsDir, report);
		const grader = createGrader(resultsDir, async (request) => {
			if (request.args[0] === "-c") return success("4.1.0\n");
			if (request.command === "docker") return success("27.0.0\n");
			return { exitCode: 1, stdout: "", stderr: "image build failed", timedOut: false };
		});
		await expect(grader.grade(report)).rejects.toThrow("image build failed");
		const store = new TraceStore(join(resultsDir, "eval.sqlite"));
		try {
			expect(store.getEvalReport(report.id)).toMatchObject({
				metricKind: "generation",
				benchmark: { gradingStatus: "not_run" },
			});
		} finally {
			store.close();
		}
	});

	it("marks a passing official report as resolved", async () => {
		const root = tempDir("swebench-official-resolved-");
		const resultsDir = join(root, "results");
		const report = createGenerationReport();
		await prepareGenerationReport(resultsDir, report);
		const grader = createGrader(resultsDir, async (request) => {
			if (request.args[0] === "-c") return success("4.1.0\n");
			if (request.command === "docker") return success("27.0.0\n");
			writeOfficialResult(request.cwd, request.args, report.cases[0]!.caseId, true);
			return success("evaluation completed\n");
		});
		const graded = await grader.grade(report);
		expect(graded).toMatchObject({
			successRate: 1,
			benchmark: { resolutionRate: 1, officialGrading: { resolvedIds: ["owner__repo-1"] } },
			cases: [{ passed: true, benchmark: { officialGrading: { status: "resolved" } } }],
		});
	});

	it("rejects incomplete official reports and out-of-scope predictions", async () => {
		const root = tempDir("swebench-official-invalid-");
		const resultsDir = join(root, "results");
		const report = createGenerationReport();
		await prepareGenerationReport(resultsDir, report);
		const predictionsPath = resolvePredictions(resultsDir, report.id);
		const prediction = JSON.parse(readFileSync(predictionsPath, "utf8")) as SweBenchPrediction;
		writeFileSync(predictionsPath, `${JSON.stringify({ ...prediction, instance_id: "other__repo-2" })}\n`);
		const grader = createGrader(resultsDir, async () => success("4.1.0\n"));
		await expect(grader.grade(report)).rejects.toThrow("实例集合");

		await writePredictions(resultsDir, report);
		const incomplete = createGrader(resultsDir, async (request) => {
			if (request.args[0] === "-c") return success("4.1.0\n");
			if (request.command === "docker") return success("27.0.0\n");
			return success("completed without report");
		});
		await expect(incomplete.grade(report)).rejects.toThrow("报告不完整");
	});

	it("fails preflight without Docker and warns for low memory", async () => {
		const resultsDir = join(tempDir("swebench-official-doctor-"), "results");
		mkdirSync(resultsDir, { recursive: true });
		const grader = createGrader(resultsDir, async (request) => {
			if (request.args[0] === "-c") return success("4.1.0\n");
			return { exitCode: 1, stdout: "", stderr: "daemon unavailable", timedOut: false };
		});
		const doctor = await grader.doctor();
		expect(doctor.status).toBe("fail");
		expect(doctor.checks).toContainEqual(expect.objectContaining({ id: "docker-daemon", status: "fail" }));
		expect(doctor.checks).toContainEqual(expect.objectContaining({ id: "grader-memory", status: "warn" }));
	});
});

function createGrader(
	resultsDir: string,
	processRunner: (request: GraderProcessRequest) => Promise<GraderProcessResult>,
): SweBenchOfficialGrader {
	return new SweBenchOfficialGrader({
		resultsDir,
		pythonExecutable: "grader-python",
		processRunner,
		architecture: "x64",
		totalMemoryBytes: 8 * GIB,
		availableDiskBytes: 200 * GIB,
	});
}

function createGenerationReport(): EvalReport {
	return {
		id: "eval-generation",
		suite: "swebench-lite-dev",
		startedAt: 1,
		endedAt: 2,
		successRate: 1,
		averageCost: 0.02,
		p95LatencyMs: 100,
		config: { model: "faux" },
		metricKind: "generation",
		generationRate: 1,
		cases: [
			{
				caseId: "owner__repo-1",
				runId: "run-1",
				passed: true,
				hardFailure: false,
				durationMs: 100,
				cost: 0.02,
				graders: [{ type: "swebench", passed: true, hardFailure: false, message: "generated" }],
				workspaceChanges: { added: [], modified: ["target.py"], deleted: [] },
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

async function prepareGenerationReport(resultsDir: string, report: EvalReport): Promise<void> {
	await writePredictions(resultsDir, report);
	await persistEvalReport(resultsDir, report);
}

async function writePredictions(resultsDir: string, report: EvalReport): Promise<void> {
	const directory = join(resultsDir, report.id);
	mkdirSync(directory, { recursive: true });
	const prediction: SweBenchPrediction = {
		instance_id: report.cases[0]!.caseId,
		model_name_or_path: "faux/faux",
		model_patch: "diff --git a/target.py b/target.py\n",
	};
	writeFileSync(resolvePredictions(resultsDir, report.id), `${JSON.stringify(prediction)}\n`);
}

function resolvePredictions(resultsDir: string, evalId: string): string {
	return join(resultsDir, evalId, "predictions.jsonl");
}

function writeOfficialResult(cwd: string, args: string[], instanceId: string, resolved: boolean): void {
	const runId = args[args.indexOf("--run_id") + 1]!;
	const directory = join(cwd, "logs", "run_evaluation", runId, "faux__faux", instanceId);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "report.json"), JSON.stringify({ [instanceId]: { resolved } }));
	writeFileSync(join(directory, "test_output.txt"), "test output");
}

function success(stdout: string): GraderProcessResult {
	return { exitCode: 0, stdout, stderr: "", timedOut: false };
}
