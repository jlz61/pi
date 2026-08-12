import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { compareEvalReports, EvalRunner, readEvalReport, readEvalSuite, type EvalReport } from "./eval.ts";
import {
	exportSweBenchGradingBundle,
	importSweBenchGradingResult,
	readSweBenchGradingResult,
} from "./eval-bundle.ts";
import type { PermissionRule } from "./permission.ts";
import {
	resolveSweBenchPython,
	runSweBenchDoctor,
	SweBenchBridge,
	SweBenchRunner,
} from "./swebench.ts";
import { resolveSweBenchGraderPython, SweBenchOfficialGrader } from "./swebench-grader.ts";
import type { RegisteredTool, RunStatus } from "./types.ts";
import {
	loadHarnessConfig,
	resolveModelSelection,
	sanitizedConfigSnapshot,
	type HarnessCliConfig,
	type ModelSelection,
} from "./node/config.ts";
import { runDoctor } from "./node/doctor.ts";
import { NodeHarness } from "./node/harness.ts";
import { createNetworkRuntime, type NetworkRuntime } from "./node/network.ts";
import {
	renderBaselines,
	renderBundleExport,
	renderBundleImport,
	renderDoctor,
	renderEvalComparison,
	renderEvalList,
	renderEvalReport,
	renderJson,
	renderRun,
	renderSessions,
	renderTraceDetail,
	renderTraceList,
} from "./node/render.ts";
import { TraceStore } from "./node/trace-store.ts";

type OutputFormat = "human" | "json";

export interface CliIo {
	cwd: string;
	env: NodeJS.ProcessEnv;
	stdout: { write(value: string): unknown };
	stderr: { write(value: string): unknown };
}

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string>;
}

interface ModelRuntime {
	models: Models;
	model: Model<Api>;
	network: NetworkRuntime;
}

const defaultIo: CliIo = {
	cwd: process.cwd(),
	env: process.env,
	stdout: process.stdout,
	stderr: process.stderr,
};

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
	let format: OutputFormat = "human";
	try {
		const parsed = parseArgs(args);
		format = parseFormat(parsed.flags.get("format"));
		const [command] = parsed.positionals;
		let config: HarnessCliConfig;
		try {
			config = await loadHarnessConfig(parsed.flags.get("config") ?? "harness.config.json");
		} catch (error) {
			if (command !== "doctor") throw error;
			const report = {
				status: "fail" as const,
				checks: [{ id: "config", label: "配置文件", status: "fail" as const, message: errorMessage(error) }],
			};
			io.stdout.write(format === "json" ? renderJson(report) : renderDoctor(report));
			return 1;
		}
		return await execute(parsed, config, format, io);
	} catch (error) {
		if (format === "json") {
			io.stdout.write(renderJson({ ok: false, error: { code: "CLI_ERROR", message: errorMessage(error) } }));
		} else {
			io.stderr.write(`错误：${errorMessage(error)}\n`);
		}
		return 1;
	}
}

