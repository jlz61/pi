import { describe, expect, it } from "vitest";
import { PermissionBroker } from "../src/permission.ts";

const request = {
	sessionId: "session",
	runId: "run",
	toolName: "write",
	resources: ["/workspace/file.ts"],
	argsSummary: { path: "file.ts" },
};

describe("PermissionBroker", () => {
	it("allows reads, asks for mutations, and denies non-interactive asks", async () => {
		const broker = new PermissionBroker({ isExternalResource: () => false });
		await expect(broker.authorize(request)).resolves.toMatchObject({
			action: "deny",
			source: "non_interactive",
		});
		await expect(broker.authorize({ ...request, toolName: "read" })).resolves.toMatchObject({
			action: "allow",
			source: "rule",
		});
	});

	it("applies deny before ask before allow across resources", async () => {
		const broker = new PermissionBroker({
			isExternalResource: () => false,
			rules: [
				{ tool: "write", resource: "/workspace/*", action: "allow" },
				{ tool: "write", resource: "*/secret", action: "deny" },
			],
		});
		await expect(
			broker.authorize({ ...request, resources: ["/workspace/file.ts", "/workspace/secret"] }),
		).resolves.toMatchObject({ action: "deny", source: "rule" });
	});

	it("remembers an exact session approval", async () => {
		let prompts = 0;
		const broker = new PermissionBroker({
			isExternalResource: () => false,
			prompt: () => {
				prompts++;
				return "allow_session";
			},
		});
		await expect(broker.authorize(request)).resolves.toMatchObject({ action: "allow", source: "approval" });
		await expect(broker.authorize(request)).resolves.toMatchObject({ action: "allow", source: "session" });
		expect(prompts).toBe(1);
	});

	it("hard-denies external resources before rules and approval", async () => {
		const broker = new PermissionBroker({
			isExternalResource: () => true,
			rules: [{ tool: "*", resource: "*", action: "allow" }],
			prompt: () => "allow_once",
		});
		await expect(broker.authorize(request)).resolves.toMatchObject({ action: "deny", source: "external" });
	});
});
