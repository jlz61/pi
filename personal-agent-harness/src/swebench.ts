import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@earendil-works/pi-ai";
import {
	persistEvalReport,
	type EvalCaseResult,
	type EvalReport,
	type SweBenchCase,
	type SweBenchEvalSuite,
	type SweBenchPrediction,
} from "./eval.ts";
import type { PermissionRule } from "./permission.ts";
import type { DoctorCheck, DoctorCheckStatus, DoctorReport, JsonValue, RegisteredTool } from "./types.ts";
import type { NodeHarness } from "./node/harness.ts";
import { createWorkspaceNavigationTools } from "./node/tools.ts";

const BRIDGE_TIMEOUT_MS = 30_000;
const PROCESS_OUTPUT_LIMIT = 20_000_000;
const DEFAULT_BRIDGE_PATH = fileURLToPath(new URL("../python/swebench_bridge.py", import.meta.url));

export interface BridgeInspection {
	bridgeVersion: string;
	rowCount: number;
	columns: string[];
	instanceIds: string[];
}

export interface BridgeCases {
	bridgeVersion: string;
	cases: SweBenchCase[];
}

interface ProcessResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface SweBenchBridgeOptions {
	pythonExecutable: string;
	bridgePath?: string;
	timeoutMs?: number;
}

export interface SweBenchDataBridge {
	readonly pythonExecutable: string;
	inspect(parquetPath: string): Promise<BridgeInspection>;
	loadCases(parquetPath: string, instanceIds: string[]): Promise<BridgeCases>;
}

export class SweBenchBridge implements SweBenchDataBridge {
	readonly pythonExecutable: string;
	readonly bridgePath: string;
	private readonly timeoutMs: number;

	constructor(options: SweBenchBridgeOptions) {
		this.pythonExecutable = options.pythonExecutable;
		this.bridgePath = resolve(options.bridgePath ?? DEFAULT_BRIDGE_PATH);
		this.timeoutMs = options.timeoutMs ?? BRIDGE_TIMEOUT_MS;
	}

	async inspect(parquetPath: string): Promise<BridgeInspection> {
		const data = await this.call({ operation: "inspect", parquetPath: resolve(parquetPath) });
		return validateInspection(data);
	}

	async loadCases(parquetPath: string, instanceIds: string[]): Promise<BridgeCases> {
		const data = await this.call({ operation: "load_cases", parquetPath: resolve(parquetPath), instanceIds });
		return validateCases(data, instanceIds);
	}