async function execute(parsed: ParsedArgs, config: HarnessCliConfig, format: OutputFormat, io: CliIo): Promise<number> {
	const [command, subcommand, ...rest] = parsed.positionals;
	const dataDir = resolve(io.cwd, parsed.flags.get("data-dir") ?? config.dataDir ?? ".harness");
	const resultsDir = resolve(io.cwd, parsed.flags.get("results-dir") ?? "eval-results");

	if (command === "doctor") return runDoctorCommand(parsed, config, dataDir, format, io);
	if (command === "trace") return runTraceCommand(subcommand, rest, parsed, dataDir, format, io);
	if (command === "eval" && subcommand === "swebench" && rest[0] === "doctor") {
		return runSweBenchDoctorCommand(required(rest[1], "SWE-bench Suite 路径"), parsed, config, resultsDir, format, io);
	}
	if (command === "eval" && subcommand === "swebench" && rest[0] === "grade") {
		return runSweBenchGradeCommand(required(rest[1], "Eval ID 或 latest"), parsed, config, resultsDir, format, io);
	}
	if (command === "eval" && subcommand !== "run") {
		return runEvalQueryCommand(subcommand, rest, parsed, resultsDir, format, io);
	}

	const runtime = resolveModelRuntime(parsed, config, io.env);
	try {
		if (command === "eval" && subcommand === "run") {
			const suitePath = required(rest[0], "Eval Suite 路径");
			const suite = await readEvalSuite(suitePath);
			const configSnapshot = sanitizedConfigSnapshot(config, {
					provider: runtime.model.provider,
					modelId: runtime.model.id,
			});
			const report = suite.type === "swebench"
				? await new SweBenchRunner({
						resultsDir,
						bridge: new SweBenchBridge({
							pythonExecutable: resolveSweBenchPython({
								cliValue: parsed.flags.get("python"),
								env: io.env,
								configValue: config.swebench?.pythonExecutable,
								cwd: io.cwd,
							}),
						}),
						modelName: `${runtime.model.provider}/${runtime.model.id}`,
						config: configSnapshot,
						createHarness: (cwd, caseDataDir, options) =>
							createHarness(runtime, config, caseDataDir, cwd, options),
					}).run(suite, parsed.flags.get("instance-id"))
				: await new EvalRunner({
						resultsDir,
						config: configSnapshot,
						createHarness: (cwd, caseDataDir) => createHarness(runtime, config, caseDataDir, cwd),
					}).run(suite);
			const reportPath = resolve(resultsDir, report.id, "report.json");
			io.stdout.write(format === "json" ? renderJson(report) : renderEvalReport(report, reportPath));
			if (format === "human") io.stdout.write(`查看结果：harness eval show ${report.id} --results-dir ${resultsDir}\n`);
			return report.successRate < 1 ? 1 : 0;
		}

		const harness = await createHarness(runtime, config, dataDir, parsed.flags.get("cwd") ?? io.cwd);
		try {
			if (command === "run") {
				const prompt = required([subcommand, ...rest].filter(Boolean).join(" "), "Prompt");
				const result = await (await harness.createSession()).run(prompt);
				io.stdout.write(format === "json" ? renderJson(result) : renderRun(result, dataDir));
				return result.status === "completed" ? 0 : 1;
			}
			if (command === "session" && subcommand === "list") {
				const sessions = await harness.listSessions();
				io.stdout.write(format === "json" ? renderJson(sessions) : renderSessions(sessions));
				return 0;
			}
			if (command === "session" && subcommand === "continue") {
				const session = await harness.openSession(required(rest[0], "Session ID"));
				const result = await session.run(required(rest.slice(1).join(" "), "Prompt"));
				io.stdout.write(format === "json" ? renderJson(result) : renderRun(result, dataDir));
				return result.status === "completed" ? 0 : 1;
			}
			io.stderr.write(usage());
			return 2;
		} finally {
			await harness.close();
		}
	} finally {
		await runtime.network.close();
	}
}

async function runSweBenchDoctorCommand(
	suitePath: string,
	parsed: ParsedArgs,
	config: HarnessCliConfig,
	resultsDir: string,
	format: OutputFormat,
	io: CliIo,
): Promise<number> {
	const suite = await readEvalSuite(suitePath);
	if (suite.type !== "swebench") throw new Error("该文件不是 SWE-bench Suite");
	const bridge = new SweBenchBridge({
		pythonExecutable: resolveSweBenchPython({
			cliValue: parsed.flags.get("python"),
			env: io.env,
			configValue: config.swebench?.pythonExecutable,
			cwd: io.cwd,
		}),
	});
	const report = await runSweBenchDoctor({
		suite,
		bridge,
		cacheDir: resolve(resultsDir, "cache", "swebench-lite", "repos"),
	});
	const grader = new SweBenchOfficialGrader({
		resultsDir,
		env: io.env,
		pythonExecutable: resolveSweBenchGraderPython({
			cliValue: parsed.flags.get("grader-python"),
			env: io.env,
			configValue: config.swebench?.graderPythonExecutable,
			cwd: io.cwd,
		}),
	});
	const graderReport = await grader.doctor();
	const combined = {
		status: report.status === "fail" ? "fail" as const : graderReport.status === "ok" ? report.status : "warn" as const,
		checks: [
			...report.checks.filter((check) => check.id !== "docker"),
			...graderReport.checks.map((check) => ({
				...check,
				status: check.status === "fail" ? "warn" as const : check.status,
			})),
		],
	};
	io.stdout.write(format === "json" ? renderJson(combined) : renderDoctor(combined));
	return combined.status === "fail" ? 1 : 0;
}

