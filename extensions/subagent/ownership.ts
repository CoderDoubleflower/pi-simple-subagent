import * as fs from "node:fs";
import * as path from "node:path";

export interface WriteScope { path: string; tree: boolean }

/** Resolve symlinks even for a file that has not been created yet. */
export function canonicalPath(value: string, cwd: string): string {
	let existing = path.resolve(cwd, value);
	const suffix: string[] = [];
	for (;;) {
		try {
			const result = path.join(fs.realpathSync.native(existing), ...suffix);
			return process.platform === "win32" ? result.toLowerCase() : result;
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			suffix.unshift(path.basename(existing));
			existing = parent;
		}
	}
}

export function normalizeScopes(values: readonly string[], cwd: string): WriteScope[] {
	const scopes = values.map((raw) => {
		const value = raw.trim();
		if (!value) throw new Error("write_scope entries must not be empty.");
		const treeSuffix = /(?:\/|\\)\*\*$/.test(value);
		const base = treeSuffix ? value.slice(0, -3) || path.parse(value).root : value;
		if (/[*?\[\]{}]/.test(base)) {
			throw new Error("write_scope supports exact files, directories, and a trailing /** only; arbitrary globs are not supported.");
		}
		const resolved = canonicalPath(base, cwd);
		let directory = false;
		try { directory = fs.statSync(resolved).isDirectory(); } catch { /* May be a new file or directory. */ }
		return { path: resolved, tree: treeSuffix || /[\\/]$/.test(value) || directory };
	});
	return scopes.filter((scope, index) => scopes.findIndex((item) => item.path === scope.path && item.tree === scope.tree) === index);
}

function within(file: string, directory: string): boolean {
	const relative = path.relative(directory, file);
	return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

export function scopesOverlap(left: WriteScope, right: WriteScope): boolean {
	return left.path === right.path || (left.tree && within(right.path, left.path)) || (right.tree && within(left.path, right.path));
}

/** Only tools with explicit write destinations can be checked; this is not a shell sandbox. */
export function toolWritePaths(toolName: string, input: Record<string, unknown>): string[] | undefined {
	const name = toolName.toLowerCase();
	if (["write", "edit", "multiedit"].includes(name)) {
		const file = input.path ?? input.file_path;
		return typeof file === "string" && file.trim() ? [file] : [];
	}
	if (name !== "apply_patch") return undefined;
	const patch = input.patch ?? input.input;
	if (typeof patch !== "string") return [];
	return [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/gm)].map((match) => match[1].trim());
}

export function describeScopes(scopes: readonly WriteScope[]): string[] {
	return scopes.map((scope) => scope.path + (scope.tree ? `${path.sep}**` : ""));
}