	private async call(request: Record<string, JsonValue>): Promise<unknown> {
		const result = await runProcess(this.pythonExecutable, [this.bridgePath], {
			input: `${JSON.stringify(request)}\n`,
			timeoutMs: this.timeoutMs,
		});
		if (result.timedOut) throw new Error(`SWE-bench bridge timed out after ${this.timeoutMs}ms`);
		let response: unknown;
		try {
			response = JSON.parse(result.stdout) as unknown;
		} catch {
			throw new Error(`SWE-bench bridge returned invalid JSON${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
		}
		if (!isRecord(response) || typeof response.ok !== "boolean") {
			throw new Error("SWE-bench bridge response has an invalid envelope");
		}
		if (!response.ok) {
			const error = response.error;
			if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
				throw new Error(`${error.code}: ${error.message}`);
			}
			throw new Error("SWE-bench bridge failed without a structured error");
		}
		if (result.exitCode !== 0) throw new Error(`SWE-bench bridge exited with ${String(result.exitCode)}`);
		return response.data;
	}
}

export interface ResolvePythonOptions {
	cliValue?: string | undefined;
	env?: NodeJS.ProcessEnv;
	configValue?: string | undefined;
	cwd?: string;
}

export function resolveSweBenchPython(options: ResolvePythonOptions = {}): string {
	const env = options.env ?? process.env;
	const cwd = resolve(options.cwd ?? process.cwd());
	const configured = options.cliValue ?? env.HARNESS_PYTHON ?? options.configValue;
	if (configured) return configured;
	const local = resolve(cwd, ".venv-swebench", "bin", "python");
	return existsSync(local) ? local : "python3";
}

export interface SweBenchRunnerOptions {
	resultsDir: string;
	bridge: SweBenchDataBridge;
	modelName: string;
	config?: Record<string, JsonValue>;
	createHarness: (
		cwd: string,
		dataDir: string,
		options: {
			tools: RegisteredTool[];
			permissionRules: PermissionRule[];
			systemPrompt: string;
			disabledBuiltinTools: string[];
		},
	) => Promise<NodeHarness>;
	repositoryUrl?: (repo: string) => string;
}

export class SweBenchRunner {
	private readonly options: SweBenchRunnerOptions;

	constructor(options: SweBenchRunnerOptions) {
		this.options = options;
	}

	async run(suite: SweBenchEvalSuite, selectedInstanceId?: string): Promise<EvalReport> {
		const instanceIds = selectedInstanceId === undefined ? suite.dataset.instanceIds : [selectedInstanceId];
		if (selectedInstanceId !== undefined && !suite.dataset.instanceIds.includes(selectedInstanceId)) {
			throw new Error(`Instance is not declared by the suite: ${selectedInstanceId}`);
		}
		const inspection = await this.options.bridge.inspect(suite.dataset.path);
		const loaded = await this.options.bridge.loadCases(suite.dataset.path, instanceIds);
		if (inspection.bridgeVersion !== loaded.bridgeVersion) throw new Error("SWE-bench bridge version changed during the run");
		const datasetChecksum = createHash("sha256").update(await readFile(suite.dataset.path)).digest("hex");
		const comparisonKey = createHash("sha256")
			.update(JSON.stringify({ datasetChecksum, split: suite.dataset.split, instanceIds: [...instanceIds].sort() }))
			.digest("hex");
		const id = uuidv7();
		const startedAt = Date.now();
		const reportDir = resolve(this.options.resultsDir, id);
		const repositoryCache = new GitRepositoryCache({
			root: resolve(this.options.resultsDir, "cache", "swebench-lite", "repos"),
			...(this.options.repositoryUrl === undefined ? {} : { repositoryUrl: this.options.repositoryUrl }),
		});
		await mkdir(reportDir, { recursive: true });
		const results: EvalCaseResult[] = [];
		const predictions: SweBenchPrediction[] = [];
		for (const item of loaded.cases) {
			const executed = await this.runCase(item, suite, reportDir, repositoryCache);
			results.push(executed.result);
			predictions.push(executed.prediction);
		}
		await writeFile(
			join(reportDir, "predictions.jsonl"),
			`${predictions.map((prediction) => JSON.stringify(prediction)).join("\n")}\n`,
			"utf8",
		);
		const endedAt = Date.now();
		const latencies = results.map((result) => result.durationMs).sort((left, right) => left - right);
		const generated = results.filter((result) => result.benchmark?.generationStatus === "generated").length;
		const generationRate = results.length === 0 ? 0 : generated / results.length;
		const report: EvalReport = {
			id,
			suite: suite.name,
			startedAt,
			endedAt,
			successRate: generationRate,
			averageCost: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.cost, 0) / results.length,
			p95LatencyMs: percentile(latencies, 0.95),
			config: {
				...(this.options.config ?? {}),
				benchmarkVersion: "swebench-lite-generation-v2",
			},
			cases: results,
			metricKind: "generation",
			generationRate,
			benchmark: {
				datasetChecksum,
				split: suite.dataset.split,
				instanceIds,
				bridgeVersion: inspection.bridgeVersion,
				gradingStatus: "not_run",
				resolutionRate: null,
				comparisonKey,
			},
		};
		await persistEvalReport(this.options.resultsDir, report);
		return report;
	}

	private async runCase(
		item: SweBenchCase,
		suite: SweBenchEvalSuite,
		reportDir: string,
		repositoryCache: GitRepositoryCache,
	): Promise<{ result: EvalCaseResult; prediction: SweBenchPrediction }> {
		const startedAt = Date.now();
		const caseDir = resolve(reportDir, item.instanceId);
		const temporaryRoot = await mkdtemp(join(tmpdir(), "personal-agent-swebench-"));
		const workspace = join(temporaryRoot, "repo");
		const relativeCaseDir = relative(resolve(this.options.resultsDir), caseDir);
		const predictionPath = join(relativeCaseDir, "prediction.json");
		const patchPath = join(relativeCaseDir, "model.patch");
		let harness: NodeHarness | undefined;
		let runId: string | undefined;
		let durationMs = 0;
		let cost = 0;
		let patch = "";
		let workspaceChanges: EvalCaseResult["workspaceChanges"] = { added: [], modified: [], deleted: [] };
		let generationStatus: NonNullable<EvalCaseResult["benchmark"]>["generationStatus"] = "infrastructure_failed";
		let errorMessage: string | undefined;
		try {
			await mkdir(caseDir, { recursive: true });
			await repositoryCache.prepare(item.repo, item.baseCommit, workspace);
			const permissionRules: PermissionRule[] = [
				{ tool: "*", resource: "*", action: "deny" },
				{ tool: "read", resource: "*", action: "allow" },
				{ tool: "list", resource: "*", action: "allow" },
				{ tool: "search", resource: "*", action: "allow" },
				{ tool: "git_diff", resource: "*", action: "allow" },
				{ tool: "write", resource: "*", action: "allow" },
				{ tool: "edit", resource: "*", action: "allow" },
			];
			harness = await this.options.createHarness(workspace, join(caseDir, "data"), {
				tools: createWorkspaceNavigationTools(workspace),
				permissionRules,
				systemPrompt: [
					"You are solving a SWE-bench issue in a disposable repository.",
					"Treat the issue description and its stated dialect, version, inputs, and conditions as the exact scope. Preserve behavior outside that scope.",
					"Inspect relevant production code and existing tests with list, search, and read before editing.",
					"Implement the smallest correct production-code fix with write or edit.",
					"Existing tests, fixtures, snapshots, and expected outputs are compatibility requirements: do not modify them merely to make your change appear correct unless the issue explicitly requests a test-only change.",
					"Shell execution is unavailable. Before finishing, use git_diff to review every changed file and remove unrelated changes.",
					"Do not modify files outside the repository.",
				].join(" "),
				disabledBuiltinTools: ["exec"],
			});
			const session = await harness.createSession({
				cwd: workspace,
				metadata: { benchmark: "swebench-lite", instanceId: item.instanceId, repo: item.repo },
			});
			const run = await session.run(buildPrompt(item), {
				timeoutMs: suite.timeoutMs,
				...(suite.maxTurns === undefined ? {} : { maxTurns: suite.maxTurns }),
				...(suite.maxTokens === undefined ? {} : { maxTokens: suite.maxTokens }),
				maxCost: suite.maxCost,
				configVersion: "swebench-lite-generation-v2",
			});
			runId = run.runId;
			durationMs = run.durationMs;
			cost = run.usage.cost.total;
			if (run.status !== "completed") {
				generationStatus = "agent_failed";
				errorMessage = run.error ?? `Agent run ended with ${run.status}`;
			} else {
				await runGit(["add", "-A", "--", "."], workspace);
				patch = (await runGit(["diff", "--cached", "--binary", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"], workspace)).stdout;
				workspaceChanges = parseGitChanges((await runGit(["diff", "--cached", "--name-status", "-z"], workspace)).stdout);
				generationStatus = patch.trim() ? "generated" : "empty_patch";
				if (!patch.trim()) errorMessage = "Agent completed without generating a patch";
			}
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
		} finally {
			try {
				await harness?.close();
			} catch (error) {
				generationStatus = "infrastructure_failed";
				errorMessage = `Failed to close Harness: ${errorText(error)}`;
			}
		}

		const prediction: SweBenchPrediction = {
			instance_id: item.instanceId,
			model_name_or_path: this.options.modelName,
			model_patch: patch,
		};
		const passed = generationStatus === "generated";
		const result: EvalCaseResult = {
			caseId: item.instanceId,
			...(runId === undefined ? {} : { runId }),
			passed,
			hardFailure: generationStatus === "agent_failed" || generationStatus === "infrastructure_failed",
			durationMs: durationMs || Date.now() - startedAt,
			cost,
			graders: [
				{
					type: "swebench",
					passed,
					hardFailure: generationStatus === "agent_failed" || generationStatus === "infrastructure_failed",
					message: passed ? "Patch generated; official grading was not run" : (errorMessage ?? generationStatus),
				},
			],
			workspaceChanges,
			benchmark: {
				type: "swebench",
				instanceId: item.instanceId,
				repo: item.repo,
				baseCommit: item.baseCommit,
				predictionPath,
				patchPath,
				generationStatus,
			},
		};
		try {
			await mkdir(caseDir, { recursive: true });
			await Promise.all([
				writeFile(join(caseDir, "model.patch"), patch, "utf8"),
				writeFile(join(caseDir, "prediction.json"), `${JSON.stringify(prediction, null, 2)}\n`, "utf8"),
				writeFile(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
			]);
			return { result, prediction };
		} finally {
			await rm(temporaryRoot, { recursive: true, force: true });
		}
	}
}

interface GitRepositoryCacheOptions {
	root: string;
	repositoryUrl?: (repo: string) => string;
}

export class GitRepositoryCache {
	private readonly root: string;
	private readonly repositoryUrl: (repo: string) => string;

	constructor(options: GitRepositoryCacheOptions) {
		this.root = resolve(options.root);
		this.repositoryUrl = options.repositoryUrl ?? ((repo) => `https://github.com/${repo}.git`);
	}

	async prepare(repo: string, baseCommit: string, workspace: string): Promise<void> {
		validateRepository(repo, baseCommit);
		await mkdir(this.root, { recursive: true });
		const mirror = join(this.root, `${repo.replace("/", "__")}.git`);
		if (!existsSync(mirror)) {
			await runGit(["clone", "--mirror", "--", this.repositoryUrl(repo), mirror], dirname(mirror));
		}
		let commitExists = await gitSucceeds(["cat-file", "-e", `${baseCommit}^{commit}`], mirror);
		if (!commitExists) {
			await runGit(["fetch", "--no-tags", "origin", baseCommit], mirror);
			commitExists = await gitSucceeds(["cat-file", "-e", `${baseCommit}^{commit}`], mirror);
		}
		if (!commitExists) throw new Error(`Base commit is unavailable: ${repo}@${baseCommit}`);
		await runGit(["clone", "--no-hardlinks", "--no-checkout", "--", mirror, workspace], dirname(workspace));
		await runGit(["checkout", "--detach", baseCommit], workspace, { GIT_LFS_SKIP_SMUDGE: "1" });
		const status = await runGit(["status", "--porcelain=v1"], workspace);
		if (status.stdout.trim()) throw new Error(`Prepared repository is not clean: ${repo}@${baseCommit}`);
	}
}

export interface SweBenchDoctorOptions {
	suite: SweBenchEvalSuite;
	bridge: SweBenchDataBridge;
	cacheDir: string;
}

export async function runSweBenchDoctor(options: SweBenchDoctorOptions): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	checks.push(await executableCheck("python", "Python", options.bridge.pythonExecutable, ["--version"]));
	checks.push(await executableCheck("git", "Git", "git", ["--version"]));
	try {
		const inspection = await options.bridge.inspect(options.suite.dataset.path);
		checks.push({
			id: "parquet",
			label: "SWE-bench 数据集",
			status: "ok",
			message: `${options.suite.dataset.split}，${inspection.rowCount} 个实例，Bridge v${inspection.bridgeVersion}`,
		});
	} catch (error) {
		checks.push({ id: "parquet", label: "SWE-bench 数据集", status: "fail", message: errorText(error) });
	}
	try {
		let candidate = resolve(options.cacheDir);
		while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate);
		await access(candidate, constants.W_OK);
		checks.push({ id: "cache", label: "仓库缓存", status: "ok", message: resolve(options.cacheDir) });
	} catch (error) {
		checks.push({ id: "cache", label: "仓库缓存", status: "fail", message: errorText(error) });
	}
	const docker = await runProcess("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 10_000 });
	checks.push(
		docker.exitCode === 0
			? { id: "docker", label: "Docker", status: "ok", message: docker.stdout.trim() }
			: { id: "docker", label: "Docker", status: "warn", message: "当前仅生成 Patch，未启用官方评分" },
	);
	return { status: aggregateStatus(checks), checks };
}

function validateInspection(value: unknown): BridgeInspection {
	if (
		!isRecord(value) ||
		typeof value.bridgeVersion !== "string" ||
		typeof value.rowCount !== "number" ||
		!isStringArray(value.columns) ||
		!isStringArray(value.instanceIds) ||
		new Set(value.instanceIds).size !== value.instanceIds.length
	) {
		throw new Error("SWE-bench inspect response is invalid");
	}
	return {
		bridgeVersion: value.bridgeVersion,
		rowCount: value.rowCount,
		columns: value.columns,
		instanceIds: value.instanceIds,
	};
}

function validateCases(value: unknown, expectedIds: string[]): BridgeCases {
	if (!isRecord(value) || typeof value.bridgeVersion !== "string" || !Array.isArray(value.cases)) {
		throw new Error("SWE-bench case response is invalid");
	}
	const cases = value.cases.map((item): SweBenchCase => {
		if (
			!isRecord(item) ||
			typeof item.instanceId !== "string" ||
			typeof item.repo !== "string" ||
			typeof item.baseCommit !== "string" ||
			typeof item.problemStatement !== "string" ||
			typeof item.version !== "string" ||
			(item.environmentSetupCommit !== undefined && typeof item.environmentSetupCommit !== "string")
		) {
			throw new Error("SWE-bench bridge returned an invalid case");
		}
		return {
			instanceId: item.instanceId,
			repo: item.repo,
			baseCommit: item.baseCommit,
			problemStatement: item.problemStatement,
			version: item.version,
			...(item.environmentSetupCommit === undefined ? {} : { environmentSetupCommit: item.environmentSetupCommit }),
		};
	});
	if (cases.length !== expectedIds.length || cases.some((item, index) => item.instanceId !== expectedIds[index])) {
		throw new Error("SWE-bench bridge returned missing, extra, or reordered cases");
	}
	return { bridgeVersion: value.bridgeVersion, cases };
}

function buildPrompt(item: SweBenchCase): string {
	return [
		`Repository: ${item.repo}`,
		`Version: ${item.version}`,
		"",
		"Issue:",
		item.problemStatement,
		"",
		"Inspect the repository and implement the code change that resolves this issue. Do not only describe the solution.",
	].join("\n");
}

function validateRepository(repo: string, baseCommit: string): void {
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error(`Invalid repository name: ${repo}`);
	if (!/^[0-9a-f]{40}$/u.test(baseCommit)) throw new Error(`Invalid base commit: ${baseCommit}`);
}

async function runGit(
	args: string[],
	cwd: string,
	env: Record<string, string> = {},
): Promise<ProcessResult> {
	const result = await runProcess("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		timeoutMs: 300_000,
		env: { GIT_TERMINAL_PROMPT: "0", ...env },
	});
	if (result.timedOut) throw new Error(`Git command timed out: ${args[0] ?? "unknown"}`);
	if (result.exitCode !== 0) {
		throw new Error(`Git command failed (${args[0] ?? "unknown"}): ${(result.stderr || result.stdout).trim()}`);
	}
	return result;
}

