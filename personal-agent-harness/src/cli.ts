#!/usr/bin/env node
import { isBrokenPipeError, runCli } from "./cli-app.ts";

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (isBrokenPipeError(error)) process.exit(0);
	throw error;
});

process.exitCode = await runCli(process.argv.slice(2));