async function runSweBenchGradeCommand(
	reference: string,
	parsed: ParsedArgs,
	config: HarnessCliConfig,
	resultsDir: string,
	format: OutputFormat,
	io: CliIo,
): Promise<number> {
	const store = new TraceStore(resolve(resultsDir, "eval.sqlite"));
	let report: EvalReport;
	try {
		report = resolveStoredEval(store, reference);
	} finally {
		store.close();
	}
	const grader = new SweBenchOfficialGrader({
		resultsDir,
		env: io.env,
		pythonExecutable: resolveSweBenchGraderPython({
			cliValue: parsed.flags.get("grader-python"),
			env: io.env,
			configValue: config.swebench?.graderPythonExecutable,
			cwd: io.cwd,
		}),
	});
	const namespace = parseSweBenchNamespace(parsed.flags.get("namespace"));
	const graded = await grader.grade(report, {
		maxWorkers: parsePositiveInteger(parsed.flags.get("max-workers"), 1, "--max-workers"),
		timeoutSeconds: parsePositiveInteger(parsed.flags.get("timeout"), 1_800, "--timeout"),
		...(namespace === undefined ? {} : { namespace }),
	});
	io.stdout.write(format === "json" ? renderJson(graded) : renderEvalReport(graded, resolve(resultsDir, graded.id, "report.json")));
	return 0;
}

function parseSweBenchNamespace(value: string | undefined): "none" | "swebench" | undefined {
	if (value === undefined) return undefined;
	if (value === "none" || value === "swebench") return value;
	throw new Error("--namespace 必须是 none 或 swebench");
}

async function runDoctorCommand(
	parsed: ParsedArgs,
	config: HarnessCliConfig,
	dataDir: string,
	format: OutputFormat,
	io: CliIo,
): Promise<number> {
	const models = builtinModels();
	const selection = resolveModelSelection(
		config,
		{
			...(parsed.flags.get("provider") === undefined ? {} : { provider: parsed.flags.get("provider")! }),
			...(parsed.flags.get("model") === undefined ? {} : { model: parsed.flags.get("model")! }),
		},
		io.env,
	);
	const network = createNetworkRuntime(models, config.network, io.env);
	try {
		const report = await runDoctor({ config, dataDir, cwd: io.cwd, models, network, ...(selection ? { selection } : {}) });
		io.stdout.write(format === "json" ? renderJson(report) : renderDoctor(report));
		return report.status === "fail" ? 1 : 0;
	} finally {
		await network.close();
	}
}

function runTraceCommand(
	subcommand: string | undefined,
	rest: string[],
	parsed: ParsedArgs,
	dataDir: string,
	format: OutputFormat,
	io: CliIo,
): number {
	const store = new TraceStore(resolve(dataDir, "harness.sqlite"));
	try {
		if (subcommand === "list") {
			const status = parseRunStatus(parsed.flags.get("status"));
			const summaries = store.listTraceSummaries({
				limit: parseLimit(parsed.flags.get("limit")),
				...(status === undefined ? {} : { status }),
			});
			io.stdout.write(format === "json" ? renderJson(summaries) : renderTraceList(summaries));
			return 0;
		}
		if (subcommand === "show") {
			const reference = required(rest[0], "Run ID 或 latest");
			const runId = reference === "latest" ? store.listTraceSummaries({ limit: 1 })[0]?.run.runId : reference;
			if (!runId) throw new Error("暂无 Trace");
			const detail = store.getTraceDetail(runId);
			if (!detail) throw new Error(`Run 不存在：${runId}`);
			io.stdout.write(format === "json" ? renderJson(detail) : renderTraceDetail(detail));
			return 0;
		}
		throw new Error("Trace 命令应为 list 或 show");
	} finally {
		store.close();
	}
}

