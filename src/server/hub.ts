import { randomUUID } from "node:crypto";
import { HUB_MODES, titleFromPrompt, type ChatSummary, type HubMastery, type HubMode, type HubState, type SessionOrigin } from "../core/contracts.ts";
import { applyHubAction, HubDataError, parseHubAction, type HubEditContext } from "../core/hub.ts";
import { checkEvidenceFromChat } from "../core/hub-evidence.ts";
import { projectMastery } from "../core/hub-mastery.ts";
import { decideProbe, type ProbeDecision, type SessionBrief, type SessionBriefConcept } from "../core/hub-session.ts";
import { newSessionBriefMessage } from "../core/native-messages.ts";
import { hubStore } from "../store/hub.ts";
import { chatStore } from "../store/chats.ts";
import { readSettings } from "../store/settings.ts";

/** A request the hub refuses. Routes map `status` to the HTTP response. */
export class HubRequestError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

export interface HubSnapshot {
	state: HubState;
	mastery: HubMastery;
	/** Linked sessions, newest first, grouped by lesson id. */
	lessonSessions: Record<string, ChatSummary[]>;
	/** Sessions linked to a topic but no lesson (for example Ask sessions). */
	topicSessions: Record<string, ChatSummary[]>;
}

function editContext(): HubEditContext {
	return {
		now: new Date().toISOString(),
		newId: (prefix) => `${prefix}_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`,
	};
}

function asRequestError(error: unknown): never {
	if (error instanceof HubDataError) throw new HubRequestError(error.message, 400);
	throw error;
}

/** Chat id → updatedAt already scanned for check evidence in this process. */
const scanned = new Map<string, string>();

function syncCheckEvidence(state: HubState, linked: readonly ChatSummary[]): void {
	const found = [];
	for (const summary of linked) {
		const lessonId = summary.origin?.lessonId;
		if (!lessonId || scanned.get(summary.id) === summary.updatedAt) continue;
		const chat = chatStore.getChat(summary.id);
		if (!chat) continue;
		found.push(...checkEvidenceFromChat({ id: chat.id, lessonId, messages: chat.messages, tree: chat.tree, updatedAt: chat.updatedAt }, state));
		scanned.set(summary.id, summary.updatedAt);
	}
	hubStore.appendEvidence(found);
}

function push<T>(map: Record<string, T[]>, key: string, value: T): void {
	(map[key] ??= []).push(value);
}

/** Current hub state with mastery, after pulling any new check results from linked chats. */
export function hubSnapshot(now: Date = new Date()): HubSnapshot {
	const state = hubStore.read();
	const linked = chatStore.listChats().filter((c) => c.origin !== undefined);
	syncCheckEvidence(state, linked);

	const lessonSessions: Record<string, ChatSummary[]> = {};
	const topicSessions: Record<string, ChatSummary[]> = {};
	for (const chat of linked) {
		if (chat.origin?.lessonId) push(lessonSessions, chat.origin.lessonId, chat);
		else if (chat.origin?.topicId) push(topicSessions, chat.origin.topicId, chat);
	}
	const mastery = projectMastery(state, hubStore.readEvidence(), now, new Set(Object.keys(lessonSessions)));
	return { state, mastery, lessonSessions, topicSessions };
}

/** Apply one validated edit from an untrusted body. */
export function applyHubEdit(body: unknown): { state: HubState; createdId?: string } {
	try {
		const result = applyHubAction(hubStore.read(), parseHubAction(body), editContext());
		hubStore.write(result.state);
		return result;
	} catch (error) {
		return asRequestError(error);
	}
}

function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalId(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value) throw new HubRequestError(`${key} must be an id.`, 400);
	return value;
}

/**
 * Link an existing chat to the hub. With `lessonId` the chat joins that
 * lesson. Otherwise a new lesson is made in `topicId` from the chat's title,
 * with one concept per node of the chat's plan map, so its past checks count.
 */
export function adoptChat(body: unknown): { lessonId: string; createdLesson: boolean } {
	if (!isRec(body)) throw new HubRequestError("The request must be an object.", 400);
	const chatId = optionalId(body, "chatId");
	if (!chatId) throw new HubRequestError("chatId is required.", 400);
	const chat = chatStore.getChat(chatId);
	if (!chat) throw new HubRequestError("That session no longer exists.", 404);
	const mode: HubMode = chat.kind === "practice" ? "practice" : "deep-dive";

	const lessonId = optionalId(body, "lessonId");
	if (lessonId) {
		const lesson = hubStore.read().lessons.find((l) => l.id === lessonId);
		if (!lesson) throw new HubRequestError("That lesson no longer exists.", 404);
		chatStore.saveOrigin(chat.id, { mode, lessonId, topicId: lesson.topicId });
		return { lessonId, createdLesson: false };
	}

	const topicId = optionalId(body, "topicId");
	if (!topicId) throw new HubRequestError("Give a lessonId to join, or a topicId to make a new lesson in.", 400);
	const concepts = (chat.tree?.nodes ?? []).map((n) => ({ title: n.title, slug: n.id }));
	const created = applyHubEdit({ type: "lesson.create", topicId, title: chat.title, goal: chat.title, concepts, prereqLessonIds: [], parentLessonId: null });
	if (!created.createdId) throw new HubRequestError("Could not create the lesson.", 500);
	const origin: SessionOrigin = { mode, lessonId: created.createdId, topicId };
	chatStore.saveOrigin(chat.id, origin);
	return { lessonId: created.createdId, createdLesson: true };
}

