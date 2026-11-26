"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
	ArchiveIcon, ArrowLeftIcon, BookOpenIcon, ChevronDownIcon, ChevronRightIcon, DumbbellIcon, FolderPlusIcon, LinkIcon,
	MessageCircleQuestionIcon, PencilIcon, PlayIcon, PlusIcon, RouteIcon, SearchIcon, SparklesIcon, Trash2Icon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { milestoneSections, type HubAction, type HubLesson, type HubMilestone, type HubPlan, type HubTopic } from "@/src/core";
import { hubEdit, startHubSession, useHub, type HubData } from "./hub-data";
import { HubForms, type HubCreated, type HubDialogState } from "./hub-forms";
import {
	ConceptDot, ConceptDots, DotLegend, LessonStatusBadge, NOT_YET, ProgressBar, SectionHeading, SessionList, STATUS_LABEL,
} from "./hub-parts";
import { childTopics, lessonConcepts, lessonPrompt, topicLessons, topicPath, topicProgress, type LessonMode } from "./hub-tree";

export type HubNav =
	| { screen: "home" }
	| { screen: "topic"; id: string }
	| { screen: "plan"; id: string }
	| { screen: "milestone"; planId: string; id: string };

interface Ctx {
	data: HubData;
	navigate: (nav: HubNav) => void;
	open: (dialog: HubDialogState) => void;
}

/** The learning hub: home, topic and plan screens over one live snapshot. */
export function HubView({ nav, onNavigate }: { nav: HubNav; onNavigate: (nav: HubNav) => void }) {
	const { data, error } = useHub();
	const [dialog, setDialog] = useState<HubDialogState | null>(null);

	if (!data) {
		return (
			<div className="flex h-full items-center justify-center pb-40">
				<p className="font-ui text-sm text-muted-foreground" role={error ? "alert" : undefined}>
					{error ?? "Loading the learning hub…"}
				</p>
			</div>
		);
	}

	const ctx: Ctx = { data, navigate: onNavigate, open: setDialog };
	const onCreated = (c: HubCreated) => {
		if (c.kind === "topic") onNavigate({ screen: "topic", id: c.id });
		if (c.kind === "plan") onNavigate({ screen: "plan", id: c.id });
	};

	let body: ReactNode;
	if (nav.screen === "topic") {
		const topic = data.state.topics.find((t) => t.id === nav.id);
		body = topic ? <TopicScreen ctx={ctx} topic={topic} /> : <Missing what="topic" ctx={ctx} />;
	} else if (nav.screen === "plan") {
		const plan = data.state.plans.find((p) => p.id === nav.id);
		body = plan ? <PlanScreen ctx={ctx} plan={plan} /> : <Missing what="plan" ctx={ctx} />;
	} else if (nav.screen === "milestone") {
		const plan = data.state.plans.find((p) => p.id === nav.planId);
		const milestone = plan?.milestones.find((m) => m.id === nav.id);
		body = plan && milestone ? <MilestoneScreen ctx={ctx} plan={plan} milestone={milestone} /> : <Missing what="milestone" ctx={ctx} />;
	} else {
		body = <HomeScreen ctx={ctx} />;
	}

	return (
		<div className="h-full overflow-y-auto" data-testid="hub-view">
			<div className="mx-auto w-full max-w-3xl px-6 pb-56 pt-16">
				{error && <p role="alert" className="mb-4 text-sm text-error">{error}</p>}
				{body}
			</div>
			<HubForms dialog={dialog} data={data} onClose={() => setDialog(null)} onCreated={onCreated} onOpen={setDialog} />
		</div>
	);
}

function Missing({ what, ctx }: { what: string; ctx: Ctx }) {
	return (
		<div className="flex flex-col items-start gap-3">
			<p className="text-sm text-muted-foreground">This {what} no longer exists.</p>
			<Button variant="outline" size="sm" onClick={() => ctx.navigate({ screen: "home" })}><ArrowLeftIcon /> Back to the hub</Button>
		</div>
	);
}

function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
	return (
		<div className="mb-6">
			<h1 className="font-title text-3xl tracking-tight">{children}</h1>
			{sub && <p className="mt-1.5 text-base text-muted-foreground">{sub}</p>}
		</div>
	);
}

