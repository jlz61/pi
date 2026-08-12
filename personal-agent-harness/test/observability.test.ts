import { describe, expect, it } from "vitest";
import type { EvalReport } from "../src/eval.ts";
import { TraceStore } from "../src/node/trace-store.ts";

describe("observability queries", () => {
	it("lists, filters, and summarizes traces", () => {
		const store = new TraceStore(":memory:");
		store.startRun(
			{
				runId: "run-1",
				sessionId: "session-1",
				status: "running",
				startedAt: 1,
				modelProvider: "faux",
				modelId: "faux",
				totalTokens: 0,
				cost: 0,
			},
			{},
		);
		for (const [sequence, type, attributes] of [
			[1, "turn_start", {}],
			[2, "tool_start", {}],
			[3, "permission_decision", { action: "allow" }],
		] as const) {
			store.appendEvent({
				eventId: `event-${sequence}`,
				sessionId: "session-1",
				runId: "run-1",
				timestamp: sequence,
				type,
				attributes,
			});
		}
		store.finishRun({
			runId: "run-1",
			sessionId: "session-1",
			status: "completed",
			startedAt: 1,
			endedAt: 4,
			durationMs: 3,
			modelProvider: "faux",
			modelId: "faux",
			totalTokens: 10,
			cost: 0,
		});
		expect(store.listTraceSummaries({ status: "completed" })[0]).toMatchObject({
			turns: 1,
			toolCalls: 1,
			permissionCounts: { allow: 1, deny: 0 },
		});
		expect(store.getTraceDetail("run-1")?.events).toHaveLength(3);
		store.close();
	});

	it("stores eval reports and immutable named baselines", () => {
		const store = new TraceStore(":memory:");
		const report = createReport("eval-1", true);
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
			[
				{
					evalRunId: report.id,
					caseId: "case-1",
					runId: "run-1",
					passed: true,
					hardFailure: false,
					durationMs: 10,
					cost: 0.1,
					details: { graders: [], workspaceChanges: { added: [], modified: [], deleted: [] } },
				},
			],
		);
		expect(store.getEvalReport("eval-1")).toMatchObject({ id: "eval-1", cases: [{ caseId: "case-1" }] });
		expect(store.saveEvalBaseline("main", report)).toMatchObject({ name: "main", evalRunId: "eval-1" });
		expect(() => store.saveEvalBaseline("main", report)).toThrow(/already exists/u);
		expect(() => store.saveEvalBaseline("Bad Name", report)).toThrow(/Baseline name/u);
		store.close();
	});
});

function createReport(id: string, passed: boolean): EvalReport {
	return {
		id,
		suite: "suite",
		startedAt: 1,
		endedAt: 2,
		successRate: passed ? 1 : 0,
		averageCost: 0.1,
		p95LatencyMs: 10,
		config: { model: "faux" },
		cases: [
			{
				caseId: "case-1",
				runId: "run-1",
				passed,
				hardFailure: false,
				durationMs: 10,
				cost: 0.1,
				graders: [],
				workspaceChanges: { added: [], modified: [], deleted: [] },
			},
		],
	};
}
