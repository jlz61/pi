import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { NodeHarness } from "./node/harness.ts";
import { TraceStore, type EvalCaseRecord } from "./node/trace-store.ts";
import type { HarnessEvent, JsonValue, RunResult } from "./types.ts";

export type GraderConfig = CommandGraderConfig | FileGraderConfig | TraceGraderConfig;

export interface CommandGraderConfig {
	type: "command";
	command: string;
	timeoutMs?: number;
}

export interface FileGraderConfig {
	type: "file";
	path: string;
	exists?: boolean;
	contains?: string;
	matches?: string;
}

export interface TraceGraderConfig {
	type: "trace";
	toolCalled?: string;
	permissionAction?: "allow" | "deny";
	maxTurns?: number;
	maxTokens?: number;
	maxCost?: number;
}

export interface EvalCase {
	id: string;
	input: string;
	fixture?: string;
	timeoutMs: number;
	graders: GraderConfig[];
	tags: string[];
}

export interface FixtureEvalSuite {
	type?: "fixture";
	name: string;
	cases: EvalCase[];
}

export interface SweBenchEvalSuite {
	type: "swebench";
	name: string;
	dataset: {
		path: string;
		split: "dev" | "test";
		instanceIds: string[];
	};
	timeoutMs: number;
	maxTurns?: number;
	maxTokens?: number;
	maxCost: number;
	tags: string[];
}

export type EvalSuite = FixtureEvalSuite | SweBenchEvalSuite;

export interface SweBenchCase {
	instanceId: string;
	repo: string;
	baseCommit: string;
	problemStatement: string;
	version: string;
	environmentSetupCommit?: string;
}

export interface SweBenchPrediction {
	instance_id: string;
	model_name_or_path: string;
	model_patch: string;
}

export interface GraderResult {
	type: GraderConfig["type"] | "swebench" | "swebench_official";
	passed: boolean;
	hardFailure: boolean;
	message: string;
}

export interface EvalCaseResult {
	caseId: string;
	runId?: string;
	passed: boolean;
	hardFailure: boolean;
	durationMs: number;
	cost: number;
	graders: GraderResult[];
	workspaceChanges: { added: string[]; modified: string[]; deleted: string[] };
	benchmark?: {
		type: "swebench";
		instanceId: string;
		repo: string;
		baseCommit: string;
		predictionPath: string;
		patchPath: string;
		generationStatus: "generated" | "empty_patch" | "agent_failed" | "infrastructure_failed";
		officialGrading?: {
			status: SweBenchResolutionStatus;
			reportPath: string;
			testOutputPath: string;
		};
	};
}

export type SweBenchGradingStatus = "not_run" | "completed" | "failed";
export type SweBenchResolutionStatus = "resolved" | "unresolved" | "error";

export interface SweBenchOfficialGrading {
	graderVersion: "4.1.0";
	gradeId: string;
	status: SweBenchGradingStatus;
	startedAt: number;
	endedAt: number;
	resolutionRate: number | null;
	resolvedIds: string[];
	unresolvedIds: string[];
	errorIds: string[];
	artifactsDir: string;
}

export interface SweBenchReportMetadata {
	datasetChecksum: string;
	split: "dev" | "test";
	instanceIds: string[];
	bridgeVersion: string;
	gradingStatus: SweBenchGradingStatus;
	resolutionRate: number | null;
	comparisonKey: string;
	officialGrading?: SweBenchOfficialGrading;
}

export interface EvalReport {
	id: string;
	suite: string;
	startedAt: number;
	endedAt: number;
	successRate: number;
	averageCost: number;
	p95LatencyMs: number;
	config: Record<string, JsonValue>;
	cases: EvalCaseResult[];
	metricKind?: "fixture" | "generation" | "resolution";
	generationRate?: number;
	benchmark?: SweBenchReportMetadata;
}

export interface EvalComparison {
	baselineId: string;
	candidateId: string;
	metricKind: "fixture" | "generation" | "resolution";
	successRateDelta: number;
	averageCostDelta: number;
	p95LatencyDeltaMs: number;
	regressions: string[];
	improvements: string[];
}

