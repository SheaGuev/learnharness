import type { HubConcept, HubLesson, HubMastery, HubState, HubTopic } from "@/src/core";

export function childTopics(topics: readonly HubTopic[], parentId: string | null): HubTopic[] {
	return topics.filter((t) => t.parentId === parentId).sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
}

/** Depth-first topic list with indented labels, skipping `excludeId` and everything under it. */
export function topicOptions(topics: readonly HubTopic[], excludeId?: string): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	const walk = (parentId: string | null, depth: number) => {
		for (const t of childTopics(topics, parentId)) {
			if (t.id === excludeId) continue;
			out.push({ id: t.id, label: `${"  ".repeat(depth)}${depth ? "└ " : ""}${t.title}` });
			walk(t.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

export function topicPath(topics: readonly HubTopic[], id: string): HubTopic[] {
	const byId = new Map(topics.map((t) => [t.id, t]));
	const path: HubTopic[] = [];
	for (let t = byId.get(id); t; t = t.parentId ? byId.get(t.parentId) : undefined) {
		if (path.includes(t)) break;
		path.unshift(t);
	}
	return path;
}

export function descendantTopicIds(topics: readonly HubTopic[], id: string): Set<string> {
	const ids = new Set<string>([id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const t of topics) {
			if (t.parentId !== null && ids.has(t.parentId) && !ids.has(t.id)) {
				ids.add(t.id);
				grew = true;
			}
		}
	}
	return ids;
}

export function lessonConcepts(state: HubState, lesson: HubLesson): HubConcept[] {
	const byId = new Map(state.concepts.map((c) => [c.id, c]));
	return lesson.conceptIds.flatMap((id) => {
		const c = byId.get(id);
		return c ? [c] : [];
	});
}

export function topicLessons(state: HubState, topicId: string): HubLesson[] {
	return state.lessons.filter((l) => l.topicId === topicId).sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

/** Solid vs total concepts across a topic and its subtopics. */
export function topicProgress(state: HubState, mastery: HubMastery, topicId: string): { solid: number; total: number; lessons: number } {
	const ids = descendantTopicIds(state.topics, topicId);
	const concepts = state.concepts.filter((c) => ids.has(c.topicId));
	return {
		solid: concepts.filter((c) => mastery.concepts[c.id]?.status === "solid").length,
		total: concepts.length,
		lessons: state.lessons.filter((l) => ids.has(l.topicId)).length,
	};
}

export type LessonMode = "explain" | "deep-dive" | "practice";

/** The opening learner message for a lesson session; the server's brief carries the structured context. */
export function lessonPrompt(state: HubState, lesson: HubLesson, mode: LessonMode): string {
	const concepts = lessonConcepts(state, lesson).map((c) => c.title);
	const list = concepts.length ? ` Concepts: ${concepts.join(", ")}.` : "";
	if (mode === "practice") return `I want to practice "${lesson.title}". Goal: ${lesson.goal}.${list}`;
	if (mode === "explain") return `Give me a short lesson on "${lesson.title}". Goal: ${lesson.goal}.${list}`;
	return `Teach me "${lesson.title}". Goal: ${lesson.goal}.${list}`;
}