async function runEvalQueryCommand(
	subcommand: string | undefined,
	rest: string[],
	parsed: ParsedArgs,
	resultsDir: string,
	format: OutputFormat,
	io: CliIo,
): Promise<number> {
	const store = new TraceStore(resolve(resultsDir, "eval.sqlite"));
	try {
		if (subcommand === "list") {
			const runs = store.listEvalRuns(parseLimit(parsed.flags.get("limit")));
			io.stdout.write(format === "json" ? renderJson(runs) : renderEvalList(runs));
			return 0;
		}
		if (subcommand === "show") {
			const report = resolveStoredEval(store, required(rest[0], "Eval ID 或 latest"));
			io.stdout.write(format === "json" ? renderJson(report) : renderEvalReport(report));
			return 0;
		}
		if (subcommand === "baseline" && rest[0] === "list") {
			const records = store.listEvalBaselines();
			io.stdout.write(format === "json" ? renderJson(records) : renderBaselines(records));
			return 0;
		}
		if (subcommand === "baseline" && rest[0] === "save") {
			const report = resolveStoredEval(store, required(rest[1], "Eval ID 或 latest"));
			const baseline = store.saveEvalBaseline(required(parsed.flags.get("name"), "Baseline 名称"), report);
			io.stdout.write(format === "json" ? renderJson(baseline) : renderBaselines([baseline]));
			return 0;
		}
		if (subcommand === "compare") {
			const baseline = await resolveEvalReference(required(rest[0], "Baseline 引用"), store, resultsDir);
			const candidate = await resolveEvalReference(required(rest[1], "Candidate 引用"), store, resultsDir);
			const comparison = compareEvalReports(baseline, candidate);
			io.stdout.write(format === "json" ? renderJson(comparison) : renderEvalComparison(comparison));
			return comparison.regressions.length > 0 ? 1 : 0;
		}
		if (subcommand === "export") {
			const report = resolveStoredEval(store, required(rest[0], "Eval ID 或 latest"));
			const exported = await exportSweBenchGradingBundle({
				resultsDir,
				report,
				outputPath: required(parsed.flags.get("output"), "--output 路径"),
			});
			io.stdout.write(format === "json" ? renderJson(exported) : renderBundleExport(exported));
			return 0;
		}
		if (subcommand === "import") {
			const resultPath = required(rest[0], "评分结果 JSON 路径");
			const gradingResult = await readSweBenchGradingResult(resultPath);
			const report = resolveStoredEval(store, gradingResult.evalId);
			const imported = await importSweBenchGradingResult({ resultsDir, report, resultPath });
			io.stdout.write(format === "json" ? renderJson(imported.summary) : renderBundleImport(imported.summary));
			return imported.summary.errors > 0 ? 1 : 0;
		}
		throw new Error("Eval 命令应为 list、show、baseline、compare、export、import 或 run");
	} finally {
		store.close();
	}
}

async function resolveEvalReference(reference: string, store: TraceStore, resultsDir: string): Promise<EvalReport> {
	if (reference.startsWith("baseline:")) {
		const baseline = store.getEvalBaseline(reference.slice("baseline:".length));
		if (!baseline) throw new Error(`Baseline 不存在：${reference}`);
		return baseline.report;
	}
	if (reference === "latest" || reference.startsWith("eval:")) {
		return resolveStoredEval(store, reference === "latest" ? reference : reference.slice("eval:".length));
	}
	const direct = resolve(reference);
	const fromResults = resolve(resultsDir, reference);
	if (existsSync(direct)) return readEvalReport(direct);
	if (existsSync(fromResults)) return readEvalReport(fromResults);
	const stored = store.getEvalReport(reference);
	if (stored) return stored;
	throw new Error(`Eval 引用不存在：${reference}`);
}

function resolveStoredEval(store: TraceStore, reference: string): EvalReport {
	const id = reference === "latest" ? store.listEvalRuns(1)[0]?.id : reference;
	if (!id) throw new Error("暂无 Eval 结果");
	const report = store.getEvalReport(id);
	if (!report) throw new Error(`Eval 不存在：${id}`);
	return report;
}

