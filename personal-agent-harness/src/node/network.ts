import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import {
	Agent,
	EnvHttpProxyAgent,
	fetch as undiciFetch,
	type Dispatcher,
	type RequestInfo as UndiciRequestInfo,
	type RequestInit as UndiciRequestInit,
} from "undici";
import type { NetworkConfig } from "./config.ts";

export type ResolvedProxyMode = "env" | "direct";

export interface NetworkRuntime {
	readonly fetch: typeof globalThis.fetch;
	readonly streamFn: StreamFn;
	readonly proxyMode: ResolvedProxyMode;
	readonly connectTimeoutMs: number;
	close(): Promise<void>;
}

export interface ProxyEnvironment {
	httpProxy?: string;
	httpsProxy?: string;
	noProxy?: string;
}

export interface NetworkRuntimeDependencies {
	dispatcher?: Dispatcher;
	fetch?: typeof undiciFetch;
}

export function resolveProxyMode(
	configured: NetworkConfig["proxy"] = "auto",
	env: NodeJS.ProcessEnv = process.env,
): ResolvedProxyMode {
	if (configured === "env" || configured === "direct") return configured;
	return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ? "env" : "direct";
}

export function createNetworkRuntime(
	models: Models,
	config: NetworkConfig = {},
	env: NodeJS.ProcessEnv = process.env,
	dependencies: NetworkRuntimeDependencies = {},
): NetworkRuntime {
	const proxyMode = resolveProxyMode(config.proxy, env);
	const connectTimeoutMs = config.connectTimeoutMs ?? 15_000;
	const proxy = resolveProxyEnvironment(env);
	const dispatcher: Dispatcher = dependencies.dispatcher ?? (proxyMode === "env"
		? new EnvHttpProxyAgent({
				...(proxy.httpProxy === undefined ? {} : { httpProxy: proxy.httpProxy }),
				...(proxy.httpsProxy === undefined ? {} : { httpsProxy: proxy.httpsProxy }),
				...(proxy.noProxy === undefined ? {} : { noProxy: proxy.noProxy }),
				connectTimeout: connectTimeoutMs,
			})
		: new Agent({ connectTimeout: connectTimeoutMs }));
	const fetchImplementation = dependencies.fetch ?? undiciFetch;
	const networkFetch: typeof globalThis.fetch = async (input, init) => {
		const response = await fetchImplementation(input as unknown as UndiciRequestInfo, {
			...(init as unknown as UndiciRequestInit),
			dispatcher,
		});
		return response as unknown as Response;
	};
	const streamFn: StreamFn = (model, context, options) =>
		models.streamSimple(model, context, { ...options, fetch: networkFetch });
	return {
		fetch: networkFetch,
		streamFn,
		proxyMode,
		connectTimeoutMs,
		close: () => dispatcher.close(),
	};
}

export function resolveProxyEnvironment(env: NodeJS.ProcessEnv = process.env): ProxyEnvironment {
	const httpProxy = env.HTTP_PROXY ?? env.http_proxy;
	const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy;
	const noProxy = env.NO_PROXY ?? env.no_proxy;
	return {
		...(httpProxy === undefined ? {} : { httpProxy }),
		...(httpsProxy === undefined ? {} : { httpsProxy }),
		...(noProxy === undefined ? {} : { noProxy }),
	};
}
