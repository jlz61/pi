import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";
import type { RegisteredTool } from "./types.ts";

export class ToolRegistry {
	private readonly tools = new Map<string, RegisteredTool>();

	register(definition: RegisteredTool): () => void {
		if (this.tools.has(definition.tool.name)) throw new Error(`Tool already registered: ${definition.tool.name}`);
		this.tools.set(definition.tool.name, definition);
		return () => this.tools.delete(definition.tool.name);
	}

	get(name: string): RegisteredTool | undefined {
		return this.tools.get(name);
	}

	list(): RegisteredTool[] {
		return [...this.tools.values()];
	}

	agentTools(): AgentTool<TSchema, unknown>[] {
		return this.list().map((definition) => definition.tool);
	}
}
