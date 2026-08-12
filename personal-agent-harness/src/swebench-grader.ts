import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, statfs, writeFile } from "node:fs/promises";
import { arch, totalmem } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	replacePersistedEvalReport,
	type EvalCaseResult,
	type EvalReport,
	type SweBenchOfficialGrading,
	type SweBenchPrediction,
} from "./eval.ts";
import type { DoctorCheck, DoctorReport } from "./types.ts";

const GRADER_VERSION = "4.1.0" as const;
const PROCESS_OUTPUT_LIMIT = 20_000_000;
const MIN_DISK_BYTES = 120 * 1024 ** 3;
const RECOMMENDED_MEMORY_BYTES = 16 * 1024 ** 3;

export interface GraderProcessRequest {
	command: string;
	args: string[];
	cwd: string;
	timeoutMs: number;
	env: NodeJS.ProcessEnv;
}

export interface GraderProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export type GraderProcessRunner = (request: GraderProcessRequest) => Promise<GraderProcessResult>;

export interface ResolveGraderPythonOptions {
	cliValue?: string | undefined;
	env?: NodeJS.ProcessEnv;
	configValue?: string | undefined;
	cwd?: string;
}

export function resolveSweBenchGraderPython(options: ResolveGraderPythonOptions = {}): string {
	const env = options.env ?? process.env;
	const cwd = resolve(options.cwd ?? process.cwd());
	const configured = options.cliValue ?? env.HARNESS_SWEBENCH_GRADER_PYTHON ?? options.configValue;
	if (configured) return configured;
	const local = resolve(cwd, ".venv-swebench-grader", "bin", "python");
	return existsSync(local) ? local : "python3";
}

export interface SweBenchOfficialGraderOptions {
	resultsDir: string;
	pythonExecutable: string;
	processRunner?: GraderProcessRunner;
	dockerExecutable?: string;
	architecture?: string;
	totalMemoryBytes?: number;
	availableDiskBytes?: number;
	env?: NodeJS.ProcessEnv;
}

export interface SweBenchGradeOptions {
	maxWorkers?: number;
	timeoutSeconds?: number;
	namespace?: "none" | "swebench";
}

interface OfficialCaseResult {
	instanceId: string;
	resolved: boolean;
	reportPath: string;
	testOutputPath: string;
}

export class SweBenchOfficialGrader {
	private readonly resultsDir: string;
	private readonly pythonExecutable: string;
	private readonly processRunner: GraderProcessRunner;
	private readonly dockerExecutable: string;
	private readonly architecture: string;
	private readonly totalMemoryBytes: number;
	private readonly configuredAvailableDiskBytes: number | undefined;
	private readonly env: NodeJS.ProcessEnv;

	constructor(options: SweBenchOfficialGraderOptions) {
		this.resultsDir = resolve(options.resultsDir);
		this.pythonExecutable = options.pythonExecutable;
		this.processRunner = options.processRunner ?? runGraderProcess;
		this.dockerExecutable = options.dockerExecutable ?? "docker";
		this.architecture = options.architecture ?? arch();
		this.totalMemoryBytes = options.totalMemoryBytes ?? totalmem();
		this.configuredAvailableDiskBytes = options.availableDiskBytes;
		this.env = options.env ?? process.env;
	}