function Crumbs({ ctx, trail }: { ctx: Ctx; trail: { label: string; nav: HubNav }[] }) {
	return (
		<nav className="mb-3 flex flex-wrap items-center gap-1 font-ui text-xs text-muted-foreground" aria-label="Breadcrumb">
			<button type="button" className="hover:text-foreground" onClick={() => ctx.navigate({ screen: "home" })}>Hub</button>
			{trail.map((t) => (
				<span key={JSON.stringify(t.nav)} className="flex items-center gap-1">
					<ChevronRightIcon className="size-3" />
					<button type="button" className="hover:text-foreground" onClick={() => ctx.navigate(t.nav)}>{t.label}</button>
				</span>
			))}
		</nav>
	);
}

// ─── starting sessions ──────────────────────────────────────────────────────

function useStart() {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const start = (req: Parameters<typeof startHubSession>[0]) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		startHubSession(req)
			.then((id) => router.push(`/chat/${id}`))
			.catch((err: unknown) => {
				setBusy(false);
				setError(err instanceof Error ? err.message : "Could not start the session.");
			});
	};
	return { busy, error, start, openChat: (id: string) => router.push(`/chat/${id}`) };
}

function lessonStart(data: HubData, lesson: HubLesson, mode: LessonMode, planId?: string) {
	return {
		mode, lessonId: lesson.id, topicId: lesson.topicId, ...(planId ? { planId } : {}),
		title: mode === "practice" ? `Practice: ${lesson.title}` : mode === "explain" ? `Explain: ${lesson.title}` : lesson.title,
		prompt: lessonPrompt(data.state, lesson, mode),
	};
}

// ─── home ───────────────────────────────────────────────────────────────────

