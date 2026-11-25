import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { HubEvidence, HubState } from "../src/core/contracts/hub.ts";

// Isolated data dir, set before any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hub-session-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { applyHubAction, emptyHubState, parseHubAction } = await import("../src/core/hub.ts");
const { projectMastery } = await import("../src/core/hub-mastery.ts");
const { decideProbe, sessionBriefText } = await import("../src/core/hub-session.ts");
const { nativeInputCause, newSessionBriefMessage, newUserMessage, toLlmMessages } = await import("../src/core/native-messages.ts");
const { newCompactionMarker } = await import("../src/core/compaction.ts");
const { projectView } = await import("../src/core/view.ts");
const { hubStore } = await import("../src/store/hub.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { HubRequestError, startHubSession } = await import("../src/server/hub.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const NOW = new Date("2026-11-24T00:00:00.000Z");
let seq = 0;
const ctx = { now: NOW.toISOString(), newId: (prefix: string) => `${prefix}_${++seq}` };

function act(state: HubState, body: unknown) {
	const result = applyHubAction(state, parseHubAction(body), ctx);
	assert.ok(result.createdId, "a create action returns the new id");
	return { state: result.state, id: result.createdId };
}

/** Two lessons in one topic; "eviction" lists "caching" as its prerequisite. */
function seeded() {
	const topic = act(emptyHubState(), { type: "topic.create", title: "System design" });
	const caching = act(topic.state, {
		type: "lesson.create", topicId: topic.id, title: "Caching", goal: "Know when a cache helps",
		concepts: [{ title: "Cache-aside" }, { title: "Write-through" }],
	});
	const eviction = act(caching.state, {
		type: "lesson.create", topicId: topic.id, title: "Eviction", goal: "Pick an eviction policy",
		concepts: [{ title: "LRU" }], prereqLessonIds: [caching.id],
	});
	const state = eviction.state;
	const conceptId = (slug: string) => state.concepts.find((c) => c.slug === slug)?.id ?? "";
	const lesson = (id: string) => state.lessons.find((l) => l.id === id);
	return { state, topicId: topic.id, cachingId: caching.id, evictionId: eviction.id, conceptId, lesson };
}

function solid(conceptId: string, at: string): HubEvidence {
	return { id: `e_${conceptId}_${at}`, conceptId, chatId: "c", at, kind: "assessment", result: "solid" };
}

describe("probe policy", () => {
	const recent = "2026-11-23T12:00:00.000Z";

	it("explain, ask and practice never probe; a deep dive honours the learner's choice", () => {
		const { state, cachingId, lesson } = seeded();
		const concepts = projectMastery(state, [], NOW).concepts;
		for (const mode of ["explain", "ask", "practice"] as const) {
			assert.deepEqual(decideProbe({ mode, state, concepts, lesson: lesson(cachingId), probe: true }), { probe: false, reason: "mode", staleConceptIds: [] });
		}
		assert.equal(decideProbe({ mode: "deep-dive", state, concepts, lesson: lesson(cachingId), probe: false }).reason, "declined");
		assert.equal(decideProbe({ mode: "deep-dive", state, concepts, lesson: lesson(cachingId), probe: true }).probe, true);
	});

	it("probes a new topic, then skips once every prerequisite concept has recent evidence", () => {
		const { state, evictionId, conceptId, lesson } = seeded();
		const fresh = projectMastery(state, [], NOW).concepts;
		assert.equal(decideProbe({ mode: "deep-dive", state, concepts: fresh, lesson: lesson(evictionId) }).reason, "new-topic");

		const oneKnown = projectMastery(state, [solid(conceptId("cache-aside"), recent)], NOW).concepts;
		const missing = decideProbe({ mode: "deep-dive", state, concepts: oneKnown, lesson: lesson(evictionId) });
		assert.deepEqual([missing.probe, missing.reason, missing.staleConceptIds], [true, "missing-evidence", [conceptId("write-through")]]);

		// Eviction's own concept (lru) has no evidence; only its prerequisites count.
		const bothKnown = projectMastery(state, [solid(conceptId("cache-aside"), recent), solid(conceptId("write-through"), recent)], NOW).concepts;
		assert.deepEqual(decideProbe({ mode: "deep-dive", state, concepts: bothKnown, lesson: lesson(evictionId) }), { probe: false, reason: "fresh", staleConceptIds: [] });
	});

	it("probes when a prerequisite's review is due", () => {
		const { state, evictionId, conceptId, lesson } = seeded();
		const old = "2026-11-01T00:00:00.000Z";
		const concepts = projectMastery(state, [solid(conceptId("cache-aside"), recent), solid(conceptId("write-through"), old)], NOW).concepts;
		const decision = decideProbe({ mode: "deep-dive", state, concepts, lesson: lesson(evictionId) });
		assert.deepEqual([decision.probe, decision.reason, decision.staleConceptIds], [true, "review-due", [conceptId("write-through")]]);
	});

	it("a lesson without prerequisites is judged by its own concepts", () => {
		const { state, cachingId, conceptId, lesson } = seeded();
		const partial = projectMastery(state, [solid(conceptId("cache-aside"), recent)], NOW).concepts;
		assert.equal(decideProbe({ mode: "deep-dive", state, concepts: partial, lesson: lesson(cachingId) }).reason, "missing-evidence");
		const full = projectMastery(state, [solid(conceptId("cache-aside"), recent), solid(conceptId("write-through"), recent)], NOW).concepts;
		assert.equal(decideProbe({ mode: "deep-dive", state, concepts: full, lesson: lesson(cachingId) }).probe, false);
	});
});

describe("session-brief marker", () => {
	const brief = {
		mode: "deep-dive" as const, goal: "Pick an eviction policy", lessonTitle: "Eviction", topicTitle: "System design",
		probe: false, probeReason: "fresh" as const,
		concepts: [
			{ slug: "lru", title: "LRU", status: "not-yet" as const, lastAt: null, reviewDue: false, prerequisite: false },
			{ slug: "cache-aside", title: "Cache-aside", status: "solid" as const, lastAt: "2026-11-23T12:00:00.000Z", reviewDue: false, prerequisite: true },
		],
	};

	it("tells the model the slugs to use as plan_init node ids, the known state and the mode rules", () => {
		const text = sessionBriefText(brief);
		assert.match(text, /^\[Session brief\]/);
		assert.match(text, /plan_init node ids/);
		assert.match(text, /- lru — LRU: no evidence yet/);
		assert.match(text, /Prerequisites from earlier lessons:\n- cache-aside — Cache-aside: solid, last seen 2026-11-23/);
		assert.match(text, /there is no probe/);
		assert.match(sessionBriefText({ ...brief, probe: true }), /Probe first/);
		assert.match(sessionBriefText({ ...brief, mode: "explain" }), /short lesson/);
	});

	it("reaches the model as a user message, survives a compaction cut, and is neutral input", () => {
		const marker = newSessionBriefMessage(brief);
		const first = newUserMessage("Let's go");
		const kept = newUserMessage("Next step");
		const plain = toLlmMessages([marker, first]);
		assert.equal(plain[0]?.role, "user");
		assert.equal(JSON.stringify(plain[0]).includes("[Session brief]"), true);

		const compaction = newCompactionMarker("Summary so far", { firstKeptMessageId: kept.id, tokensBefore: 1, at: NOW.toISOString() });
		const wire = toLlmMessages([marker, first, compaction, kept]);
		assert.equal(wire.length, 3, "brief, compaction head, kept message");
		assert.ok(JSON.stringify(wire[0]).includes("[Session brief]"));
		assert.ok(JSON.stringify(wire[1]).includes("Summary so far"));

		assert.equal(nativeInputCause(marker, [marker]), "neutral");
	});

	it("projects to a quiet data part, not a text bubble", () => {
		const marker = newSessionBriefMessage(brief);
		const [view] = projectView([marker]);
		assert.equal(view?.role, "user");
		assert.deepEqual(view?.parts.map((p) => p.type), ["data-session-brief"]);
	});
});

describe("POST /api/hub/start service", () => {
	it("creates a deep dive with origin, skipProbe from the policy, and the brief as message[0]", () => {
		const { state, topicId, evictionId, conceptId } = seeded();
		hubStore.write(state);
		const recent = "2026-11-23T12:00:00.000Z";
		hubStore.appendEvidence([solid(conceptId("cache-aside"), recent), solid(conceptId("write-through"), recent)]);

		const started = startHubSession({ mode: "deep-dive", lessonId: evictionId }, NOW);
		assert.deepEqual(started.origin, { mode: "deep-dive", lessonId: evictionId, topicId, skipProbe: true });
		const chat = chatStore.getChat(started.id);
		assert.equal(chat?.title, "Eviction");
		assert.deepEqual(chat?.origin, started.origin);
		const [first] = chat?.messages ?? [];
		assert.ok(first?.role === "custom" && first.customType === "session-brief");
		assert.match(first.content, /- lru — LRU: no evidence yet/);
		assert.match(first.content, /- cache-aside — Cache-aside: solid/);

		const asked = startHubSession({ mode: "deep-dive", lessonId: evictionId, probe: true }, NOW);
		assert.equal(asked.origin.skipProbe, false);
	});

	it("explain always skips; practice makes a practice chat without skipProbe", () => {
		const { state, cachingId } = seeded();
		hubStore.write(state);
		const explain = startHubSession({ mode: "explain", lessonId: cachingId, probe: true }, NOW);
		assert.equal(explain.origin.skipProbe, true);
		assert.equal(chatStore.getChat(explain.id)?.kind, undefined, "explain is a teaching chat");
		const practice = startHubSession({ mode: "practice", lessonId: cachingId }, NOW);
		assert.equal(practice.origin.skipProbe, undefined);
		assert.equal(chatStore.getChat(practice.id)?.kind, "practice");
	});

	it("an ask from a prompt alone titles the session and sets the goal", () => {
		hubStore.write(emptyHubState());
		const started = startHubSession({ mode: "ask", prompt: "  What is a write-back cache?  " }, NOW);
		assert.deepEqual(started.origin, { mode: "ask", skipProbe: true });
		const chat = chatStore.getChat(started.id);
		assert.equal(chat?.kind, "tutor", "an ask runs the tutor agent");
		assert.equal(chat?.title, "What is a write-back cache?");
		const [first] = chat?.messages ?? [];
		assert.ok(first?.role === "custom");
		assert.match(first.content, /Goal: What is a write-back cache\?/);
	});

	it("refuses bad bodies", () => {
		hubStore.write(emptyHubState());
		const status = (body: unknown) => {
			try {
				startHubSession(body, NOW);
				return 200;
			} catch (error) {
				assert.ok(error instanceof HubRequestError);
				return error.status;
			}
		};
		assert.equal(status({ mode: "lecture", prompt: "x" }), 400);
		assert.equal(status({ mode: "ask" }), 400);
		assert.equal(status({ mode: "ask", prompt: "x", probe: "yes" }), 400);
		assert.equal(status({ mode: "explain", lessonId: "lesson_missing" }), 404);
		assert.equal(status({ mode: "explain", topicId: "topic_missing" }), 404);
	});
});
