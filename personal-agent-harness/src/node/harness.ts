import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentMessage,
	BeforeToolCallContext,
	StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { uuidv7 } from "@earendil-works/pi-ai";
import { EventDispatcher } from "../events.ts";
import { HookRegistry } from "../hooks.ts";
import {
	PermissionBroker,
	type PermissionPrompt,
	type PermissionRule,
} from "../permission.ts";
import { PiRuntimeAdapterFactory } from "../runtime.ts";
import { ToolRegistry } from "../tool-registry.ts";
import { TraceRecorder } from "../trace-recorder.ts";
import type {
	AgentInput,
	AgentRuntimeAdapter,
	CreateSessionOptions,
	HarnessEventListener,
	JsonValue,
	RegisteredTool,
	RunOptions,
	RunResult,
	RuntimeAdapterFactory,
	SessionSummary,
	StoredRun,
	TraceCaptureOptions,
} from "../types.ts";
import { canonicalizeWorkspace, createBuiltinTools, isWithinWorkspace } from "./tools.ts";
import { PiSessionStore, type DurableSessionHandle } from "./session-store.ts";
import { TraceStore } from "./trace-store.ts";

export interface HarnessSession {
	readonly id: string;
	run(input: AgentInput, options?: RunOptions): Promise<RunResult>;
	steer(input: AgentInput): void;
	abort(): void;
	subscribe(listener: HarnessEventListener): () => void;
}

export interface Harness {
	readonly hooks: HookRegistry;
	createSession(options?: CreateSessionOptions): Promise<HarnessSession>;
	openSession(sessionId: string): Promise<HarnessSession>;
	listSessions(): Promise<SessionSummary[]>;
	close(): Promise<void>;
}

export interface NodeHarnessOptions {
	dataDir: string;
	cwd?: string;
	model: Model<Api>;
	streamFn: StreamFn;
	systemPrompt?: string;
	permissionRules?: PermissionRule[];
	permissionPrompt?: PermissionPrompt;
	tools?: RegisteredTool[];
	disabledBuiltinTools?: string[];
	capture?: TraceCaptureOptions;
	runtimeFactory?: RuntimeAdapterFactory;
	resolveModel?: (provider: string, modelId: string) => Model<Api> | undefined | Promise<Model<Api> | undefined>;
}

export class NodeHarness implements Harness {
	readonly hooks = new HookRegistry();
	readonly traceStore: TraceStore;
	private readonly options: NodeHarnessOptions;
	private readonly cwd: string;
	private readonly sessionStore: PiSessionStore;
	private readonly runtimeFactory: RuntimeAdapterFactory;
	private readonly sessions = new Map<string, NodeHarnessSession>();
	private closed = false;

	private constructor(options: NodeHarnessOptions, cwd: string, traceStore: TraceStore, sessionStore: PiSessionStore) {
		this.options = options;
		this.cwd = cwd;
		this.traceStore = traceStore;
		this.sessionStore = sessionStore;
		this.runtimeFactory = options.runtimeFactory ?? new PiRuntimeAdapterFactory();
	}

	static async create(options: NodeHarnessOptions): Promise<NodeHarness> {
		const cwd = await canonicalizeWorkspace(options.cwd ?? process.cwd());
		const dataDir = resolve(options.dataDir);
		const traceStore = new TraceStore(resolve(dataDir, "harness.sqlite"));
		traceStore.interruptRunning();
		const sessionStore = new PiSessionStore(resolve(dataDir, "sessions.sqlite"), cwd);
		return new NodeHarness(options, cwd, traceStore, sessionStore);
	}

	async createSession(options: CreateSessionOptions = {}): Promise<HarnessSession> {
		this.assertOpen();
		const cwd = await canonicalizeWorkspace(options.cwd ?? this.cwd);
		const handle = await this.sessionStore.create({
			...(options.id === undefined ? {} : { id: options.id }),
			cwd,
			modelProvider: this.options.model.provider,
			modelId: this.options.model.id,
			systemPrompt: options.systemPrompt ?? this.options.systemPrompt ?? "You are a careful coding assistant.",
			...(options.metadata === undefined ? {} : { metadata: options.metadata }),
		});
		return this.createSessionFacade(handle, this.options.model);
	}