function HomeScreen({ ctx }: { ctx: Ctx }) {
	const { data } = ctx;
	const { state, mastery } = data;
	const starter = useStart();
	const activePlans = state.plans.filter((p) => !p.archived);
	const lessonById = new Map(state.lessons.map((l) => [l.id, l]));
	const topicById = new Map(state.topics.map((t) => [t.id, t]));

	const actions = (
		<div className="mb-8 flex flex-wrap gap-2">
			<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "topic", parentId: null })} data-testid="hub-new-topic"><FolderPlusIcon /> New topic</Button>
			<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "planner" })} data-testid="hub-new-plan"><RouteIcon /> New plan</Button>
			<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "adopt" })} disabled={state.topics.length === 0} title={state.topics.length ? undefined : "Create a topic first"} data-testid="hub-adopt"><LinkIcon /> Add a session</Button>
		</div>
	);

	if (state.topics.length === 0) {
		return (
			<div data-testid="hub-empty">
				<Title sub="Plans, topics and lessons live here, outside any one chat. Each lesson gets fresh sessions, and what you show in its checks builds up your mastery.">Learning hub</Title>
				<div className="mb-4 rounded-xl border border-border p-6" data-testid="hub-empty-plan">
					<h2 className="text-lg font-semibold">Plan what you want to learn</h2>
					<p className="mt-2 text-base text-muted-foreground">
						The planner asks about your goal, time and background, then builds a plan with you: milestones, the topics under each, and small lessons.
					</p>
					<Button className="mt-5" onClick={() => ctx.open({ kind: "planner" })} data-testid="hub-empty-plan-button">
						<RouteIcon /> Plan with the planner
					</Button>
				</div>
				<div className="rounded-xl border border-dashed border-border p-6">
					<h2 className="text-lg font-semibold">Or start with a topic</h2>
					<ol className="mt-3 flex list-decimal flex-col gap-1.5 pl-5 text-base text-muted-foreground">
						<li>Create a topic for something you want to learn.</li>
						<li>Add lessons to it, each with one goal and a few concepts.</li>
						<li>Group lessons into a plan when you want a path to follow.</li>
					</ol>
					<Button className="mt-5" onClick={() => ctx.open({ kind: "topic", parentId: null })} data-testid="hub-empty-create-topic">
						<FolderPlusIcon /> Create a topic
					</Button>
					<p className="mt-4 text-sm text-muted-foreground">Or ask anything in the box below to start a quick session.</p>
				</div>
			</div>
		);
	}

	const continueItems = activePlans.flatMap((p) => {
		const next = mastery.plans[p.id]?.nextLessonId;
		const lesson = next ? lessonById.get(next) : undefined;
		return lesson ? [{ plan: p, lesson }] : [];
	});
	const recent = continueItems.length === 0
		? state.lessons
			.filter((l) => mastery.lessons[l.id]?.status === "in-progress")
			.map((l) => ({ lesson: l, at: data.lessonSessions[l.id]?.[0]?.updatedAt ?? l.updatedAt }))
			.sort((a, b) => b.at.localeCompare(a.at))
			.slice(0, 3)
		: [];

	const review = state.concepts
		.map((c) => ({ concept: c, m: mastery.concepts[c.id] ?? NOT_YET }))
		.filter(({ m }) => m.reviewDue || m.status === "shaky" || m.status === "gap")
		.sort((a, b) => Number(b.m.reviewDue) - Number(a.m.reviewDue));

	return (
		<div data-testid="hub-home">
			<Title>Learning hub</Title>
			{actions}

			{(continueItems.length > 0 || recent.length > 0) && (
				<section className="mb-8" data-testid="hub-continue">
					<SectionHeading>Continue</SectionHeading>
					<div className="grid gap-3 sm:grid-cols-2">
						{continueItems.map(({ plan, lesson }) => (
							<ContinueCard key={plan.id} ctx={ctx} lesson={lesson} label={plan.title} planId={plan.id} starter={starter}
								progress={mastery.plans[plan.id]} onLabel={() => ctx.navigate({ screen: "plan", id: plan.id })} />
						))}
						{recent.map(({ lesson }) => (
							<ContinueCard key={lesson.id} ctx={ctx} lesson={lesson} label={topicById.get(lesson.topicId)?.title ?? ""} starter={starter}
								progress={mastery.lessons[lesson.id]} onLabel={() => ctx.navigate({ screen: "topic", id: lesson.topicId })} />
						))}
					</div>
					{starter.error && <p role="alert" className="mt-2 text-sm text-error">{starter.error}</p>}
				</section>
			)}

			{review.length > 0 && (
				<section className="mb-8" data-testid="hub-review">
					<SectionHeading>Review due</SectionHeading>
					<ul className="flex flex-col divide-y divide-border/50 rounded-xl border">
						{review.slice(0, 8).map(({ concept, m }) => {
							const lesson = state.lessons.find((l) => l.conceptIds.includes(concept.id));
							return (
								<li key={concept.id} className="flex items-center gap-3 px-3 py-2">
									<ConceptDot mastery={m} title={concept.title} />
									<span className="min-w-0 flex-1 truncate text-sm">{concept.title}</span>
									<span className="shrink-0 font-ui text-xs text-muted-foreground">{m.reviewDue ? "Review due" : STATUS_LABEL[m.status]}</span>
									<button type="button" className="shrink-0 truncate font-ui text-xs text-muted-foreground hover:text-foreground" onClick={() => ctx.navigate({ screen: "topic", id: concept.topicId })}>
										{topicById.get(concept.topicId)?.title}
									</button>
									{lesson && (
										<Button size="xs" variant="outline" disabled={starter.busy} onClick={() => starter.start({
											mode: "practice", lessonId: lesson.id, topicId: lesson.topicId,
											title: `Review: ${concept.title}`, prompt: `I want to practice "${concept.title}" from the lesson "${lesson.title}".`,
										})}>
											<DumbbellIcon /> Practice
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				</section>
			)}

			{activePlans.length > 0 && (
				<section className="mb-8" data-testid="hub-plans">
					<SectionHeading>Plans</SectionHeading>
					<ul className="flex flex-col gap-2">
						{activePlans.map((p) => (
							<li key={p.id}>
								<button type="button" onClick={() => ctx.navigate({ screen: "plan", id: p.id })}
									className="flex w-full flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-accent/50">
									<span className="flex items-center gap-2">
										<RouteIcon className="size-4 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate font-medium">{p.title}</span>
										<span className="shrink-0 font-ui text-xs text-muted-foreground">{p.milestones.length} {p.milestones.length === 1 ? "milestone" : "milestones"}</span>
									</span>
									<span className="truncate text-sm text-muted-foreground">{p.goal}</span>
									<ProgressBar solid={mastery.plans[p.id]?.solid ?? 0} total={mastery.plans[p.id]?.total ?? 0} />
								</button>
							</li>
						))}
					</ul>
				</section>
			)}

			<section className="mb-8" data-testid="hub-topics">
				<SectionHeading action={<DotLegend />}>Topics</SectionHeading>
				<TopicTree ctx={ctx} parentId={null} depth={0} />
			</section>
		</div>
	);
}

function ContinueCard({ ctx, lesson, label, planId, progress, onLabel, starter }: {
	ctx: Ctx; lesson: HubLesson; label: string; planId?: string; progress: { solid: number; total: number } | undefined;
	onLabel: () => void; starter: ReturnType<typeof useStart>;
}) {
	const latest = ctx.data.lessonSessions[lesson.id]?.[0];
	return (
		<div className="flex flex-col gap-2 rounded-xl border bg-card p-4" data-testid="hub-continue-card">
			<button type="button" onClick={onLabel} className="self-start truncate font-ui text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground">{label}</button>
			<span className="font-medium">{lesson.title}</span>
			<span className="line-clamp-2 text-sm text-muted-foreground">{lesson.goal}</span>
			<ConceptDots concepts={lessonConcepts(ctx.data.state, lesson)} mastery={ctx.data.mastery.concepts} />
			{progress && <ProgressBar solid={progress.solid} total={progress.total} />}
			<div className="mt-1 flex gap-2">
				<Button size="sm" disabled={starter.busy} data-testid="hub-continue-button"
					onClick={() => (latest ? starter.openChat(latest.id) : starter.start(lessonStart(ctx.data, lesson, "deep-dive", planId)))}>
					<PlayIcon /> {latest ? "Continue" : "Start"}
				</Button>
				{latest && (
					<Button size="sm" variant="outline" disabled={starter.busy} onClick={() => starter.start(lessonStart(ctx.data, lesson, "deep-dive", planId))}>
						New session
					</Button>
				)}
			</div>
		</div>
	);
}

function TopicTree({ ctx, parentId, depth }: { ctx: Ctx; parentId: string | null; depth: number }) {
	const topics = childTopics(ctx.data.state.topics, parentId);
	if (topics.length === 0) return null;
	return (
		<ul className={cn("flex flex-col", depth === 0 ? "gap-2" : "mt-1 gap-1 border-l border-border/60 pl-3")}>
			{topics.map((t) => {
				const p = topicProgress(ctx.data.state, ctx.data.mastery, t.id);
				return (
					<li key={t.id}>
						<button type="button" onClick={() => ctx.navigate({ screen: "topic", id: t.id })} data-testid="hub-topic-row"
							className={cn("flex w-full items-center gap-3 rounded-lg px-3 text-left transition-colors hover:bg-accent/50", depth === 0 ? "border py-2.5" : "py-1.5")}>
							<span className={cn("min-w-0 flex-1 truncate", depth === 0 && "font-medium")}>{t.title}</span>
							<span className="shrink-0 font-ui text-xs text-muted-foreground">{p.lessons} {p.lessons === 1 ? "lesson" : "lessons"}</span>
							{p.total > 0 && <ProgressBar solid={p.solid} total={p.total} className="w-40 shrink-0" />}
						</button>
						<TopicTree ctx={ctx} parentId={t.id} depth={depth + 1} />
					</li>
				);
			})}
		</ul>
	);
}

// ─── topic ──────────────────────────────────────────────────────────────────

function useEdit() {
	const [error, setError] = useState<string | null>(null);
	const run = (action: HubAction, then?: () => void) => {
		setError(null);
		hubEdit(action).then(() => then?.()).catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not save that change."));
	};
	return { error, run };
}

function ConfirmButton({ label, onConfirm, testId }: { label: string; onConfirm: () => void; testId?: string }) {
	const [armed, setArmed] = useState(false);
	return (
		<Button size="sm" variant={armed ? "destructive" : "ghost"} data-testid={testId}
			onClick={() => (armed ? onConfirm() : setArmed(true))} onBlur={() => setArmed(false)}>
			<Trash2Icon /> {armed ? `Confirm ${label.toLowerCase()}` : label}
		</Button>
	);
}

function TopicScreen({ ctx, topic }: { ctx: Ctx; topic: HubTopic }) {
	const { state } = ctx.data;
	const edit = useEdit();
	const path = topicPath(state.topics, topic.id);
	const subtopics = childTopics(state.topics, topic.id);
	const lessons = topicLessons(state, topic.id);
	const lessonIds = new Set(lessons.map((l) => l.id));
	const roots = lessons.filter((l) => l.parentLessonId === null || !lessonIds.has(l.parentLessonId));
	const loose = ctx.data.topicSessions[topic.id] ?? [];
	const progress = topicProgress(state, ctx.data.mastery, topic.id);

	return (
		<div data-testid="hub-topic">
			<Crumbs ctx={ctx} trail={path.slice(0, -1).map((t) => ({ label: t.title, nav: { screen: "topic", id: t.id } }))} />
			<Title sub={topic.summary}>{topic.title}</Title>
			{progress.total > 0 && <ProgressBar solid={progress.solid} total={progress.total} className="mb-4 max-w-sm" />}
			<div className="mb-8 flex flex-wrap gap-2">
				<Button size="sm" onClick={() => ctx.open({ kind: "lesson", topicId: topic.id })} data-testid="hub-new-lesson"><PlusIcon /> Lesson</Button>
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "ask", topicId: topic.id, about: topic.title })} data-testid="hub-topic-ask"><MessageCircleQuestionIcon /> Ask</Button>
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "topic", parentId: topic.id })} data-testid="hub-new-subtopic"><FolderPlusIcon /> Subtopic</Button>
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "adopt", topicId: topic.id })}><LinkIcon /> Add a session</Button>
				<Button size="sm" variant="ghost" onClick={() => ctx.open({ kind: "topic", parentId: topic.parentId, edit: topic })} data-testid="hub-edit-topic"><PencilIcon /> Edit</Button>
				<ConfirmButton label="Delete" onConfirm={() => edit.run({ type: "topic.delete", id: topic.id }, () => ctx.navigate(topic.parentId ? { screen: "topic", id: topic.parentId } : { screen: "home" }))} />
			</div>
			{edit.error && <p role="alert" className="-mt-5 mb-6 text-sm text-error">{edit.error}</p>}

			{subtopics.length > 0 && (
				<section className="mb-8">
					<SectionHeading>Subtopics</SectionHeading>
					<TopicTree ctx={ctx} parentId={topic.id} depth={0} />
				</section>
			)}

			<section className="mb-8">
				<SectionHeading action={<DotLegend />}>Lessons</SectionHeading>
				{roots.length === 0 ? (
					<div className="rounded-xl border border-dashed p-5 text-sm text-muted-foreground">
						No lessons yet. A lesson is one narrow goal with a few concepts, small enough for one or two sessions.
						<div className="mt-3"><Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "lesson", topicId: topic.id })}><PlusIcon /> Create a lesson</Button></div>
					</div>
				) : (
					<ul className="flex flex-col gap-2">
						{roots.map((l) => <LessonCard key={l.id} ctx={ctx} lesson={l} all={lessons} />)}
					</ul>
				)}
			</section>

			{loose.length > 0 && (
				<section className="mb-8">
					<SectionHeading>Other sessions in this topic</SectionHeading>
					<SessionList sessions={loose} empty="" />
				</section>
			)}
		</div>
	);
}

