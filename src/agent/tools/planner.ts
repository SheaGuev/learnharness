import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { askUserQuestionTool } from "../tools.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { healToolRecord } from "./heal.ts";
import type { ChatStore, HubStore } from "../../core/ports.ts";
import type { HubEvidence, HubState } from "../../core/contracts/hub.ts";
import { HubDataError } from "../../core/hub.ts";
import { projectMastery } from "../../core/hub-mastery.ts";
import { applyPlanDraft, planOutline } from "../../core/hub-plan-draft.ts";

export interface PlannerToolContext {
	chatId: string;
	chatStore: ChatStore;
	hubStore: HubStore;
	now?: () => Date;
	newId?: (prefix: string) => string;
}

const readHubInput = Type.Object({});

const lessonDraft = Type.Object({
	id: Type.Optional(Type.String({ description: "An existing lesson id from read_hub or an earlier save_plan, to update it instead of creating one." })),
	title: Type.String({ minLength: 1 }),
	goal: Type.String({ minLength: 1, description: "One narrow goal: what the learner can do after this lesson (about 30 minutes)." }),
	concepts: Type.Array(Type.String({ minLength: 1 }), {
		description: "2 to 5 concept titles, in any script. Mastery is tracked on these. This list replaces the lesson's concepts.",
	}),
});

const topicDraft = Type.Object({
	id: Type.Optional(Type.String({ description: "An existing topic id, to reuse it. Without one, a topic with the same title is reused or a new one is made." })),
	title: Type.String({ minLength: 1 }),
	summary: Type.Optional(Type.String()),
	lessons: Type.Array(lessonDraft, {
		description: "The lessons this milestone needs from this topic, in study order. The milestone shows only these, so one topic can be split across milestones.",
	}),
});

const savePlanInput = Type.Object({
	title: Type.String({ minLength: 1 }),
	goal: Type.String({ minLength: 1, description: "The learner's goal in their terms, with the success criterion." }),
	milestones: Type.Array(
		Type.Object({
			id: Type.Optional(Type.String({ description: "The milestone id from an earlier save, to keep it." })),
			title: Type.String({ minLength: 1 }),
			goal: Type.String({ minLength: 1, description: "What the learner can do once this milestone is done." }),
			topics: Type.Array(topicDraft, { minItems: 1 }),
		}),
		{ minItems: 1, description: "The whole plan, in order. Milestones left out are removed from the plan." },
	),
});

function hubOverview(state: HubState, evidence: readonly HubEvidence[], now: Date): string {
	if (state.topics.length === 0 && state.plans.length === 0) return "The hub is empty: no topics, lessons or plans yet.";
	const mastery = projectMastery(state, evidence, now);
	const lines: string[] = [];
	const conceptLine = (id: string) => {
		const c = state.concepts.find((x) => x.id === id);
		return c ? `${c.title} (${mastery.concepts[id]?.status ?? "not-yet"})` : null;
	};
	lines.push("Topics:");
	const visit = (parentId: string | null, depth: number) => {
		for (const t of state.topics.filter((x) => x.parentId === parentId).sort((a, b) => a.order - b.order)) {
			const pad = "  ".repeat(depth);
			lines.push(`${pad}- Topic "${t.title}" (id ${t.id})${t.summary ? `: ${t.summary}` : ""}`);
			for (const l of state.lessons.filter((x) => x.topicId === t.id).sort((a, b) => a.order - b.order)) {
				const concepts = l.conceptIds.flatMap((id) => conceptLine(id) ?? []);
				lines.push(`${pad}  - Lesson "${l.title}" (id ${l.id}, ${mastery.lessons[l.id]?.status ?? "not-started"}): ${l.goal}${concepts.length ? ` [${concepts.join("; ")}]` : ""}`);
			}
			visit(t.id, depth + 1);
		}
	};
	visit(null, 0);
	const plans = state.plans.filter((p) => !p.archived);
	if (plans.length > 0) lines.push("", "Plans:", ...plans.map((p) => planOutline(state, p)));
	return lines.join("\n");
}

/** read_hub: what the hub already holds, so the planner reuses topics and skips what is solid. */
export function readHubTool(ctx: PlannerToolContext): AgentTool<typeof readHubInput> {
	return {
		name: "read_hub",
		label: "read_hub",
		description:
			"Read the learning hub: every topic and lesson with ids, each concept's mastery status, and the active plans. " +
			"Call it before proposing a plan so you reuse existing topics and lessons and skip what is already solid.",
		parameters: readHubInput,
		execute: serverExecute("read_hub", readHubInput, async () => {
			const now = ctx.now?.() ?? new Date();
			return { text: hubOverview(ctx.hubStore.read(), ctx.hubStore.readEvidence(), now), details: { ok: true } };
		}),
	};
}

/**
 * save_plan: write the agreed plan into the hub. The first call creates the
 * plan and links this session to it; later calls revise that plan.
 */
export function savePlanTool(ctx: PlannerToolContext): AgentTool<typeof savePlanInput> {
	return {
		name: "save_plan",
		label: "save_plan",
		description:
			"Save the plan the learner agreed to into the learning hub: milestones, each with topics, each with lessons and concepts. " +
			"The first call creates the plan; later calls in this session revise it. Always send the whole plan. Pass the ids the " +
			"result gives back to keep milestones, topics and lessons. A topic can appear in several milestones, each listing " +
			"its own lessons from it. Topics, lessons and concepts are never deleted: leaving one out only removes it from the " +
			"plan, milestone or lesson.",
		parameters: savePlanInput,
		execute: serverExecute("save_plan", savePlanInput, async (input) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			const now = ctx.now?.() ?? new Date();
			const newId = ctx.newId ?? ((prefix: string) => `${prefix}_${now.getTime().toString(36)}_${randomUUID().slice(0, 8)}`);
			try {
				const result = applyPlanDraft(ctx.hubStore.read(), input, record.origin?.planId, { now: now.toISOString(), newId });
				ctx.hubStore.write(result.state);
				if (record.origin?.planId !== result.planId) {
					ctx.chatStore.saveOrigin(ctx.chatId, { ...(record.origin ?? { mode: "plan" }), planId: result.planId });
				}
				const plan = result.state.plans.find((p) => p.id === result.planId);
				const outline = plan ? planOutline(result.state, plan) : "";
				return {
					text: `Plan saved (${result.created.topics} new topics, ${result.created.lessons} new lessons). The learner can open it from the hub.\n\n${outline}`,
					details: { ok: true, planId: result.planId, created: result.created },
				};
			} catch (error) {
				if (error instanceof HubDataError) return { ok: false, error: error.message };
				throw error;
			}
		}),
	};
}

const HUB_KEY = Symbol.for("lh.planner.hub.v1");
const shared: typeof globalThis & { [HUB_KEY]?: HubStore } = globalThis;

/** Give the planner tools their hub store from the composition root, so the agent layer never imports the store adapter. */
export function configurePlannerTools(hubStore: HubStore): void {
	shared[HUB_KEY] = hubStore;
}

/** The planner's registry: the goal interview, hub reads and writes, and the read-only learner files. */
export function createPlannerTools(ctx?: { chatId: string; chatStore: ChatStore }): Record<string, AgentTool<any>> {
	const hubStore = shared[HUB_KEY];
	return healToolRecord({
		ask_user_question: askUserQuestionTool,
		...(ctx && hubStore ? { read_hub: readHubTool({ ...ctx, hubStore }), save_plan: savePlanTool({ ...ctx, hubStore }) } : {}),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
	});
}
