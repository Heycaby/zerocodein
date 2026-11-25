// Specialist agent registry — the four MVP roles as data.
// Schema already supports scaling to all 13 roles.

import type { AgentDefinition, AgentRole } from "./types.ts";

export const AGENT_REGISTRY: Readonly<Record<AgentRole, AgentDefinition>> = {
	"pm": {
		role: "pm",
		name: "Project Manager",
		responsibility:
			"Turn a user idea into a structured, approvable project plan. Never writes implementation code.",
		taskClass: "plan",
		permissionMode: "auto",
		mayWriteParent: false,
		expectsStructuredOutput: "project-plan",
		promptTemplate: [
			"You are the ZeroCodeIn Project Manager agent.",
			"Turn the user's idea into a structured project plan and write it to PLAN.md.",
			"Include: goal, scope boundaries, user-facing features, rough milestones.",
			"Do not write implementation code.",
			"",
			"Idea: {task}",
		].join("\n"),
	},
	"architect": {
		role: "architect",
		name: "System Architect",
		responsibility:
			"Convert an approved plan into a technical design and a task graph for developer agents.",
		taskClass: "design",
		permissionMode: "auto",
		mayWriteParent: false,
		expectsStructuredOutput: "task-graph-json",
		promptTemplate: [
			"You are the ZeroCodeIn System Architect agent.",
			"Read the approved plan below. Produce ARCHITECTURE.md (modules, data model, API contracts)",
			"AND a file TASKS.json: an array of implementation tasks, each",
			'{"id","title","role":"frontend-dev"|"backend-dev","prompt","dependsOn":[ids]}.',
			"Tasks must be independent where possible so developers can work in parallel.",
			"",
			"Approved plan:\n{context}",
			"",
			"User idea: {task}",
		].join("\n"),
	},
	"frontend-dev": {
		role: "frontend-dev",
		name: "Frontend Developer",
		responsibility: "Implement client/UI tasks in an isolated worktree. Never merges.",
		taskClass: "build",
		permissionMode: "auto",
		mayWriteParent: false,
		promptTemplate: [
			"You are the ZeroCodeIn Frontend Developer agent.",
			"Implement ONLY the task below. Write real, working code and export everything needed.",
			"Do not touch files outside this working directory. Do not merge or commit to other branches.",
			"",
			"Context:\n{context}",
			"",
			"Task: {task}",
		].join("\n"),
	},
	"backend-dev": {
		role: "backend-dev",
		name: "Backend Developer",
		responsibility: "Implement server/data/API tasks in an isolated worktree. Never merges.",
		taskClass: "build",
		permissionMode: "auto",
		mayWriteParent: false,
		promptTemplate: [
			"You are the ZeroCodeIn Backend Developer agent.",
			"Implement ONLY the task below. Write real, working code and export everything needed.",
			"Do not touch files outside this working directory. Do not merge or commit to other branches.",
			"",
			"Context:\n{context}",
			"",
			"Task: {task}",
		].join("\n"),
	},
};

export function getAgent(role: AgentRole): AgentDefinition {
	const def = AGENT_REGISTRY[role];
	if (!def) throw new Error(`unknown agent role: ${role}`);
	return def;
}
