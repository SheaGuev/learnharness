import { randomUUID } from "node:crypto";
import type { ChatSummary, HubMastery, HubMode, HubState, SessionOrigin } from "../core/contracts.ts";
import { applyHubAction, HubDataError, parseHubAction, type HubEditContext } from "../core/hub.ts";
import { checkEvidenceFromChat } from "../core/hub-evidence.ts";
import { projectMastery } from "../core/hub-mastery.ts";
import { hubStore } from "../store/hub.ts";
import { chatStore } from "../store/chats.ts";

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
