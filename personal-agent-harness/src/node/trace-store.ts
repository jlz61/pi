import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EvalCaseResult, EvalReport } from "../eval.ts";
import type { PermissionDecision, PermissionRequest } from "../permission.ts";
import type { HarnessEvent, JsonValue, StoredRun, StoredSpan, TraceDetail, TraceSummary } from "../types.ts";

export interface EvalRunRecord {
	id: string;
	suite: string;
	startedAt: number;
	endedAt: number;
	successRate: number;
	averageCost: number;
	p95LatencyMs: number;
	config: Record<string, JsonValue>;
	details?: Record<string, JsonValue>;
	metricKind?: "fixture" | "generation" | "resolution";
	generationRate?: number;
}

export interface EvalCaseRecord {
	evalRunId: string;
	caseId: string;
	runId?: string;
	passed: boolean;
	hardFailure: boolean;
	durationMs: number;
	cost: number;
	details: Record<string, JsonValue>;
}

export interface EvalBaselineRecord {
	name: string;
	evalRunId: string;
	createdAt: number;
	report: EvalReport;
}

function parseObject(value: string): Record<string, JsonValue> {
	return JSON.parse(value) as Record<string, JsonValue>;
}

export class TraceStore {
	private readonly database: DatabaseSync;

	constructor(path: string) {
		if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
		this.database = new DatabaseSync(path);
		this.database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;");
		this.migrate();
	}

	interruptRunning(now = Date.now()): number {
		const result = this.database
			.prepare("UPDATE runs SET status = 'interrupted', ended_at = ?, duration_ms = ? - started_at WHERE status = 'running'")
			.run(now, now);
		this.database
			.prepare("UPDATE spans SET status = 'error', ended_at = ?, attributes = json_set(attributes, '$.interrupted', json('true')) WHERE status = 'running'")
			.run(now);
		return Number(result.changes);
	}

	startRun(run: StoredRun, config: Record<string, JsonValue>): void {
		const serializedConfig = JSON.stringify(config);
		const configId = createHash("sha256").update(serializedConfig).digest("hex");
		this.database
			.prepare("INSERT OR IGNORE INTO config_versions (id, created_at, config) VALUES (?, ?, ?)")
			.run(configId, run.startedAt, serializedConfig);
		this.database
			.prepare(
				"INSERT INTO runs (run_id, session_id, status, started_at, model_provider, model_id, total_tokens, cost, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				run.runId,
				run.sessionId,
				run.status,
				run.startedAt,
				run.modelProvider,
				run.modelId,
				run.totalTokens,
				run.cost,
				serializedConfig,
			);
	}

	finishRun(run: StoredRun): void {
		this.database
			.prepare(
				"UPDATE runs SET status = ?, ended_at = ?, duration_ms = ?, total_tokens = ?, cost = ?, error = ? WHERE run_id = ?",
			)
			.run(
				run.status,
				run.endedAt ?? null,
				run.durationMs ?? null,
				run.totalTokens,
				run.cost,
				run.error ?? null,
				run.runId,
			);
	}

	startSpan(span: StoredSpan): void {
		this.database
			.prepare(
				"INSERT INTO spans (span_id, run_id, parent_span_id, type, name, status, started_at, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				span.spanId,
				span.runId,
				span.parentSpanId ?? null,
				span.type,
				span.name,
				span.status,
				span.startedAt,
				JSON.stringify(span.attributes),
			);
	}

	finishSpan(spanId: string, status: "ok" | "error", endedAt: number, attributes: Record<string, JsonValue>): void {
		this.database
			.prepare("UPDATE spans SET status = ?, ended_at = ?, attributes = ? WHERE span_id = ?")
			.run(status, endedAt, JSON.stringify(attributes), spanId);
	}

