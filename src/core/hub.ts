import {
	CURRENT_HUB_VERSION, EVIDENCE_KINDS, EVIDENCE_RESULTS, EXPLORE_SOURCES, EXPLORE_STATUSES, HUB_MODES,
	type HubConcept, type HubEvidence, type HubExploreItem, type HubLesson, type HubMilestone, type HubPlan,
	type HubState, type HubTopic, type SessionOrigin,
} from "./contracts/hub.ts";

/** Invalid hub input or data. Routes map it to 400; store reads surface it as a refusal. */
export class HubDataError extends Error {}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
	throw new HubDataError(message);
}

function reqStr(r: Rec, key: string, where: string): string {
	const v = r[key];
	if (typeof v !== "string" || !v.trim()) return fail(`${where}: ${key} must be a non-empty string.`);
	return v.trim();
}

function optStr(r: Rec, key: string, where: string): string | undefined {
	const v = r[key];
	if (v === undefined) return undefined;
	if (typeof v !== "string") return fail(`${where}: ${key} must be a string.`);
	return v.trim() || undefined;
}

function nullableId(r: Rec, key: string, where: string): string | null {
	const v = r[key];
	if (v === undefined || v === null) return null;
	if (typeof v !== "string" || !v) return fail(`${where}: ${key} must be an id or null.`);
	return v;
}

function strList(r: Rec, key: string, where: string): string[] {
	const v = r[key];
	if (v === undefined) return [];
	if (!Array.isArray(v)) return fail(`${where}: ${key} must be a list.`);
	return v.map((item) => (typeof item === "string" && item ? item : fail(`${where}: ${key} holds a non-id value.`)));
}

function int(r: Rec, key: string, where: string, fallback: number): number {
	const v = r[key];
	if (v === undefined) return fallback;
	if (typeof v !== "number" || !Number.isInteger(v)) return fail(`${where}: ${key} must be a whole number.`);
	return v;
}

function oneOf<T extends string>(r: Rec, key: string, allowed: readonly T[], where: string): T {
	const v = r[key];
	const match = allowed.find((a) => a === v);
	return match ?? fail(`${where}: ${key} must be one of ${allowed.join(", ")}.`);
}

function bool(r: Rec, key: string, fallback: boolean, where: string): boolean {
	const v = r[key];
	if (v === undefined) return fallback;
	if (typeof v !== "boolean") return fail(`${where}: ${key} must be true or false.`);
	return v;
}

function records(raw: Rec, key: string): Rec[] {
	const v = raw[key];
	if (v === undefined) return [];
	if (!Array.isArray(v)) return fail(`Hub data: ${key} must be a list.`);
	return v.map((item, i) => (isRec(item) ? item : fail(`Hub data: ${key}[${i}] is not an object.`)));
}

/** Lowercase plan-map slug grammar: a-z, 0-9, hyphen and underscore. */
export function slugify(title: string): string {
	const slug = title.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
	return slug || "concept";
}

export function emptyHubState(): HubState {
	return { version: CURRENT_HUB_VERSION, topics: [], concepts: [], lessons: [], plans: [], explore: [] };
}

function parseTopic(r: Rec): HubTopic {
	const w = "Topic";
	const summary = optStr(r, "summary", w);
	return {
		id: reqStr(r, "id", w), title: reqStr(r, "title", w), parentId: nullableId(r, "parentId", w),
		order: int(r, "order", w, 0), createdAt: reqStr(r, "createdAt", w), ...(summary ? { summary } : {}),
	};
}

function parseConcept(r: Rec): HubConcept {
	const w = "Concept";
	const slug = reqStr(r, "slug", w);
	if (slugify(slug) !== slug) fail(`Concept slug "${slug}" must use lowercase letters, digits, hyphens or underscores.`);
	return { id: reqStr(r, "id", w), slug, title: reqStr(r, "title", w), topicId: reqStr(r, "topicId", w) };
}

