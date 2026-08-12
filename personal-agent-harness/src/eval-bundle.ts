import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	replacePersistedEvalReport,
	type EvalCaseResult,
	type EvalReport,
	type SweBenchOfficialGrading,
	type SweBenchPrediction,
	type SweBenchResolutionStatus,
} from "./eval.ts";

const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface SweBenchGradingBundleManifest {
	schemaVersion: 1;
	kind: "swebench-grading-bundle";
	bundleId: string;
	evalId: string;
	suite: string;
	exportedAt: number;
	dataset: {
		checksum: string;
		split: "dev" | "test";
		instanceIds: string[];
	};
	config: Record<string, unknown>;
	cases: Array<{
		instanceId: string;
		repo: string;
		baseCommit: string;
		patchPath: string;
		patchSha256: string;
		patchBytes: number;
	}>;
}

export interface SweBenchBundleExportResult {
	bundleId: string;
	evalId: string;
	outputPath: string;
	caseCount: number;
	bytes: number;
}

export interface SweBenchImportedCaseResult {
	instanceId: string;
	status: SweBenchResolutionStatus;
	reportPath: string;
	testOutputPath: string;
}

export interface SweBenchGradingResult {
	schemaVersion: 1;
	kind: "swebench-grading-result";
	bundleId: string;
	evalId: string;
	graderVersion: "4.1.0";
	gradeId: string;
	startedAt: number;
	endedAt: number;
	artifactsDir: string;
	cases: SweBenchImportedCaseResult[];
}

export interface SweBenchBundleImportResult {
	bundleId: string;
	evalId: string;
	gradeId: string;
	resolutionRate: number;
	resolved: number;
	unresolved: number;
	errors: number;
}

export async function readSweBenchGradingResult(path: string): Promise<SweBenchGradingResult> {
	return validateGradingResult(JSON.parse(await readFile(resolve(path), "utf8")) as unknown);
}

interface BundleMaterial {
	bundleId: string;
	manifestCases: SweBenchGradingBundleManifest["cases"];
	patches: Map<string, string>;
}

