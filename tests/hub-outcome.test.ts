import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// Isolated data dir, set before any config-loading import.
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-hub-outcome-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { applyHubAction, emptyHubState, parseHubAction } = await import("../src/core/hub.ts");
const { sessionOutcomeChanges } = await import("../src/core/hub-outcome.ts");
const { reportOutcomeTool } = await import("../src/agent/tools/report-outcome.ts");
const { createProberTools, createTeacherTools } = await import("../src/agent/tools.ts");
// The composition root: importing it configures report_outcome's hub store.
const { stores } = await import("../src/server/stores.ts");
const { applyHubEdit, hubSnapshot } = await import("../src/server/hub.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const NOW = "2026-11-25T00:00:00.000Z";
let seq = 0;
const ctx = { now: NOW, newId: (prefix: string) => `${prefix}_${++seq}` };
type State = ReturnType<typeof emptyHubState>;

function act(state: State, body: unknown) {
	return applyHubAction(state, parseHubAction(body), ctx);
}

function id(result: { createdId?: string }): string {
	assert.ok(result.createdId);
	return result.createdId;
}

/** A topic with a prerequisite lesson (Hashing) and a lesson that needs it (Caching). */
function seeded() {
	let state = emptyHubState();
	const t = act(state, { type: "topic.create", title: "System design" });
	state = t.state;
	const topicId = id(t);
	const pre = act(state, { type: "lesson.create", topicId, title: "Hashing", goal: "g", concepts: [{ title: "Consistent hashing" }] });
	state = pre.state;
	const l = act(state, {
		type: "lesson.create", topicId, title: "Caching", goal: "Know when a cache helps",
		concepts: [{ title: "Cache-aside" }, { title: "TTL and eviction" }], prereqLessonIds: [id(pre)],
	});
	const slug = (s: string) => l.state.concepts.find((c) => c.slug === s)?.id ?? "";
	return { state: l.state, topicId, lessonId: id(l), slug };
}

function isRec(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultOf(result: { content: { type: string }[]; details: unknown }): { text: string; details: Record<string, unknown> } {
	const first = result.content[0];
	const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
	assert.ok(isRec(result.details));
	return { text, details: result.details };
}

describe("session outcome → hub changes", () => {
	it("maps slugs to the lesson's and its prerequisites' concepts, with a plan-map title fallback", () => {
		const { state, lessonId, slug } = seeded();
		const tree = { nodes: [{ id: "eviction", title: "TTL and eviction" }], edges: [], version: 1 };
		const changes = sessionOutcomeChanges(state, { chatId: "c1", lessonId, callId: "call1", at: NOW, tree }, {
			summary: "Mostly there",
			concepts: [
				{ slug: "cache-aside", status: "solid", note: "explained the read path" },
				{ slug: "eviction", status: "shaky" },
				{ slug: "Consistent Hashing", status: "gap" },
				{ slug: "nonsense", status: "solid" },
			],
			deeperDives: [{ title: "Write-behind caches", goal: "Know the failure modes", fromSlug: "cache-aside" }],
		});
		assert.ok(changes);
		assert.deepEqual(
			changes.evidence.map((e) => [e.id, e.conceptId, e.kind, e.result, e.note]),
			[
				["assessment_c1_call1_cache-aside", slug("cache-aside"), "assessment", "solid", "explained the read path"],
				["assessment_c1_call1_ttl-and-eviction", slug("ttl-and-eviction"), "assessment", "shaky", undefined],
				["assessment_c1_call1_consistent-hashing", slug("consistent-hashing"), "assessment", "gap", undefined],
			],
		);
		assert.ok(changes.evidence.every((e) => e.lessonId === lessonId && e.chatId === "c1"));
		assert.deepEqual(changes.unknownSlugs, ["nonsense"]);
		const dive = changes.state.explore.find((e) => e.id === "deeper_c1_call1_0");
		assert.deepEqual(dive && { source: dive.source, why: dive.why, from: dive.fromConceptId, chat: dive.chatId }, {
			source: "teacher", why: "Know the failure modes", from: slug("cache-aside"), chat: "c1",
		});
	});

	it("adds nothing new when the same call is applied twice, and returns null for a missing lesson", () => {
		const { state, lessonId } = seeded();
		const source = { chatId: "c1", lessonId, callId: "call1", at: NOW };
		const outcome = { summary: "s", concepts: [], explore: [{ title: "CDNs", why: "Caching at the edge" }] };
		const first = sessionOutcomeChanges(state, source, outcome);
		assert.equal(first?.exploreAdded, 1);
		const again = sessionOutcomeChanges(first.state, source, outcome);
		assert.equal(again?.exploreAdded, 0);
		assert.equal(again.state.explore.length, 1);
		assert.equal(sessionOutcomeChanges(state, { ...source, lessonId: "gone" }, outcome), null);
	});
});

describe("report_outcome tool", () => {
	function hubChat() {
		const topicId = id(applyHubEdit({ type: "topic.create", title: "Databases" }));
		const lessonId = id(applyHubEdit({
			type: "lesson.create", topicId, title: "Indexes", goal: "Know when an index helps",
			concepts: [{ title: "B-tree index" }, { title: "Covering index" }], prereqLessonIds: [], parentLessonId: null,
		}));
		const chat = stores.chatStore.createChat("Indexes", undefined, { mode: "deep-dive", lessonId, topicId });
		return { chatId: chat.id, lessonId };
	}

	function teacherTools(chatId: string) {
		return createTeacherTools({ chatId, chatStore: stores.chatStore, jobStore: stores.jobStore, spawn: () => {} });
	}

	it("changes the lesson's mastery in the hub snapshot, and a retried call doesn't duplicate", async () => {
		const { chatId, lessonId } = hubChat();
		const tool = teacherTools(chatId).report_outcome;
		assert.ok(tool, "registered for a lesson-linked chat");
		const before = hubSnapshot(new Date(NOW));
		assert.equal(before.mastery.lessons[lessonId]?.solid, 0);

		const input = {
			summary: "Solid on both",
			concepts: [{ slug: "b-tree-index", status: "solid" }, { slug: "covering-index", status: "solid" }],
			explore: [{ title: "Partial indexes", why: "Asked about filtering" }],
		};
		const first = resultOf(await tool.execute("call-1", input));
		assert.equal(first.details.ok, true);
		assert.match(first.text, /2 concepts assessed, 1 explore item added/);
		await tool.execute("call-1", input);

		const after = hubSnapshot(new Date(NOW));
		assert.deepEqual(after.mastery.lessons[lessonId], { status: "complete", solid: 2, total: 2 });
		assert.equal(stores.hubStore.readEvidence().filter((e) => e.chatId === chatId).length, 2);
		assert.deepEqual(after.state.explore.filter((e) => e.chatId === chatId).map((e) => [e.title, e.source]), [["Partial indexes", "teacher"]]);
	});

	it("is offered to the prober on hub chats too, for probe findings", () => {
		const { chatId } = hubChat();
		const tools = createProberTools({ chatId, chatStore: stores.chatStore, deliver: () => {}, jobStore: stores.jobStore, spawn: () => {} });
		assert.ok(tools.report_outcome);
	});

	it("is absent outside the hub and refuses a chat with no lesson", async () => {
		const plain = stores.chatStore.createChat("Not from the hub");
		assert.equal(teacherTools(plain.id).report_outcome, undefined);

		const tool = reportOutcomeTool({ chatId: plain.id, chatStore: stores.chatStore, hubStore: stores.hubStore });
		const refused = resultOf(await tool.execute("call-x", { summary: "s", concepts: [{ slug: "b-tree-index", status: "solid" }] }));
		assert.equal(refused.details.ok, false);
		assert.match(String(refused.details.error), /isn't linked to a hub lesson/);
		assert.equal(stores.hubStore.readEvidence().filter((e) => e.chatId === plain.id).length, 0);
	});

	it("refuses a report whose slugs all miss, listing the valid ones", async () => {
		const { chatId } = hubChat();
		const tool = teacherTools(chatId).report_outcome;
		assert.ok(tool);
		const refused = resultOf(await tool.execute("call-2", { summary: "s", concepts: [{ slug: "hash-index", status: "gap" }] }));
		assert.equal(refused.details.ok, false);
		assert.match(String(refused.details.error), /Valid slugs: b-tree-index, covering-index/);
	});
});
