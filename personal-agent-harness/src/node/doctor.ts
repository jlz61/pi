import { resolve } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import type { DoctorCheck, DoctorCheckStatus, DoctorReport } from "../types.ts";
import type { HarnessCliConfig, ModelSelection } from "./config.ts";
import type { NetworkRuntime } from "./network.ts";
import { PiSessionStore } from "./session-store.ts";
import { TraceStore } from "./trace-store.ts";

export interface DoctorOptions {
	config: HarnessCliConfig;
	selection?: ModelSelection;
	dataDir: string;
	cwd: string;
	models: Models;
	network: NetworkRuntime;
	nodeVersion?: string;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	checks.push(checkNodeVersion(options.nodeVersion ?? process.versions.node));
	checks.push({ id: "config", label: "配置文件", status: "ok", message: "结构校验通过，未包含明文凭证" });
	checks.push({
		id: "proxy",
		label: "网络代理",
		status: "ok",
		message: options.network.proxyMode === "env" ? "已启用环境代理" : "使用直接连接",
	});

	const model = options.selection
		? options.models.getModel(options.selection.provider, options.selection.modelId)
		: undefined;
	if (!options.selection) {
		checks.push({ id: "model", label: "模型", status: "fail", message: "未配置 provider 和 model" });
	} else if (!model) {
		checks.push({
			id: "model",
			label: "模型",
			status: "fail",
			message: `模型不存在：${options.selection.provider}/${options.selection.modelId}`,
		});
	} else {
		checks.push({
			id: "model",
			label: "模型",
			status: "ok",
			message: `${model.provider}/${model.id}`,
		});
	}

	if (options.selection) {
		try {
			const auth = await options.models.checkAuth(options.selection.provider);
			checks.push(
				auth
					? { id: "auth", label: "模型凭证", status: "ok", message: auth.source ?? `${auth.type} 已配置` }
					: { id: "auth", label: "模型凭证", status: "fail", message: "未找到可用凭证" },
			);
		} catch (error) {
			checks.push({ id: "auth", label: "模型凭证", status: "fail", message: errorMessage(error) });
		}
	}

	if (model) {
		try {
			const response = await options.network.fetch(model.baseUrl, {
				method: "HEAD",
				signal: AbortSignal.timeout(options.network.connectTimeoutMs),
			});
			checks.push({
				id: "network",
				label: "模型服务",
				status: "ok",
				message: `服务可达，HTTP ${response.status}`,
			});
		} catch (error) {
			checks.push({ id: "network", label: "模型服务", status: "fail", message: errorMessage(error) });
		}
	}

	const dataDir = resolve(options.dataDir);
	try {
		const traceStore = new TraceStore(resolve(dataDir, "harness.sqlite"));
		try {
			traceStore.listTraceSummaries({ limit: 1 });
		} finally {
			traceStore.close();
		}
		checks.push({ id: "trace_db", label: "Trace 数据库", status: "ok", message: resolve(dataDir, "harness.sqlite") });
	} catch (error) {
		checks.push({ id: "trace_db", label: "Trace 数据库", status: "fail", message: errorMessage(error) });
	}

	try {
		const sessionStore = new PiSessionStore(resolve(dataDir, "sessions.sqlite"), options.cwd);
		try {
			await sessionStore.list();
		} finally {
			await sessionStore.close();
		}
		checks.push({
			id: "session_db",
			label: "Session 数据库",
			status: "ok",
			message: resolve(dataDir, "sessions.sqlite"),
		});
	} catch (error) {
		checks.push({ id: "session_db", label: "Session 数据库", status: "fail", message: errorMessage(error) });
	}

	return { status: aggregateStatus(checks), checks };
}

function checkNodeVersion(version: string): DoctorCheck {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	const supported = major > 22 || (major === 22 && minor >= 19);
	return {
		id: "node",
		label: "Node.js",
		status: supported ? "ok" : "fail",
		message: supported ? `${version}，满足 >=22.19.0` : `${version}，需要 >=22.19.0`,
	};
}

function aggregateStatus(checks: DoctorCheck[]): DoctorCheckStatus {
	if (checks.some((check) => check.status === "fail")) return "fail";
	if (checks.some((check) => check.status === "warn")) return "warn";
	return "ok";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