function parseLesson(r: Rec): HubLesson {
	const w = "Lesson";
	return {
		id: reqStr(r, "id", w), topicId: reqStr(r, "topicId", w), title: reqStr(r, "title", w), goal: reqStr(r, "goal", w),
		conceptIds: strList(r, "conceptIds", w), prereqLessonIds: strList(r, "prereqLessonIds", w),
		parentLessonId: nullableId(r, "parentLessonId", w), order: int(r, "order", w, 0),
		createdAt: reqStr(r, "createdAt", w), updatedAt: reqStr(r, "updatedAt", w),
	};
}

function parseMilestone(r: Rec): HubMilestone {
	const w = "Milestone";
	return { id: reqStr(r, "id", w), title: reqStr(r, "title", w), lessonIds: strList(r, "lessonIds", w) };
}

function parsePlan(r: Rec): HubPlan {
	const w = "Plan";
	return {
		id: reqStr(r, "id", w), title: reqStr(r, "title", w), goal: reqStr(r, "goal", w),
		milestones: records(r, "milestones").map(parseMilestone), archived: bool(r, "archived", false, w),
		createdAt: reqStr(r, "createdAt", w), updatedAt: reqStr(r, "updatedAt", w),
	};
}

function parseExplore(r: Rec): HubExploreItem {
	const w = "Explore item";
	const topicId = optStr(r, "topicId", w);
	const fromConceptId = optStr(r, "fromConceptId", w);
	const chatId = optStr(r, "chatId", w);
	return {
		id: reqStr(r, "id", w), title: reqStr(r, "title", w), why: reqStr(r, "why", w),
		source: oneOf(r, "source", EXPLORE_SOURCES, w), status: oneOf(r, "status", EXPLORE_STATUSES, w),
		createdAt: reqStr(r, "createdAt", w),
		...(topicId ? { topicId } : {}), ...(fromConceptId ? { fromConceptId } : {}), ...(chatId ? { chatId } : {}),
	};
}

/** Parse and integrity-check stored hub data. Refuses data stamped newer than this build. */
export function parseHubState(raw: unknown): HubState {
	if (!isRec(raw)) return fail("Hub data is not an object.");
	const version = raw.version;
	if (typeof version === "number" && version > CURRENT_HUB_VERSION) {
		return fail(`Hub data is format version ${version}, newer than this app understands (${CURRENT_HUB_VERSION}). Update the app.`);
	}
	if (version !== CURRENT_HUB_VERSION) return fail("Hub data has a missing or unknown format version.");
	const state: HubState = {
		version: CURRENT_HUB_VERSION,
		topics: records(raw, "topics").map(parseTopic),
		concepts: records(raw, "concepts").map(parseConcept),
		lessons: records(raw, "lessons").map(parseLesson),
		plans: records(raw, "plans").map(parsePlan),
		explore: records(raw, "explore").map(parseExplore),
	};
	assertHubIntegrity(state);
	return state;
}

function uniqueIds(items: readonly { id: string }[], what: string): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (ids.has(item.id)) fail(`Duplicate ${what} id "${item.id}".`);
		ids.add(item.id);
	}
	return ids;
}

