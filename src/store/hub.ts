import fs from "node:fs";
import { HUB_DIR, HUB_EVIDENCE_FILE, HUB_FILE } from "../../config.ts";
import type { HubEvidence, HubState } from "../core/contracts/hub.ts";
import { emit } from "../core/events.ts";
import { assertHubIntegrity, emptyHubState, parseEvidence, parseHubState } from "../core/hub.ts";
import type { HubStore } from "../core/ports.ts";
import { removeLeftoverTemps, writeFileAtomicSync } from "./atomic-write.ts";

function readEvidenceLines(): HubEvidence[] {
	let raw: string;
	try {
		raw = fs.readFileSync(HUB_EVIDENCE_FILE, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const out: HubEvidence[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try { parsed = JSON.parse(line); } catch { continue; }
		const evidence = parseEvidence(parsed);
		if (evidence) out.push(evidence);
	}
	return out;
}

export const hubStore: HubStore = {
	read() {
		let raw: string;
		try {
			raw = fs.readFileSync(HUB_FILE, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return emptyHubState();
			throw error;
		}
		return parseHubState(JSON.parse(raw));
	},
	write(state) {
		assertHubIntegrity(state);
		fs.mkdirSync(HUB_DIR, { recursive: true });
		writeFileAtomicSync(HUB_FILE, JSON.stringify(state, null, "\t") + "\n");
		removeLeftoverTemps(HUB_FILE);
		emit("hub-changed", {});
	},
	readEvidence: readEvidenceLines,
	appendEvidence(items) {
		if (items.length === 0) return 0;
		const known = new Set(readEvidenceLines().map((e) => e.id));
		const fresh: HubEvidence[] = [];
		for (const item of items) {
			if (known.has(item.id)) continue;
			known.add(item.id);
			fresh.push(item);
		}
		if (fresh.length === 0) return 0;
		fs.mkdirSync(HUB_DIR, { recursive: true });
		// A torn final line from a crash is skipped on read, so a plain append is enough here.
		fs.appendFileSync(HUB_EVIDENCE_FILE, fresh.map((e) => JSON.stringify(e)).join("\n") + "\n");
		emit("hub-changed", {});
		return fresh.length;
	},
};