function LessonCard({ ctx, lesson, all, planId, highlight = false }: {
	ctx: Ctx; lesson: HubLesson; all?: readonly HubLesson[]; planId?: string; highlight?: boolean;
}) {
	const { data } = ctx;
	const [open, setOpen] = useState(highlight);
	const starter = useStart();
	const edit = useEdit();
	const concepts = lessonConcepts(data.state, lesson);
	const sessions = data.lessonSessions[lesson.id] ?? [];
	const progress = data.mastery.lessons[lesson.id];
	const children = (all ?? []).filter((l) => l.parentLessonId === lesson.id);
	const weak = concepts.filter((c) => {
		const s = data.mastery.concepts[c.id]?.status;
		return s === "shaky" || s === "gap";
	});

	return (
		<li data-testid="hub-lesson" data-lesson-id={lesson.id}>
			<div className={cn("rounded-xl border", highlight && "border-foreground/40")}>
				<button type="button" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="hub-lesson-toggle"
					className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
					{open ? <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />}
					<span className="min-w-0 flex-1 truncate font-medium">{lesson.title}</span>
					<ConceptDots concepts={concepts} mastery={data.mastery.concepts} />
					<LessonStatusBadge progress={progress} />
				</button>
				{open && (
					<div className="border-t border-border/60 px-4 pb-4 pt-3" data-testid="hub-lesson-detail">
						<p className="mb-3 text-base text-muted-foreground">{lesson.goal}</p>
						{concepts.length > 0 && (
							<ul className="mb-4 flex flex-col gap-1">
								{concepts.map((c) => {
									const m = data.mastery.concepts[c.id] ?? NOT_YET;
									return (
										<li key={c.id} className="group flex items-center gap-2.5 text-sm" data-testid="hub-concept-row">
											<ConceptDot mastery={m} />
											<span className="min-w-0 flex-1 truncate">{c.title}</span>
											<span className="shrink-0 font-ui text-xs text-muted-foreground">
												{m.reviewDue ? "Review due" : STATUS_LABEL[m.status]}
												{m.passes + m.fails > 0 && ` · ${m.passes}✓ ${m.fails}✗`}
											</span>
											<button type="button" className="shrink-0 font-ui text-xs text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
												onClick={() => ctx.open({ kind: "lesson", topicId: lesson.topicId, parentLessonId: lesson.id, seedConcepts: [c], seedTitle: `Deep dive: ${c.title}` })}>
												Go deeper
											</button>
										</li>
									);
								})}
							</ul>
						)}
						<div className="mb-4 flex flex-wrap gap-2">
							<Button size="sm" disabled={starter.busy || sessions.length === 0} onClick={() => sessions[0] && starter.openChat(sessions[0].id)} data-testid="hub-lesson-continue"
								title={sessions.length ? "Reopen the latest session" : "No session yet"}>
								<PlayIcon /> Continue
							</Button>
							<Button size="sm" variant="outline" disabled={starter.busy} onClick={() => starter.start(lessonStart(data, lesson, "explain", planId))} data-testid="hub-lesson-explain"
								title="A short lesson with checks at the end, no assessment first">
								<BookOpenIcon /> Explain
							</Button>
							<Button size="sm" variant="outline" disabled={starter.busy} onClick={() => starter.start(lessonStart(data, lesson, "deep-dive", planId))} data-testid="hub-lesson-new-session"
								title="Step-by-step lesson; assesses you first when your evidence is missing or stale">
								<SearchIcon /> Deep dive
							</Button>
							<Button size="sm" variant="outline" disabled={starter.busy} onClick={() => starter.start(lessonStart(data, lesson, "practice", planId))} data-testid="hub-lesson-practice">
								<DumbbellIcon /> Practice
							</Button>
							<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "ask", topicId: lesson.topicId, lessonId: lesson.id, about: lesson.title })} data-testid="hub-lesson-ask">
								<MessageCircleQuestionIcon /> Ask
							</Button>
							<Button size="sm" variant="outline" data-testid="hub-lesson-deeper"
								onClick={() => ctx.open({ kind: "lesson", topicId: lesson.topicId, parentLessonId: lesson.id, seedConcepts: weak, seedTitle: `Deep dive: ${lesson.title}` })}>
								<SparklesIcon /> Go deeper
							</Button>
						</div>
						{starter.error && <p role="alert" className="mb-3 text-sm text-error">{starter.error}</p>}
						<SectionHeading action={<Button size="xs" variant="ghost" onClick={() => ctx.open({ kind: "adopt", lessonId: lesson.id })} data-testid="hub-lesson-adopt"><LinkIcon /> Add a session</Button>}>
							Sessions
						</SectionHeading>
						<SessionList sessions={sessions} empty="No sessions yet. Start one above, or add an existing session." />
						<div className="mt-3 flex gap-1 border-t border-border/40 pt-3">
							<Button size="sm" variant="ghost" onClick={() => ctx.open({ kind: "lesson", topicId: lesson.topicId, edit: lesson })} data-testid="hub-edit-lesson"><PencilIcon /> Edit</Button>
							{!planId && <ConfirmButton label="Delete" onConfirm={() => edit.run({ type: "lesson.delete", id: lesson.id })} />}
						</div>
						{edit.error && <p role="alert" className="mt-2 text-sm text-error">{edit.error}</p>}
					</div>
				)}
			</div>
			{children.length > 0 && (
				<ul className="ml-5 mt-2 flex flex-col gap-2 border-l border-border/60 pl-3">
					{children.map((c) => <LessonCard key={c.id} ctx={ctx} lesson={c} all={all} planId={planId} />)}
				</ul>
			)}
		</li>
	);
}

