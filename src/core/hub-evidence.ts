import type { HubConcept, HubEvidence, HubState } from "./contracts/hub.ts";
import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage } from "./native-messages.ts";
import { slugify } from "./hub.ts";

function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface EvidenceSource {
	id: string;
	lessonId: string;
	messages: readonly LhMessage[];
	tree?: PlanTree;
	updatedAt: string;
}

/**
 * Resolve a plan-map node id to one of the lesson's concepts: by slug first,
 * then by the node's title, since an adopted chat's map predates the lesson
 * and its slugs were chosen by the teacher.
 */
export function conceptForNode(nodeId: string, concepts: readonly HubConcept[], tree: PlanTree | undefined): HubConcept | undefined {
	const bySlug = concepts.find((c) => c.slug === nodeId || c.slug === slugify(nodeId));
	if (bySlug) return bySlug;
	const title = tree?.nodes.find((n) => n.id === nodeId)?.title;
	if (!title) return undefined;
	const titleSlug = slugify(title);
	return concepts.find((c) => c.slug === titleSlug || slugify(c.title) === titleSlug);
}

/**
 * Evidence from graded `quiz` checks in a lesson-linked chat. Predictions are
 * skipped (they come before teaching), as are dismissed questions and errors.
 * Ids derive from the tool call, so re-scanning a chat never duplicates.
 */
export function checkEvidenceFromChat(chat: EvidenceSource, state: HubState): HubEvidence[] {
	const lesson = state.lessons.find((l) => l.id === chat.lessonId);
	if (!lesson) return [];
	const lessonConcepts = state.concepts.filter((c) => lesson.conceptIds.includes(c.id));
	if (lessonConcepts.length === 0) return [];

	const checkNodes = new Map<string, string>();
	const out: HubEvidence[] = [];
	for (const m of chat.messages) {
		if (m.role === "assistant") {
			for (const block of m.content) {
				if (block.type !== "toolCall" || block.name !== "quiz") continue;
				const args = block.arguments;
				if (args.type === "check" && typeof args.nodeId === "string" && args.nodeId) checkNodes.set(block.id, args.nodeId);
			}
			continue;
		}
		if (m.role !== "toolResult" || m.toolName !== "quiz" || m.isError) continue;
		const nodeId = checkNodes.get(m.toolCallId);
		if (!nodeId) continue;
		const details = m.details;
		if (!isRec(details) || details.dismissed === true) continue;
		const passed = details.dontKnow === true ? false : typeof details.correct === "boolean" ? details.correct : undefined;
		if (passed === undefined) continue;
		const concept = conceptForNode(nodeId, lessonConcepts, chat.tree);
		if (!concept) continue;
		out.push({
			id: `check_${chat.id}_${m.toolCallId}`,
			conceptId: concept.id,
			chatId: chat.id,
			lessonId: lesson.id,
			at: Number.isFinite(m.timestamp) ? new Date(m.timestamp).toISOString() : chat.updatedAt,
			kind: "check",
			result: passed ? "pass" : "fail",
		});
	}
	return out;
}
