import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LhMessage } from "../src/core/native-messages.ts";

// Isolated data dir, set before any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hub-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { applyHubAction, emptyHubState, HubDataError, parseHubAction, parseHubState, parseSessionOrigin, slugify } = await import("../src/core/hub.ts");
const { conceptMastery, projectMastery } = await import("../src/core/hub-mastery.ts");
const { checkEvidenceFromChat } = await import("../src/core/hub-evidence.ts");
const { newAnswerResult } = await import("../src/core/native-messages.ts");
const { hubStore } = await import("../src/store/hub.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { adoptChat, applyHubEdit, hubSnapshot } = await import("../src/server/hub.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

let seq = 0;
const ctx = { now: "2026-11-24T00:00:00.000Z", newId: (prefix: string) => `${prefix}_${++seq}` };
type State = ReturnType<typeof emptyHubState>;

function act(state: State, body: unknown) {
	return applyHubAction(state, parseHubAction(body), ctx);
}

function created(result: { createdId?: string }): string {
	assert.ok(result.createdId, "a create action returns the new id");
	return result.createdId;
}

function seeded() {
	let state = emptyHubState();
	const t = act(state, { type: "topic.create", title: "System design" });
	state = t.state;
	const topicId = created(t);
	const l = act(state, {
		type: "lesson.create", topicId, title: "Caching", goal: "Know when a cache helps",
		concepts: [{ title: "Cache-aside" }, { title: "TTL and eviction" }],
	});
	return { state: l.state, topicId, lessonId: created(l) };
}

function assistantCalls(id: string, calls: { id: string; args: Record<string, string> }[]): LhMessage {
	return {
		id, role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "toolUse", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: "quiz", arguments: c.args })),
	};
}

describe("hub edits", () => {
	it("creates topics, subtopics, lessons and plans, reusing concepts by slug within a topic", () => {
		const { state, topicId, lessonId } = seeded();
		const sub = act(state, { type: "topic.create", title: "Storage", parentId: topicId });
		assert.equal(sub.state.topics.find((t) => t.id === sub.createdId)?.parentId, topicId);

		const second = act(sub.state, { type: "lesson.create", topicId, title: "Cache invalidation", goal: "Keep caches correct", concepts: [{ title: "Cache-aside" }], prereqLessonIds: [lessonId] });
		const lesson = second.state.lessons.find((l) => l.id === second.createdId);
		assert.equal(second.state.concepts.length, 2, "the shared slug reuses the existing concept");
		assert.deepEqual(lesson?.prereqLessonIds, [lessonId]);

		const plan = act(second.state, { type: "plan.create", title: "Interview prep", goal: "Pass the loop", milestones: [{ title: "Basics", lessonIds: [lessonId, created(second)] }] });
		assert.equal(plan.state.plans[0]?.milestones[0]?.lessonIds.length, 2);
	});

	it("refuses edits that break references or nest a topic inside itself", () => {
		const { state, topicId } = seeded();
		assert.throws(() => act(state, { type: "lesson.create", topicId: "missing", title: "x", goal: "y" }), HubDataError);
		const sub = act(state, { type: "topic.create", title: "Child", parentId: topicId });
		assert.throws(() => act(sub.state, { type: "topic.update", id: topicId, parentId: created(sub) }), /nested inside itself/);
		assert.throws(() => act(state, { type: "topic.delete", id: topicId }), /lessons first/);
		assert.throws(() => parseHubAction({ type: "explode" }), /Unknown hub action/);
	});

	it("deleting a lesson removes it from plans and prerequisites", () => {
		const { state, topicId, lessonId } = seeded();
		const other = act(state, { type: "lesson.create", topicId, title: "Next", goal: "Next step", prereqLessonIds: [lessonId] });
		const plan = act(other.state, { type: "plan.create", title: "P", goal: "G", milestones: [{ title: "M", lessonIds: [lessonId] }] });
		const after = act(plan.state, { type: "lesson.delete", id: lessonId }).state;
		assert.deepEqual(after.plans[0]?.milestones[0]?.lessonIds, []);
		assert.deepEqual(after.lessons.find((l) => l.id === other.createdId)?.prereqLessonIds, []);
	});

	it("parses stored data and refuses a newer format", () => {
		const { state } = seeded();
		assert.deepEqual(parseHubState(JSON.parse(JSON.stringify(state))), state);
		assert.throws(() => parseHubState({ ...state, version: 2 }), /newer than this app/);
		assert.equal(slugify("TTL & Eviction!"), "ttl-eviction");
		assert.deepEqual(parseSessionOrigin({ mode: "explain", lessonId: "l1", skipProbe: true }), { mode: "explain", lessonId: "l1", skipProbe: true });
		assert.throws(() => parseSessionOrigin({ mode: "lecture" }), HubDataError);
	});
});

