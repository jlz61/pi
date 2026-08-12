import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import { EventDispatcher } from "./events.ts";
import type { HookExecution } from "./hooks.ts";
import type { TraceStore } from "./node/trace-store.ts";
import {
	addUsage,
	emptyUsage,
	type HarnessEvent,
	type JsonValue,
	type StoredSpan,
	type TraceCaptureOptions,
} from "./types.ts";

interface ActiveSpan {
	span: StoredSpan;
	attributes: Record<string, JsonValue>;
}

function assistantUsage(message: AgentMessage): Usage | undefined {
	return message.role === "assistant" ? message.usage : undefined;
}

function toolUsage(message: AgentMessage): Usage | undefined {
	return message.role === "toolResult" ? message.usage : undefined;
}

export class TraceRecorder {
	readonly usage = emptyUsage();
	readonly runSpanId = uuidv7();
	turnCount = 0;
	lastAssistant?: AssistantMessage;
	private readonly store: TraceStore;
	private readonly dispatcher: EventDispatcher;
	private readonly sessionId: string;
	private readonly runId: string;
	private readonly spans = new Map<string, ActiveSpan>();
	private readonly toolSpans = new Map<string, string>();
	private currentTurnId: string | undefined;
	private currentTurnSpanId: string | undefined;
	private requestSpanId: string | undefined;
	private requestStartedAt: number | undefined;
	private firstTokenAt: number | undefined;
	private fallbackSequence = 0;
	private storageErrors = 0;
	private readonly capture: TraceCaptureOptions;

	constructor(options: {
		store: TraceStore;
		dispatcher: EventDispatcher;
		sessionId: string;
		runId: string;
		startedAt: number;
		modelProvider: string;
		modelId: string;
		capture: TraceCaptureOptions;
	}) {
		this.store = options.store;
		this.dispatcher = options.dispatcher;
		this.sessionId = options.sessionId;
		this.runId = options.runId;
		this.capture = options.capture;
		this.startSpan({
			spanId: this.runSpanId,
			runId: options.runId,
			type: "run",
			name: "harness.run",
			status: "running",
			startedAt: options.startedAt,
			attributes: { modelProvider: options.modelProvider, modelId: options.modelId },
		});
		this.emit("run_start", {}, { spanId: this.runSpanId });
	}

	recordAgentEvent(event: AgentEvent): void {
		const now = Date.now();
		switch (event.type) {
			case "agent_start":
			case "agent_end":
				this.emit(event.type, { messageCount: event.type === "agent_end" ? event.messages.length : 0 });
				break;
			case "turn_start": {
				this.turnCount++;
				this.currentTurnId = uuidv7();
				this.currentTurnSpanId = uuidv7();
				this.startSpan({
					spanId: this.currentTurnSpanId,
					runId: this.runId,
					parentSpanId: this.runSpanId,
					type: "turn",
					name: "harness.turn",
					status: "running",
					startedAt: now,
					attributes: { turn: this.turnCount },
				});
				this.emit("turn_start", { turn: this.turnCount }, this.turnIds());
				break;
			}
			case "turn_end": {
				const failed = event.message.role === "assistant" && event.message.stopReason === "error";
				this.emit("turn_end", { toolResults: event.toolResults.length, failed }, this.turnIds());
				if (this.currentTurnSpanId) this.finishSpan(this.currentTurnSpanId, failed ? "error" : "ok", now, {});
				this.currentTurnId = undefined;
				this.currentTurnSpanId = undefined;
				break;
			}
			case "message_start":
				if (event.message.role === "assistant") this.startRequest(now);
				this.emit("message_start", { role: event.message.role }, this.messageIds());
				break;
			case "message_update":
				this.firstTokenAt ??= now;
				this.emit("message_update", { deltaType: event.assistantMessageEvent.type }, this.messageIds());
				break;
			case "message_end":
				this.recordMessageEnd(event.message, now);
				break;
			case "tool_execution_start": {
				const spanId = uuidv7();
				this.toolSpans.set(event.toolCallId, spanId);
				this.startSpan({
					spanId,
					runId: this.runId,
					...(this.currentTurnSpanId === undefined ? {} : { parentSpanId: this.currentTurnSpanId }),
					type: "tool",
					name: `harness.tool.${event.toolName}`,
					status: "running",
					startedAt: now,
					attributes: { toolName: event.toolName, toolCallId: event.toolCallId },
				});
				this.emit(
					"tool_start",
					{ toolName: event.toolName, toolCallId: event.toolCallId },
					{
						...this.turnIds(),
						spanId,
						...(this.currentTurnSpanId === undefined ? {} : { parentSpanId: this.currentTurnSpanId }),
					},
				);
				break;
			}
			case "tool_execution_update":
				this.emit(
					"tool_update",
					{ toolName: event.toolName, toolCallId: event.toolCallId },
					this.toolIds(event.toolCallId),
				);
				break;
			case "tool_execution_end": {
				const spanId = this.toolSpans.get(event.toolCallId);
				this.emit(
					"tool_end",
					{ toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError },
					this.toolIds(event.toolCallId),
				);
				if (spanId) this.finishSpan(spanId, event.isError ? "error" : "ok", now, { isError: event.isError });
				this.toolSpans.delete(event.toolCallId);
				break;
			}
		}
	}

