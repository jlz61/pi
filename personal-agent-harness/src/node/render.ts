import type { EvalCaseResult, EvalComparison, EvalReport } from "../eval.ts";
import type { SweBenchBundleExportResult, SweBenchBundleImportResult } from "../eval-bundle.ts";
import type { DoctorReport, RunResult, SessionSummary, StoredSpan, TraceDetail, TraceSummary } from "../types.ts";
import type { EvalBaselineRecord, EvalRunRecord } from "./trace-store.ts";

export function renderJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function renderDoctor(report: DoctorReport): string {
	const lines = [`诊断结果：${statusLabel(report.status)}`];
	for (const check of report.checks) lines.push(`${checkMark(check.status)} ${check.label}：${check.message}`);
	return `${lines.join("\n")}\n`;
}

export function renderRun(result: RunResult, dataDir: string): string {
	const text = result.finalMessage?.role === "assistant"
		? result.finalMessage.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n")
		: "";
	const lines = text ? [text, ""] : [];
	lines.push(
		`运行状态：${statusLabel(result.status)}`,
		`Run ID：${result.runId}`,
		`Session ID：${result.sessionId}`,
		`耗时：${formatDuration(result.durationMs)}，Token：${result.usage.totalTokens}，成本：${formatCost(result.usage.cost.total)}`,
		`查看 Trace：harness trace show ${result.runId} --data-dir ${dataDir}`,
	);
	if (result.error) lines.push(`错误：${result.error}`);
	return `${lines.join("\n")}\n`;
}

export function renderSessions(sessions: SessionSummary[]): string {
	if (sessions.length === 0) return "暂无 Session。\n";
	return `${sessions
		.map(
			(session) =>
				`${session.id}  ${session.model.provider}/${session.model.modelId}  ${new Date(session.createdAt).toLocaleString()}  ${session.cwd}`,
		)
		.join("\n")}\n`;
}

export function renderTraceList(summaries: TraceSummary[]): string {
	if (summaries.length === 0) return "暂无 Trace。\n";
	const lines = summaries.map(({ run, turns, toolCalls, permissionCounts }) =>
		[
			run.runId,
			statusLabel(run.status),
			`${run.modelProvider}/${run.modelId}`,
			formatDuration(run.durationMs ?? 0),
			`turn=${turns}`,
			`tool=${toolCalls}`,
			`allow=${permissionCounts.allow}`,
			`deny=${permissionCounts.deny}`,
		].join("  "),
	);
	return `${lines.join("\n")}\n`;
}

export function renderTraceDetail(detail: TraceDetail): string {
	const { run } = detail;
	const lines = [
		`Run：${run.runId}`,
		`状态：${statusLabel(run.status)}`,
		`Session：${run.sessionId}`,
		`模型：${run.modelProvider}/${run.modelId}`,
		`开始时间：${new Date(run.startedAt).toLocaleString()}`,
		`耗时：${formatDuration(run.durationMs ?? 0)}`,
		`Token：${run.totalTokens}，成本：${formatCost(run.cost)}`,
		`Turn：${detail.turns}，Tool：${detail.toolCalls}，权限允许/拒绝：${detail.permissionCounts.allow}/${detail.permissionCounts.deny}`,
	];
	if (run.error) lines.push(`错误：${run.error}`);
	lines.push("", "Span：", ...renderSpanTree(detail.spans));
	return `${lines.join("\n")}\n`;
}

export function renderEvalList(runs: EvalRunRecord[]): string {
	if (runs.length === 0) return "暂无 Eval 结果。\n";
	return `${runs
		.map(
			(run) =>
				`${run.id}  ${run.suite}  ${metricLabel(run.metricKind)}=${formatPercent(run.successRate)}  成本=${formatCost(run.averageCost)}  P95=${formatDuration(run.p95LatencyMs)}`,
		)
		.join("\n")}\n`;
}

export function renderEvalReport(report: EvalReport, reportPath?: string): string {
	const isGeneration = report.metricKind === "generation";
	const isResolution = report.metricKind === "resolution";
	const lines = [
		`Eval：${report.id}`,
		`Suite：${report.suite}`,
		`${isGeneration ? "Patch 生成率" : isResolution ? "官方解决率" : "成功率"}：${formatPercent(report.successRate)}`,
		`平均成本：${formatCost(report.averageCost)}`,
		`P95 延迟：${formatDuration(report.p95LatencyMs)}`,
	];
	if (report.benchmark) {
		lines.push(`数据集：SWE-bench Lite/${report.benchmark.split}，Case：${report.benchmark.instanceIds.length}`);
		if (report.generationRate !== undefined) lines.push(`Patch 生成率：${formatPercent(report.generationRate)}`);
		if (report.benchmark.gradingStatus === "completed" && report.benchmark.officialGrading) {
			const grading = report.benchmark.officialGrading;
			lines.push(
				`官方评分：完成，解决率 ${formatPercent(grading.resolutionRate ?? 0)}`,
				`Resolved/Unresolved/Error：${grading.resolvedIds.length}/${grading.unresolvedIds.length}/${grading.errorIds.length}`,
				`评分产物：${grading.artifactsDir}`,
			);
		} else {
			lines.push("官方评分：未运行，Patch 生成成功不代表 Issue 已解决");
		}
	}
	if (reportPath) lines.push(`报告：${reportPath}`);
	lines.push("", "Cases：");
	for (const result of report.cases) {
		const caseLabel = result.benchmark?.officialGrading
			? result.benchmark.officialGrading.status === "resolved"
				? "[已解决]"
				: result.benchmark.officialGrading.status === "unresolved"
					? "[未解决]"
					: "[评分错误]"
			: result.benchmark
			? result.benchmark.generationStatus === "generated"
				? "[已生成]"
				: `[${generationStatusLabel(result.benchmark.generationStatus)}]`
			: result.passed
				? "[通过]"
				: "[失败]";
		lines.push(
			`${caseLabel} ${result.caseId}  ${formatDuration(result.durationMs)}  ${formatCost(result.cost)}${result.hardFailure ? "  硬失败" : ""}`,
		);
		for (const grader of result.graders) {
			lines.push(`  ${grader.passed ? "✓" : "✗"} ${grader.type}：${grader.message}`);
		}
		const changes = result.workspaceChanges;
		lines.push(`  变更：新增 ${changes.added.length}，修改 ${changes.modified.length}，删除 ${changes.deleted.length}`);
		if (result.runId) lines.push(`  Run ID：${result.runId}`);
		if (result.benchmark) lines.push(`  Patch：${result.benchmark.patchPath}`);
	}
	return `${lines.join("\n")}\n`;
}