export interface EvalRunnerOptions {
	resultsDir: string;
	createHarness: (cwd: string, dataDir: string) => Promise<NodeHarness>;
	config?: Record<string, JsonValue>;
}

export class EvalRunner {
	private readonly options: EvalRunnerOptions;

	constructor(options: EvalRunnerOptions) {
		this.options = options;
	}

	async run(suite: FixtureEvalSuite): Promise<EvalReport> {
		validateFixtureSuite(suite);
		const id = uuidv7();
		const startedAt = Date.now();
		const reportDir = resolve(this.options.resultsDir, id);
		await mkdir(reportDir, { recursive: true });
		const results: EvalCaseResult[] = [];
		for (const evalCase of suite.cases) results.push(await this.runCase(evalCase, reportDir));
		const endedAt = Date.now();
		const latencies = results.map((result) => result.durationMs).sort((left, right) => left - right);
		const report: EvalReport = {
			id,
			suite: suite.name,
			startedAt,
			endedAt,
			successRate: results.length === 0 ? 0 : results.filter((result) => result.passed).length / results.length,
			averageCost: results.length === 0 ? 0 : results.reduce((sum, result) => sum + result.cost, 0) / results.length,
			p95LatencyMs: percentile(latencies, 0.95),
			config: { ...(this.options.config ?? {}) },
			cases: results,
			metricKind: "fixture",
		};
		await persistEvalReport(this.options.resultsDir, report);
		return report;
	}

	private async runCase(evalCase: EvalCase, reportDir: string): Promise<EvalCaseResult> {
		const workspace = await mkdtemp(join(tmpdir(), "personal-agent-eval-"));
		const caseDir = join(reportDir, evalCase.id);
		await mkdir(caseDir, { recursive: true });
		let harness: NodeHarness | undefined;
		try {
			if (evalCase.fixture) await cp(resolve(evalCase.fixture), workspace, { recursive: true });
			const before = await snapshotWorkspace(workspace);
			harness = await this.options.createHarness(workspace, join(caseDir, "data"));
			const session = await harness.createSession({ cwd: workspace });
			const run = await session.run(evalCase.input, { timeoutMs: evalCase.timeoutMs });
			const events = harness.traceStore.getEvents(run.runId);
			const graders = await Promise.all(
				evalCase.graders.map((grader) => grade(grader, workspace, run, events)),
			);
			const after = await snapshotWorkspace(workspace);
			const workspaceChanges = compareSnapshots(before, after);
			const externalAttempt = events.some(
				(event) =>
					event.type === "permission_decision" &&
					event.attributes.action === "deny" &&
					event.attributes.source === "external",
			);
			if (externalAttempt) {
				graders.push({
					type: "trace",
					passed: false,
					hardFailure: true,
					message: "Agent attempted to access a resource outside the workspace",
				});
			}
			const result: EvalCaseResult = {
				caseId: evalCase.id,
				runId: run.runId,
				passed: run.status === "completed" && graders.every((grader) => grader.passed),
				hardFailure: graders.some((grader) => grader.hardFailure),
				durationMs: run.durationMs,
				cost: run.usage.cost.total,
				graders,
				workspaceChanges,
			};
			await writeCaseArtifacts(caseDir, result);
			return result;
		} catch (error) {
			const result: EvalCaseResult = {
				caseId: evalCase.id,
				passed: false,
				hardFailure: true,
				durationMs: 0,
				cost: 0,
				graders: [
					{
						type: "trace",
						passed: false,
						hardFailure: true,
						message: error instanceof Error ? error.message : String(error),
					},
				],
				workspaceChanges: { added: [], modified: [], deleted: [] },
			};
			await writeCaseArtifacts(caseDir, result);
			return result;
		} finally {
			await harness?.close();
			await rm(workspace, { recursive: true, force: true });
		}
	}
}