	recordHook(execution: HookExecution): void {
		const spanId = uuidv7();
		const attributes: Record<string, JsonValue> = { hook: execution.name };
		if (execution.error) attributes.error = execution.error;
		this.startSpan({
			spanId,
			runId: this.runId,
			parentSpanId: this.runSpanId,
			type: "hook",
			name: `harness.hook.${execution.name}`,
			status: "running",
			startedAt: execution.startedAt,
			attributes,
		});
		this.finishSpan(spanId, execution.status, execution.endedAt, attributes);
		this.emit("hook_end", { hook: execution.name, status: execution.status }, { spanId, parentSpanId: this.runSpanId });
	}

	finish(status: "completed" | "failed" | "aborted", endedAt: number, error?: string): void {
		for (const [spanId, active] of this.spans) {
			if (spanId !== this.runSpanId) this.finishSpan(spanId, "error", endedAt, { ...active.attributes, incomplete: true });
		}
		const attributes: Record<string, JsonValue> = {
			outcome: status,
			turns: this.turnCount,
			totalTokens: this.usage.totalTokens,
			cost: this.usage.cost.total,
			storageErrors: this.storageErrors,
		};
		if (error) attributes.error = error;
		this.emit("run_end", attributes, { spanId: this.runSpanId });
		this.finishSpan(this.runSpanId, status === "failed" ? "error" : "ok", endedAt, attributes);
	}

	emitPermission(attributes: Record<string, JsonValue>): void {
		this.emit("permission_decision", attributes);
	}

	private recordMessageEnd(message: AgentMessage, now: number): void {
		const usage = assistantUsage(message) ?? toolUsage(message);
		if (usage) addUsage(this.usage, usage);
		const attributes: Record<string, JsonValue> = { role: message.role };
		if (this.capture.mode === "redacted") {
			try {
				attributes.content = this.capture.redactor(messageText(message), { kind: "message", role: message.role });
			} catch {
				attributes.redactionError = true;
			}
		}
		if (message.role === "assistant") {
			this.lastAssistant = message;
			attributes.stopReason = message.stopReason;
			attributes.totalTokens = message.usage.totalTokens;
			attributes.cost = message.usage.cost.total;
			if (message.errorMessage) attributes.error = message.errorMessage;
			if (this.requestSpanId) {
				this.finishSpan(this.requestSpanId, message.stopReason === "error" ? "error" : "ok", now, {
					stopReason: message.stopReason,
					totalTokens: message.usage.totalTokens,
					cost: message.usage.cost.total,
					...(this.firstTokenAt === undefined || this.requestStartedAt === undefined
						? {}
						: { firstTokenMs: this.firstTokenAt - this.requestStartedAt }),
				});
			}
			this.requestSpanId = undefined;
			this.requestStartedAt = undefined;
			this.firstTokenAt = undefined;
		}
		this.emit("message_end", attributes, this.messageIds());
	}

