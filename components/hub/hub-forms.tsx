"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useRouter } from "next/navigation";
import { adoptChat, hubEdit, startHubSession, unlinkedChats, type HubData } from "./hub-data";
import { Field, HubDialog, SELECT_CLASS } from "./hub-parts";
import { topicOptions } from "./hub-tree";
import type { ChatSummary, HubConcept, HubLesson, HubPlan, HubTopic } from "@/src/core";

export type HubDialogState =
	| { kind: "topic"; parentId: string | null; edit?: HubTopic }
	| { kind: "lesson"; topicId: string; edit?: HubLesson; parentLessonId?: string; seedConcepts?: HubConcept[]; seedTitle?: string }
	| { kind: "plan"; edit?: HubPlan }
	| { kind: "planner"; planId?: string; milestoneId?: string; about?: string }
	| { kind: "adopt"; lessonId?: string; topicId?: string }
	| { kind: "ask"; topicId?: string; lessonId?: string; planId?: string; milestoneId?: string; about: string };

export type HubCreated = { kind: "topic" | "lesson" | "plan"; id: string };

function useSubmit(onDone: () => void) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const run = (work: () => Promise<void>) => (e: FormEvent) => {
		e.preventDefault();
		if (busy) return;
		setBusy(true);
		setError(null);
		work()
			.then(() => {
				setBusy(false);
				onDone();
			})
			.catch((err: unknown) => {
				setBusy(false);
				setError(err instanceof Error ? err.message : "Something went wrong.");
			});
	};
	return { busy, error, run };
}

function Footer({ busy, error, submit, onCancel, extra }: { busy: boolean; error: string | null; submit: string; onCancel: () => void; extra?: ReactNode }) {
	return (
		<>
			{error && <p role="alert" data-testid="hub-form-error" className="mb-3 text-sm text-error">{error}</p>}
			<div className="mt-2 flex items-center gap-2">
				{extra}
				<div className="flex-1" />
				<Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>Cancel</Button>
				<Button type="submit" size="sm" disabled={busy} data-testid="hub-form-submit">{submit}</Button>
			</div>
		</>
	);
}