	appendEvent(event: Omit<HarnessEvent, "sequence">): HarnessEvent {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const row = this.database
				.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events WHERE session_id = ?")
				.get(event.sessionId) as { next: number };
			const committed: HarnessEvent = { ...event, sequence: row.next };
			this.database
				.prepare(
					"INSERT INTO events (event_id, session_id, run_id, turn_id, span_id, parent_span_id, sequence, timestamp, type, attributes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					committed.eventId,
					committed.sessionId,
					committed.runId ?? null,
					committed.turnId ?? null,
					committed.spanId ?? null,
					committed.parentSpanId ?? null,
					committed.sequence,
					committed.timestamp,
					committed.type,
					JSON.stringify(committed.attributes),
				);
			this.database.exec("COMMIT");
			return committed;
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	recordPermission(request: PermissionRequest, decision: PermissionDecision, timestamp = Date.now()): void {
		this.database
			.prepare(
				"INSERT INTO permissions (session_id, run_id, timestamp, tool_name, resources, args_summary, action, source, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				request.sessionId,
				request.runId,
				timestamp,
				request.toolName,
				JSON.stringify(request.resources),
				JSON.stringify(request.argsSummary),
				decision.action,
				decision.source,
				decision.reason ?? null,
			);
	}

	getRun(runId: string): StoredRun | undefined {
		const row = this.database.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
		return row ? runFromRow(row) : undefined;
	}

	listRuns(sessionId?: string): StoredRun[] {
		const rows = (sessionId
			? this.database.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY started_at DESC").all(sessionId)
			: this.database.prepare("SELECT * FROM runs ORDER BY started_at DESC").all()) as unknown as RunRow[];
		return rows.map(runFromRow);
	}

	listTraceSummaries(options: { limit?: number; status?: StoredRun["status"] } = {}): TraceSummary[] {
		const limit = normalizeLimit(options.limit);
		const rows = (options.status === undefined
			? this.database.prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit)
			: this.database
					.prepare("SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?")
					.all(options.status, limit)) as unknown as RunRow[];
		return rows.map((row) => this.createTraceSummary(runFromRow(row)));
	}

	getTraceDetail(runId: string): TraceDetail | undefined {
		const run = this.getRun(runId);
		if (!run) return undefined;
		return {
			...this.createTraceSummary(run),
			spans: this.getSpans(runId),
			events: this.getEvents(runId),
		};
	}

	getEvents(runId: string): HarnessEvent[] {
		const rows = this.database
			.prepare("SELECT * FROM events WHERE run_id = ? ORDER BY sequence")
			.all(runId) as unknown as EventRow[];
		return rows.map((row) => ({
			eventId: row.event_id,
			sessionId: row.session_id,
			...(row.run_id === null ? {} : { runId: row.run_id }),
			...(row.turn_id === null ? {} : { turnId: row.turn_id }),
			...(row.span_id === null ? {} : { spanId: row.span_id }),
			...(row.parent_span_id === null ? {} : { parentSpanId: row.parent_span_id }),
			sequence: row.sequence,
			timestamp: row.timestamp,
			type: row.type,
			attributes: parseObject(row.attributes),
		}));
	}

	getSpans(runId: string): StoredSpan[] {
		const rows = this.database
			.prepare("SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, rowid")
			.all(runId) as unknown as SpanRow[];
		return rows.map((row) => ({
			spanId: row.span_id,
			runId: row.run_id,
			...(row.parent_span_id === null ? {} : { parentSpanId: row.parent_span_id }),
			type: row.type,
			name: row.name,
			status: row.status,
			startedAt: row.started_at,
			...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
			attributes: parseObject(row.attributes),
		}));
	}

