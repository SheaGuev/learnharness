/**
 * Ask sessions (the tutor kind): POST /api/hub/start { mode: "ask" } makes a
 * kind:"tutor" chat, the handler routes it to the tutor from turn 1, and the
 * tutor answers with no probe, plan or quiz tools. Runs under an isolated
 * LH_DATA_DIR (hub and chat stores both write), so every app-module import
 * is dynamic.
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

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tutor-flow-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { POST: postHubStart } = await import("../app/api/hub/start/route.ts");
const { applyHubEdit } = await import("../src/server/hub.ts");
const { handleChatRequest, sessionAgentKind } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { composeInstructions, createTutorAgent } = await import("../src/agent/teacher-agent.ts");
const { danglingQuestionOf } = await import("../src/core/native-messages.ts");

type TeachingAgent = import("../src/agent/teacher-agent.ts").TeachingAgent;

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

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

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drainTurn(chatId: string, input: unknown, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const ack = await handleChatRequest(post(chatId, input), factory);
	if (ack.status !== 200) assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

async function startAsk(topicId: string): Promise<string> {
	const res = await postHubStart(new Request("http://test/api/hub/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mode: "ask", topicId, prompt: "What does a write-back cache defer?" }),
	}));
	assert.equal(res.status, 200);
	const body: unknown = await res.json();
	assert.ok(typeof body === "object" && body !== null && "id" in body && typeof body.id === "string");
	chatStore.saveSettings(body.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return body.id;
}

/** The handler's agent seam, test-shaped: refuses to build anything but the
 *  tutor, and keeps the agent so the test can read its prompt and tools. */
function tutorFactory(chatId: string, engine: PiEngine, built: TeachingAgent[]): Parameters<typeof handleChatRequest>[1] {
	return (opts) => {
		const record = chatStore.getChat(chatId);
		assert.ok(record);
		assert.equal(sessionAgentKind({ ...record, messages: record.messages }), "tutor");
		const agent = createTutorAgent({ engine, messages: opts.messages });
		built.push(agent);
		return agent;
	};
}

describe("Ask sessions run the tutor", () => {
	const topic = applyHubEdit({ type: "topic.create", title: "Caching" });
	assert.ok(topic.createdId);
	const topicId = topic.createdId;

	it("POST /api/hub/start { mode: ask } creates a tutor chat that skips the probe", async () => {
		const id = await startAsk(topicId);
		const chat = chatStore.getChat(id);
		assert.equal(chat?.kind, "tutor");
		assert.deepEqual(chat?.origin, { mode: "ask", topicId, skipProbe: true });
		assert.equal(chatStore.listChats().find((c) => c.id === id)?.kind, "tutor");
		assert.equal(sessionAgentKind({ kind: chat?.kind, messages: chat?.messages ?? [], origin: chat?.origin }), "tutor");
	});

	it("turn 1 answers directly with the tutor's prompt and read-only tool set", async () => {
		const id = await startAsk(topicId);
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxText("It defers the write to the backing store until the line is evicted.")]),
		]);
		const built: TeachingAgent[] = [];
		await drainTurn(id, { type: "text", text: "What does a write-back cache defer?" }, tutorFactory(id, engine, built));

		const [agent] = built;
		assert.ok(agent);
		assert.equal(agent.state.systemPrompt, composeInstructions("tutor"));
		assert.deepEqual(agent.state.tools.map((t) => t.name).sort(), ["ask_user_question", "find", "grep", "ls", "read"]);
		assert.ok(calls[0]?.includes("Mode: Ask"), "the model saw the session brief");
		const messages = chatStore.getChat(id)?.messages ?? [];
		assert.ok(messages.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("until the line is evicted")));
		assert.ok(!messages.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall")), "no probe, plan or quiz call");
	});

	it("a clarifying ask_user_question ends the turn and waits for the learner", async () => {
		const id = await startAsk(topicId);
		const { engine } = scripted([
			() => fauxAssistantMessage([fauxToolCall("ask_user_question", {
				question: "Which cache do you mean?",
				options: [{ label: "CPU cache (Recommended)" }, { label: "Web cache" }],
			}, { id: "call-ask-1" })], { stopReason: "toolUse" }),
		]);
		await drainTurn(id, { type: "text", text: "How does the cache handle writes?" }, tutorFactory(id, engine, []));
		const messages = chatStore.getChat(id)?.messages ?? [];
		assert.equal(danglingQuestionOf(messages)?.toolCallId, "call-ask-1");
	});
});