function TopicForm({ data, parentId, edit, onClose, onCreated }: {
	data: HubData; parentId: string | null; edit?: HubTopic; onClose: () => void; onCreated: (c: HubCreated) => void;
}) {
	const [title, setTitle] = useState(edit?.title ?? "");
	const [summary, setSummary] = useState(edit?.summary ?? "");
	const [parent, setParent] = useState<string>(edit ? edit.parentId ?? "" : parentId ?? "");
	const { busy, error, run } = useSubmit(onClose);
	const options = topicOptions(data.state.topics, edit?.id);
	return (
		<HubDialog open title={edit ? "Edit topic" : parent ? "New subtopic" : "New topic"} onClose={onClose} busy={busy} testId="hub-topic-form">
			<form onSubmit={run(async () => {
				const parentValue = parent || null;
				if (edit) {
					await hubEdit({ type: "topic.update", id: edit.id, title, summary, parentId: parentValue });
					return;
				}
				const id = await hubEdit({ type: "topic.create", title, parentId: parentValue, ...(summary.trim() ? { summary } : {}) });
				if (id) onCreated({ kind: "topic", id });
			})}>
				<Field label="Title">
					<Input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Distributed systems" data-testid="hub-topic-title" />
				</Field>
				<Field label="Summary">
					<Textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What this topic covers (optional)" />
				</Field>
				<Field label="Inside">
					<select className={SELECT_CLASS} value={parent} onChange={(e) => setParent(e.target.value)} data-testid="hub-topic-parent">
						<option value="">Top level</option>
						{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
					</select>
				</Field>
				<Footer busy={busy} error={error} submit={edit ? "Save" : "Create topic"} onCancel={onClose} />
			</form>
		</HubDialog>
	);
}

interface ConceptRow { key: string; title: string; existingId?: string }

function LessonForm({ data, topicId, edit, parentLessonId, seedConcepts, seedTitle, onClose, onCreated }: {
	data: HubData; topicId: string; edit?: HubLesson; parentLessonId?: string; seedConcepts?: HubConcept[]; seedTitle?: string;
	onClose: () => void; onCreated: (c: HubCreated) => void;
}) {
	const conceptById = new Map(data.state.concepts.map((c) => [c.id, c]));
	const initialConcepts: ConceptRow[] = edit
		? edit.conceptIds.flatMap((id) => {
			const c = conceptById.get(id);
			return c ? [{ key: c.id, title: c.title, existingId: c.id }] : [];
		})
		: (seedConcepts ?? []).map((c) => ({ key: c.id, title: c.title }));
	const [topic, setTopic] = useState(edit?.topicId ?? topicId);
	const [title, setTitle] = useState(edit?.title ?? seedTitle ?? "");
	const [goal, setGoal] = useState(edit?.goal ?? "");
	const [concepts, setConcepts] = useState<ConceptRow[]>(initialConcepts);
	const [draft, setDraft] = useState("");
	const [prereqs, setPrereqs] = useState<string[]>(edit?.prereqLessonIds ?? []);
	const { busy, error, run } = useSubmit(onClose);
	const options = topicOptions(data.state.topics);
	const otherLessons = data.state.lessons.filter((l) => l.id !== edit?.id);

	const addDraft = () => {
		const t = draft.trim();
		if (!t || concepts.some((c) => c.title.toLowerCase() === t.toLowerCase())) return;
		setConcepts([...concepts, { key: `new_${Date.now()}_${concepts.length}`, title: t }]);
		setDraft("");
	};

	return (
		<HubDialog open title={edit ? "Edit lesson" : parentLessonId ? "New deep dive" : "New lesson"} onClose={onClose} busy={busy} testId="hub-lesson-form">
			<form onSubmit={run(async () => {
				const pending = draft.trim();
				const all = pending && !concepts.some((c) => c.title.toLowerCase() === pending.toLowerCase())
					? [...concepts, { key: "pending", title: pending }]
					: concepts;
				if (edit) {
					const kept = new Set(all.flatMap((c) => (c.existingId ? [c.existingId] : [])));
					const removeConceptIds = edit.conceptIds.filter((id) => !kept.has(id));
					const addConcepts = all.filter((c) => !c.existingId).map((c) => ({ title: c.title }));
					await hubEdit({
						type: "lesson.update", id: edit.id, title, goal, topicId: topic, prereqLessonIds: prereqs,
						...(addConcepts.length ? { addConcepts } : {}), ...(removeConceptIds.length ? { removeConceptIds } : {}),
					});
					return;
				}
				const seeded = new Map((seedConcepts ?? []).map((c) => [c.id, c]));
				const id = await hubEdit({
					type: "lesson.create", topicId: topic, title, goal, prereqLessonIds: prereqs, parentLessonId: parentLessonId ?? null,
					concepts: all.map((c) => {
						const seed = seeded.get(c.key);
						return seed && seed.topicId === topic ? { title: seed.title, slug: seed.slug } : { title: c.title };
					}),
				});
				if (id) onCreated({ kind: "lesson", id });
			})}>
				<Field label="Title">
					<Input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Leader election" data-testid="hub-lesson-title" />
				</Field>
				<Field label="Goal" hint="One narrow goal: what you should be able to do after this lesson.">
					<Textarea value={goal} onChange={(e) => setGoal(e.target.value)} required placeholder="Explain how Raft elects a leader and why terms matter" data-testid="hub-lesson-goal" />
				</Field>
				<Field label="Topic">
					<select className={SELECT_CLASS} value={topic} onChange={(e) => setTopic(e.target.value)}>
						{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
					</select>
				</Field>
				<div className="mb-3 flex flex-col gap-1.5">
					<span className="text-xs uppercase tracking-wider text-muted-foreground">Concepts</span>
					{concepts.length > 0 && (
						<ul className="flex flex-wrap gap-1.5" data-testid="hub-lesson-concepts">
							{concepts.map((c) => (
								<li key={c.key} className="flex items-center gap-1 rounded-md border border-border bg-background py-0.5 pl-2 pr-0.5 text-sm">
									{c.title}
									<button
										type="button"
										aria-label={`Remove ${c.title}`}
										onClick={() => setConcepts(concepts.filter((x) => x.key !== c.key))}
										className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
									>
										<XIcon className="size-3" />
									</button>
								</li>
							))}
						</ul>
					)}
					<div className="flex gap-1.5">
						<Input
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									addDraft();
								}
							}}
							placeholder="Add a concept and press Enter"
							data-testid="hub-concept-input"
						/>
						<Button type="button" variant="outline" size="sm" className="h-9" onClick={addDraft} aria-label="Add concept">
							<PlusIcon />
						</Button>
					</div>
					<span className="text-xs text-muted-foreground/80">Concepts are what mastery is tracked on. Checks in linked sessions update them.</span>
				</div>
				{otherLessons.length > 0 && (
					<Field label="Prerequisites">
						<div className="flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-border/60 p-2">
							{otherLessons.map((l) => (
								<span key={l.id} className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										className="size-4 accent-primary"
										checked={prereqs.includes(l.id)}
										onChange={(e) => setPrereqs(e.target.checked ? [...prereqs, l.id] : prereqs.filter((id) => id !== l.id))}
										aria-label={`Prerequisite: ${l.title}`}
									/>
									{l.title}
								</span>
							))}
						</div>
					</Field>
				)}
				<Footer busy={busy} error={error} submit={edit ? "Save" : "Create lesson"} onCancel={onClose} />
			</form>
		</HubDialog>
	);
}