	private startRequest(startedAt: number): void {
		this.requestSpanId = uuidv7();
		this.requestStartedAt = startedAt;
		this.firstTokenAt = undefined;
		this.startSpan({
			spanId: this.requestSpanId,
			runId: this.runId,
			...(this.currentTurnSpanId === undefined ? {} : { parentSpanId: this.currentTurnSpanId }),
			type: "model_request",
			name: "pi.ai.request",
			status: "running",
			startedAt,
			attributes: {},
		});
	}

	private startSpan(span: StoredSpan): void {
		this.spans.set(span.spanId, { span, attributes: { ...span.attributes } });
		try {
			this.store.startSpan(span);
		} catch {
			this.storageErrors++;
		}
	}

	private finishSpan(
		spanId: string,
		status: "ok" | "error",
		endedAt: number,
		attributes: Record<string, JsonValue>,
	): void {
		const active = this.spans.get(spanId);
		if (!active) return;
		const merged = { ...active.attributes, ...attributes };
		try {
			this.store.finishSpan(spanId, status, endedAt, merged);
		} catch {
			this.storageErrors++;
		}
		this.spans.delete(spanId);
	}

	private emit(
		type: string,
		attributes: Record<string, JsonValue>,
		ids: { turnId?: string; spanId?: string; parentSpanId?: string } = {},
	): void {
		const event = {
			eventId: uuidv7(),
			sessionId: this.sessionId,
			runId: this.runId,
			...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
			...(ids.spanId === undefined ? {} : { spanId: ids.spanId }),
			...(ids.parentSpanId === undefined ? {} : { parentSpanId: ids.parentSpanId }),
			timestamp: Date.now(),
			type,
			attributes,
		};
		let committed: HarnessEvent;
		try {
			committed = this.store.appendEvent(event);
			this.fallbackSequence = committed.sequence;
		} catch {
			this.storageErrors++;
			committed = { ...event, sequence: ++this.fallbackSequence };
		}
		this.dispatcher.emit(committed);
	}

	private turnIds(): { turnId?: string; spanId?: string; parentSpanId?: string } {
		return {
			...(this.currentTurnId === undefined ? {} : { turnId: this.currentTurnId }),
			...(this.currentTurnSpanId === undefined ? {} : { spanId: this.currentTurnSpanId }),
			parentSpanId: this.runSpanId,
		};
	}

	private messageIds(): { turnId?: string; spanId?: string; parentSpanId?: string } {
		return {
			...(this.currentTurnId === undefined ? {} : { turnId: this.currentTurnId }),
			...(this.requestSpanId === undefined ? {} : { spanId: this.requestSpanId }),
			...(this.currentTurnSpanId === undefined ? {} : { parentSpanId: this.currentTurnSpanId }),
		};
	}

	private toolIds(toolCallId: string): { turnId?: string; spanId?: string; parentSpanId?: string } {
		const spanId = this.toolSpans.get(toolCallId);
		return {
			...(this.currentTurnId === undefined ? {} : { turnId: this.currentTurnId }),
			...(spanId === undefined ? {} : { spanId }),
			...(this.currentTurnSpanId === undefined ? {} : { parentSpanId: this.currentTurnSpanId }),
		};
	}
}

function messageText(message: AgentMessage): string {
	if (message.role === "user") {
		if (typeof message.content === "string") return message.content;
		return message.content.map((part) => (part.type === "text" ? part.text : `[image:${part.mimeType}]`)).join("\n");
	}
	if (message.role === "assistant") {
		return message.content
			.map((part) => {
				if (part.type === "text") return part.text;
				if (part.type === "thinking") return part.thinking;
				return `[tool:${part.name}]`;
			})
			.join("\n");
	}
	if (!("content" in message)) return `[message:${message.role}]`;
	const content: unknown = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return `[message:${message.role}]`;
	return content
		.map((part: unknown) => {
			if (!part || typeof part !== "object") return "[content]";
			const block = part as Record<string, unknown>;
			if (block.type === "text" && typeof block.text === "string") return block.text;
			if (block.type === "image" && typeof block.mimeType === "string") return `[image:${block.mimeType}]`;
			return "[content]";
		})
		.join("\n");
}