// ─── plan ───────────────────────────────────────────────────────────────────

function NextLessonButton({ ctx, lessonId, planId, starter }: {
	ctx: Ctx; lessonId: string | null | undefined; planId: string; starter: ReturnType<typeof useStart>;
}) {
	const lesson = lessonId ? ctx.data.state.lessons.find((l) => l.id === lessonId) : undefined;
	if (!lesson) return null;
	const latest = ctx.data.lessonSessions[lesson.id]?.[0];
	return (
		<Button size="sm" disabled={starter.busy} data-testid="hub-next-lesson"
			onClick={() => (latest ? starter.openChat(latest.id) : starter.start(lessonStart(ctx.data, lesson, "deep-dive", planId)))}>
			<PlayIcon /> {latest ? "Continue" : "Start"}: {lesson.title}
		</Button>
	);
}

function TopicChips({ ctx, topicIds }: { ctx: Ctx; topicIds: readonly string[] }) {
	const topicById = new Map(ctx.data.state.topics.map((t) => [t.id, t]));
	const topics = topicIds.flatMap((id) => topicById.get(id) ?? []);
	if (topics.length === 0) return null;
	return (
		<span className="flex flex-wrap gap-1.5">
			{topics.map((t) => (
				<span key={t.id} className="rounded-md border border-border/70 px-1.5 py-0.5 font-ui text-xs text-muted-foreground">{t.title}</span>
			))}
		</span>
	);
}