function isHubMode(value: unknown): value is HubMode {
	return HUB_MODES.some((m) => m === value);
}

function briefConcepts(state: HubState, mastery: HubMastery, ownIds: readonly string[], prereqIds: readonly string[]): SessionBriefConcept[] {
	const byId = new Map(state.concepts.map((c) => [c.id, c]));
	const own = new Set(ownIds);
	const ordered = [...new Set([...ownIds, ...prereqIds])];
	return ordered.flatMap((id) => {
		const concept = byId.get(id);
		if (!concept) return [];
		const m = mastery.concepts[id];
		return [{
			slug: concept.slug, title: concept.title, status: m?.status ?? "not-yet", lastAt: m?.lastAt ?? null,
			reviewDue: m?.reviewDue ?? false, prerequisite: !own.has(id),
		}];
	});
}

export interface HubStartResult {
	id: string;
	title: string;
	origin: SessionOrigin;
	probe: ProbeDecision;
}

/**
 * Start a hub session: `{ mode, lessonId?, topicId?, planId?, prompt?, probe? }`.
 * The new chat carries its origin (with `skipProbe` from the probe policy)
 * and a session-brief marker as message[0]. `probe` is the learner's
 * override of the policy and only counts for deep dives. `prompt` titles
 * the session and is its goal when no lesson is given; the learner's first
 * message is still sent as a normal turn.
 */
export function startHubSession(body: unknown, now: Date = new Date()): HubStartResult {
	if (!isRec(body)) throw new HubRequestError("The request must be an object.", 400);
	if (!isHubMode(body.mode)) throw new HubRequestError(`mode must be one of ${HUB_MODES.join(", ")}.`, 400);
	const mode = body.mode;
	if (body.probe !== undefined && typeof body.probe !== "boolean") throw new HubRequestError("probe must be true or false.", 400);
	const probeChoice = body.probe;
	if (body.prompt !== undefined && typeof body.prompt !== "string") throw new HubRequestError("prompt must be text.", 400);
	const prompt = body.prompt?.trim() || undefined;

	const { state, mastery } = hubSnapshot(now);
	const lessonId = optionalId(body, "lessonId");
	const lesson = lessonId ? state.lessons.find((l) => l.id === lessonId) : undefined;
	if (lessonId && !lesson) throw new HubRequestError("That lesson no longer exists.", 404);
	const topicId = lesson?.topicId ?? optionalId(body, "topicId");
	const topic = topicId ? state.topics.find((t) => t.id === topicId) : undefined;
	if (topicId && !topic) throw new HubRequestError("That topic no longer exists.", 404);
	const planId = optionalId(body, "planId");
	if (planId && !state.plans.some((p) => p.id === planId)) throw new HubRequestError("That plan no longer exists.", 404);
	if (!lesson && !topic && !prompt) throw new HubRequestError("Give a lesson, a topic or a prompt.", 400);

	const probe = decideProbe({ mode, state, concepts: mastery.concepts, lesson, topicId, probe: probeChoice });
	const lessonById = new Map(state.lessons.map((l) => [l.id, l]));
	const ownIds = lesson ? lesson.conceptIds : state.concepts.filter((c) => c.topicId === topicId).map((c) => c.id);
	const prereqIds = lesson ? lesson.prereqLessonIds.flatMap((id) => lessonById.get(id)?.conceptIds ?? []) : [];

	const goal = lesson?.goal || prompt || topic?.title || "";
	const brief: SessionBrief = {
		mode, goal, probe: probe.probe, probeReason: probe.reason,
		...(lesson ? { lessonTitle: lesson.title } : {}),
		...(topic ? { topicTitle: topic.title } : {}),
		concepts: briefConcepts(state, mastery, ownIds, prereqIds),
	};
	const origin: SessionOrigin = {
		mode,
		...(lesson ? { lessonId: lesson.id } : {}),
		...(topicId ? { topicId } : {}),
		...(planId ? { planId } : {}),
		...(mode === "practice" ? {} : { skipProbe: !probe.probe }),
	};

	const chat = chatStore.createChat(titleFromPrompt(lesson?.title ?? prompt ?? topic?.title ?? ""), mode === "practice" ? "practice" : undefined, origin);
	chatStore.saveMessages(chat.id, [newSessionBriefMessage(brief)]);
	// Same birth stamp as POST /api/chats: a session owns the strong slot's model from creation.
	const strong = readSettings()?.models?.strong;
	if (strong?.model) {
		chatStore.saveSettings(chat.id, { model: { provider: strong.model.provider, id: strong.model.id }, thinkingLevel: strong.thinkingLevel });
	}
	return { id: chat.id, title: chat.title, origin, probe };
}