async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
	const result = await runProcess("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		timeoutMs: 30_000,
		env: { GIT_TERMINAL_PROMPT: "0" },
	});
	return result.exitCode === 0 && !result.timedOut;
}

function parseGitChanges(output: string): EvalCaseResult["workspaceChanges"] {
	const added: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];
	const values = output.split("\0").filter(Boolean);
	for (let index = 0; index < values.length; index++) {
		const status = values[index] ?? "";
		const path = values[++index];
		if (!path) break;
		if (status.startsWith("A")) added.push(path);
		else if (status.startsWith("D")) deleted.push(path);
		else if (status.startsWith("R") || status.startsWith("C")) {
			const target = values[++index];
			if (target) {
				deleted.push(path);
				added.push(target);
			}
		} else modified.push(path);
	}
	return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

async function executableCheck(id: string, label: string, executable: string, args: string[]): Promise<DoctorCheck> {
	const result = await runProcess(executable, args, { timeoutMs: 10_000 });
	return result.exitCode === 0
		? { id, label, status: "ok", message: (result.stdout || result.stderr).trim() }
		: { id, label, status: "fail", message: (result.stderr || result.stdout || `${executable} 不可用`).trim() };
}

function aggregateStatus(checks: DoctorCheck[]): DoctorCheckStatus {
	if (checks.some((check) => check.status === "fail")) return "fail";
	if (checks.some((check) => check.status === "warn")) return "warn";
	return "ok";
}

function percentile(sorted: number[], value: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runProcess(
	executable: string,
	args: string[],
	options: { cwd?: string; input?: string; timeoutMs: number; env?: Record<string, string> },
): Promise<ProcessResult> {
	return new Promise((resolvePromise) => {
		let settled = false;
		const finish = (result: ProcessResult): void => {
			if (settled) return;
			settled = true;
			resolvePromise(result);
		};
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(executable, args, {
				...(options.cwd === undefined ? {} : { cwd: options.cwd }),
				env: { ...process.env, ...(options.env ?? {}) },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			finish({ exitCode: null, stdout: "", stderr: errorText(error), timedOut: false });
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = `${stdout}${chunk}`.slice(-PROCESS_OUTPUT_LIMIT);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = `${stderr}${chunk}`.slice(-PROCESS_OUTPUT_LIMIT);
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			finish({ exitCode: null, stdout, stderr: errorText(error), timedOut });
		});
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			finish({ exitCode, stdout, stderr, timedOut });
		});
		child.stdin.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") {
				clearTimeout(timer);
				finish({ exitCode: null, stdout, stderr: errorText(error), timedOut });
			}
		});
		child.stdin.end(options.input ?? "");
	});
}