/** Cross-references must resolve: topics form a tree, lessons and plans point at existing records. */
export function assertHubIntegrity(state: HubState): void {
	const topicIds = uniqueIds(state.topics, "topic");
	const conceptIds = uniqueIds(state.concepts, "concept");
	const lessonIds = uniqueIds(state.lessons, "lesson");
	uniqueIds(state.plans, "plan");
	uniqueIds(state.explore, "explore item");

	const parentOf = new Map(state.topics.map((t) => [t.id, t.parentId]));
	for (const t of state.topics) {
		if (t.parentId !== null && !topicIds.has(t.parentId)) fail(`Topic "${t.title}" has a missing parent.`);
		const seen = new Set<string>([t.id]);
		for (let p = t.parentId; p !== null; p = parentOf.get(p) ?? null) {
			if (seen.has(p)) fail(`Topic "${t.title}" is nested inside itself.`);
			seen.add(p);
		}
	}
	const slugsByTopic = new Map<string, Set<string>>();
	for (const c of state.concepts) {
		if (!topicIds.has(c.topicId)) fail(`Concept "${c.title}" belongs to a missing topic.`);
		const slugs = slugsByTopic.get(c.topicId) ?? new Set<string>();
		if (slugs.has(c.slug)) fail(`Two concepts in one topic share the slug "${c.slug}".`);
		slugs.add(c.slug);
		slugsByTopic.set(c.topicId, slugs);
	}
	for (const l of state.lessons) {
		if (!topicIds.has(l.topicId)) fail(`Lesson "${l.title}" belongs to a missing topic.`);
		for (const id of l.conceptIds) if (!conceptIds.has(id)) fail(`Lesson "${l.title}" references a missing concept.`);
		for (const id of l.prereqLessonIds) {
			if (id === l.id || !lessonIds.has(id)) fail(`Lesson "${l.title}" has an invalid prerequisite.`);
		}
		if (l.parentLessonId !== null && (l.parentLessonId === l.id || !lessonIds.has(l.parentLessonId))) {
			fail(`Lesson "${l.title}" has an invalid parent lesson.`);
		}
	}
	for (const p of state.plans) {
		uniqueIds(p.milestones, `milestone in plan "${p.title}"`);
		for (const m of p.milestones) for (const id of m.lessonIds) if (!lessonIds.has(id)) fail(`Plan "${p.title}" references a missing lesson.`);
	}
	for (const e of state.explore) {
		if (e.topicId !== undefined && !topicIds.has(e.topicId)) fail(`Explore item "${e.title}" points at a missing topic.`);
		if (e.fromConceptId !== undefined && !conceptIds.has(e.fromConceptId)) fail(`Explore item "${e.title}" points at a missing concept.`);
	}
}

export function parseSessionOrigin(raw: unknown): SessionOrigin | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRec(raw)) return fail("origin must be an object.");
	const w = "origin";
	const lessonId = optStr(raw, "lessonId", w);
	const topicId = optStr(raw, "topicId", w);
	const planId = optStr(raw, "planId", w);
	const skipProbe = raw.skipProbe === undefined ? undefined : bool(raw, "skipProbe", false, w);
	return {
		mode: oneOf(raw, "mode", HUB_MODES, w),
		...(lessonId ? { lessonId } : {}), ...(topicId ? { topicId } : {}), ...(planId ? { planId } : {}),
		...(skipProbe !== undefined ? { skipProbe } : {}),
	};
}

/** One evidence line; null for a line this build cannot interpret, so a ledger read skips it. */
export function parseEvidence(raw: unknown): HubEvidence | null {
	try {
		if (!isRec(raw)) return null;
		const w = "Evidence";
		const lessonId = optStr(raw, "lessonId", w);
		const note = optStr(raw, "note", w);
		return {
			id: reqStr(raw, "id", w), conceptId: reqStr(raw, "conceptId", w), chatId: reqStr(raw, "chatId", w),
			at: reqStr(raw, "at", w), kind: oneOf(raw, "kind", EVIDENCE_KINDS, w), result: oneOf(raw, "result", EVIDENCE_RESULTS, w),
			...(lessonId ? { lessonId } : {}), ...(note ? { note } : {}),
		};
	} catch (error) {
		if (error instanceof HubDataError) return null;
		throw error;
	}
}

// ─── edits ────────────────────────────────────────────────────────────────

export interface ConceptDraft { title: string; slug?: string }
export interface MilestoneDraft { id?: string; title: string; lessonIds: string[] }

export type HubAction =
	| { type: "topic.create"; title: string; summary?: string; parentId: string | null }
	| { type: "topic.update"; id: string; title?: string; summary?: string; parentId?: string | null; order?: number }
	| { type: "topic.delete"; id: string }
	| { type: "lesson.create"; topicId: string; title: string; goal: string; concepts: ConceptDraft[]; prereqLessonIds: string[]; parentLessonId: string | null }
	| { type: "lesson.update"; id: string; title?: string; goal?: string; topicId?: string; order?: number; prereqLessonIds?: string[]; addConcepts?: ConceptDraft[]; removeConceptIds?: string[] }
	| { type: "lesson.delete"; id: string }
	| { type: "plan.create"; title: string; goal: string; milestones: MilestoneDraft[] }
	| { type: "plan.update"; id: string; title?: string; goal?: string; archived?: boolean; milestones?: MilestoneDraft[] }
	| { type: "plan.delete"; id: string }
	| { type: "explore.add"; title: string; why: string; source: HubExploreItem["source"]; topicId?: string; fromConceptId?: string; chatId?: string }
	| { type: "explore.status"; id: string; status: HubExploreItem["status"] };

