import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createTestHarness, tempDir } from "./helpers.ts";

it("runs a complete harness demo without an API key", async () => {
	const harness = await createTestHarness({
		root: tempDir("harness-demo-"),
		responses: [fauxAssistantMessage("ok")],
	});
	try {
		const result = await (await harness.createSession()).run("Say exactly: ok");
		expect(result.status).toBe("completed");
		expect(result.finalMessage?.role).toBe("assistant");
	} finally {
		await harness.close();
	}
});
