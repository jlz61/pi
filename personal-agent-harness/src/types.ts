import type {
	AgentMessage,
	AgentTool,
	AgentEvent,
	AfterToolCallContext,
	AfterToolCallResult,
	BeforeToolCallContext,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, TSchema, Usage } from "@earendil-works/pi-ai";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AgentInput = string | AgentMessage | { text: string; images?: ImageContent[] };

export interface RunBudget {
	timeoutMs?: number;
	maxTurns?: number;
	/** Maximum uncached input, output, and cache-write tokens accumulated by the run. */
	maxTokens?: number;
	maxCost?: number;
}

export interface RunOptions extends RunBudget {
	configVersion?: string;
}

export type RunStatus = "completed" | "failed" | "aborted" | "interrupted";

export interface RunResult {
	runId: string;
	sessionId: string;
	status: RunStatus;
	finalMessage?: AgentMessage;
	usage: Usage;
	durationMs: number;
	error?: string;
}

export interface CreateSessionOptions {
	id?: string;
	cwd?: string;
	systemPrompt?: string;
	metadata?: Record<string, JsonValue>;
}

export interface SessionSummary {
	id: string;
	cwd: string;
	createdAt: number;
	model: { provider: string; modelId: string };
}

export interface HarnessEvent {
	eventId: string;
	sessionId: string;
	runId?: string;
	turnId?: string;
	spanId?: string;
	parentSpanId?: string;
	sequence: number;
	timestamp: number;
	type: string;
	attributes: Record<string, JsonValue>;
}

export type HarnessEventListener = (event: HarnessEvent) => void | Promise<void>;

export interface RuntimeRequest {
	messages: AgentMessage[];
}

export type RuntimeEvent = AgentEvent;

export type TraceCaptureOptions =
	| { mode: "metadata-only" }
	| {
			mode: "redacted";
			redactor: (value: string, context: { kind: "message"; role: string }) => string;
	  };

export interface AgentRuntimeAdapter {
	run(request: RuntimeRequest): AsyncIterable<RuntimeEvent>;
	steer(input: AgentMessage): void;
	abort(): void;
}

export interface RuntimeAdapterOptions {
	sessionId: string;
	systemPrompt: string;
	model: Model<Api>;
	streamFn: StreamFn;
	messages: AgentMessage[];
	tools: AgentTool<TSchema, unknown>[];
	transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
	beforeToolCall?: (
		context: BeforeToolCallContext,
		signal?: AbortSignal,
	) => Promise<{ block?: boolean; reason?: string } | undefined>;
	afterToolCall?: (
		context: AfterToolCallContext,
		signal?: AbortSignal,
	) => Promise<AfterToolCallResult | undefined>;
}

export interface RuntimeAdapterFactory {
	create(options: RuntimeAdapterOptions): AgentRuntimeAdapter;
}

export interface RegisteredTool {
	tool: AgentTool<TSchema, unknown>;
	resolveResources(args: unknown, cwd: string): Promise<string[]> | string[];
	summarizeArgs?(args: unknown): Record<string, string | number | boolean>;
}

export interface StoredRun {
	runId: string;
	sessionId: string;
	status: RunStatus | "running";
	startedAt: number;
	endedAt?: number;
	durationMs?: number;
	modelProvider: string;
	modelId: string;
	totalTokens: number;
	cost: number;
	error?: string;
}

export interface StoredSpan {
	spanId: string;
	runId: string;
	parentSpanId?: string;
	type: string;
	name: string;
	status: "running" | "ok" | "error";
	startedAt: number;
	endedAt?: number;
	attributes: Record<string, JsonValue>;
}

export interface TraceSummary {
	run: StoredRun;
	turns: number;
	toolCalls: number;
	permissionCounts: { allow: number; deny: number };
}

export interface TraceDetail extends TraceSummary {
	spans: StoredSpan[];
	events: HarnessEvent[];
}

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
	id: string;
	label: string;
	status: DoctorCheckStatus;
	message: string;
}

export interface DoctorReport {
	status: DoctorCheckStatus;
	checks: DoctorCheck[];
}

export function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(target: Usage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
	if (usage.reasoning !== undefined) target.reasoning = (target.reasoning ?? 0) + usage.reasoning;
	if (usage.cacheWrite1h !== undefined) target.cacheWrite1h = (target.cacheWrite1h ?? 0) + usage.cacheWrite1h;
}