function conceptDrafts(r: Rec, key: string, where: string): ConceptDraft[] {
	return records(r, key).map((c) => {
		const slug = optStr(c, "slug", where);
		return { title: reqStr(c, "title", where), ...(slug ? { slug } : {}) };
	});
}

function milestoneDrafts(r: Rec, where: string): MilestoneDraft[] {
	return records(r, "milestones").map((m) => {
		const id = optStr(m, "id", where);
		return { title: reqStr(m, "title", where), lessonIds: strList(m, "lessonIds", where), ...(id ? { id } : {}) };
	});
}

function has(r: Rec, key: string): boolean {
	return r[key] !== undefined;
}

/** Validate an untrusted edit request body. */
export function parseHubAction(raw: unknown): HubAction {
	if (!isRec(raw)) return fail("The request must be an object.");
	const type = raw.type;
	const w = typeof type === "string" ? type : "action";
	switch (type) {
		case "topic.create": {
			const summary = optStr(raw, "summary", w);
			return { type, title: reqStr(raw, "title", w), parentId: nullableId(raw, "parentId", w), ...(summary ? { summary } : {}) };
		}
		case "topic.update": {
			const summary = optStr(raw, "summary", w);
			return {
				type, id: reqStr(raw, "id", w),
				...(has(raw, "title") ? { title: reqStr(raw, "title", w) } : {}),
				...(summary !== undefined ? { summary } : {}),
				...(has(raw, "parentId") ? { parentId: nullableId(raw, "parentId", w) } : {}),
				...(has(raw, "order") ? { order: int(raw, "order", w, 0) } : {}),
			};
		}
		case "topic.delete":
		case "lesson.delete":
		case "plan.delete":
			return { type, id: reqStr(raw, "id", w) };
		case "lesson.create":
			return {
				type, topicId: reqStr(raw, "topicId", w), title: reqStr(raw, "title", w), goal: reqStr(raw, "goal", w),
				concepts: conceptDrafts(raw, "concepts", w), prereqLessonIds: strList(raw, "prereqLessonIds", w),
				parentLessonId: nullableId(raw, "parentLessonId", w),
			};
		case "lesson.update":
			return {
				type, id: reqStr(raw, "id", w),
				...(has(raw, "title") ? { title: reqStr(raw, "title", w) } : {}),
				...(has(raw, "goal") ? { goal: reqStr(raw, "goal", w) } : {}),
				...(has(raw, "topicId") ? { topicId: reqStr(raw, "topicId", w) } : {}),
				...(has(raw, "order") ? { order: int(raw, "order", w, 0) } : {}),
				...(has(raw, "prereqLessonIds") ? { prereqLessonIds: strList(raw, "prereqLessonIds", w) } : {}),
				...(has(raw, "addConcepts") ? { addConcepts: conceptDrafts(raw, "addConcepts", w) } : {}),
				...(has(raw, "removeConceptIds") ? { removeConceptIds: strList(raw, "removeConceptIds", w) } : {}),
			};
		case "plan.create":
			return { type, title: reqStr(raw, "title", w), goal: reqStr(raw, "goal", w), milestones: milestoneDrafts(raw, w) };
		case "plan.update":
			return {
				type, id: reqStr(raw, "id", w),
				...(has(raw, "title") ? { title: reqStr(raw, "title", w) } : {}),
				...(has(raw, "goal") ? { goal: reqStr(raw, "goal", w) } : {}),
				...(has(raw, "archived") ? { archived: bool(raw, "archived", false, w) } : {}),
				...(has(raw, "milestones") ? { milestones: milestoneDrafts(raw, w) } : {}),
			};
		case "explore.add": {
			const topicId = optStr(raw, "topicId", w);
			const fromConceptId = optStr(raw, "fromConceptId", w);
			const chatId = optStr(raw, "chatId", w);
			return {
				type, title: reqStr(raw, "title", w), why: reqStr(raw, "why", w), source: oneOf(raw, "source", EXPLORE_SOURCES, w),
				...(topicId ? { topicId } : {}), ...(fromConceptId ? { fromConceptId } : {}), ...(chatId ? { chatId } : {}),
			};
		}
		case "explore.status":
			return { type, id: reqStr(raw, "id", w), status: oneOf(raw, "status", EXPLORE_STATUSES, w) };
		default:
			return fail(`Unknown hub action "${String(type)}".`);
	}
}

