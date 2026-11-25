import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import type { ChatStore, HubStore } from "../../core/ports.ts";
import { sessionOutcomeChanges } from "../../core/hub-outcome.ts";

export interface ReportOutcomeContext {
	chatId: string;
	chatStore: ChatStore;
	hubStore: HubStore;
	now?: () => Date;
}

const reportOutcomeInput = Type.Object({
	summary: Type.String({ minLength: 1, description: "One or two sentences on where the learner stands now." }),
	concepts: Type.Array(
		Type.Object({
			slug: Type.String({ minLength: 1, description: "A lesson concept slug from the session brief." }),
			status: Type.Union([Type.Literal("solid"), Type.Literal("shaky"), Type.Literal("gap")], {
				description: "solid: reasons with it unaided. shaky: partly there or inconsistent. gap: missing or wrong.",
			}),
			note: Type.Optional(Type.String({ description: "The evidence behind the status, in one line." })),
		}),
		{ description: "Every lesson concept you have evidence on. Leave out concepts you have no evidence on." },
	),
	explore: Type.Optional(
		Type.Array(Type.Object({ title: Type.String({ minLength: 1 }), why: Type.String({ minLength: 1 }) }), {
			description: "Neighbouring topics worth exploring next, and why.",
		}),
	),
	deeperDives: Type.Optional(
		Type.Array(
			Type.Object({
				title: Type.String({ minLength: 1 }),
				goal: Type.String({ minLength: 1 }),
				fromSlug: Type.String({ minLength: 1, description: "The lesson concept this dive goes deeper on." }),
			}),
			{ description: "Deeper lessons the learner could take on one of this lesson's concepts." },
		),
	),
});

/**
 * report_outcome records what a session showed about the learner into the
 * hub: assessment evidence for the linked lesson's concepts (which sets
 * their mastery outright) plus explore suggestions. Chats with no hub
 * lesson are refused.
 */
export function reportOutcomeTool(ctx: ReportOutcomeContext): AgentTool<typeof reportOutcomeInput> {
	return {
		name: "report_outcome",
		label: "report_outcome",
		description:
			"Record the learner's state on this hub lesson's concepts, plus suggested next topics, in the learning hub. " +
			"Each concept gets solid, shaky or gap, keyed by the slugs in the session brief. Later sessions read these " +
			"results instead of re-measuring. Only works in sessions linked to a hub lesson.",
		parameters: reportOutcomeInput,
		execute: serverExecute("report_outcome", reportOutcomeInput, async (input, { toolCallId }) => {
			const record = ctx.chatStore.getChat(ctx.chatId);
			if (!record) return { ok: false, error: `Chat not found: ${ctx.chatId}` };
			const lessonId = record.origin?.lessonId;
			if (!lessonId) {
				return { ok: false, error: "This session isn't linked to a hub lesson, so there is nowhere to record an outcome. Don't call report_outcome again in this session." };
			}
			const at = (ctx.now?.() ?? new Date()).toISOString();
			const changes = sessionOutcomeChanges(ctx.hubStore.read(), { chatId: ctx.chatId, lessonId, callId: toolCallId, at, tree: record.tree }, input);
			if (!changes) return { ok: false, error: "The hub lesson this session was linked to no longer exists. Nothing was recorded." };
			const validSlugs = changes.lessonConcepts.map((c) => c.slug).join(", ");
			if (changes.evidence.length === 0 && changes.unknownSlugs.length > 0 && !input.explore?.length && !input.deeperDives?.length) {
				return { ok: false, error: `None of these slugs match the lesson's concepts: ${changes.unknownSlugs.join(", ")}. Valid slugs: ${validSlugs}.` };
			}

			if (changes.exploreAdded > 0) ctx.hubStore.write(changes.state);
			ctx.hubStore.appendEvidence(changes.evidence);
			const lines = [
				`Outcome recorded: ${changes.evidence.length} concept${changes.evidence.length === 1 ? "" : "s"} assessed, ${changes.exploreAdded} explore item${changes.exploreAdded === 1 ? "" : "s"} added.`,
			];
			if (changes.unknownSlugs.length > 0) lines.push(`Ignored unknown slugs: ${changes.unknownSlugs.join(", ")}. Valid slugs: ${validSlugs}.`);
			return {
				text: lines.join(" "),
				details: { ok: true, assessed: changes.evidence.map((e) => e.conceptId), exploreAdded: changes.exploreAdded, unknownSlugs: changes.unknownSlugs },
			};
		}),
	};
}

const HUB_KEY = Symbol.for("lh.report-outcome.hub.v1");
const shared: typeof globalThis & { [HUB_KEY]?: HubStore } = globalThis;

/** Give the tool its hub store from the composition root, so the agent layer never imports the store adapter. */
export function configureReportOutcome(hubStore: HubStore): void {
	shared[HUB_KEY] = hubStore;
}

/**
 * The registry entry: report_outcome for chats linked to a hub lesson, once
 * a hub store is configured; empty otherwise, so other chats never see it.
 */
export function reportOutcomeTools(ctx: { chatId: string; chatStore: ChatStore }): Record<string, AgentTool<any>> {
	const hubStore = shared[HUB_KEY];
	if (!hubStore || !ctx.chatStore.getChat(ctx.chatId)?.origin?.lessonId) return {};
	return { report_outcome: reportOutcomeTool({ ...ctx, hubStore }) };
}
