export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionResponse = "allow_once" | "allow_session" | "deny";

export interface PermissionRule {
	tool: string;
	resource: string;
	action: PermissionAction;
}

export interface PermissionRequest {
	sessionId: string;
	runId: string;
	toolName: string;
	resources: string[];
	argsSummary: Record<string, string | number | boolean>;
}

export interface PermissionDecision {
	action: "allow" | "deny";
	source: "rule" | "approval" | "session" | "non_interactive" | "external";
	reason?: string;
}

export type PermissionPrompt = (request: PermissionRequest) => PermissionResponse | Promise<PermissionResponse>;
export type PermissionObserver = (request: PermissionRequest, decision: PermissionDecision) => void;

export interface PermissionBrokerOptions {
	rules?: PermissionRule[];
	prompt?: PermissionPrompt;
	isExternalResource: (toolName: string, resource: string) => boolean;
	onDecision?: PermissionObserver;
}

function wildcardMatch(pattern: string, value: string): boolean {
	const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
	return new RegExp(`^${escaped}$`, "u").test(value);
}

function grantKey(toolName: string, resources: readonly string[]): string {
	return `${toolName}\0${[...resources].sort().join("\0")}`;
}

export class PermissionBroker {
	private readonly rules: PermissionRule[];
	private readonly prompt: PermissionPrompt | undefined;
	private readonly isExternalResource: (toolName: string, resource: string) => boolean;
	private readonly onDecision: PermissionObserver | undefined;
	private readonly sessionGrants = new Set<string>();

	constructor(options: PermissionBrokerOptions) {
		this.rules = [...(options.rules ?? [])];
		this.prompt = options.prompt;
		this.isExternalResource = options.isExternalResource;
		this.onDecision = options.onDecision;
	}

	async authorize(request: PermissionRequest): Promise<PermissionDecision> {
		if (request.resources.some((resource) => this.isExternalResource(request.toolName, resource))) {
			return this.finish(request, {
				action: "deny",
				source: "external",
				reason: "Resource is outside the configured workspace",
			});
		}

		const key = grantKey(request.toolName, request.resources);
		if (this.sessionGrants.has(key)) return this.finish(request, { action: "allow", source: "session" });

		const resourceActions = request.resources.length === 0
			? [this.resolveAction(request.toolName, "*")]
			: request.resources.map((resource) => this.resolveAction(request.toolName, resource));
		if (resourceActions.includes("deny")) {
			return this.finish(request, { action: "deny", source: "rule", reason: "Denied by permission rule" });
		}
		if (!resourceActions.includes("ask")) return this.finish(request, { action: "allow", source: "rule" });

		if (!this.prompt) {
			return this.finish(request, {
				action: "deny",
				source: "non_interactive",
				reason: "Permission requires approval in non-interactive mode",
			});
		}

		const response = await this.prompt(request);
		if (response === "allow_session") {
			this.sessionGrants.add(key);
			return this.finish(request, { action: "allow", source: "approval" });
		}
		if (response === "allow_once") return this.finish(request, { action: "allow", source: "approval" });
		return this.finish(request, { action: "deny", source: "approval", reason: "User denied permission" });
	}

	private resolveAction(toolName: string, resource: string): PermissionAction {
		let resolved: PermissionAction | undefined;
		for (const rule of this.rules) {
			if (wildcardMatch(rule.tool, toolName) && wildcardMatch(rule.resource, resource)) resolved = rule.action;
		}
		if (resolved) return resolved;
		return toolName === "read" ? "allow" : "ask";
	}

	private finish(request: PermissionRequest, decision: PermissionDecision): PermissionDecision {
		this.onDecision?.(request, decision);
		return decision;
	}
}
