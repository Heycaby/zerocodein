// A3 IDE adapter — console implementation for headless runs/tests.
// A workbench contribution will implement the same contract inside the app.

import type { IdeAdapter } from "./contracts.ts";

export class ConsoleIdeAdapter implements IdeAdapter {
	readonly notifications: { message: string; level: string }[] = [];
	private answers: Record<string, string> = {};

	/** Preload answers for headless runs: question substring → answer. */
	withAnswers(answers: Record<string, string>): this {
		this.answers = answers;
		return this;
	}

	notify(message: string, level: "info" | "warn" | "error"): void {
		this.notifications.push({ message, level });
		console.log(`[${level.toUpperCase()}] ${message}`);
	}

	showDiff(taskId: string, worktreePath: string, diffSummary: string): void {
		console.log(`\n===== DIFF for task ${taskId} (${worktreePath}) =====\n${diffSummary}\n===== END DIFF =====\n`);
	}

	async ask(question: string): Promise<string> {
		for (const [key, answer] of Object.entries(this.answers)) {
			if (question.includes(key)) return answer;
		}
		// FAIL CLOSED: no configured answer means denial, never implicit
		// approval. Scripted flows must preload explicit answers.
		return "deny";
	}
}
