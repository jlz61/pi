import type { Models } from "@earendil-works/pi-ai";
import type { Dispatcher, RequestInit, Response as UndiciResponse } from "undici";
import { describe, expect, it, vi } from "vitest";
import { createNetworkRuntime, resolveProxyEnvironment, resolveProxyMode } from "../src/node/network.ts";

describe("network runtime", () => {
	it("selects environment proxy automatically and preserves NO_PROXY", () => {
		const env = { HTTPS_PROXY: "http://proxy.invalid:8080", NO_PROXY: "localhost,.internal" };
		expect(resolveProxyMode("auto", env)).toBe("env");
		expect(resolveProxyEnvironment(env)).toEqual({
			httpsProxy: "http://proxy.invalid:8080",
			noProxy: "localhost,.internal",
		});
		expect(resolveProxyMode("direct", env)).toBe("direct");
	});

	it("injects the configured dispatcher into fetch without exposing proxy data", async () => {
		const close = vi.fn(async () => undefined);
		const dispatcher = { close } as unknown as Dispatcher;
		let receivedInit: RequestInit | undefined;
		const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
			receivedInit = init;
			return new Response("ok") as unknown as UndiciResponse;
		});
		const models = {
			streamSimple: vi.fn(),
		} as unknown as Models;
		const runtime = createNetworkRuntime(models, { proxy: "env" }, { HTTPS_PROXY: "http://secret-proxy" }, {
			dispatcher,
			fetch: fetchMock,
		});
		await runtime.fetch("https://example.com");
		expect(receivedInit?.dispatcher).toBe(dispatcher);
		expect(runtime.proxyMode).toBe("env");
		await runtime.close();
		expect(close).toHaveBeenCalledOnce();
	});
});