export interface HubEditContext {
	now: string;
	newId: (prefix: string) => string;
}

function findOrFail<T extends { id: string }>(items: readonly T[], id: string, what: string): T {
	return items.find((item) => item.id === id) ?? fail(`No ${what} with id "${id}".`);
}

function nextOrder(items: readonly { order: number }[]): number {
	return items.reduce((max, item) => Math.max(max, item.order + 1), 0);
}

/** Make concepts for a lesson, reusing a topic concept when the slug already exists there. */
function resolveConcepts(state: HubState, topicId: string, drafts: readonly ConceptDraft[], ctx: HubEditContext): { concepts: HubConcept[]; ids: string[] } {
	const concepts = [...state.concepts];
	const ids: string[] = [];
	for (const draft of drafts) {
		const slug = slugify(draft.slug ?? draft.title);
		const existing = concepts.find((c) => c.topicId === topicId && c.slug === slug);
		if (existing) {
			if (!ids.includes(existing.id)) ids.push(existing.id);
			continue;
		}
		const concept: HubConcept = { id: ctx.newId("concept"), slug, title: draft.title, topicId };
		concepts.push(concept);
		ids.push(concept.id);
	}
	return { concepts, ids };
}

function milestonesFrom(drafts: readonly MilestoneDraft[], ctx: HubEditContext): HubMilestone[] {
	return drafts.map((m) => ({ id: m.id ?? ctx.newId("milestone"), title: m.title, lessonIds: [...m.lessonIds] }));
}

export interface HubEditResult {
	state: HubState;
	/** Id of the record a create action made. */
	createdId?: string;
}

/** Apply one edit and integrity-check the result. Never mutates its input. */
export function applyHubAction(state: HubState, action: HubAction, ctx: HubEditContext): HubEditResult {
	const result = applyUnchecked(state, action, ctx);
	assertHubIntegrity(result.state);
	return result;
}