	async doctor(): Promise<DoctorReport> {
		const checks: DoctorCheck[] = [];
		checks.push({
			id: "architecture",
			label: "CPU 架构",
			status: this.architecture === "x64" ? "ok" : "fail",
			message: this.architecture,
		});
		const python = await this.processRunner({
			command: this.pythonExecutable,
			args: [
				"-c",
				"import importlib.metadata; print(importlib.metadata.version('swebench'))",
			],
			cwd: this.resultsDir,
			timeoutMs: 10_000,
			env: this.env,
		});
		const pythonVersion = python.stdout.trim();
		checks.push({
			id: "swebench-grader",
			label: "官方 Grader",
			status: python.exitCode === 0 && pythonVersion === GRADER_VERSION ? "ok" : "fail",
			message:
				python.exitCode === 0
					? `swebench ${pythonVersion || "unknown"}，需要 ${GRADER_VERSION}`
					: (python.stderr.trim() || "无法加载 swebench"),
		});
		const docker = await this.processRunner({
			command: this.dockerExecutable,
			args: ["info", "--format", "{{.ServerVersion}}"],
			cwd: this.resultsDir,
			timeoutMs: 15_000,
			env: this.env,
		});
		checks.push({
			id: "docker-daemon",
			label: "Docker daemon",
			status: docker.exitCode === 0 ? "ok" : "fail",
			message: docker.exitCode === 0 ? docker.stdout.trim() : (docker.stderr.trim() || "Docker daemon 不可用"),
		});
		const availableDiskBytes = this.configuredAvailableDiskBytes ?? (await availableBytes(this.resultsDir));
		checks.push({
			id: "grader-disk",
			label: "WSL 工作区磁盘",
			status: availableDiskBytes >= MIN_DISK_BYTES ? "ok" : "fail",
			message: `${formatGiB(availableDiskBytes)} GiB 可用；这不代表 Docker Desktop 磁盘镜像所在 Windows 分区的空间`,
		});
		checks.push({
			id: "grader-memory",
			label: "评分内存",
			status: this.totalMemoryBytes >= RECOMMENDED_MEMORY_BYTES ? "ok" : "warn",
			message: `${formatGiB(this.totalMemoryBytes)} GiB，总内存建议至少 16 GiB；低内存保持单并发`,
		});
		return {
			status: checks.some((check) => check.status === "fail")
				? "fail"
				: checks.some((check) => check.status === "warn")
					? "warn"
					: "ok",
			checks,
		};
	}

	async grade(report: EvalReport, options: SweBenchGradeOptions = {}): Promise<EvalReport> {
		const maxWorkers = options.maxWorkers ?? 1;
		const timeoutSeconds = options.timeoutSeconds ?? 1_800;
		const namespace = options.namespace ?? (report.benchmark?.split === "dev" ? "none" : "swebench");
		if (maxWorkers !== 1) throw new Error("当前本地配置只允许 --max-workers 1");
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
			throw new Error("--timeout 必须是正整数秒");
		}
		if (!report.benchmark || (report.metricKind !== "generation" && report.metricKind !== "resolution")) {
			throw new Error(`Eval 不是可评分的 SWE-bench generation 报告：${report.id}`);
		}
		if (report.benchmark.gradingStatus === "completed") throw new Error(`Eval 已完成官方评分：${report.id}`);
		const instanceIds = [...report.benchmark.instanceIds];
		validateCaseSet(report, instanceIds);
		const reportDir = resolve(this.resultsDir, report.id);
		const predictionsPath = resolve(reportDir, "predictions.jsonl");
		await validatePredictions(predictionsPath, instanceIds);
		await mkdir(this.resultsDir, { recursive: true });
		const doctor = await this.doctor();
		if (doctor.status === "fail") {
			throw new Error(
				`官方 Grader 预检失败：${doctor.checks.filter((check) => check.status === "fail").map((check) => `${check.label}: ${check.message}`).join("；")}`,
			);
		}

		const gradeId = uuidv7();
		const officialRunId = `harness-${gradeId}`;
		const gradeDir = resolve(reportDir, "official-grading", gradeId);
		await mkdir(gradeDir, { recursive: true });
		const startedAt = Date.now();
		const result = await this.processRunner({
			command: this.pythonExecutable,
			args: [
				"-m",
				"swebench.harness.run_evaluation",
				"--dataset_name",
				"princeton-nlp/SWE-bench_Lite",
				"--split",
				report.benchmark.split,
				"--predictions_path",
				predictionsPath,
				"--instance_ids",
				...instanceIds,
				"--namespace",
				namespace,
				"--max_workers",
				String(maxWorkers),
				"--timeout",
				String(timeoutSeconds),
				"--run_id",
				officialRunId,
			],
			cwd: gradeDir,
			timeoutMs: Math.max(3_600_000, (timeoutSeconds + 1_800) * instanceIds.length * 1_000),
			env: this.env,
		});
		await Promise.all([
			writeFile(join(gradeDir, "stdout.log"), result.stdout, "utf8"),
			writeFile(join(gradeDir, "stderr.log"), result.stderr, "utf8"),
		]);
		if (result.timedOut || result.exitCode !== 0) {
			await writeFailure(gradeDir, {
				gradeId,
				startedAt,
				endedAt: Date.now(),
				error: result.timedOut
					? "Official evaluator process timed out"
					: `Official evaluator exited with ${String(result.exitCode)}`,
			});
			throw new Error(
				result.timedOut
					? "官方 SWE-bench evaluator 进程超时"
					: `官方 SWE-bench evaluator 失败：${result.stderr.trim() || `exit ${String(result.exitCode)}`}`,
			);
		}

