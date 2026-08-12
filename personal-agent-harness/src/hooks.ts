import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentMessage,
	BeforeToolCallContext,
} from "@earendil-works/pi-agent-core";

export interface BeforeRunEvent {
	messages: AgentMessage[];
	systemPrompt: string;
}

export interface BeforeRunResult {
	messages?: AgentMessage[];
	systemPrompt?: string;
}

export interface TransformContextEvent {
	messages: AgentMessage[];
}

export interface TransformContextResult {
	messages: AgentMessage[];
}

export interface BeforeToolResult {
	block?: { reason: string };
}

export interface AfterRunEvent {
	status: "completed" | "failed" | "aborted";
	error?: string;
}

export type HookName = "before_run" | "transform_context" | "before_tool" | "after_tool" | "after_run";

export interface HookExecution {
	name: HookName;
	startedAt: number;
	endedAt: number;
	status: "ok" | "error";
	error?: string;
}

export type HookExecutionObserver = (execution: HookExecution) => void;
export type BeforeRunHook = (event: BeforeRunEvent) => BeforeRunResult | undefined | Promise<BeforeRunResult | undefined>;
export type TransformContextHook = (
	event: TransformContextEvent,
) => TransformContextResult | undefined | Promise<TransformContextResult | undefined>;
export type BeforeToolHook = (
	event: BeforeToolCallContext,
) => BeforeToolResult | undefined | Promise<BeforeToolResult | undefined>;
export type AfterToolHook = (
	event: AfterToolCallContext,
) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
export type AfterRunHook = (event: AfterRunEvent) => void | Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateBeforeRunResult(value: unknown): asserts value is BeforeRunResult | undefined {
	if (value === undefined) return;
	if (!isRecord(value)) throw new TypeError("before_run hook result must be an object");
	if (value.systemPrompt !== undefined && typeof value.systemPrompt !== "string") {
		throw new TypeError("before_run.systemPrompt must be a string");
	}
	if (value.messages !== undefined && !Array.isArray(value.messages)) {
		throw new TypeError("before_run.messages must be an array");
	}
}

function validateTransformResult(value: unknown): asserts value is TransformContextResult | undefined {
	if (value === undefined) return;
	if (!isRecord(value) || !Array.isArray(value.messages)) {
		throw new TypeError("transform_context hook result must contain a messages array");
	}
}

function validateBeforeToolResult(value: unknown): asserts value is BeforeToolResult | undefined {
	if (value === undefined) return;
	if (!isRecord(value)) throw new TypeError("before_tool hook result must be an object");
	if (value.block !== undefined) {
		if (!isRecord(value.block) || typeof value.block.reason !== "string") {
			throw new TypeError("before_tool.block.reason must be a string");
		}
	}
}

function validateAfterToolResult(value: unknown): asserts value is AfterToolCallResult | undefined {
	if (value === undefined) return;
	if (!isRecord(value)) throw new TypeError("after_tool hook result must be an object");
	if (value.content !== undefined && !Array.isArray(value.content)) {
		throw new TypeError("after_tool.content must be an array");
	}
	if (value.isError !== undefined && typeof value.isError !== "boolean") {
		throw new TypeError("after_tool.isError must be a boolean");
	}
	if (value.terminate !== undefined && typeof value.terminate !== "boolean") {
		throw new TypeError("after_tool.terminate must be a boolean");
	}
}

export class HookRegistry {
	private readonly beforeRunHooks: BeforeRunHook[] = [];
	private readonly transformContextHooks: TransformContextHook[] = [];
	private readonly beforeToolHooks: BeforeToolHook[] = [];
	private readonly afterToolHooks: AfterToolHook[] = [];
	private readonly afterRunHooks: AfterRunHook[] = [];

	on(name: "before_run", hook: BeforeRunHook): () => void;
	on(name: "transform_context", hook: TransformContextHook): () => void;
	on(name: "before_tool", hook: BeforeToolHook): () => void;
	on(name: "after_tool", hook: AfterToolHook): () => void;
	on(name: "after_run", hook: AfterRunHook): () => void;
	on(
		name: HookName,
		hook: BeforeRunHook | TransformContextHook | BeforeToolHook | AfterToolHook | AfterRunHook,
	): () => void {
		const list = this.listFor(name);
		list.push(hook);
		return () => {
			const index = list.indexOf(hook);
			if (index >= 0) list.splice(index, 1);
		};
	}

	async runBeforeRun(event: BeforeRunEvent, observer?: HookExecutionObserver): Promise<BeforeRunEvent> {
		let current = { messages: [...event.messages], systemPrompt: event.systemPrompt };
		for (const hook of this.beforeRunHooks) {
			const result = await this.execute("before_run", () => hook(current), false, observer);
			validateBeforeRunResult(result);
			if (result?.messages) current = { ...current, messages: [...current.messages, ...result.messages] };
			if (result?.systemPrompt !== undefined) current = { ...current, systemPrompt: result.systemPrompt };
		}
		return current;
	}

	async runTransformContext(
		messages: AgentMessage[],
		observer?: HookExecutionObserver,
	): Promise<AgentMessage[]> {
		let current = [...messages];
		for (const hook of this.transformContextHooks) {
			const result = await this.execute(
				"transform_context",
				() => hook({ messages: current }),
				false,
				observer,
			);
			validateTransformResult(result);
			if (result) current = [...result.messages];
		}
		return current;
	}

	async runBeforeTool(event: BeforeToolCallContext, observer?: HookExecutionObserver): Promise<BeforeToolResult> {
		for (const hook of this.beforeToolHooks) {
			const result = await this.execute("before_tool", () => hook(event), true, observer);
			validateBeforeToolResult(result);
			if (result?.block) return result;
		}
		return {};
	}

	async runAfterTool(
		event: AfterToolCallContext,
		observer?: HookExecutionObserver,
	): Promise<AfterToolCallResult | undefined> {
		let combined: AfterToolCallResult | undefined;
		for (const hook of this.afterToolHooks) {
			const result = await this.execute("after_tool", () => hook(event), false, observer);
			validateAfterToolResult(result);
			if (result) combined = { ...combined, ...result };
		}
		return combined;
	}

	async runAfterRun(event: AfterRunEvent, observer?: HookExecutionObserver): Promise<void> {
		for (const hook of this.afterRunHooks) {
			await this.execute("after_run", () => hook(event), false, observer);
		}
	}

	private listFor(
		name: HookName,
	): Array<BeforeRunHook | TransformContextHook | BeforeToolHook | AfterToolHook | AfterRunHook> {
		switch (name) {
			case "before_run":
				return this.beforeRunHooks;
			case "transform_context":
				return this.transformContextHooks;
			case "before_tool":
				return this.beforeToolHooks;
			case "after_tool":
				return this.afterToolHooks;
			case "after_run":
				return this.afterRunHooks;
		}
	}

	private async execute<T>(
		name: HookName,
		execute: () => T | Promise<T>,
		failClosed: boolean,
		observer?: HookExecutionObserver,
	): Promise<T | undefined> {
		const startedAt = Date.now();
		try {
			const result = await execute();
			observer?.({ name, startedAt, endedAt: Date.now(), status: "ok" });
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			observer?.({ name, startedAt, endedAt: Date.now(), status: "error", error: message });
			if (failClosed) return { block: { reason: `Hook ${name} failed: ${message}` } } as T;
			return undefined;
		}
	}
}
