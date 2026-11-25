"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { HostDialog } from "@/components/host-dialog";
import { timeAgo } from "@/components/sidebar";
import type { ChatSummary, ConceptMastery, ConceptStatus, HubConcept, LessonProgress } from "@/src/core";

export const STATUS_LABEL: Record<ConceptStatus, string> = {
	"not-yet": "Not yet",
	learning: "Learning",
	shaky: "Shaky",
	gap: "Gap",
	solid: "Solid",
};

const DOT_CLASS: Record<ConceptStatus, string> = {
	"not-yet": "border border-muted-foreground/60 bg-transparent",
	learning: "border border-muted-foreground bg-muted-foreground/50",
	shaky: "bg-warning",
	gap: "bg-error",
	solid: "bg-success",
};

export const NOT_YET: ConceptMastery = { status: "not-yet", passes: 0, fails: 0, lastAt: null, dueAt: null, reviewDue: false };

export function ConceptDot({ mastery, title, className }: { mastery: ConceptMastery; title?: string; className?: string }) {
	const label = `${title ? `${title}: ` : ""}${STATUS_LABEL[mastery.status]}${mastery.reviewDue ? ", review due" : ""}`;
	return (
		<span
			role="img"
			aria-label={label}
			title={label}
			data-testid="concept-dot"
			data-status={mastery.status}
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				DOT_CLASS[mastery.status],
				mastery.reviewDue && "ring-2 ring-warning/70 ring-offset-1 ring-offset-background",
				className,
			)}
		/>
	);
}

export function ConceptDots({ concepts, mastery }: { concepts: readonly HubConcept[]; mastery: Record<string, ConceptMastery> }) {
	if (concepts.length === 0) return <span className="text-xs text-muted-foreground/70">No concepts</span>;
	return (
		<span className="flex flex-wrap items-center gap-1">
			{concepts.map((c) => <ConceptDot key={c.id} mastery={mastery[c.id] ?? NOT_YET} title={c.title} />)}
		</span>
	);
}

export function DotLegend() {
	const statuses: ConceptStatus[] = ["solid", "learning", "shaky", "gap", "not-yet"];
	return (
		<div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" data-testid="hub-dot-legend">
			{statuses.map((s) => (
				<span key={s} className="flex items-center gap-1.5">
					<ConceptDot mastery={{ ...NOT_YET, status: s }} />
					{STATUS_LABEL[s]}
				</span>
			))}
		</div>
	);
}

export function ProgressBar({ solid, total, className }: { solid: number; total: number; className?: string }) {
	const pct = total > 0 ? Math.round((solid / total) * 100) : 0;
	return (
		<div className={cn("flex items-center gap-2", className)}>
			<div className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent" aria-hidden="true">
				<div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
			</div>
			<span className="shrink-0 font-ui text-xs text-muted-foreground">{solid}/{total} solid</span>
		</div>
	);
}

const LESSON_STATUS_LABEL: Record<LessonProgress["status"], string> = {
	"not-started": "Not started",
	"in-progress": "In progress",
	complete: "Complete",
	"needs-review": "Review due",
};

export function LessonStatusBadge({ progress }: { progress: LessonProgress | undefined }) {
	const status = progress?.status ?? "not-started";
	return (
		<span
			data-testid="lesson-status"
			className={cn(
				"shrink-0 rounded-sm border px-1.5 py-0.5 font-ui text-[11px] uppercase tracking-wider",
				status === "complete" && "border-success/40 text-success",
				status === "needs-review" && "border-warning/40 text-warning",
				status === "in-progress" && "border-border text-foreground",
				status === "not-started" && "border-border/60 text-muted-foreground",
			)}
		>
			{LESSON_STATUS_LABEL[status]}
		</span>
	);
}

export function SessionList({ sessions, empty }: { sessions: readonly ChatSummary[]; empty: string }) {
	if (sessions.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
	return (
		<ul className="flex flex-col gap-0.5" data-testid="hub-session-list">
			{sessions.map((s) => (
				<li key={s.id}>
					<Link
						href={`/chat/${s.id}`}
						className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent"
					>
						<span className="min-w-0 flex-1 truncate">{s.title}</span>
						<span className="shrink-0 font-ui text-[11px] uppercase tracking-wider text-muted-foreground">
							{s.origin?.mode ?? s.kind}
						</span>
						<span className="shrink-0 font-ui text-xs text-muted-foreground">{timeAgo(s.updatedAt)}</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
	return (
		<div className="mb-2 flex items-center gap-2">
			<h2 className="text-xs uppercase tracking-widest text-muted-foreground/80">{children}</h2>
			<div className="flex-1" />
			{action}
		</div>
	);
}

/** A centered modal card on the shared interaction-layer stack. */
export function HubDialog({ open, title, onClose, busy = false, children, testId }: {
	open: boolean;
	title: string;
	onClose: () => void;
	busy?: boolean;
	children: ReactNode;
	testId?: string;
}) {
	return (
		<HostDialog
			open={open}
			aria-label={title}
			onClose={() => {
				if (busy) return "blocked";
				onClose();
				return "closed";
			}}
			backdropProps={{ className: "fixed inset-0 z-50 flex items-center justify-center bg-background/80" }}
			frame={
				<div
					data-testid={testId}
					onClick={(e) => e.stopPropagation()}
					className="flex max-h-[calc(100dvh-4rem)] w-[34rem] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border bg-card p-5 shadow-xl"
				/>
			}
		>
			<h2 className="mb-4 text-sm font-semibold">{title}</h2>
			{children}
		</HostDialog>
	);
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
	return (
		<label className="mb-3 flex flex-col gap-1.5">
			<span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
			{children}
			{hint && <span className="text-xs text-muted-foreground/80">{hint}</span>}
		</label>
	);
}

export const SELECT_CLASS =
	"h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30";