function PlanScreen({ ctx, plan }: { ctx: Ctx; plan: HubPlan }) {
	const { data } = ctx;
	const edit = useEdit();
	const starter = useStart();
	const lessonById = new Map(data.state.lessons.map((l) => [l.id, l]));
	const progress = data.mastery.plans[plan.id];
	const planning = (data.planSessions[plan.id] ?? []).filter((s) => s.origin?.milestoneId === undefined);

	return (
		<div data-testid="hub-plan">
			<Crumbs ctx={ctx} trail={[]} />
			<Title sub={plan.goal}>{plan.title}</Title>
			{progress && <ProgressBar solid={progress.solid} total={progress.total} className="mb-4 max-w-sm" />}
			<div className="mb-8 flex flex-wrap gap-2">
				<NextLessonButton ctx={ctx} lessonId={progress?.nextLessonId} planId={plan.id} starter={starter} />
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "planner", planId: plan.id, about: plan.title })} data-testid="hub-revise-plan">
					<SparklesIcon /> Revise with planner
				</Button>
				<Button size="sm" variant="ghost" onClick={() => ctx.open({ kind: "plan", edit: plan })} data-testid="hub-edit-plan"><PencilIcon /> Edit</Button>
				<Button size="sm" variant="ghost" onClick={() => edit.run({ type: "plan.update", id: plan.id, archived: !plan.archived })}>
					<ArchiveIcon /> {plan.archived ? "Unarchive" : "Archive"}
				</Button>
				<ConfirmButton label="Delete" onConfirm={() => edit.run({ type: "plan.delete", id: plan.id }, () => ctx.navigate({ screen: "home" }))} />
			</div>
			{starter.error && <p role="alert" className="-mt-5 mb-6 text-sm text-error">{starter.error}</p>}
			{edit.error && <p role="alert" className="-mt-5 mb-6 text-sm text-error">{edit.error}</p>}

			{plan.milestones.length === 0 ? (
				<p className="text-sm text-muted-foreground">No milestones yet. Revise the plan with the planner, or edit it to add some.</p>
			) : (
				<ol className="flex flex-col" data-testid="hub-milestones">
					{plan.milestones.map((m, i) => {
						const mp = progress?.milestones[m.id];
						const next = mp?.nextLessonId ? lessonById.get(mp.nextLessonId) : undefined;
						const last = i === plan.milestones.length - 1;
						return (
							<li key={m.id} className="relative flex gap-4 pb-6">
								{!last && <span className="absolute left-[11px] top-7 h-[calc(100%-1.75rem)] w-px bg-border" aria-hidden="true" />}
								<span className={cn(
									"relative z-10 mt-3 flex size-6 shrink-0 items-center justify-center rounded-full border font-ui text-xs",
									mp?.complete ? "border-success bg-success text-background" : "border-border bg-background text-muted-foreground",
								)}>{i + 1}</span>
								<button type="button" data-testid="hub-milestone-card" onClick={() => ctx.navigate({ screen: "milestone", planId: plan.id, id: m.id })}
									className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-accent/50">
									<span className="flex items-center gap-2">
										<span className="min-w-0 flex-1 truncate font-medium">{m.title}</span>
										<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
									</span>
									{m.goal && <span className="text-sm text-muted-foreground">{m.goal}</span>}
									<TopicChips ctx={ctx} topicIds={m.topicIds} />
									{mp && mp.total > 0 && <ProgressBar solid={mp.solid} total={mp.total} />}
									{next && !mp?.complete && <span className="truncate font-ui text-xs text-muted-foreground">Next: {next.title}</span>}
								</button>
							</li>
						);
					})}
				</ol>
			)}

			{planning.length > 0 && (
				<section className="mb-8 mt-2">
					<SectionHeading>Planning sessions</SectionHeading>
					<SessionList sessions={planning} empty="" />
				</section>
			)}
		</div>
	);
}

