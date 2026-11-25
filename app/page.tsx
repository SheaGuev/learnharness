import { Home } from "@/components/home";
import type { HubNav } from "@/components/hub/hub-view";
import { readSettingsRecord } from "@/src/server";
import { resolveSettings, slotsConfigured } from "@/src/core";

// Dynamic: the configured state is server-rendered into the page (the
// setup CTA's truth on the first frame), and every navigation re-reads
// the record (dynamic routes aren't cached client-side).
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function param(params: SearchParams, key: string): string | undefined {
	const value = params[key];
	return typeof value === "string" && value ? value : undefined;
}

export default async function HomePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
	const params = await searchParams;
	// First-run gate (model-slots wave): chats cannot start until the user
	// has picked all three slots — the dock shows the CTA while the raw
	// record's models section lacks any slot pin.
	const record = readSettingsRecord();
	// GRAPH RENDERING (owner, 2026-10-06): off = the map view is the chains
	// view. Resolved through the one core resolver (missing section /
	// absent key → factory default on); re-read per navigation.
	const rendering = resolveSettings(record ?? null).graph.rendering;
	const topic = param(params, "topic");
	const plan = param(params, "plan");
	const hubNav: HubNav = topic ? { screen: "topic", id: topic } : plan ? { screen: "plan", id: plan } : { screen: "home" };
	return (
		<Home
			initialConfigured={slotsConfigured(record?.models)}
			rendering={rendering}
			view={param(params, "view") === "map" ? "map" : "hub"}
			hubNav={hubNav}
		/>
	);
}
