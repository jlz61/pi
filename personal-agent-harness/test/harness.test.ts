import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { TraceStore } from "../src/node/trace-store.ts";
import { createTestHarness, tempDir } from "./helpers.ts";

const harnesses: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
});

describe("NodeHarness", () => {
	it("persists a session and produces a complete metadata-only trace", async () => {
		const root = tempDir("harness-session-");
		writeFileSync(join(root, "input.txt"), "top-secret-content", "utf8");
		const harness = await createTestHarness({
			root,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			],
		});
		harnesses.push(harness);
		const session = await harness.createSession({ id: "session-1" });
		const seen: number[] = [];
		session.subscribe((event) => {
			seen.push(event.sequence);
		});
		const result = await session.run("read input.txt");
		expect(result.status).toBe("completed");
		expect(result.usage.totalTokens).toBeGreaterThan(0);
		expect(seen).toEqual([...seen].sort((left, right) => left - right));
		const spans = harness.traceStore.getSpans(result.runId);
		expect(spans.some((span) => span.type === "run")).toBe(true);
		expect(spans.some((span) => span.type === "turn")).toBe(true);
		expect(spans.some((span) => span.type === "model_request")).toBe(true);
		expect(spans.some((span) => span.type === "tool")).toBe(true);
		expect(spans.every((span) => span.status !== "running")).toBe(true);
		const serialized = JSON.stringify({ spans, events: harness.traceStore.getEvents(result.runId) });
		expect(serialized).not.toContain("top-secret-content");
		expect(serialized).not.toContain("read input.txt");
		expect((await harness.listSessions()).map((item) => item.id)).toContain("session-1");
	});

	it("denies mutation asks in non-interactive mode", async () => {
		const root = tempDir("harness-deny-");
		const harness = await createTestHarness({
			root,
			responses: [
				fauxAssistantMessage(fauxToolCall("write", { path: "blocked.txt", content: "no" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("handled"),
			],
		});
		harnesses.push(harness);
		const result = await (await harness.createSession()).run("write a file");
		expect(result.status).toBe("completed");
		expect(() => readFileSync(join(root, "blocked.txt"))).toThrow();
		expect(harness.traceStore.getEvents(result.runId)).toContainEqual(
			expect.objectContaining({
				type: "permission_decision",
				attributes: expect.objectContaining({ action: "deny", source: "non_interactive" }),
			}),
		);
	});

	it("restores committed context after closing and reopening", async () => {
		const root = tempDir("harness-reopen-");
		const first = await createTestHarness({ root, responses: [fauxAssistantMessage("first response")] });
		const firstSession = await first.createSession({ id: "persistent" });
		expect((await firstSession.run("first prompt")).status).toBe("completed");
		await first.close();

		const secondRuntimeResponse = (context: { messages: Array<{ role: string }> }) => {
			expect(context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
			return fauxAssistantMessage("second response");
		};
		const second = await createTestHarness({ root, responses: [secondRuntimeResponse] });
		harnesses.push(second);
		const restored = await second.openSession("persistent");
		expect((await restored.run("second prompt")).status).toBe("completed");
	});

	it("supports explicit redacted content capture", async () => {
		const root = tempDir("harness-redacted-");
		const harness = await createTestHarness({
			root,
			responses: [fauxAssistantMessage("assistant-secret")],
			capture: { mode: "redacted", redactor: () => "[redacted]" },
		});
		harnesses.push(harness);
		const result = await (await harness.createSession()).run("user-secret");
		const serialized = JSON.stringify(harness.traceStore.getEvents(result.runId));
		expect(serialized).toContain("[redacted]");
		expect(serialized).not.toContain("user-secret");
		expect(serialized).not.toContain("assistant-secret");
	});

	it("aborts an active provider stream", async () => {
		const root = tempDir("harness-abort-");
		const harness = await createTestHarness({
			root,
			responses: [fauxAssistantMessage("long response ".repeat(100))],
			fauxOptions: { tokensPerSecond: 10, tokenSize: { min: 2, max: 3 } },
		});
		harnesses.push(harness);
		const session = await harness.createSession();
		const pending = session.run("start");
		setTimeout(() => session.abort(), 50);
		await expect(pending).resolves.toMatchObject({ status: "aborted" });
	});

	it("does not charge repeated cache reads against the token budget", async () => {
		const responses = () => [
			fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		];
		const measureRoot = tempDir("harness-budget-measure-");
		writeFileSync(join(measureRoot, "input.txt"), "content", "utf8");
		const measureHarness = await createTestHarness({ root: measureRoot, responses: responses() });
		harnesses.push(measureHarness);
		const measured = await (await measureHarness.createSession()).run("read input.txt");
		expect(measured.usage.cacheRead).toBeGreaterThan(0);
		const nonCacheTokens = measured.usage.input + measured.usage.output + measured.usage.cacheWrite;
		expect(measured.usage.totalTokens).toBeGreaterThan(nonCacheTokens);

		const allowedRoot = tempDir("harness-budget-allowed-");
		writeFileSync(join(allowedRoot, "input.txt"), "content", "utf8");
		const allowedHarness = await createTestHarness({ root: allowedRoot, responses: responses() });
		harnesses.push(allowedHarness);
		const allowed = await (await allowedHarness.createSession()).run("read input.txt", {
			maxTokens: nonCacheTokens,
		});
		expect(allowed.status).toBe("completed");
		expect(allowed.usage.totalTokens).toBeGreaterThan(nonCacheTokens);

		const deniedRoot = tempDir("harness-budget-denied-");
		writeFileSync(join(deniedRoot, "input.txt"), "content", "utf8");
		const deniedHarness = await createTestHarness({ root: deniedRoot, responses: responses() });
		harnesses.push(deniedHarness);
		const denied = await (await deniedHarness.createSession()).run("read input.txt", {
			maxTokens: nonCacheTokens - 1,
		});
		expect(denied).toMatchObject({
			status: "failed",
			error: `Run exceeded non-cache token budget of ${nonCacheTokens - 1}`,
		});
	});

	it("prevents a symlink from escaping the workspace", async () => {
		const root = tempDir("harness-symlink-");
		const outside = tempDir("harness-outside-");
		writeFileSync(join(outside, "secret.txt"), "outside-secret", "utf8");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
		const harness = await createTestHarness({
			root,
			responses: [
				fauxAssistantMessage(fauxToolCall("read", { path: "link.txt" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("blocked"),
			],
		});
		harnesses.push(harness);
		const result = await (await harness.createSession()).run("read link.txt");
		expect(harness.traceStore.getEvents(result.runId)).toContainEqual(
			expect.objectContaining({
				type: "permission_decision",
				attributes: expect.objectContaining({ action: "deny", source: "external" }),
			}),
		);
	});

	it("fails closed when a before_tool hook crashes", async () => {
		const root = tempDir("harness-hook-");
		mkdirSync(root, { recursive: true });
		const harness = await createTestHarness({
			root,
			rules: [{ tool: "write", resource: "*", action: "allow" }],
			responses: [
				fauxAssistantMessage(fauxToolCall("write", { path: "blocked.txt", content: "no" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("blocked"),
			],
		});
		harness.hooks.on("before_tool", () => {
			throw new Error("policy crashed");
		});
		harnesses.push(harness);
		const result = await (await harness.createSession()).run("write blocked.txt");
		expect(() => readFileSync(join(root, "blocked.txt"))).toThrow();
		expect(harness.traceStore.getSpans(result.runId)).toContainEqual(
			expect.objectContaining({ type: "hook", status: "error" }),
		);
	});

	it("marks abandoned runs as interrupted on startup", () => {
		const store = new TraceStore(":memory:");
		store.startRun(
			{
				runId: "run",
				sessionId: "session",
				status: "running",
				startedAt: 1,
				modelProvider: "faux",
				modelId: "faux",
				totalTokens: 0,
				cost: 0,
			},
			{},
		);
		expect(store.interruptRunning(10)).toBe(1);
		expect(store.getRun("run")).toMatchObject({ status: "interrupted", endedAt: 10, durationMs: 9 });
		store.close();
	});
});
