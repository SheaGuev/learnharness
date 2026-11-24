import { adoptChat, HubRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

/** Link an existing session to a lesson: `{ chatId, lessonId }`, or `{ chatId, topicId }` to make a lesson from it. */
export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "The request body must be JSON." }, { status: 400 });
	}
	try {
		return Response.json(adoptChat(body));
	} catch (error) {
		if (error instanceof HubRequestError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: "Could not link that session." }, { status: 500 });
	}
}
