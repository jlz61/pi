import type { HarnessEvent, HarnessEventListener } from "./types.ts";

export class EventDispatcher {
	private readonly listeners = new Set<HarnessEventListener>();
	private readonly onListenerError: ((event: HarnessEvent, error: Error) => void) | undefined;

	constructor(onListenerError?: (event: HarnessEvent, error: Error) => void) {
		this.onListenerError = onListenerError;
	}

	subscribe(listener: HarnessEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: HarnessEvent): void {
		for (const listener of this.listeners) {
			try {
				const result = listener(event);
				if (result instanceof Promise) {
					void result.catch((error: unknown) => this.report(event, error));
				}
			} catch (error) {
				this.report(event, error);
			}
		}
	}

	private report(event: HarnessEvent, error: unknown): void {
		this.onListenerError?.(event, error instanceof Error ? error : new Error(String(error)));
	}
}
