// A4 Git adapter — real implementation over the git CLI.
// This adapter is the ONLY writer of repository state in the system.

import type {
	DiffSummary,
	FileChange,
	GitAdapter,
	MergeResult,
	WorktreeInfo,
} from "./contracts.ts";

async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		throw new Error(`git ${args[0]} failed (${code}): ${err.trim() || out.trim()}`);
	}
	return out.trim();
}

export class RealGitAdapter implements GitAdapter {
	async createWorktree(
		repoPath: string,
		name: string,
		baseRef = "HEAD",
	): Promise<WorktreeInfo> {
		const branch = `zci/${name}`;
		const path = `${repoPath}/.zci-worktrees/${name}`;
		const base = await git(repoPath, ["rev-parse", baseRef]);
		await git(repoPath, ["worktree", "add", path, "-b", branch, base]);
		return { path, branch, baseRef: base };
	}

	async getDiff(worktreePath: string, baseRef: string): Promise<DiffSummary> {
		// Everything the agent changed vs the worktree's base — committed or not.
		// -M enables rename detection so renames appear as such, not delete+add.
		const patch = await git(worktreePath, ["diff", "-M", baseRef]);
		const status = await git(worktreePath, ["status", "--porcelain"]);
		const newFiles = status
			.split("\n")
			.filter((l) => l.startsWith("??"))
			.map((l) => l.slice(3).trim());
		let insertions = 0;
		let deletions = 0;
		const stat = await git(worktreePath, ["diff", "--shortstat", baseRef]).catch(() => "");
		const ins = /(\d+) insertion/.exec(stat);
		const del = /(\d+) deletion/.exec(stat);
		if (ins?.[1]) insertions = parseInt(ins[1], 10);
		if (del?.[1]) deletions = parseInt(del[1], 10);
		const changes: FileChange[] = [];
		const nameStatus = await git(worktreePath, [
			"diff", "--name-status", "-M", baseRef,
		]).catch(() => "");
		for (const line of nameStatus.split("\n").filter(Boolean)) {
			const [code, ...paths] = line.split("\t");
			const first = paths[0] ?? "";
			if (code?.startsWith("R")) {
				changes.push({ status: "renamed", path: paths[1] ?? first, oldPath: first });
			} else if (code === "A") {
				changes.push({ status: "added", path: first });
			} else if (code === "D") {
				changes.push({ status: "deleted", path: first });
			} else {
				changes.push({ status: "modified", path: first });
			}
		}
		const filesChanged = new Set([...changes.map((c) => c.path), ...newFiles]).size;
		return { filesChanged, insertions, deletions, patch, newFiles, changes };
	}

	async commitAll(worktreePath: string, message: string): Promise<string> {
		await git(worktreePath, ["add", "-A"]);
		const status = await git(worktreePath, ["status", "--porcelain"]);
		if (status.length === 0) {
			return git(worktreePath, ["rev-parse", "HEAD"]);
		}
		await git(worktreePath, [
			"-c", "user.name=zerocodein-agent",
			"-c", "user.email=agent@zerocodein.local",
			"commit", "-m", message,
		]);
		return git(worktreePath, ["rev-parse", "HEAD"]);
	}

	async applyToParent(repoPath: string, worktree: WorktreeInfo): Promise<MergeResult> {
		// Ensure the worktree's changes are committed before merging.
		const status = await git(worktree.path, ["status", "--porcelain"]);
		if (status.length > 0) {
			await this.commitAll(worktree.path, "zerocodein: agent work");
		}
		const headBefore = await git(repoPath, ["rev-parse", "HEAD"]);
		try {
			await git(repoPath, [
				"-c", "user.name=zerocodein",
				"-c", "user.email=orchestrator@zerocodein.local",
				"merge", "--no-ff", worktree.branch,
				"-m", `zerocodein: merge ${worktree.branch}`,
			]);
		} catch (e) {
			const conflicting = await git(repoPath, [
				"diff", "--name-only", "--diff-filter=U",
			]).catch(() => "");
			await git(repoPath, ["merge", "--abort"]).catch(() => {});
			await git(repoPath, ["reset", "--hard", headBefore]).catch(() => {});
			const err = e as Error;
			throw new Error(
				`merge conflict applying ${worktree.branch}: ${conflicting || err.message}`,
			);
		}
		return { commit: await git(repoPath, ["rev-parse", "HEAD"]), conflictingFiles: [] };
	}

	async deleteWorktree(repoPath: string, worktree: WorktreeInfo): Promise<void> {
		await git(repoPath, ["worktree", "remove", "--force", worktree.path]).catch(() => {});
		await git(repoPath, ["branch", "-D", worktree.branch]).catch(() => {});
	}
}