	async openSession(sessionId: string): Promise<HarnessSession> {
		this.assertOpen();
		const handle = await this.sessionStore.open(sessionId);
		const model = await this.resolveModel(handle.harnessMetadata.modelProvider, handle.harnessMetadata.modelId);
		return this.createSessionFacade(handle, model);
	}

	async listSessions(): Promise<SessionSummary[]> {
		this.assertOpen();
		return this.sessionStore.list();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await Promise.all([...this.sessions.values()].map((session) => session.close()));
		await this.sessionStore.close();
		this.traceStore.close();
	}

	private createSessionFacade(handle: DurableSessionHandle, model: Model<Api>): NodeHarnessSession {
		const existing = this.sessions.get(handle.metadata.id);
		if (existing) return existing;
		const session = new NodeHarnessSession({
			handle,
			model,
			streamFn: this.options.streamFn,
			sessionStore: this.sessionStore,
			traceStore: this.traceStore,
			runtimeFactory: this.runtimeFactory,
			hooks: this.hooks,
			...(this.options.permissionRules === undefined ? {} : { permissionRules: this.options.permissionRules }),
			...(this.options.permissionPrompt === undefined ? {} : { permissionPrompt: this.options.permissionPrompt }),
			...(this.options.tools === undefined ? {} : { customTools: this.options.tools }),
			...(this.options.disabledBuiltinTools === undefined
				? {}
				: { disabledBuiltinTools: this.options.disabledBuiltinTools }),
			capture: this.options.capture ?? { mode: "metadata-only" },
		});
		this.sessions.set(session.id, session);
		return session;
	}

	private async resolveModel(provider: string, modelId: string): Promise<Model<Api>> {
		if (this.options.model.provider === provider && this.options.model.id === modelId) return this.options.model;
		const model = await this.options.resolveModel?.(provider, modelId);
		if (!model) throw new Error(`Model is unavailable for restored session: ${provider}/${modelId}`);
		return model;
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Harness is closed");
	}
}

interface NodeHarnessSessionOptions {
	handle: DurableSessionHandle;
	model: Model<Api>;
	streamFn: StreamFn;
	sessionStore: PiSessionStore;
	traceStore: TraceStore;
	runtimeFactory: RuntimeAdapterFactory;
	hooks: HookRegistry;
	permissionRules?: PermissionRule[];
	permissionPrompt?: PermissionPrompt;
	customTools?: RegisteredTool[];
	disabledBuiltinTools?: string[];
	capture: TraceCaptureOptions;
}

class NodeHarnessSession implements HarnessSession {
	readonly id: string;
	private readonly options: NodeHarnessSessionOptions;
	private readonly dispatcher = new EventDispatcher();
	private readonly toolRegistry = new ToolRegistry();
	private permissionBroker?: PermissionBroker;
	private activeRuntime: AgentRuntimeAdapter | undefined;
	private activeRecorder: TraceRecorder | undefined;
	private idlePromise: Promise<void> = Promise.resolve();
	private resolveIdle: (() => void) | undefined;
	private abortRequested = false;
	private closed = false;

	constructor(options: NodeHarnessSessionOptions) {
		this.options = options;
		this.id = options.handle.metadata.id;
	}

