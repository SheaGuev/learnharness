"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { SessionBrief } from "@/src/core";
import { cn } from "@/lib/utils";

const MODE_LABELS: Record<SessionBrief["mode"], string> = {
	ask: "Ask",
	explain: "Explain",
	"deep-dive": "Deep dive",
	practice: "Practice",
	plan: "Plan",
};

function isBrief(value: unknown): value is SessionBrief {
	return typeof value === "object" && value !== null && "mode" in value && "goal" in value && "concepts" in value && Array.isArray(value.concepts);
}

/** The hub's session brief (message[0] of a hub-started session): muted and collapsed by default. */
export function SessionBriefCard({ data }: { data: unknown }) {
	const [open, setOpen] = useState(false);
	if (!isBrief(data)) return null;
	const own = data.concepts.filter((c) => !c.prerequisite);
	const prereqs = data.concepts.filter((c) => c.prerequisite);
	const start = data.mode === "deep-dive" ? (data.probe ? "starts with an assessment" : "starts teaching") : null;
	return (
		<div data-testid="session-brief-card" className="my-1">
			<button
				type="button"
				data-testid="session-brief-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">{MODE_LABELS[data.mode]}</span>
				<span className="min-w-0 flex-1 truncate">
					{data.lessonTitle ?? data.milestoneTitle ?? data.topicTitle ?? data.planTitle ?? data.goal}
					{start ? ` · ${start}` : ""}
				</span>
			</button>
			{open && (
				<div data-testid="session-brief-body" className="mt-1 space-y-1 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					<div className="leading-relaxed text-muted-foreground">
						<span className="font-medium text-foreground/80">Goal</span> — {data.goal}
					</div>
					{[{ label: "Concepts", list: own }, { label: "Prerequisites", list: prereqs }].map(({ label, list }) =>
						list.length === 0 ? null : (
							<div key={label} className="pt-1">
								<div className="font-medium text-foreground/80">{label}</div>
								{list.map((c) => (
									<div key={c.slug} className="text-muted-foreground">
										{c.title}: {c.lastAt === null ? "no evidence yet" : `${c.status}${c.reviewDue ? ", review due" : ""}`}
									</div>
								))}
							</div>
						),
					)}
				</div>
			)}
		</div>
	);
}
