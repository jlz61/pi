import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import type { JsonValue } from "../types.ts";

const permissionSchema = Type.Object(
	{
		tool: Type.String({ minLength: 1 }),
		resource: Type.String({ minLength: 1 }),
		action: Type.Union([Type.Literal("allow"), Type.Literal("ask"), Type.Literal("deny")]),
	},
	{ additionalProperties: false },
);

const networkSchema = Type.Object(
	{
		proxy: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("env"), Type.Literal("direct")])),
		connectTimeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
	},
	{ additionalProperties: false },
);

const sweBenchSchema = Type.Object(
	{
		pythonExecutable: Type.Optional(Type.String({ minLength: 1 })),
		graderPythonExecutable: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

const cliConfigSchema = Type.Object(
	{
		provider: Type.Optional(Type.String({ minLength: 1 })),
		model: Type.Optional(Type.String({ minLength: 1 })),
		dataDir: Type.Optional(Type.String({ minLength: 1 })),
		systemPrompt: Type.Optional(Type.String()),
		permissions: Type.Optional(Type.Array(permissionSchema)),
		network: Type.Optional(networkSchema),
		swebench: Type.Optional(sweBenchSchema),
	},
	{ additionalProperties: false },
);

export type HarnessCliConfig = Static<typeof cliConfigSchema>;
export type NetworkConfig = Static<typeof networkSchema>;

export interface ModelSelection {
	provider: string;
	modelId: string;
}

export async function loadHarnessConfig(path: string): Promise<HarnessCliConfig> {
	const absolutePath = resolve(path);
	let source: string;
	try {
		source = await readFile(absolutePath, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(source) as unknown;
	} catch (error) {
		throw new Error(`配置文件不是合法 JSON：${absolutePath}：${error instanceof Error ? error.message : String(error)}`);
	}
	return parseHarnessConfig(parsed, absolutePath);
}

export function parseHarnessConfig(value: unknown, source = "配置"): HarnessCliConfig {
	if (Value.Check(cliConfigSchema, value)) return value;
	const messages = [...Value.Errors(cliConfigSchema, value)].map(
		(error) => `${error.instancePath || "/"} ${error.message} ${JSON.stringify(error.params)}`,
	);
	throw new Error(`${source} 校验失败：${messages.join("；")}`);
}

export function resolveModelSelection(
	config: HarnessCliConfig,
	overrides: { provider?: string; model?: string },
	env: NodeJS.ProcessEnv = process.env,
): ModelSelection | undefined {
	const provider = overrides.provider ?? env.HARNESS_PROVIDER ?? config.provider;
	const modelId = overrides.model ?? env.HARNESS_MODEL ?? config.model;
	if (!provider && !modelId) return undefined;
	if (!provider || !modelId) throw new Error("模型配置不完整：provider 和 model 必须同时设置");
	return { provider, modelId };
}

export function sanitizedConfigSnapshot(config: HarnessCliConfig, selection?: ModelSelection): Record<string, JsonValue> {
	return {
		...(selection === undefined ? {} : { provider: selection.provider, model: selection.modelId }),
		...(config.systemPrompt === undefined ? {} : { systemPromptVersion: hashString(config.systemPrompt) }),
		permissions: (config.permissions ?? []).map((rule) => ({ ...rule })),
		network: {
			proxy: config.network?.proxy ?? "auto",
			connectTimeoutMs: config.network?.connectTimeoutMs ?? 15_000,
		},
		...(config.swebench === undefined
			? {}
			: {
					swebench: {
						bridgeConfigured: config.swebench.pythonExecutable !== undefined,
						graderConfigured: config.swebench.graderPythonExecutable !== undefined,
					},
				}),
	};
}

function hashString(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash ^= character.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