	async run(input: AgentInput, runOptions: RunOptions = {}): Promise<RunResult> {
		this.assertOpen();
		if (this.activeRuntime) throw new Error("Session already has an active run");
		this.idlePromise = new Promise<void>((resolvePromise) => {
			this.resolveIdle = resolvePromise;
		});
		this.abortRequested = false;
		const runId = uuidv7();
		const startedAt = Date.now();
		const storedRun: StoredRun = {
			runId,
			sessionId: this.id,
			status: "running",
			startedAt,
			modelProvider: this.options.model.provider,
			modelId: this.options.model.id,
			totalTokens: 0,
			cost: 0,
		};
		this.options.traceStore.startRun(storedRun, this.configSnapshot(runOptions));
		const recorder = new TraceRecorder({
			store: this.options.traceStore,
			dispatcher: this.dispatcher,
			sessionId: this.id,
			runId,
			startedAt,
			modelProvider: this.options.model.provider,
			modelId: this.options.model.id,
			capture: this.options.capture,
		});
		this.activeRecorder = recorder;

		let status: "completed" | "failed" | "aborted" = "completed";
		let error: string | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await this.ensureTools();
			const initial = normalizeInput(input);
			const prepared = await this.options.hooks.runBeforeRun(
				{ messages: [initial], systemPrompt: this.options.handle.harnessMetadata.systemPrompt },
				(execution) => recorder.recordHook(execution),
			);
			const existingMessages = await this.options.sessionStore.messages(this.options.handle);
			this.activeRuntime = this.options.runtimeFactory.create({
				sessionId: this.id,
				systemPrompt: prepared.systemPrompt,
				model: this.options.model,
				streamFn: this.options.streamFn,
				messages: existingMessages,
				tools: this.toolRegistry.agentTools(),
				transformContext: async (messages) =>
					this.options.hooks.runTransformContext(messages, (execution) => recorder.recordHook(execution)),
				beforeToolCall: (context) => this.beforeTool(context, runId, recorder),
				afterToolCall: (context) => this.afterTool(context, recorder),
			});
			if (this.abortRequested) this.activeRuntime.abort();
			if (runOptions.timeoutMs !== undefined) {
				if (!Number.isFinite(runOptions.timeoutMs) || runOptions.timeoutMs <= 0) {
					throw new Error("timeoutMs must be a positive finite number");
				}
				timer = setTimeout(() => {
					error = `Run exceeded timeout of ${runOptions.timeoutMs}ms`;
					this.activeRuntime?.abort();
				}, runOptions.timeoutMs);
			}
			for await (const event of this.activeRuntime.run({ messages: prepared.messages })) {
				recorder.recordAgentEvent(event);
				if (event.type === "message_end") {
					await this.options.sessionStore.appendMessage(this.options.handle, toDurableMessage(event.message));
				}
				const budgetError = budgetExceeded(recorder, runOptions);
				if (budgetError && !error) {
					error = budgetError;
					this.activeRuntime.abort();
				}
			}
			if (error) status = "failed";
			else if (this.abortRequested || recorder.lastAssistant?.stopReason === "aborted") status = "aborted";
			else if (recorder.lastAssistant?.stopReason === "error") {
				status = "failed";
				error = recorder.lastAssistant.errorMessage ?? "Model request failed";
			}
		} catch (caught) {
			status = this.abortRequested ? "aborted" : "failed";
			error = caught instanceof Error ? caught.message : String(caught);
		} finally {
			if (timer) clearTimeout(timer);
			await this.options.hooks.runAfterRun(
				{ status, ...(error === undefined ? {} : { error }) },
				(execution) => recorder.recordHook(execution),
			);
			const endedAt = Date.now();
			recorder.finish(status, endedAt, error);
			const finishedRun: StoredRun = {
				...storedRun,
				status,
				endedAt,
				durationMs: endedAt - startedAt,
				totalTokens: recorder.usage.totalTokens,
				cost: recorder.usage.cost.total,
				...(error === undefined ? {} : { error }),
			};
			this.options.traceStore.finishRun(finishedRun);
			this.activeRuntime = undefined;
			this.activeRecorder = undefined;
			this.resolveIdle?.();
			this.resolveIdle = undefined;
		}

