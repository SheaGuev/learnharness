import type { AgentTool } from "@earendil-works/pi-agent-core";
import { askUserQuestionTool } from "../tools.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { healToolRecord } from "./heal.ts";

/** The tutor's registry (Ask sessions): the read-only learner-file set plus
 *  ask_user_question for clarifications. No quiz, plan, probe or job tools,
 *  so there is nothing to toggle. */
export function createTutorTools(): Record<string, AgentTool<any>> {
	return healToolRecord({
		ask_user_question: askUserQuestionTool,
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
	});
}
