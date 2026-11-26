/**
 * Plan sessions (the planner kind) and milestone hubs: the save_plan upsert,
 * milestone progress, POST /api/hub/start { mode: "plan" }, and a planner
 * turn that saves a plan and links the session to it. Runs under an
 * isolated LH_DATA_DIR, so every app-module import is dynamic.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-planner-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { applyHubAction, emptyHubState, parseHubAction, parseHubState } = await import("../src/core/hub.ts");
const { applyPlanDraft } = await import("../src/core/hub-plan-draft.ts");
const { milestoneLessonIds, projectMastery } = await import("../src/core/hub-mastery.ts");
const { POST: postHubStart } = await import("../app/api/hub/start/route.ts");
const { hubSnapshot } = await import("../src/server/hub.ts");
const { handleChatRequest, sessionAgentKind } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { hubStore } = await import("../src/store/hub.ts");
const { composeInstructions, createPlannerAgent } = await import("../src/agent/teacher-agent.ts");

type TeachingAgent = import("../src/agent/teacher-agent.ts").TeachingAgent;
type PlanDraft = import("../src/core/hub-plan-draft.ts").PlanDraft;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

let seq = 0;
const ctx = { now: "2026-11-26T00:00:00.000Z", newId: (prefix: string) => `${prefix}_${++seq}` };

const draft: PlanDraft = {
	title: "Rust for CLI tools",
	goal: "Ship a small CLI tool in Rust",
	milestones: [
		{
			title: "Ownership",
			goal: "Explain why the borrow checker rejects a program",
			topics: [{
				title: "Rust basics",
				lessons: [
					{ title: "Ownership and moves", goal: "Predict when a value moves", concepts: ["Move semantics", "Copy types"] },
					{ title: "Borrowing", goal: "Use shared and mutable borrows", concepts: ["Shared borrow", "Mutable borrow"] },
				],
			}],
		},
		{
			title: "A first CLI",
			goal: "Parse arguments and read files",
			topics: [{ title: "CLI crates", lessons: [{ title: "clap", goal: "Define a CLI with clap", concepts: ["Derive API"] }] }],
		},
	],
};

describe("applyPlanDraft", () => {
	it("creates the plan with milestone goals, topics and lessons", () => {
		const result = applyPlanDraft(emptyHubState(), draft, undefined, ctx);
		const plan = result.state.plans.find((p) => p.id === result.planId);
		assert.ok(plan);
		assert.deepEqual(result.created, { topics: 2, lessons: 3 });
		assert.equal(plan.milestones[0]?.goal, "Explain why the borrow checker rejects a program");
		assert.equal(plan.milestones[0]?.topicIds.length, 1);
		assert.deepEqual(plan.milestones[0]?.lessonIds, []);
		assert.equal(result.state.concepts.length, 5);
	});

	it("re-applying the same draft duplicates nothing", () => {
		const first = applyPlanDraft(emptyHubState(), draft, undefined, ctx);
		const again = applyPlanDraft(first.state, draft, first.planId, ctx);
		assert.equal(again.planId, first.planId);
		assert.deepEqual(again.created, { topics: 0, lessons: 0 });
		assert.equal(again.state.topics.length, 2);
		assert.equal(again.state.lessons.length, 3);
		assert.equal(again.state.concepts.length, 5);
		assert.deepEqual(again.state.plans[0]?.milestones.map((m) => m.id), first.state.plans[0]?.milestones.map((m) => m.id));
	});

	it("a revision drops a milestone from the plan but keeps its topic and lessons", () => {
		const first = applyPlanDraft(emptyHubState(), draft, undefined, ctx);
		const revised = applyPlanDraft(first.state, { ...draft, milestones: draft.milestones.slice(0, 1) }, first.planId, ctx);
		assert.equal(revised.state.plans[0]?.milestones.length, 1);
		assert.equal(revised.state.topics.length, 2);
		assert.equal(revised.state.lessons.length, 3);
	});

	it("reuses an existing top-level topic by title and adds only new concepts", () => {
		const base = applyHubAction(emptyHubState(), parseHubAction({ type: "topic.create", title: "rust basics", parentId: null }), ctx).state;
		const result = applyPlanDraft(base, draft, undefined, ctx);
		assert.equal(result.created.topics, 1);
		assert.equal(result.state.topics.filter((t) => t.title.toLowerCase() === "rust basics").length, 1);
	});

	it("refuses an unknown topic id with a message the model can act on", () => {
		const bad: PlanDraft = { ...draft, milestones: [{ ...draft.milestones[0]!, topics: [{ id: "topic_nope", title: "X", lessons: [] }] }] };
		assert.throws(() => applyPlanDraft(emptyHubState(), bad, undefined, ctx), /No topic with id "topic_nope"/);
	});
});

describe("milestones as hubs", () => {
	it("old milestones without topicIds or goal still parse", () => {
		const state = parseHubState({
			version: 1, topics: [], concepts: [], lessons: [], explore: [],
			plans: [{ id: "p1", title: "P", goal: "G", milestones: [{ id: "m1", title: "M", lessonIds: [] }], archived: false, createdAt: "x", updatedAt: "x" }],
		});
		assert.deepEqual(state.plans[0]?.milestones[0], { id: "m1", title: "M", topicIds: [], lessonIds: [] });
	});

	it("milestone lessons follow topic order and feed per-milestone progress", () => {
		const { state, planId } = applyPlanDraft(emptyHubState(), draft, undefined, ctx);
		const plan = state.plans.find((p) => p.id === planId);
		assert.ok(plan);
		const [first, second] = plan.milestones;
		assert.ok(first && second);
		assert.deepEqual(milestoneLessonIds(state, first).map((id) => state.lessons.find((l) => l.id === id)?.title), ["Ownership and moves", "Borrowing"]);
		const mastery = projectMastery(state, [], new Date("2026-11-26T00:00:00Z"));
		const progress = mastery.plans[planId];
		assert.equal(progress?.milestones[first.id]?.total, 4);
		assert.equal(progress?.milestones[second.id]?.total, 1);
		assert.equal(progress?.milestones[first.id]?.complete, false);
		assert.equal(progress?.nextLessonId, milestoneLessonIds(state, first)[0]);
		assert.equal(progress?.total, 5);
	});

	it("deleting a topic removes it from milestones", () => {
		let state = applyHubAction(emptyHubState(), parseHubAction({ type: "topic.create", title: "Empty", parentId: null }), ctx).state;
		const topicId = state.topics[0]!.id;
		state = applyHubAction(state, parseHubAction({ type: "plan.create", title: "P", goal: "G", milestones: [{ title: "M", topicIds: [topicId], lessonIds: [] }] }), ctx).state;
		state = applyHubAction(state, parseHubAction({ type: "topic.delete", id: topicId }), ctx).state;
		assert.deepEqual(state.plans[0]?.milestones[0]?.topicIds, []);
	});
});

function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) =>
		async (context: TranscriptContext): Promise<AssistantMessage> => {
			calls.push(context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"));
			return typeof step === "function"
				? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
				: step;
		};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

async function drainTurn(chatId: string, text: string, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const ack = await handleChatRequest(new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input: { type: "text", text } }),
	}), factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

async function startPlan(body: Record<string, unknown>): Promise<{ status: number; id?: string }> {
	const res = await postHubStart(new Request("http://test/api/hub/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "plan", ...body }),
	}));
	const json: unknown = await res.json();
	const id = typeof json === "object" && json !== null && "id" in json && typeof json.id === "string" ? json.id : undefined;
	if (id) chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return { status: res.status, ...(id ? { id } : {}) };
}

describe("Plan sessions run the planner", () => {
	it("POST /api/hub/start { mode: plan } creates a planner chat with no probe", async () => {
		const { status, id } = await startPlan({ prompt: "I want to build CLI tools in Rust" });
		assert.equal(status, 200);
		assert.ok(id);
		const chat = chatStore.getChat(id);
		assert.equal(chat?.kind, "planner");
		assert.deepEqual(chat?.origin, { mode: "plan" });
		assert.equal(sessionAgentKind({ kind: chat?.kind, messages: chat?.messages ?? [], origin: chat?.origin }), "planner");
	});

	it("a plan start needs a goal or a plan, and a milestone needs its plan", async () => {
		assert.equal((await startPlan({})).status, 400);
		assert.equal((await startPlan({ prompt: "x", milestoneId: "m_1" })).status, 400);
	});

	it("save_plan writes the plan and links the session, which then lists under the plan", async () => {
		const { id } = await startPlan({ prompt: "I want to build CLI tools in Rust" });
		assert.ok(id);
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("save_plan", JSON.parse(JSON.stringify(draft)), { id: "call-save-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Saved. Start with Ownership and moves.")]),
		]);
		const built: TeachingAgent[] = [];
		await drainTurn(id, "Looks right, save it", (opts) => {
			const agent = createPlannerAgent({ chatId: id, chatStore }, { engine, messages: opts.messages });
			built.push(agent);
			return agent;
		});

		const [agent] = built;
		assert.ok(agent);
		assert.equal(agent.state.systemPrompt, composeInstructions("planner"));
		assert.deepEqual(agent.state.tools.map((t) => t.name).sort(), ["ask_user_question", "find", "grep", "ls", "read", "read_hub", "save_plan"]);
		assert.ok(calls[0]?.includes("Mode: Plan"), "the model saw the session brief");

		const planId = chatStore.getChat(id)?.origin?.planId;
		assert.ok(planId, "the session is linked to the saved plan");
		const plan = hubStore.read().plans.find((p) => p.id === planId);
		assert.equal(plan?.title, "Rust for CLI tools");
		assert.equal(plan?.milestones.length, 2);
		assert.ok(calls[1]?.includes("Plan saved"), "the tool result reached the model");
		assert.ok(hubSnapshot().planSessions[planId]?.some((c) => c.id === id));
	});

	it("a milestone start revises that milestone of the plan", async () => {
		const plan = hubStore.read().plans[0];
		const milestone = plan?.milestones[1];
		assert.ok(plan && milestone);
		const { status, id } = await startPlan({ planId: plan.id, milestoneId: milestone.id });
		assert.equal(status, 200);
		assert.ok(id);
		const chat = chatStore.getChat(id);
		assert.equal(chat?.title, "Plan: A first CLI");
		assert.deepEqual(chat?.origin, { mode: "plan", planId: plan.id, milestoneId: milestone.id });
		const brief = JSON.stringify(chat?.messages[0]);
		assert.ok(brief.includes("Revise one milestone"));
	});

	it("an Ask from a milestone briefs on the milestone goal and its lessons' concepts", async () => {
		const plan = hubStore.read().plans[0];
		const milestone = plan?.milestones[0];
		assert.ok(plan && milestone);
		const res = await postHubStart(new Request("http://test/api/hub/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "ask", planId: plan.id, milestoneId: milestone.id, prompt: "Why do moves exist?" }),
		}));
		assert.equal(res.status, 200);
		const body: unknown = await res.json();
		assert.ok(typeof body === "object" && body !== null && "id" in body && typeof body.id === "string");
		const chat = chatStore.getChat(body.id);
		assert.equal(chat?.kind, "tutor");
		assert.deepEqual(chat?.origin, { mode: "ask", planId: plan.id, milestoneId: milestone.id, skipProbe: true });
		const brief = JSON.stringify(chat?.messages[0]);
		assert.ok(brief.includes("move-semantics") && brief.includes("mutable-borrow"), "the brief lists the milestone's concepts");
		assert.ok(hubSnapshot().planSessions[plan.id]?.some((c) => c.id === body.id));
	});
});
