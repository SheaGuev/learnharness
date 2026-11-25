"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { stashOpeningPrompt } from "@/components/opening-prompt";
import {
	parseHubState, type ChatSummary, type HubAction, type HubMastery, type HubMode, type HubState,
} from "@/src/core";

/** The client's view of `GET /api/hub`. */
export interface HubData {
	state: HubState;
	mastery: HubMastery;
	lessonSessions: Record<string, ChatSummary[]>;
	topicSessions: Record<string, ChatSummary[]>;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionMap(value: unknown): value is Record<string, ChatSummary[]> {
	return isRec(value) && Object.values(value).every(Array.isArray);
}

function isMastery(value: unknown): value is HubMastery {
	return isRec(value) && isRec(value.concepts) && isRec(value.lessons) && isRec(value.plans);
}

function toHubData(body: unknown): HubData {
	if (!isRec(body)) throw new Error("The hub sent an unreadable response.");
	if (typeof body.error === "string") throw new Error(body.error);
	const { mastery, lessonSessions, topicSessions } = body;
	if (!isMastery(mastery) || !isSessionMap(lessonSessions) || !isSessionMap(topicSessions)) {
		throw new Error("The hub sent an unreadable response.");
	}
	return { state: parseHubState(body.state), mastery, lessonSessions, topicSessions };
}

function errorText(body: unknown, fallback: string): string {
	return isRec(body) && typeof body.error === "string" ? body.error : fallback;
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/** Live hub snapshot: fetched on mount, on hub or chat-list changes, on reconnect and on window focus. */
export function useHub() {
	const [data, setData] = useState<HubData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const seq = useRef(0);

	const refresh = useCallback(() => {
		const mine = ++seq.current;
		fetch("/api/hub", { cache: "no-store" })
			.then(readJson)
			.then((body) => {
				if (mine !== seq.current) return;
				setData(toHubData(body));
				setError(null);
			})
			.catch((err: unknown) => {
				if (mine !== seq.current) return;
				setError(err instanceof Error ? err.message : "Could not load the learning hub.");
			});
	}, []);

	useEffect(() => {
		refresh();
		const onFocus = () => {
			if (document.visibilityState === "visible") refresh();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onFocus);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onFocus);
		};
	}, [refresh]);
	useServerEvent("hub-changed", refresh);
	useServerEvent("chats-changed", refresh);
	useServerResync(refresh);

	return { data, error, refresh };
}

/** One edit through `POST /api/hub`. Resolves to the created record's id, if any. */
export async function hubEdit(action: HubAction): Promise<string | undefined> {
	const res = await fetch("/api/hub", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(action),
	});
	const body = await readJson(res);
	if (!res.ok) throw new Error(errorText(body, "Could not save that change."));
	return isRec(body) && typeof body.createdId === "string" ? body.createdId : undefined;
}

export async function adoptChat(req: { chatId: string; lessonId?: string; topicId?: string }): Promise<string> {
	const res = await fetch("/api/hub/adopt", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(req),
	});
	const body = await readJson(res);
	if (!res.ok) throw new Error(errorText(body, "Could not add that session."));
	if (!isRec(body) || typeof body.lessonId !== "string") throw new Error("Could not add that session.");
	return body.lessonId;
}

/** Sessions not yet linked to the hub, newest first. */
export async function unlinkedChats(): Promise<ChatSummary[]> {
	const res = await fetch("/api/chats", { cache: "no-store" });
	const body = await readJson(res);
	if (!res.ok || !isRec(body) || !Array.isArray(body.chats)) throw new Error("Could not list sessions.");
	const chats: ChatSummary[] = body.chats.filter(
		(c): c is ChatSummary => isRec(c) && typeof c.id === "string" && typeof c.title === "string" && typeof c.updatedAt === "string",
	);
	return chats.filter((c) => c.origin === undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface HubStartRequest {
	mode: HubMode;
	lessonId?: string;
	topicId?: string;
	planId?: string;
	/** Title for the new session. */
	title: string;
	/** Opening message used when the hub start endpoint is unavailable. */
	prompt: string;
}

function chatIdFrom(body: unknown): string | undefined {
	if (!isRec(body)) return undefined;
	const id = typeof body.id === "string" ? body.id : body.chatId;
	return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}

/**
 * Start a hub session and return its chat id. Uses `POST /api/hub/start`
 * when the server has it; until then it creates a linked chat directly and
 * hands the opening prompt to the chat page.
 */
export async function startHubSession(req: HubStartRequest): Promise<string> {
	const { title, prompt, ...start } = req;
	const res = await fetch("/api/hub/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...start, prompt }),
	});
	if (res.status !== 404) {
		const body = await readJson(res);
		const id = chatIdFrom(body);
		if (!res.ok || !id) throw new Error(errorText(body, "Could not start the session."));
		// The brief is a marker, not a learner turn, so the session only starts once this opening message is sent.
		// If storage refuses it the session still opens and the learner can type the first message.
		if (prompt.trim()) stashOpeningPrompt(id, prompt);
		return id;
	}

	const origin = {
		mode: start.mode,
		...(start.lessonId ? { lessonId: start.lessonId } : {}),
		...(start.topicId ? { topicId: start.topicId } : {}),
		...(start.planId ? { planId: start.planId } : {}),
	};
	const created = await fetch("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ title, origin, ...(start.mode === "practice" ? { kind: "practice" } : {}) }),
	});
	const body = await readJson(created);
	const id = chatIdFrom(body);
	if (!created.ok || !id) throw new Error(errorText(body, "Could not start the session."));
	if (!stashOpeningPrompt(id, prompt)) throw new Error("Could not hand the opening message to the new session.");
	return id;
}