	saveEvalRun(run: EvalRunRecord, cases: EvalCaseRecord[]): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			this.database
				.prepare(
					"INSERT INTO eval_runs (id, suite, started_at, ended_at, success_rate, average_cost, p95_latency_ms, config, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					run.id,
					run.suite,
					run.startedAt,
					run.endedAt,
					run.successRate,
					run.averageCost,
					run.p95LatencyMs,
					JSON.stringify(run.config),
					JSON.stringify(run.details ?? {}),
				);
			const statement = this.database.prepare(
				"INSERT INTO eval_case_results (eval_run_id, case_id, run_id, passed, hard_failure, duration_ms, cost, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const item of cases) {
				statement.run(
					item.evalRunId,
					item.caseId,
					item.runId ?? null,
					item.passed ? 1 : 0,
					item.hardFailure ? 1 : 0,
					item.durationMs,
					item.cost,
					JSON.stringify(item.details),
				);
			}
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	replaceEvalRun(run: EvalRunRecord, cases: EvalCaseRecord[]): void {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const updated = this.database
				.prepare(
					"UPDATE eval_runs SET suite = ?, started_at = ?, ended_at = ?, success_rate = ?, average_cost = ?, p95_latency_ms = ?, config = ?, details = ? WHERE id = ?",
				)
				.run(
					run.suite,
					run.startedAt,
					run.endedAt,
					run.successRate,
					run.averageCost,
					run.p95LatencyMs,
					JSON.stringify(run.config),
					JSON.stringify(run.details ?? {}),
					run.id,
				);
			if (updated.changes !== 1) throw new Error(`Eval run does not exist: ${run.id}`);
			this.database.prepare("DELETE FROM eval_case_results WHERE eval_run_id = ?").run(run.id);
			const statement = this.database.prepare(
				"INSERT INTO eval_case_results (eval_run_id, case_id, run_id, passed, hard_failure, duration_ms, cost, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			);
			for (const item of cases) {
				if (item.evalRunId !== run.id) throw new Error(`Eval case belongs to a different run: ${item.caseId}`);
				statement.run(
					item.evalRunId,
					item.caseId,
					item.runId ?? null,
					item.passed ? 1 : 0,
					item.hardFailure ? 1 : 0,
					item.durationMs,
					item.cost,
					JSON.stringify(item.details),
				);
			}
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}

	listEvalRuns(limit = 20): EvalRunRecord[] {
		const rows = this.database
			.prepare("SELECT * FROM eval_runs ORDER BY started_at DESC LIMIT ?")
			.all(normalizeLimit(limit)) as unknown as EvalRunRow[];
		return rows.map(evalRunFromRow);
	}

	getEvalReport(id: string): EvalReport | undefined {
		const row = this.database.prepare("SELECT * FROM eval_runs WHERE id = ?").get(id) as EvalRunRow | undefined;
		if (!row) return undefined;
		const caseRows = this.database
			.prepare("SELECT * FROM eval_case_results WHERE eval_run_id = ? ORDER BY case_id")
			.all(id) as unknown as EvalCaseResultRow[];
		return {
			...evalRunFromRow(row),
			cases: caseRows.map(evalCaseResultFromRow),
		};
	}

	saveEvalBaseline(name: string, report: EvalReport, createdAt = Date.now()): EvalBaselineRecord {
		validateBaselineName(name);
		try {
			this.database
				.prepare("INSERT INTO eval_baselines (name, eval_run_id, created_at, report) VALUES (?, ?, ?, ?)")
				.run(name, report.id, createdAt, JSON.stringify(report));
		} catch (error) {
			if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
				throw new Error(`Baseline already exists: ${name}`);
			}
			throw error;
		}
		return { name, evalRunId: report.id, createdAt, report };
	}

	listEvalBaselines(): EvalBaselineRecord[] {
		const rows = this.database
			.prepare("SELECT * FROM eval_baselines ORDER BY created_at DESC, name")
			.all() as unknown as EvalBaselineRow[];
		return rows.map(evalBaselineFromRow);
	}

	getEvalBaseline(name: string): EvalBaselineRecord | undefined {
		const row = this.database.prepare("SELECT * FROM eval_baselines WHERE name = ?").get(name) as
			| EvalBaselineRow
			| undefined;
		return row ? evalBaselineFromRow(row) : undefined;
	}

	close(): void {
		this.database.close();
	}

