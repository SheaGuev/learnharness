import { applyHubEdit, hubSnapshot, HubRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	try {
		return Response.json(hubSnapshot());
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "Could not read the learning hub." }, { status: 500 });
	}
}

/** One edit per request: `{ type: "topic.create" | "lesson.update" | ..., ...fields }`. */
export async function POST(request: Request) {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "The request body must be JSON." }, { status: 400 });
	}
	try {
		return Response.json(applyHubEdit(body));
	} catch (error) {
		if (error instanceof HubRequestError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: "Could not save the learning hub." }, { status: 500 });
	}
}