async function writeCaseArtifacts(caseDir: string, result: EvalCaseResult): Promise<void> {
	await Promise.all([
		writeFile(join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8"),
		writeFile(
			join(caseDir, "workspace-changes.json"),
			`${JSON.stringify(result.workspaceChanges, null, 2)}\n`,
			"utf8",
		),
	]);
}

export async function readEvalSuite(path: string): Promise<EvalSuite> {
	const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
	const base = dirname(resolve(path));
	if (isSweBenchSuite(parsed)) {
		validateSweBenchSuite(parsed);
		return {
			...parsed,
			dataset: {
				...parsed.dataset,
				path: isAbsolute(parsed.dataset.path) ? parsed.dataset.path : resolve(base, parsed.dataset.path),
			},
		};
	}
	validateFixtureSuite(parsed);
	return {
		...parsed,
		cases: parsed.cases.map((evalCase) => ({
			...evalCase,
			...(evalCase.fixture === undefined
				? {}
				: { fixture: isAbsolute(evalCase.fixture) ? evalCase.fixture : resolve(base, evalCase.fixture) }),
		})),
	};
}

export async function readEvalReport(path: string): Promise<EvalReport> {
	return JSON.parse(await readFile(path, "utf8")) as EvalReport;
}

export function compareEvalReports(baseline: EvalReport, candidate: EvalReport): EvalComparison {
	const baselineKind = baseline.metricKind ?? "fixture";
	const candidateKind = candidate.metricKind ?? "fixture";
	if (baselineKind !== candidateKind) throw new Error("Eval metric kinds are not comparable");
	if (baselineKind === "generation" || baselineKind === "resolution") {
		if (!baseline.benchmark || !candidate.benchmark) throw new Error("SWE-bench metadata is missing");
		if (baseline.benchmark.comparisonKey !== candidate.benchmark.comparisonKey) {
			throw new Error("SWE-bench reports use different dataset, split, or instance sets");
		}
	}
	const baselineCases = new Map(baseline.cases.map((result) => [result.caseId, result]));
	const candidateCases = new Map(candidate.cases.map((result) => [result.caseId, result]));
	const regressions: string[] = [];
	const improvements: string[] = [];
	for (const [caseId, baselineResult] of baselineCases) {
		const candidateResult = candidateCases.get(caseId);
		if (!candidateResult) {
			regressions.push(`${caseId}: missing from candidate`);
			continue;
		}
		if (baselineResult.passed && !candidateResult.passed) regressions.push(`${caseId}: pass -> fail`);
		if (!baselineResult.passed && candidateResult.passed) improvements.push(`${caseId}: fail -> pass`);
	}
	return {
		baselineId: baseline.id,
		candidateId: candidate.id,
		metricKind: baselineKind,
		successRateDelta: candidate.successRate - baseline.successRate,
		averageCostDelta: candidate.averageCost - baseline.averageCost,
		p95LatencyDeltaMs: candidate.p95LatencyMs - baseline.p95LatencyMs,
		regressions,
		improvements,
	};
}

async function grade(
	config: GraderConfig,
	workspace: string,
	run: RunResult,
	events: HarnessEvent[],
): Promise<GraderResult> {
	switch (config.type) {
		case "command": {
			const result = await executeGraderCommand(config.command, workspace, config.timeoutMs ?? 60_000);
			return {
				type: "command",
				passed: result.exitCode === 0 && !result.timedOut,
				hardFailure: result.exitCode !== 0 || result.timedOut,
				message: result.timedOut ? "Command timed out" : `Command exited with ${String(result.exitCode)}`,
			};
		}
		case "file": {
			const path = resolve(workspace, config.path);
			if (!isInside(workspace, path)) {
				return { type: "file", passed: false, hardFailure: true, message: "File assertion escaped workspace" };
			}
			let content: string | undefined;
			try {
				content = await readFile(path, "utf8");
			} catch {
				content = undefined;
			}
			const expectedExists = config.exists ?? true;
			const passed =
				(content !== undefined) === expectedExists &&
				(config.contains === undefined || content?.includes(config.contains) === true) &&
				(config.matches === undefined || (content !== undefined && new RegExp(config.matches, "u").test(content)));
			return { type: "file", passed, hardFailure: false, message: passed ? "File assertion passed" : "File assertion failed" };
		}
		case "trace": {
			const checks = [
				config.toolCalled === undefined ||
					events.some((event) => event.type === "tool_start" && event.attributes.toolName === config.toolCalled),
				config.permissionAction === undefined ||
					events.some(
					(event) =>
						event.type === "permission_decision" && event.attributes.action === config.permissionAction,
				),
				config.maxTurns === undefined || events.filter((event) => event.type === "turn_start").length <= config.maxTurns,
				config.maxTokens === undefined || run.usage.totalTokens <= config.maxTokens,
				config.maxCost === undefined || run.usage.cost.total <= config.maxCost,
			];
			const passed = checks.every(Boolean);
			return { type: "trace", passed, hardFailure: false, message: passed ? "Trace assertion passed" : "Trace assertion failed" };
		}
	}
}

async function snapshotWorkspace(root: string): Promise<Map<string, string>> {
	const snapshot = new Map<string, string>();
	async function visit(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) {
				const digest = createHash("sha256").update(await readFile(path)).digest("hex");
				snapshot.set(relative(root, path), digest);
			}
		}
	}
	await visit(root);
	return snapshot;
}