function applyUnchecked(state: HubState, action: HubAction, ctx: HubEditContext): HubEditResult {
	switch (action.type) {
		case "topic.create": {
			const siblings = state.topics.filter((t) => t.parentId === action.parentId);
			const topic: HubTopic = {
				id: ctx.newId("topic"), title: action.title, parentId: action.parentId, order: nextOrder(siblings), createdAt: ctx.now,
				...(action.summary ? { summary: action.summary } : {}),
			};
			return { state: { ...state, topics: [...state.topics, topic] }, createdId: topic.id };
		}
		case "topic.update": {
			const current = findOrFail(state.topics, action.id, "topic");
			const next: HubTopic = {
				...current,
				...(action.title !== undefined ? { title: action.title } : {}),
				...(action.summary !== undefined ? { summary: action.summary } : {}),
				...(action.parentId !== undefined ? { parentId: action.parentId } : {}),
				...(action.order !== undefined ? { order: action.order } : {}),
			};
			return { state: { ...state, topics: state.topics.map((t) => (t.id === action.id ? next : t)) } };
		}
		case "topic.delete": {
			findOrFail(state.topics, action.id, "topic");
			if (state.topics.some((t) => t.parentId === action.id)) fail("Move or delete this topic's subtopics first.");
			if (state.lessons.some((l) => l.topicId === action.id)) fail("Move or delete this topic's lessons first.");
			if (state.concepts.some((c) => c.topicId === action.id)) fail("This topic still owns concepts with recorded progress.");
			return {
				state: {
					...state,
					topics: state.topics.filter((t) => t.id !== action.id),
					explore: state.explore.map((e) => (e.topicId === action.id ? withoutKey(e, "topicId") : e)),
				},
			};
		}
		case "lesson.create": {
			findOrFail(state.topics, action.topicId, "topic");
			const { concepts, ids } = resolveConcepts(state, action.topicId, action.concepts, ctx);
			const lesson: HubLesson = {
				id: ctx.newId("lesson"), topicId: action.topicId, title: action.title, goal: action.goal,
				conceptIds: ids, prereqLessonIds: [...action.prereqLessonIds], parentLessonId: action.parentLessonId,
				order: nextOrder(state.lessons.filter((l) => l.topicId === action.topicId)), createdAt: ctx.now, updatedAt: ctx.now,
			};
			return { state: { ...state, concepts, lessons: [...state.lessons, lesson] }, createdId: lesson.id };
		}
		case "lesson.update": {
			const current = findOrFail(state.lessons, action.id, "lesson");
			const topicId = action.topicId ?? current.topicId;
			const added = resolveConcepts(state, topicId, action.addConcepts ?? [], ctx);
			const removed = new Set(action.removeConceptIds ?? []);
			const conceptIds = [...current.conceptIds, ...added.ids.filter((id) => !current.conceptIds.includes(id))]
				.filter((id) => !removed.has(id));
			const next: HubLesson = {
				...current, topicId, conceptIds, updatedAt: ctx.now,
				...(action.title !== undefined ? { title: action.title } : {}),
				...(action.goal !== undefined ? { goal: action.goal } : {}),
				...(action.order !== undefined ? { order: action.order } : {}),
				...(action.prereqLessonIds !== undefined ? { prereqLessonIds: [...action.prereqLessonIds] } : {}),
			};
			return { state: { ...state, concepts: added.concepts, lessons: state.lessons.map((l) => (l.id === action.id ? next : l)) } };
		}
		case "lesson.delete": {
			findOrFail(state.lessons, action.id, "lesson");
			if (state.lessons.some((l) => l.parentLessonId === action.id)) fail("Delete or move this lesson's deep dives first.");
			return {
				state: {
					...state,
					lessons: state.lessons
						.filter((l) => l.id !== action.id)
						.map((l) => ({ ...l, prereqLessonIds: l.prereqLessonIds.filter((id) => id !== action.id) })),
					plans: state.plans.map((p) => ({
						...p,
						milestones: p.milestones.map((m) => ({ ...m, lessonIds: m.lessonIds.filter((id) => id !== action.id) })),
					})),
				},
			};
		}
		case "plan.create": {
			const plan: HubPlan = {
				id: ctx.newId("plan"), title: action.title, goal: action.goal, milestones: milestonesFrom(action.milestones, ctx),
				archived: false, createdAt: ctx.now, updatedAt: ctx.now,
			};
			return { state: { ...state, plans: [...state.plans, plan] }, createdId: plan.id };
		}
		case "plan.update": {
			const current = findOrFail(state.plans, action.id, "plan");
			const next: HubPlan = {
				...current, updatedAt: ctx.now,
				...(action.title !== undefined ? { title: action.title } : {}),
				...(action.goal !== undefined ? { goal: action.goal } : {}),
				...(action.archived !== undefined ? { archived: action.archived } : {}),
				...(action.milestones !== undefined ? { milestones: milestonesFrom(action.milestones, ctx) } : {}),
			};
			return { state: { ...state, plans: state.plans.map((p) => (p.id === action.id ? next : p)) } };
		}
		case "plan.delete":
			findOrFail(state.plans, action.id, "plan");
			return { state: { ...state, plans: state.plans.filter((p) => p.id !== action.id) } };
		case "explore.add": {
			const item: HubExploreItem = {
				id: ctx.newId("explore"), title: action.title, why: action.why, source: action.source, status: "open", createdAt: ctx.now,
				...(action.topicId ? { topicId: action.topicId } : {}),
				...(action.fromConceptId ? { fromConceptId: action.fromConceptId } : {}),
				...(action.chatId ? { chatId: action.chatId } : {}),
			};
			return { state: { ...state, explore: [...state.explore, item] }, createdId: item.id };
		}
		case "explore.status": {
			const current = findOrFail(state.explore, action.id, "explore item");
			return { state: { ...state, explore: state.explore.map((e) => (e.id === action.id ? { ...current, status: action.status } : e)) } };
		}
	}
}

function withoutKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
	const { [key]: _removed, ...rest } = value;
	return rest;
}