	private createTraceSummary(run: StoredRun): TraceSummary {
		const rows = this.database
			.prepare(
				`SELECT
					SUM(CASE WHEN type = 'turn_start' THEN 1 ELSE 0 END) AS turns,
					SUM(CASE WHEN type = 'tool_start' THEN 1 ELSE 0 END) AS tool_calls,
					SUM(CASE WHEN type = 'permission_decision' AND json_extract(attributes, '$.action') = 'allow' THEN 1 ELSE 0 END) AS permission_allow,
					SUM(CASE WHEN type = 'permission_decision' AND json_extract(attributes, '$.action') = 'deny' THEN 1 ELSE 0 END) AS permission_deny
				FROM events WHERE run_id = ?`,
			)
			.get(run.runId) as unknown as TraceAggregateRow;
		return {
			run,
			turns: rows.turns ?? 0,
			toolCalls: rows.tool_calls ?? 0,
			permissionCounts: { allow: rows.permission_allow ?? 0, deny: rows.permission_deny ?? 0 },
		};
	}

	private migrate(): void {
		this.database.exec(`
			CREATE TABLE IF NOT EXISTS config_versions (
				id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				config TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS runs (
				run_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				duration_ms INTEGER,
				model_provider TEXT NOT NULL,
				model_id TEXT NOT NULL,
				total_tokens INTEGER NOT NULL DEFAULT 0,
				cost REAL NOT NULL DEFAULT 0,
				error TEXT,
				config TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_runs_session_started ON runs(session_id, started_at DESC);
			CREATE TABLE IF NOT EXISTS spans (
				span_id TEXT PRIMARY KEY,
				run_id TEXT NOT NULL,
				parent_span_id TEXT,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				status TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER,
				attributes TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS idx_spans_run_started ON spans(run_id, started_at);
			CREATE TABLE IF NOT EXISTS events (
				event_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				run_id TEXT,
				turn_id TEXT,
				span_id TEXT,
				parent_span_id TEXT,
				sequence INTEGER NOT NULL,
				timestamp INTEGER NOT NULL,
				type TEXT NOT NULL,
				attributes TEXT NOT NULL,
				UNIQUE(session_id, sequence)
			);
			CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events(run_id, sequence);
			CREATE TABLE IF NOT EXISTS permissions (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				run_id TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				tool_name TEXT NOT NULL,
				resources TEXT NOT NULL,
				args_summary TEXT NOT NULL,
				action TEXT NOT NULL,
				source TEXT NOT NULL,
				reason TEXT
			);
			CREATE TABLE IF NOT EXISTS eval_runs (
				id TEXT PRIMARY KEY,
				suite TEXT NOT NULL,
				started_at INTEGER NOT NULL,
				ended_at INTEGER NOT NULL,
				success_rate REAL NOT NULL,
				average_cost REAL NOT NULL,
				p95_latency_ms REAL NOT NULL,
				config TEXT NOT NULL,
				details TEXT NOT NULL DEFAULT '{}'
			);
			CREATE TABLE IF NOT EXISTS eval_case_results (
				eval_run_id TEXT NOT NULL,
				case_id TEXT NOT NULL,
				run_id TEXT,
				passed INTEGER NOT NULL,
				hard_failure INTEGER NOT NULL,
				duration_ms INTEGER NOT NULL,
				cost REAL NOT NULL,
				details TEXT NOT NULL,
				PRIMARY KEY(eval_run_id, case_id)
			);
			CREATE TABLE IF NOT EXISTS eval_baselines (
				name TEXT PRIMARY KEY,
				eval_run_id TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				report TEXT NOT NULL
			);
		`);
		const columns = this.database.prepare("PRAGMA table_info(eval_runs)").all() as unknown as { name: string }[];
		if (!columns.some((column) => column.name === "details")) {
			this.database.exec("ALTER TABLE eval_runs ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
		}
	}
}

interface RunRow {
	run_id: string;
	session_id: string;
	status: StoredRun["status"];
	started_at: number;
	ended_at: number | null;
	duration_ms: number | null;
	model_provider: string;
	model_id: string;
	total_tokens: number;
	cost: number;
	error: string | null;
}

interface EventRow {
	event_id: string;
	session_id: string;
	run_id: string | null;
	turn_id: string | null;
	span_id: string | null;
	parent_span_id: string | null;
	sequence: number;
	timestamp: number;
	type: string;
	attributes: string;
}

interface SpanRow {
	span_id: string;
	run_id: string;
	parent_span_id: string | null;
	type: string;
	name: string;
	status: StoredSpan["status"];
	started_at: number;
	ended_at: number | null;
	attributes: string;
}

interface TraceAggregateRow {
	turns: number | null;
	tool_calls: number | null;
	permission_allow: number | null;
	permission_deny: number | null;
}

interface EvalRunRow {
	id: string;
	suite: string;
	started_at: number;
	ended_at: number;
	success_rate: number;
	average_cost: number;
	p95_latency_ms: number;
	config: string;
	details: string;
}

interface EvalCaseResultRow {
	eval_run_id: string;
	case_id: string;
	run_id: string | null;
	passed: number;
	hard_failure: number;
	duration_ms: number;
	cost: number;
	details: string;
}

interface EvalBaselineRow {
	name: string;
	eval_run_id: string;
	created_at: number;
	report: string;
}

function runFromRow(row: RunRow): StoredRun {
	return {
		runId: row.run_id,
		sessionId: row.session_id,
		status: row.status,
		startedAt: row.started_at,
		...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
		...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
		modelProvider: row.model_provider,
		modelId: row.model_id,
		totalTokens: row.total_tokens,
		cost: row.cost,
		...(row.error === null ? {} : { error: row.error }),
	};
}

function evalRunFromRow(row: EvalRunRow): Omit<EvalReport, "cases"> {
	const details = parseObject(row.details);
	return {
		id: row.id,
		suite: row.suite,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		successRate: row.success_rate,
		averageCost: row.average_cost,
		p95LatencyMs: row.p95_latency_ms,
		config: parseObject(row.config),
		...(details.metricKind === "fixture" || details.metricKind === "generation" || details.metricKind === "resolution"
			? { metricKind: details.metricKind }
			: {}),
		...(typeof details.generationRate === "number" ? { generationRate: details.generationRate } : {}),
		...(details.benchmark && typeof details.benchmark === "object" && !Array.isArray(details.benchmark)
			? { benchmark: details.benchmark as unknown as NonNullable<EvalReport["benchmark"]> }
			: {}),
	};
}

function evalCaseResultFromRow(row: EvalCaseResultRow): EvalCaseResult {
	const details = parseObject(row.details);
	return {
		caseId: row.case_id,
		...(row.run_id === null ? {} : { runId: row.run_id }),
		passed: row.passed === 1,
		hardFailure: row.hard_failure === 1,
		durationMs: row.duration_ms,
		cost: row.cost,
		graders: details.graders as unknown as EvalCaseResult["graders"],
		workspaceChanges: details.workspaceChanges as unknown as EvalCaseResult["workspaceChanges"],
		...(details.benchmark && typeof details.benchmark === "object" && !Array.isArray(details.benchmark)
			? { benchmark: details.benchmark as unknown as NonNullable<EvalCaseResult["benchmark"]> }
			: {}),
	};
}

function evalBaselineFromRow(row: EvalBaselineRow): EvalBaselineRecord {
	return {
		name: row.name,
		evalRunId: row.eval_run_id,
		createdAt: row.created_at,
		report: JSON.parse(row.report) as EvalReport,
	};
}

function normalizeLimit(value = 20): number {
	if (!Number.isInteger(value) || value < 1 || value > 1_000) throw new Error("limit must be an integer from 1 to 1000");
	return value;
}

export function validateBaselineName(name: string): void {
	if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) {
		throw new Error("Baseline name must use lowercase letters, numbers, dots, underscores, or hyphens");
	}
}
