import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static, type TSchema } from "typebox";
import type { RegisteredTool } from "../types.ts";

const MAX_OUTPUT_BYTES = 100_000;
const MAX_READ_BYTES = 40_000;
const DEFAULT_READ_LINES = 300;

const readSchema = Type.Object({
	path: Type.String({ description: "File path, relative to the workspace or absolute" }),
	offset: Type.Optional(Type.Integer({ minimum: 1, description: "One-based first line to read" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000, description: "Maximum number of lines" })),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "File path, relative to the workspace or absolute" }),
	content: Type.String({ description: "Complete file content" }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "File path, relative to the workspace or absolute" }),
	oldText: Type.String({ description: "Unique text to replace" }),
	newText: Type.String({ description: "Replacement text" }),
});

const execSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute in the workspace" }),
	timeoutMs: Type.Optional(Type.Number({ minimum: 1, maximum: 2_147_483_647 })),
});

const listSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory path relative to the workspace" })),
	depth: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
});

const searchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "Text or regular expression to find" }),
	path: Type.Optional(Type.String({ description: "Directory path relative to the workspace" })),
	regex: Type.Optional(Type.Boolean()),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

const gitDiffSchema = Type.Object({});

interface FileToolDetails {
	path: string;
	bytes: number;
	totalBytes?: number;
	offset?: number;
	lines?: number;
	totalLines?: number;
	truncated?: boolean;
}

interface EditToolDetails extends FileToolDetails {
	replacements: number;
}

interface ExecToolDetails {
	exitCode: number | null;
	timedOut: boolean;
	truncated: boolean;
}

interface NavigationToolDetails {
	count: number;
	truncated: boolean;
}

interface GitDiffToolDetails {
	changedFiles: number;
	truncated: boolean;
}