interface MilestoneRow { key: string; id?: string; title: string; goal: string; topicIds: string[]; lessonIds: string[] }

function move<T>(list: readonly T[], from: number, to: number): T[] {
	if (to < 0 || to >= list.length) return [...list];
	const next = [...list];
	const [item] = next.splice(from, 1);
	if (item !== undefined) next.splice(to, 0, item);
	return next;
}

function PlanForm({ data, edit, onClose, onCreated }: { data: HubData; edit?: HubPlan; onClose: () => void; onCreated: (c: HubCreated) => void }) {
	const [title, setTitle] = useState(edit?.title ?? "");
	const [goal, setGoal] = useState(edit?.goal ?? "");
	const [milestones, setMilestones] = useState<MilestoneRow[]>(
		edit?.milestones.map((m) => ({ key: m.id, id: m.id, title: m.title, goal: m.goal ?? "", topicIds: m.topicIds, lessonIds: m.lessonIds }))
			?? [{ key: "m0", title: "", goal: "", topicIds: [], lessonIds: [] }],
	);
	const { busy, error, run } = useSubmit(onClose);
	const lessonById = new Map(data.state.lessons.map((l) => [l.id, l]));
	const topicById = new Map(data.state.topics.map((t) => [t.id, t]));
	const used = new Set(milestones.flatMap((m) => m.lessonIds));
	const topicLabels = topicOptions(data.state.topics);

	const update = (key: string, change: (m: MilestoneRow) => MilestoneRow) =>
		setMilestones(milestones.map((m) => (m.key === key ? change(m) : m)));

	return (
		<HubDialog open title={edit ? "Edit plan" : "New plan"} onClose={onClose} busy={busy} testId="hub-plan-form">
			<form onSubmit={run(async () => {
				const drafts = milestones
					.filter((m) => m.title.trim() || m.lessonIds.length > 0 || m.topicIds.length > 0)
					.map((m, i) => ({
						title: m.title.trim() || `Milestone ${i + 1}`, topicIds: m.topicIds, lessonIds: m.lessonIds,
						...(m.goal.trim() ? { goal: m.goal.trim() } : {}), ...(m.id ? { id: m.id } : {}),
					}));
				if (edit) {
					await hubEdit({ type: "plan.update", id: edit.id, title, goal, milestones: drafts });
					return;
				}
				const id = await hubEdit({ type: "plan.create", title, goal, milestones: drafts });
				if (id) onCreated({ kind: "plan", id });
			})}>
				<Field label="Title">
					<Input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder="e.g. Pass a system design interview" data-testid="hub-plan-title" />
				</Field>
				<Field label="Goal">
					<Textarea value={goal} onChange={(e) => setGoal(e.target.value)} required placeholder="What finishing this plan gets you" data-testid="hub-plan-goal" />
				</Field>
				<div className="mb-3 flex flex-col gap-2">
					<span className="text-xs uppercase tracking-wider text-muted-foreground">Milestones</span>
					{milestones.map((m, mi) => (
						<div key={m.key} className="rounded-lg border border-border/60 p-2.5" data-testid="hub-milestone">
							<div className="flex items-center gap-1.5">
								<span className="w-5 shrink-0 font-ui text-xs text-muted-foreground">{mi + 1}.</span>
								<Input value={m.title} onChange={(e) => update(m.key, (x) => ({ ...x, title: e.target.value }))} placeholder="Milestone title" className="h-8" data-testid="hub-milestone-title" />
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move milestone up" onClick={() => setMilestones(move(milestones, mi, mi - 1))} disabled={mi === 0}><ArrowUpIcon /></Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Move milestone down" onClick={() => setMilestones(move(milestones, mi, mi + 1))} disabled={mi === milestones.length - 1}><ArrowDownIcon /></Button>
								<Button type="button" variant="ghost" size="icon-sm" aria-label="Remove milestone" onClick={() => setMilestones(milestones.filter((x) => x.key !== m.key))}><XIcon /></Button>
							</div>
							<Input value={m.goal} onChange={(e) => update(m.key, (x) => ({ ...x, goal: e.target.value }))} placeholder="What you can do once this milestone is done (optional)" className="mt-2 h-8" data-testid="hub-milestone-goal" />
							{m.topicIds.length > 0 && (
								<ul className="mt-2 flex flex-wrap gap-1.5 pl-6" data-testid="hub-milestone-topics">
									{m.topicIds.map((id) => (
										<li key={id} className="flex items-center gap-1 rounded-md border border-border bg-background py-0.5 pl-2 pr-0.5 text-sm">
											{topicById.get(id)?.title ?? "Missing topic"}
											<button type="button" aria-label="Remove topic" onClick={() => update(m.key, (x) => ({ ...x, topicIds: x.topicIds.filter((t) => t !== id) }))}
												className="rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
												<XIcon className="size-3" />
											</button>
										</li>
									))}
								</ul>
							)}
							<select
								className={`${SELECT_CLASS} mt-2 h-8 text-muted-foreground`}
								value=""
								data-testid="hub-milestone-add-topic"
								onChange={(e) => {
									const id = e.target.value;
									if (id) update(m.key, (x) => ({ ...x, topicIds: [...x.topicIds, id] }));
								}}
							>
								<option value="">{topicLabels.length ? "Add a topic (all its lessons)…" : "Create a topic first"}</option>
								{topicLabels.filter((o) => !m.topicIds.includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
							</select>
							{m.lessonIds.length > 0 && (
								<ol className="mt-2 flex flex-col gap-0.5 pl-6">
									{m.lessonIds.map((id, li) => (
										<li key={id} className="flex items-center gap-1 text-sm">
											<span className="min-w-0 flex-1 truncate">{lessonById.get(id)?.title ?? "Missing lesson"}</span>
											<Button type="button" variant="ghost" size="icon-xs" aria-label="Move lesson up" onClick={() => update(m.key, (x) => ({ ...x, lessonIds: move(x.lessonIds, li, li - 1) }))} disabled={li === 0}><ArrowUpIcon /></Button>
											<Button type="button" variant="ghost" size="icon-xs" aria-label="Move lesson down" onClick={() => update(m.key, (x) => ({ ...x, lessonIds: move(x.lessonIds, li, li + 1) }))} disabled={li === m.lessonIds.length - 1}><ArrowDownIcon /></Button>
											<Button type="button" variant="ghost" size="icon-xs" aria-label="Remove lesson" onClick={() => update(m.key, (x) => ({ ...x, lessonIds: x.lessonIds.filter((l) => l !== id) }))}><XIcon /></Button>
										</li>
									))}
								</ol>
							)}
							<select
								className={`${SELECT_CLASS} mt-2 h-8 text-muted-foreground`}
								value=""
								data-testid="hub-milestone-add-lesson"
								onChange={(e) => {
									const id = e.target.value;
									if (id) update(m.key, (x) => ({ ...x, lessonIds: [...x.lessonIds, id] }));
								}}
							>
								<option value="">{data.state.lessons.length ? "Add a single lesson…" : "Create lessons in a topic first"}</option>
								{data.state.lessons.filter((l) => !used.has(l.id)).map((l) => (
									<option key={l.id} value={l.id}>{l.title} ({topicById.get(l.topicId)?.title ?? "?"})</option>
								))}
							</select>
						</div>
					))}
					<Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setMilestones([...milestones, { key: `m${Date.now()}`, title: "", goal: "", topicIds: [], lessonIds: [] }])}>
						<PlusIcon /> Milestone
					</Button>
				</div>
				<Footer busy={busy} error={error} submit={edit ? "Save" : "Create plan"} onCancel={onClose} />
			</form>
		</HubDialog>
	);
}

function AdoptForm({ data, lessonId, topicId, onClose }: { data: HubData; lessonId?: string; topicId?: string; onClose: () => void }) {
	const [chats, setChats] = useState<ChatSummary[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [chatId, setChatId] = useState("");
	const [target, setTarget] = useState(lessonId ? `lesson:${lessonId}` : topicId ? `topic:${topicId}` : "");
	const { busy, error, run } = useSubmit(onClose);
	useEffect(() => {
		unlinkedChats()
			.then(setChats)
			.catch((err: unknown) => setLoadError(err instanceof Error ? err.message : "Could not list sessions."));
	}, []);
	const options = topicOptions(data.state.topics);
	return (
		<HubDialog open title="Add an existing session" onClose={onClose} busy={busy} testId="hub-adopt-form">
			<form onSubmit={run(async () => {
				if (!chatId) throw new Error("Pick a session.");
				const [kind, id] = target.split(":");
				if (!id) throw new Error("Pick where the session goes.");
				await adoptChat(kind === "lesson" ? { chatId, lessonId: id } : { chatId, topicId: id });
			})}>
				<Field label="Session">
					{loadError ? <p className="text-sm text-error">{loadError}</p> : (
						<select className={SELECT_CLASS} value={chatId} onChange={(e) => setChatId(e.target.value)} required data-testid="hub-adopt-chat">
							<option value="">{chats === null ? "Loading…" : chats.length ? "Pick a session…" : "No unlinked sessions"}</option>
							{(chats ?? []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
						</select>
					)}
				</Field>
				<Field label="Add to" hint="Joining a lesson links the session to it. A new lesson takes the session's title and one concept per node of its plan map, so its past checks count.">
					<select className={SELECT_CLASS} value={target} onChange={(e) => setTarget(e.target.value)} required data-testid="hub-adopt-target">
						<option value="">Pick a lesson or topic…</option>
						{data.state.lessons.length > 0 && (
							<optgroup label="Join a lesson">
								{data.state.lessons.map((l) => <option key={l.id} value={`lesson:${l.id}`}>{l.title}</option>)}
							</optgroup>
						)}
						<optgroup label="New lesson in topic">
							{options.map((o) => <option key={o.id} value={`topic:${o.id}`}>{o.label}</option>)}
						</optgroup>
					</select>
				</Field>
				<Footer busy={busy} error={error} submit="Add session" onCancel={onClose} />
			</form>
		</HubDialog>
	);
}

function AskForm({ topicId, lessonId, planId, milestoneId, about, onClose }: {
	topicId?: string; lessonId?: string; planId?: string; milestoneId?: string; about: string; onClose: () => void;
}) {
	const router = useRouter();
	const [question, setQuestion] = useState("");
	const { busy, error, run } = useSubmit(() => {});
	return (
		<HubDialog open title={`Ask about ${about}`} onClose={onClose} busy={busy} testId="hub-ask-form">
			<form onSubmit={run(async () => {
				const id = await startHubSession({
					mode: "ask", ...(topicId ? { topicId } : {}), ...(lessonId ? { lessonId } : {}),
					...(planId ? { planId } : {}), ...(milestoneId ? { milestoneId } : {}), title: question, prompt: question,
				});
				router.push(`/chat/${id}`);
			})}>
				<Field label="Question">
					<Textarea value={question} onChange={(e) => setQuestion(e.target.value)} required autoFocus
						placeholder="e.g. When would I pick write-through over cache-aside?" data-testid="hub-ask-question" />
				</Field>
				<p className="mb-3 text-sm text-muted-foreground">You get a direct answer with no assessment. Ask for a lesson from there if you want to go further.</p>
				<Footer busy={busy} error={error} submit="Ask" onCancel={onClose} />
			</form>
		</HubDialog>
	);
}

function PlannerForm({ planId, milestoneId, about, onClose, onManual }: {
	planId?: string; milestoneId?: string; about?: string; onClose: () => void; onManual: () => void;
}) {
	const router = useRouter();
	const [text, setText] = useState("");
	const { busy, error, run } = useSubmit(() => {});
	const revising = planId !== undefined;
	const title = !revising ? "Plan something new" : milestoneId ? `Plan the milestone ${about ?? ""}`.trim() : `Revise ${about ?? "this plan"}`;
	return (
		<HubDialog open title={title} onClose={onClose} busy={busy} testId="hub-planner-form">
			<form onSubmit={run(async () => {
				const fallback = milestoneId ? "Help me flesh out this milestone." : "Help me revise this plan.";
				const prompt = text.trim() || (revising ? fallback : "");
				if (!prompt) throw new Error("Say in a sentence what you want to learn.");
				const id = await startHubSession({
					mode: "plan", ...(planId ? { planId } : {}), ...(milestoneId ? { milestoneId } : {}),
					title: prompt, prompt,
				});
				router.push(`/chat/${id}`);
			})}>
				<Field label={revising ? "What should change?" : "What do you want to learn?"}>
					<Textarea value={text} onChange={(e) => setText(e.target.value)} required={!revising} autoFocus data-testid="hub-planner-goal"
						placeholder={revising ? "e.g. I have less time now; cut it to six weeks" : "e.g. Get comfortable enough with Rust to build a CLI tool"} />
				</Field>
				<p className="mb-3 text-sm text-muted-foreground">
					{revising
						? "The planner reads the plan as it is now and changes it with you."
						: "The planner asks a few questions about your goal, time and background, proposes milestones and lessons, and saves the plan once you agree."}
				</p>
				<Footer busy={busy} error={error} submit={revising ? "Open the planner" : "Start planning"} onCancel={onClose}
					extra={!revising && <Button type="button" variant="link" size="sm" className="px-0" onClick={onManual} data-testid="hub-plan-manual">Build by hand</Button>} />
			</form>
		</HubDialog>
	);
}

export function HubForms({ dialog, data, onClose, onCreated, onOpen }: {
	dialog: HubDialogState | null; data: HubData; onClose: () => void; onCreated: (c: HubCreated) => void; onOpen: (dialog: HubDialogState) => void;
}) {
	if (!dialog) return null;
	switch (dialog.kind) {
		case "topic":
			return <TopicForm data={data} parentId={dialog.parentId} edit={dialog.edit} onClose={onClose} onCreated={onCreated} />;
		case "lesson":
			return (
				<LessonForm
					data={data} topicId={dialog.topicId} edit={dialog.edit} parentLessonId={dialog.parentLessonId}
					seedConcepts={dialog.seedConcepts} seedTitle={dialog.seedTitle} onClose={onClose} onCreated={onCreated}
				/>
			);
		case "plan":
			return <PlanForm data={data} edit={dialog.edit} onClose={onClose} onCreated={onCreated} />;
		case "adopt":
			return <AdoptForm data={data} lessonId={dialog.lessonId} topicId={dialog.topicId} onClose={onClose} />;
		case "ask":
			return <AskForm topicId={dialog.topicId} lessonId={dialog.lessonId} planId={dialog.planId} milestoneId={dialog.milestoneId} about={dialog.about} onClose={onClose} />;
		case "planner":
			return <PlannerForm planId={dialog.planId} milestoneId={dialog.milestoneId} about={dialog.about} onClose={onClose} onManual={() => onOpen({ kind: "plan" })} />;
	}
}