		let officialCases: OfficialCaseResult[];
		try {
			const summary = await loadOfficialSummary(gradeDir, instanceIds);
			if (summary && summary.errorIds.length > 0) {
				const retry = namespace === "swebench" ? "；远程镜像不可用时请使用 --namespace none 本地构建" : "";
				throw new Error(`官方 evaluator 基础设施错误：${summary.errorIds.join(", ")}${retry}`);
			}
			officialCases = await loadOfficialCases(gradeDir, this.resultsDir, instanceIds);
		} catch (error) {
			await writeFailure(gradeDir, {
				gradeId,
				startedAt,
				endedAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		const resolvedIds = officialCases.filter((item) => item.resolved).map((item) => item.instanceId);
		const unresolvedIds = officialCases.filter((item) => !item.resolved).map((item) => item.instanceId);
		const resolutionRate = resolvedIds.length / officialCases.length;
		const grading: SweBenchOfficialGrading = {
			graderVersion: GRADER_VERSION,
			gradeId,
			status: "completed",
			startedAt,
			endedAt: Date.now(),
			resolutionRate,
			resolvedIds,
			unresolvedIds,
			errorIds: [],
			artifactsDir: relative(this.resultsDir, gradeDir),
		};
		const byId = new Map(officialCases.map((item) => [item.instanceId, item]));
		const graded: EvalReport = {
			...report,
			successRate: resolutionRate,
			metricKind: "resolution",
			cases: report.cases.map((item) => applyOfficialResult(item, byId.get(item.caseId)!)),
			benchmark: {
				...report.benchmark,
				gradingStatus: "completed",
				resolutionRate,
				officialGrading: grading,
			},
		};
		await replacePersistedEvalReport(this.resultsDir, graded);
		return graded;
	}
}

interface OfficialSummary {
	errorIds: string[];
}

async function loadOfficialSummary(gradeDir: string, expectedIds: string[]): Promise<OfficialSummary | undefined> {
	const candidates = (await readdir(gradeDir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "grading-failure.json")
		.map((entry) => join(gradeDir, entry.name));
	let summary: OfficialSummary | undefined;
	for (const path of candidates) {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (!isRecord(value) || !isStringArray(value.submitted_ids) || !isStringArray(value.error_ids)) continue;
		if (summary) throw new Error("官方 evaluator 生成了多个汇总报告");
		if (!sameSet(value.submitted_ids, expectedIds)) {
			throw new Error("官方 evaluator 汇总报告的实例集合与 Eval 报告不一致");
		}
		if (new Set(value.error_ids).size !== value.error_ids.length) {
			throw new Error("官方 evaluator 汇总报告包含重复 error 实例");
		}
		if (value.error_ids.some((id) => !expectedIds.includes(id))) {
			throw new Error("官方 evaluator 汇总报告包含未声明的 error 实例");
		}
		summary = { errorIds: value.error_ids };
	}
	return summary;
}

function applyOfficialResult(result: EvalCaseResult, official: OfficialCaseResult): EvalCaseResult {
	return {
		...result,
		passed: official.resolved,
		hardFailure: false,
		graders: [
			...result.graders.filter((grader) => grader.type !== "swebench_official"),
			{
				type: "swebench_official",
				passed: official.resolved,
				hardFailure: false,
				message: official.resolved ? "Official SWE-bench grading: resolved" : "Official SWE-bench grading: unresolved",
			},
		],
		...(result.benchmark === undefined
			? {}
			: {
					benchmark: {
						...result.benchmark,
						officialGrading: {
							status: official.resolved ? "resolved" : "unresolved",
							reportPath: official.reportPath,
							testOutputPath: official.testOutputPath,
						},
					},
				}),
	};
}

async function validatePredictions(path: string, expectedIds: string[]): Promise<void> {
	const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
	const predictions = lines.map((line): SweBenchPrediction => {
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch {
			throw new Error("predictions.jsonl 包含非法 JSON");
		}
		if (
			!isRecord(value) ||
			typeof value.instance_id !== "string" ||
			typeof value.model_name_or_path !== "string" ||
			typeof value.model_patch !== "string" ||
			!value.model_patch.trim()
		) {
			throw new Error("predictions.jsonl 包含无效或空 Patch");
		}
		return {
			instance_id: value.instance_id,
			model_name_or_path: value.model_name_or_path,
			model_patch: value.model_patch,
		};
	});
	const ids = predictions.map((item) => item.instance_id);
	if (new Set(ids).size !== ids.length || !sameSet(ids, expectedIds)) {
		throw new Error("predictions.jsonl 的实例集合与 Eval 报告不一致");
	}
}

function validateCaseSet(report: EvalReport, expectedIds: string[]): void {
	const caseIds = report.cases.map((item) => item.caseId);
	if (new Set(caseIds).size !== caseIds.length || !sameSet(caseIds, expectedIds)) {
		throw new Error("Eval Case 集合与 benchmark 元数据不一致");
	}
	if (report.cases.some((item) => item.benchmark?.generationStatus !== "generated")) {
		throw new Error("只有全部生成非空 Patch 的 Eval 才能执行官方评分");
	}
}

async function loadOfficialCases(
	gradeDir: string,
	resultsDir: string,
	expectedIds: string[],
): Promise<OfficialCaseResult[]> {
	const files = await collectFiles(join(gradeDir, "logs", "run_evaluation"));
	const reports = files.filter((path) => basename(path) === "report.json");
	const found = new Map<string, OfficialCaseResult>();
	for (const reportPath of reports) {
		const value = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
		if (!isRecord(value)) throw new Error(`官方报告不是 JSON 对象：${reportPath}`);
		const ids = Object.keys(value);
		if (ids.length !== 1) throw new Error(`官方报告必须只包含一个实例：${reportPath}`);
		const instanceId = ids[0]!;
		if (!expectedIds.includes(instanceId)) throw new Error(`官方报告包含未声明实例：${instanceId}`);
		if (found.has(instanceId)) throw new Error(`官方报告包含重复实例：${instanceId}`);
		const details = value[instanceId];
		if (!isRecord(details) || typeof details.resolved !== "boolean") {
			throw new Error(`官方报告缺少 resolved：${instanceId}`);
		}
		const testOutputPath = join(dirname(reportPath), "test_output.txt");
		if (!existsSync(testOutputPath)) throw new Error(`官方评分缺少 test_output.txt：${instanceId}`);
		found.set(instanceId, {
			instanceId,
			resolved: details.resolved,
			reportPath: relative(resultsDir, reportPath),
			testOutputPath: relative(resultsDir, testOutputPath),
		});
	}
	const missing = expectedIds.filter((id) => !found.has(id));
	if (missing.length > 0) throw new Error(`官方评分报告不完整，缺少：${missing.join(", ")}`);
	return expectedIds.map((id) => found.get(id)!);
}

async function collectFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) files.push(...(await collectFiles(path)));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

async function writeFailure(directory: string, value: Record<string, string | number>): Promise<void> {
	await writeFile(join(directory, "grading-failure.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function availableBytes(path: string): Promise<number> {
	let candidate = resolve(path);
	while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
	const stats = await statfs(candidate);
	return Number(stats.bavail) * Number(stats.bsize);
}

function formatGiB(bytes: number): string {
	return (bytes / 1024 ** 3).toFixed(1);
}

function sameSet(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((item) => right.includes(item));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

async function runGraderProcess(request: GraderProcessRequest): Promise<GraderProcessResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(request.command, request.args, {
			cwd: request.cwd,
			env: request.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result: GraderProcessResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolvePromise(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			if (stdout.length < PROCESS_OUTPUT_LIMIT) stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < PROCESS_OUTPUT_LIMIT) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => finish({ exitCode: null, stdout, stderr: error.message, timedOut }));
		child.on("close", (exitCode) => finish({ exitCode, stdout, stderr, timedOut }));
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, request.timeoutMs);
	});
}