// ─── milestone ──────────────────────────────────────────────────────────────

function MilestoneScreen({ ctx, plan, milestone }: { ctx: Ctx; plan: HubPlan; milestone: HubMilestone }) {
	const { data } = ctx;
	const { state } = data;
	const starter = useStart();
	const progress = data.mastery.plans[plan.id]?.milestones[milestone.id];
	const next = progress?.nextLessonId ?? null;
	const topicById = new Map(state.topics.map((t) => [t.id, t]));
	const topics = milestone.topicIds.flatMap((id) => topicById.get(id) ?? []);
	const lessonById = new Map(state.lessons.map((l) => [l.id, l]));
	const sections = milestoneSections(state, milestone);
	const lessonsOf = (ids: readonly string[]) => ids.flatMap((id) => lessonById.get(id) ?? []);
	const picked = lessonsOf(sections.find((sec) => sec.topicId === null)?.lessonIds ?? []);
	const sessions = (data.planSessions[plan.id] ?? []).filter((s) => s.origin?.milestoneId === milestone.id);
	const index = plan.milestones.findIndex((m) => m.id === milestone.id);

	return (
		<div data-testid="hub-milestone-screen">
			<Crumbs ctx={ctx} trail={[{ label: plan.title, nav: { screen: "plan", id: plan.id } }]} />
			<p className="mb-1 font-ui text-xs uppercase tracking-wider text-muted-foreground">Milestone {index + 1} of {plan.milestones.length}</p>
			<Title sub={milestone.goal}>{milestone.title}</Title>
			{progress && progress.total > 0 && <ProgressBar solid={progress.solid} total={progress.total} className="mb-4 max-w-sm" />}
			<div className="mb-8 flex flex-wrap gap-2">
				<NextLessonButton ctx={ctx} lessonId={next} planId={plan.id} starter={starter} />
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "ask", planId: plan.id, milestoneId: milestone.id, about: milestone.title })} data-testid="hub-milestone-ask">
					<MessageCircleQuestionIcon /> Ask
				</Button>
				<Button size="sm" variant="outline" onClick={() => ctx.open({ kind: "planner", planId: plan.id, milestoneId: milestone.id, about: milestone.title })} data-testid="hub-milestone-plan">
					<SparklesIcon /> Plan this milestone
				</Button>
				<Button size="sm" variant="ghost" onClick={() => ctx.open({ kind: "plan", edit: plan })}><PencilIcon /> Edit plan</Button>
			</div>
			{starter.error && <p role="alert" className="-mt-5 mb-6 text-sm text-error">{starter.error}</p>}

			{topics.length === 0 && picked.length === 0 && (
				<p className="mb-8 text-sm text-muted-foreground">No topics in this milestone yet. Plan it with the planner, or edit the plan to add topics.</p>
			)}

			{topics.map((topic) => {
				const lessons = lessonsOf(sections.find((sec) => sec.topicId === topic.id)?.lessonIds ?? []);
				const lessonIds = new Set(lessons.map((l) => l.id));
				const roots = lessons.filter((l) => l.parentLessonId === null || !lessonIds.has(l.parentLessonId));
				const sectionConcepts = [...new Set(lessons.flatMap((l) => l.conceptIds))];
				const tp = {
					solid: sectionConcepts.filter((id) => data.mastery.concepts[id]?.status === "solid").length,
					total: sectionConcepts.length,
				};
				return (
					<section key={topic.id} className="mb-8" data-testid="hub-milestone-topic">
						<SectionHeading action={tp.total > 0 ? <ProgressBar solid={tp.solid} total={tp.total} className="w-40" /> : undefined}>
							<button type="button" className="hover:text-foreground" onClick={() => ctx.navigate({ screen: "topic", id: topic.id })}>{topic.title}</button>
						</SectionHeading>
						{roots.length === 0 ? (
							<div className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
								No lessons in this topic yet.
								<Button size="xs" variant="outline" className="ml-2" onClick={() => ctx.open({ kind: "lesson", topicId: topic.id })}><PlusIcon /> Lesson</Button>
							</div>
						) : (
							<ul className="flex flex-col gap-2">
								{roots.map((l) => <LessonCard key={l.id} ctx={ctx} lesson={l} all={lessons} planId={plan.id} highlight={l.id === next} />)}
							</ul>
						)}
					</section>
				);
			})}

			{picked.length > 0 && (
				<section className="mb-8">
					<SectionHeading>{topics.length > 0 ? "Other lessons" : "Lessons"}</SectionHeading>
					<ul className="flex flex-col gap-2">
						{picked.map((l) => <LessonCard key={l.id} ctx={ctx} lesson={l} planId={plan.id} highlight={l.id === next} />)}
					</ul>
				</section>
			)}

			<section className="mb-8">
				<SectionHeading>Milestone sessions</SectionHeading>
				<SessionList sessions={sessions} empty="No sessions about this milestone yet. Lesson sessions show on their lesson." />
			</section>
		</div>
	);
}
