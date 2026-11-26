import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../../core/ports.ts";
import { askUserQuestionTool } from "../tools.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { healToolRecord } from "./heal.ts";
import { reportOutcomeTools } from "./report-outcome.ts";

export interface TutorToolContext {
	chatId: string;
	chatStore: ChatStore;
}

/** The tutor's registry (Ask sessions): the read-only learner-file set plus
 *  ask_user_question for clarifications, and report_outcome when the chat is
 *  linked to a hub lesson. No quiz, plan, probe or job tools, so there is
 *  nothing to toggle. */
export function createTutorTools(ctx?: TutorToolContext): Record<string, AgentTool<any>> {
	return healToolRecord({
		ask_user_question: askUserQuestionTool,
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(ctx ? reportOutcomeTools(ctx) : {}),
	});
}
