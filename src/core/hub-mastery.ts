import type {
	ConceptMastery, ConceptStatus, HubEvidence, HubMastery, HubState, LessonProgress, LessonStatus, PlanProgress,
} from "./contracts/hub.ts";

/** Days until a solid concept is due again; each later pass moves one step along. */
export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 21, 60] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

function assessed(result: HubEvidence["result"]): ConceptStatus {
	switch (result) {
		case "solid": return "solid";
		case "shaky": return "shaky";
		case "gap": return "gap";
		case "pass": return "learning";
		case "fail": return "gap";
	}
}

/**
 * Fold one concept's evidence in time order. A teacher assessment sets the
 * status outright; checks and practice move it: passes in two different
 * chats with no fail in between make it solid, and a fail knocks solid back
 * to shaky. Solid concepts come due for review on a widening schedule.
 */
export function conceptMastery(evidence: readonly HubEvidence[], now: Date): ConceptMastery {
	const sorted = [...evidence].sort((a, b) => a.at.localeCompare(b.at));
	let status: ConceptStatus = "not-yet";
	let passes = 0;
	let fails = 0;
	let passChats = new Set<string>();
	let interval = 0;
	let lastAt: string | null = null;

	for (const e of sorted) {
		lastAt = e.at;
		if (e.kind === "assessment") {
			const next = assessed(e.result);
			if (next === "solid" && status !== "solid") interval = 0;
			status = next;
			passChats = new Set();
			continue;
		}
		if (e.result === "pass" || e.result === "solid") {
			passes++;
			passChats.add(e.chatId);
			if (status === "solid") interval = Math.min(interval + 1, REVIEW_INTERVAL_DAYS.length - 1);
			else if (passChats.size >= 2) { status = "solid"; interval = 0; }
			else if (status === "not-yet" || status === "gap") status = "learning";
		} else {
			fails++;
			passChats = new Set();
			interval = 0;
			if (status === "solid") status = "shaky";
			else if (status === "not-yet") status = "learning";
		}
	}

	if (status !== "solid" || lastAt === null) return { status, passes, fails, lastAt, dueAt: null, reviewDue: false };
	const days = REVIEW_INTERVAL_DAYS[interval] ?? 60;
	const due = new Date(Date.parse(lastAt) + days * DAY_MS);
	return { status, passes, fails, lastAt, dueAt: due.toISOString(), reviewDue: now.getTime() >= due.getTime() };
}

const NOT_YET: ConceptMastery = { status: "not-yet", passes: 0, fails: 0, lastAt: null, dueAt: null, reviewDue: false };

function lessonProgress(conceptIds: readonly string[], concepts: Record<string, ConceptMastery>, hasSession: boolean): LessonProgress {
	const states = conceptIds.map((id) => concepts[id] ?? NOT_YET);
	const solid = states.filter((c) => c.status === "solid").length;
	const total = states.length;
	const touched = hasSession || states.some((c) => c.status !== "not-yet");
	let status: LessonStatus;
	if (!touched) status = "not-started";
	else if (total > 0 && solid === total) status = states.some((c) => c.reviewDue) ? "needs-review" : "complete";
	else status = "in-progress";
	return { status, solid, total };
}

/**
 * Project mastery for every concept, lesson and plan. `lessonsWithSessions`
 * marks lessons that have at least one linked chat, so a started lesson
 * with no evidence yet still reads as in progress.
 */
export function projectMastery(
	state: HubState,
	evidence: readonly HubEvidence[],
	now: Date,
	lessonsWithSessions: ReadonlySet<string> = new Set(),
): HubMastery {
	const byConcept = new Map<string, HubEvidence[]>();
	for (const e of evidence) {
		const list = byConcept.get(e.conceptId) ?? [];
		list.push(e);
		byConcept.set(e.conceptId, list);
	}
	const concepts: Record<string, ConceptMastery> = {};
	for (const c of state.concepts) concepts[c.id] = conceptMastery(byConcept.get(c.id) ?? [], now);

	const lessons: Record<string, LessonProgress> = {};
	for (const l of state.lessons) lessons[l.id] = lessonProgress(l.conceptIds, concepts, lessonsWithSessions.has(l.id));

	const lessonById = new Map(state.lessons.map((l) => [l.id, l]));
	const plans: Record<string, PlanProgress> = {};
	for (const p of state.plans) {
		const ordered = p.milestones.flatMap((m) => m.lessonIds);
		const conceptIds = new Set(ordered.flatMap((id) => lessonById.get(id)?.conceptIds ?? []));
		const solid = [...conceptIds].filter((id) => concepts[id]?.status === "solid").length;
		const nextLessonId = ordered.find((id) => lessons[id]?.status !== "complete") ?? null;
		plans[p.id] = { solid, total: conceptIds.size, nextLessonId };
	}
	return { concepts, lessons, plans };
}