function compareSnapshots(before: Map<string, string>, after: Map<string, string>): EvalCaseResult["workspaceChanges"] {
	const added = [...after.keys()].filter((path) => !before.has(path)).sort();
	const deleted = [...before.keys()].filter((path) => !after.has(path)).sort();
	const modified = [...after.keys()].filter((path) => before.has(path) && before.get(path) !== after.get(path)).sort();
	return { added, modified, deleted };
}

function percentile(sorted: number[], value: number): number {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ?? 0;
}

function isInside(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
}

function validateFixtureSuite(value: unknown): asserts value is FixtureEvalSuite {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Eval suite must be an object");
	const candidate = value as Record<string, unknown>;
	if (typeof candidate.name !== "string" || !Array.isArray(candidate.cases)) {
		throw new TypeError("Eval suite requires name and cases");
	}
	const ids = new Set<string>();
	for (const item of candidate.cases) {
		if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Eval case must be an object");
		const evalCase = item as Record<string, unknown>;
		if (
			typeof evalCase.id !== "string" ||
			typeof evalCase.input !== "string" ||
			typeof evalCase.timeoutMs !== "number" ||
			!Array.isArray(evalCase.graders) ||
			!Array.isArray(evalCase.tags)
		) {
			throw new TypeError("Eval case requires id, input, timeoutMs, graders, and tags");
		}
		if (ids.has(evalCase.id)) throw new TypeError(`Duplicate eval case id: ${evalCase.id}`);
		ids.add(evalCase.id);
	}
}

function isSweBenchSuite(value: unknown): value is { type: "swebench"; dataset: Record<string, unknown> } {
	return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).type === "swebench");
}

function validateSweBenchSuite(value: unknown): asserts value is SweBenchEvalSuite {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Eval suite must be an object");
	const candidate = value as Record<string, unknown>;
	assertOnlyKeys(candidate, ["type", "name", "dataset", "timeoutMs", "maxTurns", "maxTokens", "maxCost", "tags"], "SWE-bench suite");
	const dataset = candidate.dataset;
	if (
		candidate.type !== "swebench" ||
		typeof candidate.name !== "string" ||
		candidate.name.length === 0 ||
		!dataset ||
		typeof dataset !== "object" ||
		Array.isArray(dataset) ||
		typeof candidate.timeoutMs !== "number" ||
		typeof candidate.maxCost !== "number" ||
		!Array.isArray(candidate.tags)
	) {
		throw new TypeError("SWE-bench suite requires dataset, timeoutMs, maxCost, and tags");
	}
	const source = dataset as Record<string, unknown>;
	assertOnlyKeys(source, ["path", "split", "instanceIds"], "SWE-bench dataset");
	if (
		typeof source.path !== "string" ||
		source.path.length === 0 ||
		(source.split !== "dev" && source.split !== "test") ||
		!Array.isArray(source.instanceIds) ||
		source.instanceIds.length === 0 ||
		source.instanceIds.some((item) => typeof item !== "string" || item.length === 0) ||
		new Set(source.instanceIds).size !== source.instanceIds.length
	) {
		throw new TypeError("SWE-bench dataset requires path, split, and unique non-empty instanceIds");
	}
	for (const key of ["timeoutMs", "maxCost"] as const) {
		const number = candidate[key] as number;
		if (!Number.isFinite(number) || number <= 0) throw new TypeError(`${key} must be a positive finite number`);
	}
	for (const key of ["maxTurns", "maxTokens"] as const) {
		const number = candidate[key];
		if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number) || number <= 0)) {
			throw new TypeError(`${key} must be a positive finite number when provided`);
		}
	}
	if (candidate.tags.some((item) => typeof item !== "string")) throw new TypeError("tags must contain strings");
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
	const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
	if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