export async function exportSweBenchGradingBundle(options: {
	resultsDir: string;
	report: EvalReport;
	outputPath: string;
}): Promise<SweBenchBundleExportResult> {
	const outputPath = resolve(options.outputPath);
	if (existsSync(outputPath)) throw new Error(`导出文件已存在：${outputPath}`);
	const material = await collectBundleMaterial(options.resultsDir, options.report);
	const predictionsPath = resolve(options.resultsDir, options.report.id, "predictions.jsonl");
	const predictions = await readAndValidatePredictions(predictionsPath, material.patches);
	const manifest: SweBenchGradingBundleManifest = {
		schemaVersion: BUNDLE_SCHEMA_VERSION,
		kind: "swebench-grading-bundle",
		bundleId: material.bundleId,
		evalId: options.report.id,
		suite: options.report.suite,
		exportedAt: Date.now(),
		dataset: {
			checksum: options.report.benchmark!.datasetChecksum,
			split: options.report.benchmark!.split,
			instanceIds: [...options.report.benchmark!.instanceIds],
		},
		config: bundleConfig(options.report.config),
		cases: material.manifestCases,
	};
	const staging = await mkdtemp(join(tmpdir(), "personal-agent-grading-bundle-"));
	try {
		await mkdir(join(staging, "patches"), { recursive: true });
		await Promise.all([
			writeJson(join(staging, "manifest.json"), manifest),
			writeJson(join(staging, "report.json"), options.report),
			writeFile(
				join(staging, "predictions.jsonl"),
				`${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`,
				"utf8",
			),
			...material.manifestCases.map((item) =>
				writeFile(join(staging, item.patchPath), material.patches.get(item.instanceId)!, "utf8"),
			),
		]);
		await mkdir(dirname(outputPath), { recursive: true });
		await runTar(["-czf", outputPath, "-C", staging, "."]);
		const bytes = (await readFile(outputPath)).byteLength;
		return { bundleId: material.bundleId, evalId: options.report.id, outputPath, caseCount: material.patches.size, bytes };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export async function importSweBenchGradingResult(options: {
	resultsDir: string;
	report: EvalReport;
	resultPath: string;
}): Promise<{ report: EvalReport; summary: SweBenchBundleImportResult }> {
	if (!options.report.benchmark || options.report.metricKind !== "generation") {
		throw new Error("只有尚未评分的 SWE-bench generation 报告可以导入评分结果");
	}
	const material = await collectBundleMaterial(options.resultsDir, options.report);
	const result = await readSweBenchGradingResult(options.resultPath);
	if (result.evalId !== options.report.id) throw new Error("评分结果的 evalId 与本地 Eval 不一致");
	if (result.bundleId !== material.bundleId) throw new Error("评分结果的 bundleId 与本地数据集或 Patch checksum 不一致");
	const expectedIds = options.report.benchmark.instanceIds;
	const resultIds = result.cases.map((item) => item.instanceId);
	if (!sameSet(resultIds, expectedIds) || new Set(resultIds).size !== resultIds.length) {
		throw new Error("评分结果的实例集合与本地 Eval 不一致");
	}
	const resolvedIds = result.cases.filter((item) => item.status === "resolved").map((item) => item.instanceId);
	const unresolvedIds = result.cases.filter((item) => item.status === "unresolved").map((item) => item.instanceId);
	const errorIds = result.cases.filter((item) => item.status === "error").map((item) => item.instanceId);
	const resolutionRate = resolvedIds.length / result.cases.length;
	const officialGrading: SweBenchOfficialGrading = {
		graderVersion: result.graderVersion,
		gradeId: result.gradeId,
		status: "completed",
		startedAt: result.startedAt,
		endedAt: result.endedAt,
		resolutionRate,
		resolvedIds,
		unresolvedIds,
		errorIds,
		artifactsDir: result.artifactsDir,
	};
	const byId = new Map(result.cases.map((item) => [item.instanceId, item]));
	const report: EvalReport = {
		...options.report,
		metricKind: "resolution",
		successRate: resolutionRate,
		cases: options.report.cases.map((item) => applyImportedResult(item, byId.get(item.caseId)!)),
		benchmark: {
			...options.report.benchmark,
			gradingStatus: "completed",
			resolutionRate,
			officialGrading,
		},
	};
	await replacePersistedEvalReport(options.resultsDir, report);
	return {
		report,
		summary: {
			bundleId: material.bundleId,
			evalId: report.id,
			gradeId: result.gradeId,
			resolutionRate,
			resolved: resolvedIds.length,
			unresolved: unresolvedIds.length,
			errors: errorIds.length,
		},
	};
}

async function collectBundleMaterial(resultsDir: string, report: EvalReport): Promise<BundleMaterial> {
	if (!report.benchmark || report.metricKind !== "generation") {
		throw new Error("只有 SWE-bench generation 报告可以导出评分包");
	}
	if (report.benchmark.gradingStatus !== "not_run") throw new Error("Eval 已存在官方评分结果");
	if (report.cases.length !== report.benchmark.instanceIds.length) throw new Error("Eval Case 与 benchmark 元数据不一致");
	const reportDir = resolve(resultsDir, report.id);
	const patches = new Map<string, string>();
	const manifestCases: SweBenchGradingBundleManifest["cases"] = [];
	for (const item of report.cases) {
		if (!item.benchmark || item.benchmark.generationStatus !== "generated") {
			throw new Error(`Case 未生成可评分 Patch：${item.caseId}`);
		}
		if (!/^[A-Za-z0-9_.-]+$/u.test(item.caseId)) throw new Error(`Case ID 不能安全导出：${item.caseId}`);
		const patchFile = resolve(resultsDir, item.benchmark.patchPath);
		const child = relative(reportDir, patchFile);
		if (child === ".." || child.startsWith("../") || child.startsWith("..\\")) {
			throw new Error(`Patch 路径越过 Eval 目录：${item.caseId}`);
		}
		const patch = await readFile(patchFile, "utf8");
		if (!patch.trim()) throw new Error(`Patch 为空：${item.caseId}`);
		patches.set(item.caseId, patch);
		manifestCases.push({
			instanceId: item.caseId,
			repo: item.benchmark.repo,
			baseCommit: item.benchmark.baseCommit,
			patchPath: `patches/${item.caseId}.patch`,
			patchSha256: sha256(patch),
			patchBytes: Buffer.byteLength(patch),
		});
	}
	if (!sameSet([...patches.keys()], report.benchmark.instanceIds)) throw new Error("Patch 实例集合与 benchmark 不一致");
	const identity = {
		evalId: report.id,
		datasetChecksum: report.benchmark.datasetChecksum,
		split: report.benchmark.split,
		instanceIds: [...report.benchmark.instanceIds],
		cases: manifestCases.map(({ instanceId, repo, baseCommit, patchSha256 }) => ({ instanceId, repo, baseCommit, patchSha256 })),
	};
	return { bundleId: sha256(JSON.stringify(identity)), manifestCases, patches };
}

async function readAndValidatePredictions(path: string, patches: Map<string, string>): Promise<SweBenchPrediction[]> {
	const predictions = (await readFile(path, "utf8"))
		.split(/\r?\n/u)
		.filter((line) => line.trim())
		.map((line): SweBenchPrediction => {
			const value = JSON.parse(line) as unknown;
			if (
				!isRecord(value) ||
				typeof value.instance_id !== "string" ||
				typeof value.model_name_or_path !== "string" ||
				typeof value.model_patch !== "string"
			) {
				throw new Error("predictions.jsonl 包含无效记录");
			}
			return {
				instance_id: value.instance_id,
				model_name_or_path: value.model_name_or_path,
				model_patch: value.model_patch,
			};
		});
	if (predictions.length !== patches.size || new Set(predictions.map((item) => item.instance_id)).size !== predictions.length) {
		throw new Error("predictions.jsonl 的实例集合无效");
	}
	for (const prediction of predictions) {
		if (patches.get(prediction.instance_id) !== prediction.model_patch) {
			throw new Error(`Prediction 与 model.patch 不一致：${prediction.instance_id}`);
		}
	}
	return predictions;
}

function validateGradingResult(value: unknown): SweBenchGradingResult {
	if (
		!isRecord(value) ||
		value.schemaVersion !== BUNDLE_SCHEMA_VERSION ||
		value.kind !== "swebench-grading-result" ||
		typeof value.bundleId !== "string" ||
		typeof value.evalId !== "string" ||
		value.graderVersion !== "4.1.0" ||
		typeof value.gradeId !== "string" ||
		typeof value.startedAt !== "number" ||
		typeof value.endedAt !== "number" ||
		typeof value.artifactsDir !== "string" ||
		!Array.isArray(value.cases) ||
		value.cases.length === 0
	) {
		throw new Error("评分结果结构无效");
	}
	const cases = value.cases.map((item): SweBenchImportedCaseResult => {
		if (
			!isRecord(item) ||
			typeof item.instanceId !== "string" ||
			(item.status !== "resolved" && item.status !== "unresolved" && item.status !== "error") ||
			typeof item.reportPath !== "string" ||
			typeof item.testOutputPath !== "string"
		) {
			throw new Error("评分结果包含无效 Case");
		}
		return {
			instanceId: item.instanceId,
			status: item.status,
			reportPath: item.reportPath,
			testOutputPath: item.testOutputPath,
		};
	});
	if (!Number.isFinite(value.startedAt) || !Number.isFinite(value.endedAt) || value.endedAt < value.startedAt) {
		throw new Error("评分结果时间范围无效");
	}
	return {
		schemaVersion: BUNDLE_SCHEMA_VERSION,
		kind: "swebench-grading-result",
		bundleId: value.bundleId,
		evalId: value.evalId,
		graderVersion: value.graderVersion,
		gradeId: value.gradeId,
		startedAt: value.startedAt,
		endedAt: value.endedAt,
		artifactsDir: value.artifactsDir,
		cases,
	};
}

function applyImportedResult(result: EvalCaseResult, imported: SweBenchImportedCaseResult): EvalCaseResult {
	const passed = imported.status === "resolved";
	return {
		...result,
		passed,
		hardFailure: imported.status === "error",
		graders: [
			...result.graders.filter((grader) => grader.type !== "swebench_official"),
			{
				type: "swebench_official",
				passed,
				hardFailure: imported.status === "error",
				message: `Imported official SWE-bench grading: ${imported.status}`,
			},
		],
		...(result.benchmark === undefined
			? {}
			: {
					benchmark: {
						...result.benchmark,
						officialGrading: {
							status: imported.status,
							reportPath: imported.reportPath,
							testOutputPath: imported.testOutputPath,
						},
					},
				}),
	};
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function bundleConfig(config: EvalReport["config"]): Record<string, unknown> {
	const allowed = [
		"provider",
		"model",
		"modelId",
		"systemPromptVersion",
		"promptVersion",
		"toolConfigVersion",
		"policyConfigVersion",
		"benchmarkVersion",
	] as const;
	return Object.fromEntries(
		allowed.flatMap((key) => {
			const value = config[key];
			return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? [[key, value]] : [];
		}),
	);
}

function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item) => right.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function runTar(args: string[]): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("tar", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (exitCode) => {
			if (exitCode === 0) resolvePromise();
			else reject(new Error(`tar 导出失败：${stderr.trim() || `exit ${String(exitCode)}`}`));
		});
	});
}