function eraseTool<TParameters extends TSchema, TDetails>(
	tool: AgentTool<TParameters, TDetails>,
): AgentTool<TSchema, unknown> {
	return tool as unknown as AgentTool<TSchema, unknown>;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function canonicalizePath(cwd: string, input: string): Promise<string> {
	const absolute = resolve(cwd, input);
	if (await exists(absolute)) return realpath(absolute);

	const missing: string[] = [];
	let current = absolute;
	while (!(await exists(current))) {
		const parent = dirname(current);
		if (parent === current) throw new Error(`Cannot resolve path: ${input}`);
		missing.unshift(current.slice(parent.length).replace(/^[/\\]/u, ""));
		current = parent;
	}
	return join(await realpath(current), ...missing);
}

export async function canonicalizeWorkspace(cwd: string): Promise<string> {
	return realpath(resolve(cwd));
}

export function isWithinWorkspace(workspace: string, resource: string): boolean {
	if (!isAbsolute(resource)) return true;
	const child = relative(workspace, resource);
	return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

function countOccurrences(content: string, target: string): number {
	if (target.length === 0) return 0;
	let count = 0;
	let offset = 0;
	while (true) {
		const index = content.indexOf(target, offset);
		if (index < 0) return count;
		count++;
		offset = index + target.length;
	}
}

function truncateOutput(value: string): { output: string; truncated: boolean } {
	const bytes = Buffer.byteLength(value);
	if (bytes <= MAX_OUTPUT_BYTES) return { output: value, truncated: false };
	const buffer = Buffer.from(value);
	return {
		output: `[output truncated to last ${MAX_OUTPUT_BYTES} bytes]\n${buffer.subarray(buffer.length - MAX_OUTPUT_BYTES).toString("utf8")}`,
		truncated: true,
	};
}

export function createBuiltinTools(cwd: string): RegisteredTool[] {
	const readTool: AgentTool<typeof readSchema, FileToolDetails> = {
		name: "read",
		label: "read",
		description: "Read a bounded range of lines from a UTF-8 workspace file. Use offset to continue truncated reads.",
		parameters: readSchema,
		async execute(_toolCallId, input: Static<typeof readSchema>, signal) {
			if (signal?.aborted) throw new Error("Read aborted");
			const path = await canonicalizePath(cwd, input.path);
			const content = await readFile(path, "utf8");
			const allLines = content.split(/\r?\n/u);
			const offset = input.offset ?? 1;
			if (offset > allLines.length) throw new Error(`Read offset ${offset} exceeds ${allLines.length} lines`);
			const requested = allLines.slice(offset - 1, offset - 1 + (input.limit ?? DEFAULT_READ_LINES));
			while (requested.length > 1 && Buffer.byteLength(requested.join("\n")) > MAX_READ_BYTES) requested.pop();
			const selected = requested.join("\n");
			const endLine = offset + requested.length - 1;
			const truncated = endLine < allLines.length;
			const text = offset !== 1 || truncated
				? `[lines ${offset}-${endLine} of ${allLines.length}]\n${selected}${truncated ? `\n[truncated; continue with offset=${endLine + 1}]` : ""}`
				: selected;
			return {
				content: [{ type: "text", text }],
				details: {
					path,
					bytes: Buffer.byteLength(text),
					totalBytes: Buffer.byteLength(content),
					offset,
					lines: requested.length,
					totalLines: allLines.length,
					truncated,
				},
			};
		},
	};

	const writeTool: AgentTool<typeof writeSchema, FileToolDetails> = {
		name: "write",
		label: "write",
		description: "Create or overwrite a UTF-8 text file in the workspace.",
		parameters: writeSchema,
		async execute(_toolCallId, input: Static<typeof writeSchema>, signal) {
			if (signal?.aborted) throw new Error("Write aborted");
			const path = await canonicalizePath(cwd, input.path);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, input.content, "utf8");
			return {
				content: [{ type: "text", text: `Wrote ${Buffer.byteLength(input.content)} bytes to ${input.path}` }],
				details: { path, bytes: Buffer.byteLength(input.content) },
			};
		},
	};

	const editTool: AgentTool<typeof editSchema, EditToolDetails> = {
		name: "edit",
		label: "edit",
		description: "Replace one unique block of text in a UTF-8 file.",
		parameters: editSchema,
		async execute(_toolCallId, input: Static<typeof editSchema>, signal) {
			if (signal?.aborted) throw new Error("Edit aborted");
			if (input.oldText.length === 0) throw new Error("oldText must not be empty");
			const path = await canonicalizePath(cwd, input.path);
			const content = await readFile(path, "utf8");
			const occurrences = countOccurrences(content, input.oldText);
			if (occurrences !== 1) throw new Error(`oldText must match exactly once; found ${occurrences} matches`);
			const updated = content.replace(input.oldText, input.newText);
			await writeFile(path, updated, "utf8");
			return {
				content: [{ type: "text", text: `Edited ${input.path}` }],
				details: { path, bytes: Buffer.byteLength(updated), replacements: 1 },
			};
		},
	};

	const execTool: AgentTool<typeof execSchema, ExecToolDetails> = {
		name: "exec",
		label: "exec",
		description: "Execute a shell command in the workspace.",
		parameters: execSchema,
		async execute(_toolCallId, input: Static<typeof execSchema>, signal) {
			const result = await executeCommand(input.command, cwd, input.timeoutMs, signal);
			const truncated = truncateOutput(`${result.stdout}${result.stderr}`);
			if (result.timedOut) throw new Error(`${truncated.output}\nCommand timed out`.trim());
			if (result.exitCode !== 0) {
				throw new Error(`${truncated.output}\nCommand exited with code ${String(result.exitCode)}`.trim());
			}
			return {
				content: [{ type: "text", text: truncated.output || "(no output)" }],
				details: { exitCode: result.exitCode, timedOut: false, truncated: truncated.truncated },
			};
		},
	};

	return [
		{
			tool: eraseTool(readTool),
			resolveResources: async (args) => [await canonicalizePath(cwd, (args as Static<typeof readSchema>).path)],
			summarizeArgs: (args) => ({ path: (args as Static<typeof readSchema>).path }),
		},
		{
			tool: eraseTool(writeTool),
			resolveResources: async (args) => [await canonicalizePath(cwd, (args as Static<typeof writeSchema>).path)],
			summarizeArgs: (args) => ({ path: (args as Static<typeof writeSchema>).path }),
		},
		{
			tool: eraseTool(editTool),
			resolveResources: async (args) => [await canonicalizePath(cwd, (args as Static<typeof editSchema>).path)],
			summarizeArgs: (args) => ({ path: (args as Static<typeof editSchema>).path }),
		},
		{
			tool: eraseTool(execTool),
			resolveResources: (args) => [(args as Static<typeof execSchema>).command],
			summarizeArgs: () => ({ command: "[redacted]" }),
		},
	];
}

export function createWorkspaceNavigationTools(cwd: string): RegisteredTool[] {
	const listTool: AgentTool<typeof listSchema, NavigationToolDetails> = {
		name: "list",
		label: "list",
		description: "List files and directories inside the workspace without executing shell commands.",
		parameters: listSchema,
		async execute(_toolCallId, input: Static<typeof listSchema>, signal) {
			if (signal?.aborted) throw new Error("List aborted");
			const root = await canonicalizePath(cwd, input.path ?? ".");
			const depth = input.depth ?? 2;
			const limit = input.limit ?? 200;
			const entries: string[] = [];
			async function visit(directory: string, currentDepth: number): Promise<void> {
				if (entries.length >= limit || signal?.aborted) return;
				const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
					left.name.localeCompare(right.name),
				);
				for (const child of children) {
					if (entries.length >= limit) return;
					if (child.name === ".git") continue;
					const path = join(directory, child.name);
					const display = relative(cwd, path) || ".";
					entries.push(`${child.isDirectory() ? "dir" : child.isSymbolicLink() ? "symlink" : "file"}\t${display}`);
					if (child.isDirectory() && currentDepth < depth) await visit(path, currentDepth + 1);
				}
			}
			await visit(root, 1);
			if (signal?.aborted) throw new Error("List aborted");
			return {
				content: [{ type: "text", text: entries.join("\n") || "(empty directory)" }],
				details: { count: entries.length, truncated: entries.length >= limit },
			};
		},
	};

	const searchTool: AgentTool<typeof searchSchema, NavigationToolDetails> = {
		name: "search",
		label: "search",
		description: "Search UTF-8 source files inside the workspace without executing shell commands.",
		parameters: searchSchema,
		async execute(_toolCallId, input: Static<typeof searchSchema>, signal) {
			if (signal?.aborted) throw new Error("Search aborted");
			const root = await canonicalizePath(cwd, input.path ?? ".");
			const matcher = input.regex ? new RegExp(input.query, "u") : undefined;
			const maxResults = input.maxResults ?? 100;
			const results: string[] = [];
			let scannedFiles = 0;
			async function scanFile(path: string): Promise<void> {
				if (results.length >= maxResults || scannedFiles >= 5_000 || signal?.aborted) return;
				scannedFiles++;
				let content: Buffer;
				try {
					content = await readFile(path);
				} catch {
					return;
				}
				if (content.length > 1_000_000 || content.includes(0)) return;
				const lines = content.toString("utf8").split(/\r?\n/u);
				for (let index = 0; index < lines.length; index++) {
					const line = lines[index] ?? "";
					if (!(matcher ? matcher.test(line) : line.includes(input.query))) continue;
					results.push(`${relative(cwd, path)}:${index + 1}:${line.slice(0, 500)}`);
					if (results.length >= maxResults) return;
				}
			}
			async function visit(directory: string): Promise<void> {
				if (results.length >= maxResults || scannedFiles >= 5_000 || signal?.aborted) return;
				for (const entry of await readdir(directory, { withFileTypes: true })) {
					if (results.length >= maxResults || scannedFiles >= 5_000) return;
					if (entry.name === ".git") continue;
					const path = join(directory, entry.name);
					if (entry.isDirectory()) {
						await visit(path);
						continue;
					}
					if (entry.isFile()) await scanFile(path);
				}
			}
			const rootStats = await stat(root);
			if (rootStats.isFile()) await scanFile(root);
			else if (rootStats.isDirectory()) await visit(root);
			else throw new Error(`Search path must be a file or directory: ${input.path ?? "."}`);
			if (signal?.aborted) throw new Error("Search aborted");
			return {
				content: [{ type: "text", text: results.join("\n") || "No matches" }],
				details: { count: results.length, truncated: results.length >= maxResults || scannedFiles >= 5_000 },
			};
		},
	};

	const gitDiffTool: AgentTool<typeof gitDiffSchema, GitDiffToolDetails> = {
		name: "git_diff",
		label: "git_diff",
		description:
			"Review all current workspace changes before finishing. Shows Git status and the unstaged diff without executing repository code.",
		parameters: gitDiffSchema,
		async execute(_toolCallId, _input: Static<typeof gitDiffSchema>, signal) {
			if (signal?.aborted) throw new Error("Git diff aborted");
			const status = await executeFile("git", ["-c", "core.hooksPath=/dev/null", "status", "--short"], cwd, signal);
			if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
			const diff = await executeFile(
				"git",
				["-c", "core.hooksPath=/dev/null", "diff", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "--", "."],
				cwd,
				signal,
			);
			if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
			const output = truncateOutput(`Git status:\n${status.stdout || "(clean)"}\nGit diff:\n${diff.stdout || "(no tracked diff)"}`);
			return {
				content: [{ type: "text", text: output.output }],
				details: {
					changedFiles: status.stdout.split(/\r?\n/u).filter(Boolean).length,
					truncated: output.truncated,
				},
			};
		},
	};

	return [
		{
			tool: eraseTool(listTool),
			resolveResources: async (args) => [
				await canonicalizePath(cwd, (args as Static<typeof listSchema>).path ?? "."),
			],
			summarizeArgs: (args) => ({ path: (args as Static<typeof listSchema>).path ?? "." }),
		},
		{
			tool: eraseTool(searchTool),
			resolveResources: async (args) => [
				await canonicalizePath(cwd, (args as Static<typeof searchSchema>).path ?? "."),
			],
			summarizeArgs: (args) => ({
				path: (args as Static<typeof searchSchema>).path ?? ".",
				query: "[redacted]",
			}),
		},
		{
			tool: eraseTool(gitDiffTool),
			resolveResources: () => [resolve(cwd)],
			summarizeArgs: () => ({}),
		},
	];
}

async function executeFile(
	executable: string,
	args: string[],
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		const onAbort = (): void => {
			child.kill("SIGKILL");
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (exitCode) => {
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr, exitCode });
		});
	});
}

async function executeCommand(
	command: string,
	cwd: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/bash", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = (): void => {
			child.kill("SIGKILL");
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		if (timeoutMs !== undefined) {
			timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, timeoutMs);
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("close", (exitCode) => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolvePromise({ stdout, stderr, exitCode, timedOut });
		});
	});
}