export async function persistEvalReport(resultsDir: string, report: EvalReport): Promise<void> {
	const reportDir = resolve(resultsDir, report.id);
	await mkdir(reportDir, { recursive: true });
	await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
	const store = new TraceStore(join(resultsDir, "eval.sqlite"));
	try {
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
				details: reportDetails(report),
			},
			report.cases.map((result): EvalCaseRecord => ({
				evalRunId: report.id,
				caseId: result.caseId,
				...(result.runId === undefined ? {} : { runId: result.runId }),
				passed: result.passed,
				hardFailure: result.hardFailure,
				durationMs: result.durationMs,
				cost: result.cost,
				details: JSON.parse(
					JSON.stringify({
						graders: result.graders,
						workspaceChanges: result.workspaceChanges,
						...(result.benchmark === undefined ? {} : { benchmark: result.benchmark }),
					}),
				) as Record<string, JsonValue>,
			})),
		);
	} finally {
		store.close();
	}
}

export async function replacePersistedEvalReport(resultsDir: string, report: EvalReport): Promise<void> {
	const reportDir = resolve(resultsDir, report.id);
	const store = new TraceStore(join(resultsDir, "eval.sqlite"));
	try {
		store.replaceEvalRun(toEvalRunRecord(report), toEvalCaseRecords(report));
	} finally {
		store.close();
	}
	await writeJsonAtomic(join(reportDir, "report.json"), report);
	await Promise.all(
		report.cases.map((result) => writeJsonAtomic(join(reportDir, result.caseId, "result.json"), result)),
	);
}

function toEvalRunRecord(report: EvalReport): Parameters<TraceStore["replaceEvalRun"]>[0] {
	return {
		id: report.id,
		suite: report.suite,
		startedAt: report.startedAt,
		endedAt: report.endedAt,
		successRate: report.successRate,
		averageCost: report.averageCost,
		p95LatencyMs: report.p95LatencyMs,
		config: report.config,
		details: reportDetails(report),
	};
}

function toEvalCaseRecords(report: EvalReport): EvalCaseRecord[] {
	return report.cases.map((result) => ({
		evalRunId: report.id,
		caseId: result.caseId,
		...(result.runId === undefined ? {} : { runId: result.runId }),
		passed: result.passed,
		hardFailure: result.hardFailure,
		durationMs: result.durationMs,
		cost: result.cost,
		details: JSON.parse(
			JSON.stringify({
				graders: result.graders,
				workspaceChanges: result.workspaceChanges,
				...(result.benchmark === undefined ? {} : { benchmark: result.benchmark }),
			}),
		) as Record<string, JsonValue>,
	}));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(temporary, path);
}

function reportDetails(report: EvalReport): Record<string, JsonValue> {
	return JSON.parse(
		JSON.stringify({
			...(report.metricKind === undefined ? {} : { metricKind: report.metricKind }),
			...(report.generationRate === undefined ? {} : { generationRate: report.generationRate }),
			...(report.benchmark === undefined ? {} : { benchmark: report.benchmark }),
		}),
	) as Record<string, JsonValue>;
}

async function executeGraderCommand(
	command: string,
	cwd: string,
	timeoutMs: number,
): Promise<{ exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/bash", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], {
			cwd,
			stdio: "ignore",
			windowsHide: true,
		});
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.once("error", reject);
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolvePromise({ exitCode, timedOut });
		});
	});
}