function resolveModelRuntime(parsed: ParsedArgs, config: HarnessCliConfig, env: NodeJS.ProcessEnv): ModelRuntime {
	const selection = resolveModelSelection(
		config,
		{
			...(parsed.flags.get("provider") === undefined ? {} : { provider: parsed.flags.get("provider")! }),
			...(parsed.flags.get("model") === undefined ? {} : { model: parsed.flags.get("model")! }),
		},
		env,
	);
	if (!selection) throw new Error("需要配置模型：使用 --provider/--model、环境变量或 harness.config.json");
	const models = builtinModels();
	const model = models.getModel(selection.provider, selection.modelId) as Model<Api> | undefined;
	if (!model) throw new Error(`模型不存在：${selection.provider}/${selection.modelId}`);
	return { models, model, network: createNetworkRuntime(models, config.network, env) };
}

async function createHarness(
	runtime: ModelRuntime,
	config: HarnessCliConfig,
	dataDir: string,
	cwd: string,
	overrides?: {
		tools: RegisteredTool[];
		permissionRules: PermissionRule[];
		systemPrompt: string;
		disabledBuiltinTools: string[];
	},
): Promise<NodeHarness> {
	return NodeHarness.create({
		dataDir,
		cwd,
		model: runtime.model,
		streamFn: runtime.network.streamFn,
		resolveModel: (provider, modelId) => runtime.models.getModel(provider, modelId),
		...(overrides?.systemPrompt === undefined
			? config.systemPrompt === undefined
				? {}
				: { systemPrompt: config.systemPrompt }
			: { systemPrompt: overrides.systemPrompt }),
		...(overrides?.permissionRules === undefined
			? config.permissions === undefined
				? {}
				: { permissionRules: config.permissions }
			: { permissionRules: overrides.permissionRules }),
		...(overrides?.tools === undefined ? {} : { tools: overrides.tools }),
		...(overrides?.disabledBuiltinTools === undefined
			? {}
			: { disabledBuiltinTools: overrides.disabledBuiltinTools }),
	});
}

function parseArgs(args: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string>();
	for (let index = 0; index < args.length; index++) {
		const value = args[index]!;
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const name = value.slice(2);
		const flagValue = args[++index];
		if (!flagValue || flagValue.startsWith("--")) throw new Error(`参数 --${name} 需要值`);
		flags.set(name, flagValue);
	}
	return { positionals, flags };
}

function parseFormat(value: string | undefined): OutputFormat {
	if (value === undefined || value === "human") return "human";
	if (value === "json") return "json";
	throw new Error("--format 必须为 human 或 json");
}

function parseLimit(value: string | undefined): number {
	if (value === undefined) return 20;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("--limit 必须是 1 到 1000 的整数");
	return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} 必须是正整数`);
	return parsed;
}

function parseRunStatus(value: string | undefined): RunStatus | "running" | undefined {
	if (value === undefined) return undefined;
	if (["completed", "failed", "aborted", "interrupted", "running"].includes(value)) {
		return value as RunStatus | "running";
	}
	throw new Error("--status 不合法");
}

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`缺少${name}`);
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isBrokenPipeError(error: NodeJS.ErrnoException): boolean {
	return error.code === "EPIPE";
}

function usage(): string {
	return `用法：
  harness doctor [--format human|json]
  harness run "<prompt>"
  harness session list
  harness session continue <session-id> "<prompt>"
  harness trace list [--limit 20 --status completed]
  harness trace show <run-id|latest>
  harness eval run <suite.json> [--results-dir path]
  harness eval run <swebench-suite.json> [--instance-id id --python path]
  harness eval swebench doctor <suite.json> [--python path]
  harness eval swebench grade <eval-id|latest> [--grader-python path --timeout 1800 --max-workers 1 --namespace none|swebench]
  harness eval list [--limit 20]
  harness eval show <eval-id|latest>
  harness eval baseline save <eval-id|latest> --name <name>
  harness eval baseline list
  harness eval compare <baseline:name|eval-id|latest|report.json> <candidate>
  harness eval export <eval-id|latest> --output <bundle.tar.gz>
  harness eval import <grading-result.json> [--results-dir path]
`;
}
