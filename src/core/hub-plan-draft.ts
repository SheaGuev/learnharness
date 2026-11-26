import type { HubLesson, HubPlan, HubState, HubTopic } from "./contracts/hub.ts";
import { applyHubAction, HubDataError, slugify, type HubAction, type HubEditContext, type MilestoneDraft } from "./hub.ts";

/** A whole plan as the planner proposes it: milestones → topics → lessons → concept titles. */
export interface PlanDraft {
	title: string;
	goal: string;
	milestones: {
		id?: string;
		title: string;
		goal: string;
		topics: {
			id?: string;
			title: string;
			summary?: string;
			lessons: { id?: string; title: string; goal: string; concepts: string[] }[];
		}[];
	}[];
}

export interface PlanDraftResult {
	state: HubState;
	planId: string;
	created: { topics: number; lessons: number };
}

function sameTitle(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Upsert a planner's draft into the hub. Topics and lessons match by id,
 * then by title (top-level topics; lessons within their topic), so a
 * retried or revised draft reuses what exists instead of duplicating it.
 * Nothing is ever deleted: a milestone left out of a revision leaves the
 * plan, while its topics and lessons stay in the hub. With `planId` the
 * draft replaces that plan's title, goal and milestones.
 */
export function applyPlanDraft(state: HubState, draft: PlanDraft, planId: string | undefined, ctx: HubEditContext): PlanDraftResult {
	let current = state;
	const created = { topics: 0, lessons: 0 };
	const act = (action: HubAction): string | undefined => {
		const result = applyHubAction(current, action, ctx);
		current = result.state;
		return result.createdId;
	};

	const existingPlan = planId ? current.plans.find((p) => p.id === planId) : undefined;
	if (planId && !existingPlan) throw new HubDataError("The plan this session was planning no longer exists.");

	const milestones: MilestoneDraft[] = draft.milestones.map((m) => {
		const topicIds = m.topics.map((t) => {
			const topic = resolveTopic(current, t);
			let topicId: string;
			if (topic) {
				topicId = topic.id;
				if (t.summary && t.summary !== topic.summary) act({ type: "topic.update", id: topic.id, summary: t.summary });
			} else {
				topicId = act({ type: "topic.create", title: t.title, parentId: null, ...(t.summary ? { summary: t.summary } : {}) }) ?? "";
				created.topics++;
			}
			for (const l of t.lessons) {
				const lesson = resolveLesson(current, topicId, l);
				const concepts = l.concepts.filter((c) => c.trim()).map((title) => ({ title }));
				if (!lesson) {
					act({ type: "lesson.create", topicId, title: l.title, goal: l.goal, concepts, prereqLessonIds: [], parentLessonId: null });
					created.lessons++;
					continue;
				}
				const known = new Set(lesson.conceptIds.flatMap((id) => current.concepts.find((c) => c.id === id)?.slug ?? []));
				const addConcepts = concepts.filter((c) => !known.has(slugify(c.title)));
				act({
					type: "lesson.update", id: lesson.id, title: l.title, goal: l.goal,
					...(lesson.topicId !== topicId ? { topicId } : {}),
					...(addConcepts.length ? { addConcepts } : {}),
				});
			}
			return topicId;
		});
		const previous = existingPlan?.milestones.find((x) => (m.id ? x.id === m.id : sameTitle(x.title, m.title)));
		return {
			title: m.title, goal: m.goal, topicIds, lessonIds: previous?.lessonIds ?? [],
			...(previous ? { id: previous.id } : {}),
		};
	});

	if (existingPlan) {
		act({ type: "plan.update", id: existingPlan.id, title: draft.title, goal: draft.goal, milestones });
		return { state: current, planId: existingPlan.id, created };
	}
	const id = act({ type: "plan.create", title: draft.title, goal: draft.goal, milestones });
	if (!id) throw new HubDataError("Could not create the plan.");
	return { state: current, planId: id, created };
}

function resolveTopic(state: HubState, t: PlanDraft["milestones"][number]["topics"][number]): HubTopic | undefined {
	if (t.id) {
		const byId = state.topics.find((x) => x.id === t.id);
		if (!byId) throw new HubDataError(`No topic with id "${t.id}". Leave the id out to create a new topic.`);
		return byId;
	}
	return state.topics.find((x) => x.parentId === null && sameTitle(x.title, t.title))
		?? state.topics.find((x) => sameTitle(x.title, t.title));
}

function resolveLesson(state: HubState, topicId: string, l: { id?: string; title: string }): HubLesson | undefined {
	if (l.id) {
		const byId = state.lessons.find((x) => x.id === l.id);
		if (!byId) throw new HubDataError(`No lesson with id "${l.id}". Leave the id out to create a new lesson.`);
		return byId;
	}
	return state.lessons.find((x) => x.topicId === topicId && sameTitle(x.title, l.title));
}

/** The plan as text with every id, for the planner to read back and revise. */
export function planOutline(state: HubState, plan: HubPlan): string {
	const topicById = new Map(state.topics.map((t) => [t.id, t]));
	const lines = [`Plan "${plan.title}" (id ${plan.id}). Goal: ${plan.goal}`];
	plan.milestones.forEach((m, i) => {
		lines.push(`${i + 1}. Milestone "${m.title}" (id ${m.id})${m.goal ? `. Goal: ${m.goal}` : ""}`);
		for (const topicId of m.topicIds) {
			const topic = topicById.get(topicId);
			if (!topic) continue;
			lines.push(`   - Topic "${topic.title}" (id ${topic.id})`);
			for (const l of state.lessons.filter((x) => x.topicId === topicId).sort((a, b) => a.order - b.order)) {
				const concepts = l.conceptIds.flatMap((id) => state.concepts.find((c) => c.id === id)?.title ?? []);
				lines.push(`     - Lesson "${l.title}" (id ${l.id}): ${l.goal}${concepts.length ? ` [${concepts.join("; ")}]` : ""}`);
			}
		}
	});
	return lines.join("\n");
}
