import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentRuntimeAdapter, RuntimeAdapterFactory, RuntimeAdapterOptions, RuntimeEvent, RuntimeRequest } from "./types.ts";

class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<() => void> = [];
	private ended = false;
	private failure: Error | undefined;

	push(value: T): void {
		if (this.ended) return;
		this.values.push(value);
		this.waiters.shift()?.();
	}

	end(): void {
		this.ended = true;
		for (const wake of this.waiters.splice(0)) wake();
	}

	fail(error: unknown): void {
		this.failure = error instanceof Error ? error : new Error(String(error));
		this.end();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			const value = this.values.shift();
			if (value !== undefined) {
				yield value;
				continue;
			}
			if (this.ended) {
				if (this.failure) throw this.failure;
				return;
			}
			await new Promise<void>((resolve) => this.waiters.push(resolve));
		}
	}
}

export class PiAgentRuntimeAdapter implements AgentRuntimeAdapter {
	private readonly agent: Agent;
	private running = false;

	constructor(options: RuntimeAdapterOptions) {
		this.agent = new Agent({
			initialState: {
				systemPrompt: options.systemPrompt,
				model: options.model,
				messages: options.messages,
				tools: options.tools,
			},
			streamFn: options.streamFn,
			sessionId: options.sessionId,
			...(options.transformContext === undefined ? {} : { transformContext: options.transformContext }),
			...(options.beforeToolCall === undefined ? {} : { beforeToolCall: options.beforeToolCall }),
			...(options.afterToolCall === undefined ? {} : { afterToolCall: options.afterToolCall }),
		});
	}

	run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
		if (this.running) throw new Error("Runtime is already processing a run");
		this.running = true;
		const queue = new AsyncEventQueue<RuntimeEvent>();
		const unsubscribe = this.agent.subscribe((event) => queue.push(event));
		void this.agent.prompt(request.messages).then(
			() => {
				unsubscribe();
				this.running = false;
				queue.end();
			},
			(error: unknown) => {
				unsubscribe();
				this.running = false;
				queue.fail(error);
			},
		);
		return queue;
	}

	steer(input: AgentMessage): void {
		if (!this.running) throw new Error("No active run to steer");
		this.agent.steer(input);
	}

	abort(): void {
		this.agent.abort();
	}
}

export class PiRuntimeAdapterFactory implements RuntimeAdapterFactory {
	create(options: RuntimeAdapterOptions): AgentRuntimeAdapter {
		return new PiAgentRuntimeAdapter(options);
	}
}