export function renderEvalComparison(comparison: EvalComparison): string {
	const comparisonLabel = metricLabel(comparison.metricKind);
	const lines = [
		`Baseline：${comparison.baselineId}`,
		`Candidate：${comparison.candidateId}`,
		`${comparisonLabel}变化：${formatSigned(comparison.successRateDelta * 100, "%")}`,
		`平均成本变化：${formatSigned(comparison.averageCostDelta, "")}`,
		`P95 延迟变化：${formatSigned(comparison.p95LatencyDeltaMs, "ms")}`,
		`回归：${comparison.regressions.length}`,
		...comparison.regressions.map((item) => `  ✗ ${item}`),
		`改进：${comparison.improvements.length}`,
		...comparison.improvements.map((item) => `  ✓ ${item}`),
	];
	return `${lines.join("\n")}\n`;
}

export function renderBundleExport(result: SweBenchBundleExportResult): string {
	return [
		`评分包已导出：${result.outputPath}`,
		`Eval：${result.evalId}`,
		`Bundle ID：${result.bundleId}`,
		`Case：${result.caseCount}，大小：${result.bytes} bytes`,
	].join("\n") + "\n";
}

export function renderBundleImport(result: SweBenchBundleImportResult): string {
	return [
		`评分结果已导入：${result.evalId}`,
		`Bundle ID：${result.bundleId}`,
		`Grade ID：${result.gradeId}`,
		`官方解决率：${formatPercent(result.resolutionRate)}`,
		`Resolved/Unresolved/Error：${result.resolved}/${result.unresolved}/${result.errors}`,
	].join("\n") + "\n";
}

export function renderBaselines(records: EvalBaselineRecord[]): string {
	if (records.length === 0) return "暂无 Eval Baseline。\n";
	return `${records
		.map(
			(record) =>
				`${record.name}  eval=${record.evalRunId}  suite=${record.report.suite}  ${metricLabel(record.report.metricKind)}=${formatPercent(record.report.successRate)}  ${new Date(record.createdAt).toLocaleString()}`,
		)
		.join("\n")}\n`;
}

function generationStatusLabel(status: NonNullable<EvalCaseResult["benchmark"]>["generationStatus"]): string {
	const labels = {
		generated: "已生成",
		empty_patch: "空 Patch",
		agent_failed: "Agent 失败",
		infrastructure_failed: "基础设施失败",
	};
	return labels[status];
}

function renderSpanTree(spans: StoredSpan[]): string[] {
	const children = new Map<string | undefined, StoredSpan[]>();
	for (const span of spans) {
		const list = children.get(span.parentSpanId) ?? [];
		list.push(span);
		children.set(span.parentSpanId, list);
	}
	const lines: string[] = [];
	const visit = (span: StoredSpan, depth: number): void => {
		const duration = span.endedAt === undefined ? "进行中" : formatDuration(span.endedAt - span.startedAt);
		lines.push(`${"  ".repeat(depth)}${span.status === "ok" ? "✓" : "✗"} ${span.type}/${span.name}  ${duration}`);
		for (const child of children.get(span.spanId) ?? []) visit(child, depth + 1);
	};
	for (const root of children.get(undefined) ?? []) visit(root, 0);
	return lines.length === 0 ? ["(无 Span)"] : lines;
}

function formatDuration(value: number): string {
	return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatCost(value: number): string {
	return `$${value.toFixed(6)}`;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function formatSigned(value: number, suffix: string): string {
	return `${value >= 0 ? "+" : ""}${value.toFixed(suffix === "%" ? 1 : 6)}${suffix}`;
}

function metricLabel(kind: EvalReport["metricKind"]): string {
	if (kind === "generation") return "生成率";
	if (kind === "resolution") return "解决率";
	return "成功率";
}

function statusLabel(status: string): string {
	const labels: Record<string, string> = {
		ok: "正常",
		warn: "警告",
		fail: "失败",
		completed: "完成",
		failed: "失败",
		aborted: "已中止",
		interrupted: "被中断",
		running: "运行中",
	};
	return labels[status] ?? status;
}

function checkMark(status: string): string {
	if (status === "ok") return "[通过]";
	if (status === "warn") return "[警告]";
	return "[失败]";
}
