import { describe, expect, it } from "vitest";
import { HookRegistry } from "../src/hooks.ts";

describe("HookRegistry", () => {
	it("runs transformations in registration order and isolates ordinary errors", async () => {
		const hooks = new HookRegistry();
		const order: string[] = [];
		hooks.on("before_run", () => {
			order.push("first");
			return { systemPrompt: "changed" };
		});
		hooks.on("before_run", () => {
			order.push("broken");
			throw new Error("ignored");
		});
		hooks.on("before_run", () => {
			order.push("last");
			return { messages: [{ role: "user", content: "injected", timestamp: 1 }] };
		});
		const result = await hooks.runBeforeRun({
			messages: [{ role: "user", content: "input", timestamp: 0 }],
			systemPrompt: "original",
		});
		expect(order).toEqual(["first", "broken", "last"]);
		expect(result.systemPrompt).toBe("changed");
		expect(result.messages).toHaveLength(2);
	});

	it("fails closed when before_tool throws", async () => {
		const hooks = new HookRegistry();
		hooks.on("before_tool", () => {
			throw new Error("policy unavailable");
		});
		const result = await hooks.runBeforeTool({
			assistantMessage: {
				role: "assistant",
				content: [],
				api: "faux",
				provider: "faux",
				model: "faux",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 0,
			},
			toolCall: { type: "toolCall", id: "call", name: "write", arguments: {} },
			args: {},
			context: { systemPrompt: "", messages: [] },
		});
		expect(result.block?.reason).toContain("policy unavailable");
	});
});
