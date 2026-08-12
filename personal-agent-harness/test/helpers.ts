import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	createModels,
	fauxProvider,
	type Api,
	type FauxResponseStep,
	type Model,
	type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";
import { NodeHarness } from "../src/node/harness.ts";
import type { PermissionRule } from "../src/permission.ts";
import type { TraceCaptureOptions } from "../src/types.ts";

export function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

export function fauxRuntime(
	responses: FauxResponseStep[],
	options: RegisterFauxProviderOptions = { tokenSize: { min: 64, max: 64 } },
): { model: Model<Api>; streamFn: StreamFn } {
	const faux = fauxProvider(options);
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	return { model: faux.getModel(), streamFn: models.streamSimple.bind(models) };
}

export async function createTestHarness(options: {
	root: string;
	responses: FauxResponseStep[];
	rules?: PermissionRule[];
	capture?: TraceCaptureOptions;
	fauxOptions?: RegisterFauxProviderOptions;
}): Promise<NodeHarness> {
	const runtime = fauxRuntime(options.responses, options.fauxOptions);
	return NodeHarness.create({
		dataDir: join(options.root, "data"),
		cwd: options.root,
		model: runtime.model,
		streamFn: runtime.streamFn,
		...(options.rules === undefined ? {} : { permissionRules: options.rules }),
		...(options.capture === undefined ? {} : { capture: options.capture }),
	});
}
