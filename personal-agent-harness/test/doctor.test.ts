import type { Models } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { runDoctor } from "../src/node/doctor.ts";
import type { NetworkRuntime } from "../src/node/network.ts";
import { fauxRuntime, tempDir } from "./helpers.ts";

describe("doctor", () => {
	it("checks model, auth, network, and both databases", async () => {
		const runtime = fauxRuntime([]);
		const models = {
			getModel: vi.fn(() => runtime.model),
			checkAuth: vi.fn(async () => ({ type: "api_key", source: "TEST_API_KEY" })),
		} as unknown as Models;
		const network = {
			proxyMode: "env",
			connectTimeoutMs: 1_000,
			fetch: vi.fn(async () => new Response(null, { status: 200 })),
			streamFn: runtime.streamFn,
			close: vi.fn(async () => undefined),
		} satisfies NetworkRuntime;
		const cwd = tempDir("doctor-cwd-");
		const report = await runDoctor({
			config: {},
			selection: { provider: runtime.model.provider, modelId: runtime.model.id },
			dataDir: tempDir("doctor-data-"),
			cwd,
			models,
			network,
		});
		expect(report.status).toBe("ok");
		expect(report.checks.map((check) => check.id)).toEqual(
			expect.arrayContaining(["node", "model", "auth", "network", "trace_db", "session_db"]),
		);
	});

	it("fails without a configured model", async () => {
		const runtime = fauxRuntime([]);
		const report = await runDoctor({
			config: {},
			dataDir: tempDir("doctor-missing-data-"),
			cwd: tempDir("doctor-missing-cwd-"),
			models: {} as Models,
			network: {
				proxyMode: "direct",
				connectTimeoutMs: 1_000,
				fetch: vi.fn(),
				streamFn: runtime.streamFn,
				close: vi.fn(async () => undefined),
			},
		});
		expect(report.status).toBe("fail");
		expect(report.checks).toContainEqual(expect.objectContaining({ id: "model", status: "fail" }));
	});
});