describe("mastery", () => {
	const now = new Date("2026-11-24T00:00:00.000Z");
	const ev = (chatId: string, at: string, kind: "check" | "assessment", result: "pass" | "fail" | "solid" | "shaky" | "gap") =>
		({ id: `${chatId}-${at}`, conceptId: "c", chatId, at, kind, result });

	it("needs passes in two different chats to call a concept solid", () => {
		assert.equal(conceptMastery([ev("a", "2026-11-01", "check", "pass"), ev("a", "2026-11-02", "check", "pass")], now).status, "learning");
		assert.equal(conceptMastery([ev("a", "2026-11-01", "check", "pass"), ev("b", "2026-11-02", "check", "pass")], now).status, "solid");
	});

	it("a later fail knocks solid back to shaky; an assessment sets status outright", () => {
		const solid = [ev("a", "2026-11-01", "check", "pass"), ev("b", "2026-11-02", "check", "pass")];
		assert.equal(conceptMastery([...solid, ev("c", "2026-11-03", "check", "fail")], now).status, "shaky");
		assert.equal(conceptMastery([ev("a", "2026-11-01", "assessment", "gap")], now).status, "gap");
		assert.equal(conceptMastery([], now).status, "not-yet");
	});

	it("solid concepts come due for review after the first interval", () => {
		const m = conceptMastery([ev("a", "2026-11-20T00:00:00.000Z", "assessment", "solid")], now);
		assert.equal(m.dueAt, "2026-11-21T00:00:00.000Z");
		assert.equal(m.reviewDue, true);
	});

	it("projects lesson status and the plan's next lesson", () => {
		const { state, lessonId } = seeded();
		const plan = act(state, { type: "plan.create", title: "P", goal: "G", milestones: [{ title: "M", lessonIds: [lessonId] }] });
		const [c1, c2] = plan.state.lessons[0]?.conceptIds ?? [];
		assert.ok(c1 && c2);
		const recent = "2026-11-23T12:00:00.000Z";
		const solidBoth = [c1, c2].map((conceptId) => ({ id: conceptId, conceptId, chatId: "x", at: recent, kind: "assessment" as const, result: "solid" as const }));
		const untouched = projectMastery(plan.state, [], now);
		assert.equal(untouched.lessons[lessonId]?.status, "not-started");
		assert.equal(projectMastery(plan.state, [], now, new Set([lessonId])).lessons[lessonId]?.status, "in-progress");
		const done = projectMastery(plan.state, solidBoth, now);
		assert.equal(done.lessons[lessonId]?.status, "complete");
		assert.equal(done.plans[created(plan)]?.nextLessonId, null);
		assert.equal(untouched.plans[created(plan)]?.nextLessonId, lessonId);
	});
});

describe("check evidence from transcripts", () => {
	it("reads graded checks, skips predictions, and maps adopted map nodes by title", () => {
		const { state, lessonId } = seeded();
		const messages: LhMessage[] = [
			assistantCalls("m1", [
				{ id: "q1", args: { type: "check", nodeId: "cache-aside", question: "?" } },
				{ id: "q2", args: { type: "predict", nodeId: "cache-aside", question: "?" } },
				{ id: "q3", args: { type: "check", nodeId: "evict-node", question: "?" } },
			]),
			newAnswerResult("q1", "quiz", { kind: "quiz", correct: true }),
			newAnswerResult("q2", "quiz", { kind: "quiz", correct: false }),
			newAnswerResult("q3", "quiz", { kind: "quiz", dontKnow: true }),
		];
		const tree = { nodes: [{ id: "evict-node", title: "TTL and eviction" }], edges: [], version: 1 };
		const found = checkEvidenceFromChat({ id: "chat1", lessonId, messages, tree, updatedAt: ctx.now }, state);
		assert.deepEqual(found.map((e) => [e.id, e.result]), [["check_chat1_q1", "pass"], ["check_chat1_q3", "fail"]]);
		const concepts = new Map(state.concepts.map((c) => [c.id, c.slug]));
		assert.deepEqual(found.map((e) => concepts.get(e.conceptId)), ["cache-aside", "ttl-and-eviction"]);
	});
});

describe("hub store and service", () => {
	it("round-trips state and de-duplicates evidence", () => {
		const { state } = seeded();
		hubStore.write(state);
		assert.deepEqual(hubStore.read(), state);
		const e = { id: "e1", conceptId: state.concepts[0]?.id ?? "", chatId: "c", at: ctx.now, kind: "check" as const, result: "pass" as const };
		assert.equal(hubStore.appendEvidence([e, e]), 1);
		assert.equal(hubStore.appendEvidence([e]), 0);
		assert.equal(hubStore.readEvidence().length, 1);
	});

	it("adopts an existing chat into a new lesson and counts its checks", () => {
		const topic = applyHubEdit({ type: "topic.create", title: "Adopted" });
		const chat = chatStore.createChat("Multiplayer sync");
		chatStore.saveTree(chat.id, { nodes: [{ id: "doc-model", title: "Doc = tree of objects" }], edges: [], version: 1 });
		chatStore.saveMessages(chat.id, [
			assistantCalls("m1", [{ id: "q1", args: { type: "check", nodeId: "doc-model", question: "?" } }]),
			newAnswerResult("q1", "quiz", { kind: "quiz", correct: true }),
		]);

		const adopted = adoptChat({ chatId: chat.id, topicId: created(topic) });
		assert.equal(adopted.createdLesson, true);
		assert.deepEqual(chatStore.getChat(chat.id)?.origin, { mode: "deep-dive", lessonId: adopted.lessonId, topicId: created(topic) });

		const snapshot = hubSnapshot(new Date(ctx.now));
		assert.equal(snapshot.lessonSessions[adopted.lessonId]?.[0]?.id, chat.id);
		const lesson = snapshot.state.lessons.find((l) => l.id === adopted.lessonId);
		const conceptId = lesson?.conceptIds[0] ?? "";
		assert.equal(snapshot.mastery.concepts[conceptId]?.passes, 1);
		assert.equal(snapshot.mastery.lessons[adopted.lessonId]?.status, "in-progress");
	});

	it("createChat stores an origin and saveOrigin can clear it", () => {
		const chat = chatStore.createChat("Quick question", undefined, { mode: "ask", topicId: "t" });
		assert.deepEqual(chatStore.getChat(chat.id)?.origin, { mode: "ask", topicId: "t" });
		chatStore.saveOrigin(chat.id, null);
		assert.equal(chatStore.getChat(chat.id)?.origin, undefined);
	});
});
