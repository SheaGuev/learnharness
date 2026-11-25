import type { HubConcept, HubEvidence, HubState } from "./contracts/hub.ts";
import type { PlanTree } from "./contracts/plan.ts";
import { applyHubAction, type HubAction } from "./hub.ts";
import { conceptForNode } from "./hub-evidence.ts";

export const OUTCOME_STATUSES = ["solid", "shaky", "gap"] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

/** What a teacher or prober reports about a lesson-linked session. */
export interface SessionOutcome {
	summary: string;
	concepts: { slug: string; status: OutcomeStatus; note?: string }[];
	explore?: { title: string; why: string }[];
	deeperDives?: { title: string; goal: string; fromSlug: string }[];
}

export interface OutcomeSource {
	chatId: string;
	lessonId: string;
	/** The reporting tool call; with the chat id it makes every derived id deterministic. */
	callId: string;
	at: string;
	/** The chat's plan map, for resolving slugs the teacher renamed. */
	tree?: PlanTree;
}

export interface OutcomeChanges {
	state: HubState;
	evidence: HubEvidence[];
	/** Explore items this call adds that the state did not already hold. */
	exploreAdded: number;
	/** Reported slugs that match none of the lesson's concepts. */
	unknownSlugs: string[];
	/** The lesson's own then prerequisite concepts, for telling the model which slugs are valid. */
	lessonConcepts: HubConcept[];
}

/**
 * Turn an outcome report into `assessment` evidence for the lesson's (and
 * its prerequisites') concepts and `teacher` explore items (deeper dives included, with the
 * goal as the reason). Ids derive from chat, call and concept, so applying
 * the same call twice adds nothing. Null when the lesson no longer exists.
 */
export function sessionOutcomeChanges(state: HubState, source: OutcomeSource, outcome: SessionOutcome): OutcomeChanges | null {
	const lesson = state.lessons.find((l) => l.id === source.lessonId);
	if (!lesson) return null;
	// Prerequisite concepts count too: the probe policy judges a lesson by
	// them, so a probe's findings on them must land or the next session re-probes.
	const prereqIds = state.lessons.filter((l) => lesson.prereqLessonIds.includes(l.id)).flatMap((l) => l.conceptIds);
	const byId = new Map(state.concepts.map((c) => [c.id, c]));
	const lessonConcepts = [...new Set([...lesson.conceptIds, ...prereqIds])].flatMap((id) => byId.get(id) ?? []);
	const resolve = (slug: string) => conceptForNode(slug, lessonConcepts, source.tree);

	// Two reports on one concept in a single call: the later one stands.
	const byConcept = new Map<string, HubEvidence>();
	const unknownSlugs: string[] = [];
	for (const report of outcome.concepts) {
		const concept = resolve(report.slug);
		if (!concept) {
			unknownSlugs.push(report.slug);
			continue;
		}
		const note = report.note?.trim();
		byConcept.set(concept.id, {
			id: `assessment_${source.chatId}_${source.callId}_${concept.slug}`,
			conceptId: concept.id,
			chatId: source.chatId,
			lessonId: lesson.id,
			at: source.at,
			kind: "assessment",
			result: report.status,
			...(note ? { note } : {}),
		});
	}

	const drafts: { id: string; action: HubAction }[] = [];
	const exploreAction = (title: string, why: string, fromConceptId?: string): HubAction => ({
		type: "explore.add", title, why, source: "teacher", topicId: lesson.topicId, chatId: source.chatId,
		...(fromConceptId ? { fromConceptId } : {}),
	});
	(outcome.explore ?? []).forEach((e, i) => {
		drafts.push({ id: `explore_${source.chatId}_${source.callId}_${i}`, action: exploreAction(e.title, e.why) });
	});
	(outcome.deeperDives ?? []).forEach((d, i) => {
		drafts.push({ id: `deeper_${source.chatId}_${source.callId}_${i}`, action: exploreAction(d.title, d.goal, resolve(d.fromSlug)?.id) });
	});

	let next = state;
	let exploreAdded = 0;
	for (const draft of drafts) {
		if (next.explore.some((e) => e.id === draft.id)) continue;
		next = applyHubAction(next, draft.action, { now: source.at, newId: () => draft.id }).state;
		exploreAdded++;
	}
	return { state: next, evidence: [...byConcept.values()], exploreAdded, unknownSlugs, lessonConcepts };
}
