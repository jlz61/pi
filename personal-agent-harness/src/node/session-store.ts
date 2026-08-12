import type { AgentMessage, Session } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	createNodeSqliteFactory,
	SqliteSessionRepo,
	type SqliteSessionMetadata,
} from "@earendil-works/pi-storage-sqlite-node";
import type { JsonValue, SessionSummary } from "../types.ts";

interface HarnessSessionMetadata {
	[key: string]: unknown;
	modelProvider: string;
	modelId: string;
	systemPrompt: string;
	user?: Record<string, JsonValue>;
}

export interface DurableSessionHandle {
	session: Session<SqliteSessionMetadata>;
	metadata: SqliteSessionMetadata;
	harnessMetadata: HarnessSessionMetadata;
}

export class PiSessionStore {
	private readonly repository: SqliteSessionRepo;
	private readonly openSessions = new Set<Session<SqliteSessionMetadata>>();

	constructor(databasePath: string, envCwd: string) {
		this.repository = new SqliteSessionRepo({
			env: new NodeExecutionEnv({ cwd: envCwd }),
			sqlite: createNodeSqliteFactory(),
			databasePath,
		});
	}

	async create(options: {
		id?: string;
		cwd: string;
		modelProvider: string;
		modelId: string;
		systemPrompt: string;
		metadata?: Record<string, JsonValue>;
	}): Promise<DurableSessionHandle> {
		const harnessMetadata: HarnessSessionMetadata = {
			modelProvider: options.modelProvider,
			modelId: options.modelId,
			systemPrompt: options.systemPrompt,
			...(options.metadata === undefined ? {} : { user: options.metadata }),
		};
		const session = await this.repository.create({
			cwd: options.cwd,
			...(options.id === undefined ? {} : { id: options.id }),
			metadata: harnessMetadata,
		});
		this.openSessions.add(session);
		return { session, metadata: await session.getMetadata(), harnessMetadata };
	}

	async open(id: string): Promise<DurableSessionHandle> {
		const metadata = (await this.repository.list()).find((candidate) => candidate.id === id);
		if (!metadata) throw new Error(`Session not found: ${id}`);
		const harnessMetadata = parseHarnessMetadata(metadata.metadata);
		const session = await this.repository.open(metadata);
		this.openSessions.add(session);
		return { session, metadata, harnessMetadata };
	}

	async list(): Promise<SessionSummary[]> {
		return (await this.repository.list()).map((metadata) => {
			const harnessMetadata = parseHarnessMetadata(metadata.metadata);
			return {
				id: metadata.id,
				cwd: metadata.cwd,
				createdAt: normalizeTimestamp(metadata.createdAt),
				model: { provider: harnessMetadata.modelProvider, modelId: harnessMetadata.modelId },
			};
		});
	}

	async messages(handle: DurableSessionHandle): Promise<AgentMessage[]> {
		return (await handle.session.buildContext()).messages;
	}

	async appendMessage(handle: DurableSessionHandle, message: AgentMessage): Promise<void> {
		await handle.session.appendMessage(message);
	}

	async close(): Promise<void> {
		await Promise.all(
			[...this.openSessions].map(async (session) => {
				const storage = session.getStorage() as unknown as { cleanup(): Promise<void> };
				await storage.cleanup();
			}),
		);
		this.openSessions.clear();
	}
}

function normalizeTimestamp(value: string | number): number {
	if (typeof value === "number") return value;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new Error(`Invalid session timestamp: ${value}`);
	return timestamp;
}

function parseHarnessMetadata(value: Record<string, unknown> | undefined): HarnessSessionMetadata {
	if (
		!value ||
		typeof value.modelProvider !== "string" ||
		typeof value.modelId !== "string" ||
		typeof value.systemPrompt !== "string"
	) {
		throw new Error("Session metadata is missing the harness model configuration");
	}
	return {
		modelProvider: value.modelProvider,
		modelId: value.modelId,
		systemPrompt: value.systemPrompt,
		...(value.user && typeof value.user === "object" && !Array.isArray(value.user)
			? { user: value.user as Record<string, JsonValue> }
			: {}),
	};
}
