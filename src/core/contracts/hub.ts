/**
 * The learning hub: plans, topics and lessons that live outside any single
 * chat, plus the learner evidence that mastery is derived from. Chats link
 * back to the hub through ChatRecord.origin; the hub never stores chat ids.
 */

export const HUB_MODES = ["ask", "explain", "deep-dive", "practice", "plan"] as const;
export type HubMode = (typeof HUB_MODES)[number];

/** Where a session came from in the hub. Absent on chats started outside it. */
export interface SessionOrigin {
	mode: HubMode;
	lessonId?: string;
	topicId?: string;
	planId?: string;
	/** Set on sessions started from one milestone of `planId`. */
	milestoneId?: string;
	/** True when the hub judged the learner's evidence fresh enough to skip probing. */
	skipProbe?: boolean;
}

export interface HubTopic {
	id: string;
	title: string;
	summary?: string;
	/** Null for a top-level topic; otherwise this is a subtopic. */
	parentId: string | null;
	order: number;
	createdAt: string;
}

/** The mastery unit. `slug` doubles as the plan-map node id teachers tag checks with. */
export interface HubConcept {
	id: string;
	slug: string;
	title: string;
	topicId: string;
}

export interface HubLesson {
	id: string;
	topicId: string;
	title: string;
	goal: string;
	conceptIds: string[];
	prereqLessonIds: string[];
	/** Set on deep-dive lessons spawned from another lesson. */
	parentLessonId: string | null;
	order: number;
	createdAt: string;
	updatedAt: string;
}

/**
 * One stage of a plan, and a small hub of its own: a goal plus the topics
 * (with all their lessons) and any hand-picked lessons that reach it.
 */
export interface HubMilestone {
	id: string;
	title: string;
	goal?: string;
	topicIds: string[];
	lessonIds: string[];
}

/** A goal-driven path that references lessons from any topic instead of copying them. */
export interface HubPlan {
	id: string;
	title: string;
	goal: string;
	milestones: HubMilestone[];
	archived: boolean;
	createdAt: string;
	updatedAt: string;
}

export const EXPLORE_SOURCES = ["outcome", "teacher", "graph", "user"] as const;
export type ExploreSource = (typeof EXPLORE_SOURCES)[number];
export const EXPLORE_STATUSES = ["open", "planned", "dismissed"] as const;
export type ExploreStatus = (typeof EXPLORE_STATUSES)[number];

export interface HubExploreItem {
	id: string;
	title: string;
	why: string;
	source: ExploreSource;
	status: ExploreStatus;
	topicId?: string;
	fromConceptId?: string;
	chatId?: string;
	createdAt: string;
}

export const CURRENT_HUB_VERSION = 1;

export interface HubState {
	version: typeof CURRENT_HUB_VERSION;
	topics: HubTopic[];
	concepts: HubConcept[];
	lessons: HubLesson[];
	plans: HubPlan[];
	explore: HubExploreItem[];
}

export const EVIDENCE_KINDS = ["check", "assessment", "practice"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_RESULTS = ["pass", "fail", "solid", "shaky", "gap"] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];

/** One observation of the learner. Ids are deterministic per source so re-scans never duplicate. */
export interface HubEvidence {
	id: string;
	conceptId: string;
	chatId: string;
	lessonId?: string;
	at: string;
	kind: EvidenceKind;
	result: EvidenceResult;
	note?: string;
}

export const CONCEPT_STATUSES = ["not-yet", "learning", "shaky", "gap", "solid"] as const;
export type ConceptStatus = (typeof CONCEPT_STATUSES)[number];

export interface ConceptMastery {
	status: ConceptStatus;
	passes: number;
	fails: number;
	lastAt: string | null;
	/** When a solid concept should be reviewed; null unless solid. */
	dueAt: string | null;
	reviewDue: boolean;
}

export type LessonStatus = "not-started" | "in-progress" | "complete" | "needs-review";

export interface LessonProgress {
	status: LessonStatus;
	solid: number;
	total: number;
}

export interface MilestoneProgress {
	solid: number;
	total: number;
	/** First lesson of the milestone that is not complete. */
	nextLessonId: string | null;
	/** True when the milestone has lessons and all of them are complete. */
	complete: boolean;
}

export interface PlanProgress {
	solid: number;
	total: number;
	/** First lesson in milestone order that is not complete. */
	nextLessonId: string | null;
	milestones: Record<string, MilestoneProgress>;
}

export interface HubMastery {
	concepts: Record<string, ConceptMastery>;
	lessons: Record<string, LessonProgress>;
	plans: Record<string, PlanProgress>;
}
