import { HubRequestError, startHubSession } from "@/src/server";

export const dynamic = "force-dynamic";

/** Start a session from the hub: `{ mode, lessonId?, topicId?, planId?, prompt?, probe? }`. */
export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "The request body must be JSON." }, { status: 400 });
	}
	try {
		return Response.json(startHubSession(body));
	} catch (error) {
		if (error instanceof HubRequestError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: "Could not start that session." }, { status: 500 });
	}
}
