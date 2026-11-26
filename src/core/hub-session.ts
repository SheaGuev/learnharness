import type { ConceptMastery, ConceptStatus, HubLesson, HubMode, HubState } from "./contracts/hub.ts";

export type ProbeReason =
	| "mode"
	| "requested"
	| "declined"
	| "new-topic"
	| "missing-evidence"
	| "review-due"
	| "fresh";

export interface ProbeDecision {
	probe: boolean;
	reason: ProbeReason;
	/** Concept ids with no evidence or a due review, when that drove the decision. */
	staleConceptIds: string[];
}

export interface ProbeDecisionInput {
	mode: HubMode;
	state: HubState;
	concepts: Readonly<Record<string, ConceptMastery>>;
	lesson?: HubLesson;
	topicId?: string;
	/** The learner's explicit choice; absent lets the hub decide. */
	probe?: boolean;
}

/**
 * Whether a new session should open with a probe. Only deep dives probe.
 * A lesson is judged by its prerequisite lessons' concepts (what the learner
 * must already know); a lesson with no prerequisites is judged by its own
 * concepts, and a topic-only start by the topic's concepts. A topic with no
 * evidence anywhere is new and always probes.
 */
export function decideProbe(input: ProbeDecisionInput): ProbeDecision {
	if (input.mode !== "deep-dive") return { probe: false, reason: "mode", staleConceptIds: [] };
	if (input.probe === true) return { probe: true, reason: "requested", staleConceptIds: [] };
	if (input.probe === false) return { probe: false, reason: "declined", staleConceptIds: [] };

	const { state, concepts, lesson } = input;
	const topicId = lesson?.topicId ?? input.topicId;
	const known = (id: string) => (concepts[id]?.lastAt ?? null) !== null;
	const topicConceptIds = state.concepts.filter((c) => c.topicId === topicId).map((c) => c.id);
	if (!topicConceptIds.some(known)) return { probe: true, reason: "new-topic", staleConceptIds: topicConceptIds };

	const lessonById = new Map(state.lessons.map((l) => [l.id, l]));
	const prereqIds = lesson ? lesson.prereqLessonIds.flatMap((id) => lessonById.get(id)?.conceptIds ?? []) : [];
	const judged = lesson ? (prereqIds.length > 0 ? prereqIds : lesson.conceptIds) : topicConceptIds;

	const missing = judged.filter((id) => !known(id));
	if (missing.length > 0) return { probe: true, reason: "missing-evidence", staleConceptIds: missing };
	const due = judged.filter((id) => concepts[id]?.reviewDue === true);
	if (due.length > 0) return { probe: true, reason: "review-due", staleConceptIds: due };
	return { probe: false, reason: "fresh", staleConceptIds: [] };
}

export interface SessionBriefConcept {
	/** The plan-map node id teachers tag checks with. */
	slug: string;
	title: string;
	status: ConceptStatus;
	lastAt: string | null;
	reviewDue: boolean;
	/** True for a concept of a prerequisite lesson rather than this lesson. */
	prerequisite: boolean;
}

/** The session-brief marker's details: what the hub knew when the session started. */
export interface SessionBrief {
	mode: HubMode;
	goal: string;
	lessonTitle?: string;
	topicTitle?: string;
	planTitle?: string;
	milestoneTitle?: string;
	probe: boolean;
	probeReason: ProbeReason;
	concepts: SessionBriefConcept[];
}

const MODE_LABELS: Record<HubMode, string> = {
	ask: "Ask",
	explain: "Explain",
	"deep-dive": "Deep dive",
	practice: "Practice",
	plan: "Plan",
};

function modeRules(brief: SessionBrief): string {
	switch (brief.mode) {
		case "ask":
			return "Answer the learner's question directly. Don't probe, plan or quiz. If they want more, offer an Explain or Deep dive session.";
		case "explain":
			return "Teach a short lesson on the goal, starting now: there is no probe. Plan from the known state below, keep it brief, and finish with a few checks on the lesson concepts.";
		case "deep-dive":
			return brief.probe
				? "Probe first, as thoroughly as usual, but don't re-test concepts recorded below as solid unless their review is due. Then plan and teach step by step with checks."
				: "The learner's state below is recent, so there is no probe: plan from it and teach step by step with checks.";
		case "practice":
			return "Set practice problems on the concepts below, weighted toward shaky, gap and review-due ones.";
		case "plan":
			if (brief.milestoneTitle) return "Revise one milestone of an existing plan with the learner: its goal, topics and lessons. Keep the plan's other milestones as they are.";
			return brief.planTitle
				? "Revise an existing plan with the learner. Find out what should change, then save the revised plan."
				: "Find out what the learner wants to achieve, then build a plan with them and save it to the hub.";
	}
}

function conceptLine(c: SessionBriefConcept): string {
	const state = c.lastAt === null
		? "no evidence yet"
		: `${c.status}${c.reviewDue ? ", review due" : ""}, last seen ${c.lastAt.slice(0, 10)}`;
	return `- ${c.slug} — ${c.title}: ${state}`;
}

/** The brief's model-facing text. */
export function sessionBriefText(brief: SessionBrief): string {
	const own = brief.concepts.filter((c) => !c.prerequisite);
	const prereqs = brief.concepts.filter((c) => c.prerequisite);
	const lines = [
		// Markers reach the model as user-role messages, so the bracket marks
		// this as injected session context rather than the learner's words.
		"[Session brief] — set by the learning hub when this session started:",
		"",
		`Mode: ${MODE_LABELS[brief.mode]}. ${modeRules(brief)}`,
	];
	if (brief.planTitle) lines.push(`Plan: ${brief.planTitle}${brief.milestoneTitle ? ` (milestone: ${brief.milestoneTitle})` : ""}`);
	if (brief.lessonTitle) lines.push(`Lesson: ${brief.lessonTitle}${brief.topicTitle ? ` (topic: ${brief.topicTitle})` : ""}`);
	else if (brief.topicTitle) lines.push(`Topic: ${brief.topicTitle}`);
	lines.push(`Goal: ${brief.goal}`);
	if (own.length > 0) {
		lines.push(
			"",
			brief.mode === "ask" || brief.mode === "practice"
				? "Concepts (slug — title: known state):"
				: "Lesson concepts (slug — title: known state). Use these slugs as the plan_init node ids, and as the nodeId of checks on these concepts:",
			...own.map(conceptLine),
		);
	}
	if (prereqs.length > 0) lines.push("", "Prerequisites from earlier lessons:", ...prereqs.map(conceptLine));
	return lines.join("\n");
}