		const endedAt = Date.now();
		return {
			runId,
			sessionId: this.id,
			status,
			...(recorder.lastAssistant === undefined ? {} : { finalMessage: recorder.lastAssistant }),
			usage: recorder.usage,
			durationMs: endedAt - startedAt,
			...(error === undefined ? {} : { error }),
		};
	}

	steer(input: AgentInput): void {
		if (!this.activeRuntime) throw new Error("No active run to steer");
		this.activeRuntime.steer(normalizeInput(input));
	}

	abort(): void {
		this.abortRequested = true;
		this.activeRuntime?.abort();
	}

	subscribe(listener: HarnessEventListener): () => void {
		return this.dispatcher.subscribe(listener);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.abort();
		await this.idlePromise;
	}

	private async ensureTools(): Promise<void> {
		if (this.toolRegistry.list().length > 0) return;
		const workspace = await canonicalizeWorkspace(this.options.handle.metadata.cwd);
		const disabled = new Set(this.options.disabledBuiltinTools ?? []);
		for (const tool of [
			...createBuiltinTools(workspace).filter((item) => !disabled.has(item.tool.name)),
			...(this.options.customTools ?? []),
		]) {
			this.toolRegistry.register(tool);
		}
		this.permissionBroker = new PermissionBroker({
			...(this.options.permissionRules === undefined ? {} : { rules: this.options.permissionRules }),
			...(this.options.permissionPrompt === undefined ? {} : { prompt: this.options.permissionPrompt }),
			isExternalResource: (toolName, resource) =>
				(toolName === "read" ||
					toolName === "write" ||
					toolName === "edit" ||
					toolName === "list" ||
					toolName === "search") &&
				!isWithinWorkspace(workspace, resource),
			onDecision: (request, decision) => {
				try {
					this.options.traceStore.recordPermission(request, decision);
				} catch {
					// Permission enforcement must not depend on telemetry persistence.
				}
				this.activeRecorder?.emitPermission({
					toolName: request.toolName,
					action: decision.action,
					source: decision.source,
					resourceCount: request.resources.length,
				});
			},
		});
	}

	private async beforeTool(
		context: BeforeToolCallContext,
		runId: string,
		recorder: TraceRecorder,
	): Promise<{ block?: boolean; reason?: string } | undefined> {
		const definition = this.toolRegistry.get(context.toolCall.name);
		if (!definition || !this.permissionBroker) return { block: true, reason: "Tool is not registered" };
		let resources: string[];
		try {
			resources = await definition.resolveResources(context.args, this.options.handle.metadata.cwd);
		} catch (error) {
			return { block: true, reason: error instanceof Error ? error.message : String(error) };
		}
		const decision = await this.permissionBroker.authorize({
			sessionId: this.id,
			runId,
			toolName: context.toolCall.name,
			resources,
			argsSummary: definition.summarizeArgs?.(context.args) ?? {},
		});
		if (decision.action === "deny") return { block: true, reason: decision.reason ?? "Permission denied" };
		const hook = await this.options.hooks.runBeforeTool(context, (execution) => recorder.recordHook(execution));
		return hook.block ? { block: true, reason: hook.block.reason } : undefined;
	}

	private async afterTool(
		context: AfterToolCallContext,
		recorder: TraceRecorder,
	): Promise<AfterToolCallResult | undefined> {
		return this.options.hooks.runAfterTool(context, (execution) => recorder.recordHook(execution));
	}

	private configSnapshot(options: RunOptions): Record<string, JsonValue> {
		const disabled = new Set(this.options.disabledBuiltinTools ?? []);
		const tools = ["read", "write", "edit", "exec"]
			.filter((name) => !disabled.has(name))
			.concat(this.options.customTools?.map((item) => item.tool.name) ?? []);
		const promptHash = createHash("sha256")
			.update(this.options.handle.harnessMetadata.systemPrompt)
			.digest("hex")
			.slice(0, 16);
		return {
			modelProvider: this.options.model.provider,
			modelId: this.options.model.id,
			promptHash,
			toolNames: tools,
			configVersion: options.configVersion ?? "unversioned",
			capture: this.options.capture.mode,
		};
	}

	private assertOpen(): void {
		if (this.closed) throw new Error("Session is closed");
	}
}

function normalizeInput(input: AgentInput): AgentMessage {
	if (typeof input === "string") return { role: "user", content: input, timestamp: Date.now() };
	if ("role" in input) return input;
	return {
		role: "user",
		content: [{ type: "text", text: input.text }, ...(input.images ?? [])],
		timestamp: Date.now(),
	};
}

function toDurableMessage(message: AgentMessage): AgentMessage {
	return JSON.parse(JSON.stringify(message)) as AgentMessage;
}

function budgetExceeded(recorder: TraceRecorder, options: RunOptions): string | undefined {
	if (options.maxTurns !== undefined && recorder.turnCount > options.maxTurns) {
		return `Run exceeded turn budget of ${options.maxTurns}`;
	}
	const budgetTokens =
		recorder.usage.input + recorder.usage.output + recorder.usage.cacheWrite;
	if (options.maxTokens !== undefined && budgetTokens > options.maxTokens) {
		return `Run exceeded non-cache token budget of ${options.maxTokens}`;
	}
	if (options.maxCost !== undefined && recorder.usage.cost.total > options.maxCost) {
		return `Run exceeded cost budget of ${options.maxCost}`;
	}
	return undefined;
}
