# Course hub: handoff for the next agents

Branch `feat/course-hub` on the fork `SheaGuev/learnharness` (upstream `amosblomqvist/learnharness`, based on `069a6a11`, app 0.7.0). Updated 2026-11-26, after the T6 planner half.

## Status (2026-11-26): T6 planner

The planner half of T6 is done (spec: `~/Documents/THEVAULT/SPS/SPS/learnharness/Hub P3 Planner.md`):
- New chat kind `planner` and hub mode `plan`. "New plan" in the hub opens a goal dialog and starts a planner session. The planner interviews the learner about their goal (not their knowledge), proposes milestones → topics → lessons, and writes the plan with `save_plan` (`src/agent/tools/planner.ts`, upsert logic in `src/core/hub-plan-draft.ts`). Prompt: `src/agent/prompts/planner/00-base.md`.
- `HubMilestone` gained `goal` and `topicIds`. Mastery has per-milestone progress (`mastery.plans[id].milestones`). `GET /api/hub` adds `planSessions`.
- `POST /api/hub/start` takes `milestoneId` (with `planId`) for Ask, Explain and Plan starts from a milestone.
- UI: the plan screen lists milestone cards and offers "Revise with planner". The new milestone screen (`?plan=…&milestone=…`) shows the goal, progress, topics with lesson cards, Ask and "Plan this milestone".
- Tests: `tests/planner-flow.test.ts` (13). In the dev server, a full planner run with a real model asked 5 goal questions, proposed 5 milestones, and saved 6 topics and 21 lessons. The plan and milestone screens rendered.
- **Known issues, not fixed:**
  - `tests/plugin-question-native.test.ts` (9) and `tests/plugin-submission-native.test.ts` (1) fail on the base commit too: `reportOutcomeTools` reads `ctx.chatStore.getChat` when a test builds prober tools with no chat store.
  - Claude models sometimes call `send_to_user` and then repeat the same text as ordinary prose, so the reply shows twice. Seen in a planner session. It can affect every agent that gets `send_to_user` except the teacher, which has the narration guard.
- **Still open in T6:** the explore queue built from graph neighbours.

## Status (2026-11-25)

T1–T5 are merged into `feat/course-hub`:
- T1–T3: merges `6c565fe4`, `2b501f64`, `67770eab`; follow-up fix `83dbf706`.
- T4 (`tutor` agent kind): commit `2e06a354`.
- T5 (`report_outcome`): commit `d24dc266`.

The combined test set (23 files, 395 tests) passes, and typecheck and lint are clean.

- **Checked in the dev server:**
  - The hub is the home screen, and creating a topic and lesson works.
  - "New session" on a lesson calls `POST /api/hub/start`, links the chat with `origin`, writes the session brief, and opens the chat.
  - A deep dive with no evidence probes. An Explain start sets `skipProbe` and lists at the `plan` phase.
  - `POST /api/hub/start { mode: "ask", topicId }` creates a `tutor`-kind chat; it renders with an "Ask" badge and no probe/plan phase.
- **Not checked:** turn-level behaviour. That covers the teacher or tutor running on turn 1, the model honouring the brief's slugs, and the teacher or prober calling `report_outcome`. The dev data has no model slots configured.
- **Gaps:**
  - The lesson card has no Explain or Ask buttons, so both modes are only reachable through the API.
  - An API Ask start uses `prompt` as the chat title but doesn't send it as the first message.
  - `report_outcome` reaches the tutor only in lesson-linked Asks (a topic-only Ask has no lesson to record against). Its prompt (`tutor/10-hub-outcome.md`) never marks a concept solid and mainly sends explore items and deeper dives.
- **Next tasks:** Explain/Ask entry points in the hub UI (with the Ask question sent as the first message), then T6 (planner and explore queue).
- **Dev-browser gotcha:** a browser-pane tab that has been navigated many times can get stuck in a reload loop (`[HMR] connected` → `[Fast Refresh] rebuilding` → reload) even though no files change. A fresh tab loads normally.
- **Type-check gotcha:** with the `session-brief` marker in the message union, `capturePluginSessionView` hit TS2589 (instantiation too deep). It now widens through `unknown`, like its other branch (`src/core/plugin-view-context.ts`). Expect this class of error when adding message types.

## The goal

Turn LearnHarness from "one chat is the unit" into a **hub-centred** app. Learning plans, topics, lessons and the learner's mastery live in a hub outside any chat. The hub launches the existing agents in four modes and collects what each session learned.

- **Ask:** quick answer, no probe.
- **Explain:** short lesson, checks at the end.
- **Deep dive:** probe (when needed) → plan → step-by-step checks.
- **Practice:** problems on chosen concepts.

Product requirements from the owner:
- Plans must be small, adaptable and modular, live outside any one chat, and be easy to add to or create.
- The hub is the main place: topics → subtopics → lessons, pick up where you left off, explore neighbouring topics.
- **Probing stays thorough but doesn't run every session.** Probe only when a lesson's prerequisite concepts have no evidence or stale evidence, or the learner asks. Otherwise skip it and start teaching with the known state.
- Fresh context per lesson. Long multi-hour chats degraded model accuracy.

Specs and background live in the owner's Obsidian vault (readable on this machine, don't commit there):

| Doc | Path |
| --- | --- |
| Architecture (start here) | `~/Documents/THEVAULT/SPS/SPS/learnharness/Hub-Centred Architecture.md` |
| P1 data model + implementation status | `~/Documents/THEVAULT/SPS/SPS/learnharness/Hub P1 Data Model.md` |
| P2 mode routing (code map with file:line) | `~/Documents/THEVAULT/SPS/SPS/learnharness/Hub P2 Mode Routing.md` |
| How LearnHarness works today, and its gaps | `~/Documents/THEVAULT/SPS/SPS/learnharness/LearnHarness Internals and Gaps.md` |
| Earlier plugin design (superseded; mastery logic still applies) | `~/Documents/THEVAULT/SPS/SPS/learnharness/Course Hub Design.md` |

## What exists (P1 backend, committed)

| Part | File |
| --- | --- |
| Types: `HubState`, `HubTopic`, `HubLesson`, `HubConcept`, `HubPlan`, `HubExploreItem`, `HubEvidence`, `SessionOrigin`, mastery types | `src/core/contracts/hub.ts` |
| Validation, `parseHubAction` / `applyHubAction` (12 edit actions), integrity checks, `slugify`, `parseSessionOrigin` | `src/core/hub.ts` |
| Mastery projection (`conceptMastery`, `projectMastery`, review intervals 1/3/7/21/60 days) | `src/core/hub-mastery.ts` |
| Check evidence from transcripts (`quiz` with `type: "check"` + `nodeId`, result `details.correct`; map-node fallback by title) | `src/core/hub-evidence.ts` |
| Store: `data/hub/hub.json` (versioned, refuses newer), `data/hub/evidence.jsonl` (append-only, de-duplicated by id), emits `hub-changed` | `src/store/hub.ts`, `HubStore` port in `src/core/ports.ts` |
| `ChatRecord.origin` / `ChatSummary.origin`, `chatStore.createChat(title, kind, origin)`, `chatStore.saveOrigin` | `src/core/contracts/chat.ts`, `src/store/chats.ts` |
| Service: `hubSnapshot()` (syncs check evidence from linked chats, then projects mastery), `applyHubEdit()`, `adoptChat()` | `src/server/hub.ts` |
| API: `GET /api/hub`, `POST /api/hub` (one edit per call, `{ type: "lesson.create", ... }`), `POST /api/hub/adopt`, `origin` on `POST /api/chats` | `app/api/hub/*`, `app/api/chats/route.ts` |
| Tests (12) | `tests/hub.test.ts` |

`GET /api/hub` returns `{ state, mastery: { concepts, lessons, plans }, lessonSessions, topicSessions }`.

## Environment

- **Node 26** (CI uses 26; the shell default is 23): `export PATH="$HOME/.nvm/versions/node/v26.5.1/bin:$PATH"`
- Fresh worktree setup: `npm ci`, then `npm run plugins:setup`. This is slow on this network, about 10+ minutes.
- Dev server: `npm run dev` → http://localhost:3000. It uses the repo's gitignored `data/`, separate from the owner's installed app. **Restart it after editing `config.ts` or server barrels**: Turbopack kept stale server modules once.
- Tests: call the runner directly. A shell hook rewrites `npx`, so use `NODE_ENV=test ./node_modules/.bin/tsx --test tests/hub.test.ts`. The full suite takes over 10 minutes.
- Typecheck and lint: `./node_modules/.bin/tsc --noEmit`, `./node_modules/.bin/eslint <files>`.
- **Changing any type exported from `src/core` that plugins can see** (chat contracts, events, hub contracts) requires regenerating the committed reference, or `tests/plugin-api-reference.test.ts` fails:
  `SDK=$(mktemp -d)/sdk && node scripts/build-plugin-types.mjs "$SDK" && node scripts/build-plugin-api-reference.mjs "$SDK" docs/plugin-api`
- Known failures not related to the hub:
  - `tests/plugin-install-local.test.ts` (must run under `npm test`)
  - two production-demo helper tests in the browser-service suites (need a headless browser)
- `curl` output in this shell can be shortened by a hook. Write responses to a file (`curl -o`) before parsing them.

## Conventions (owner's rules plus repo patterns)

- **No type casts** (`as X`, `as unknown as X`) in new code. Use type guards, narrowing, or fix the types. See `isRec`-style guards in `src/core/hub.ts`.
- Default to no comments; comment only the non-obvious *why*. Never reference tickets or chats in comments.
- **Stage changes, don't commit**, unless the owner says to commit. Show what's staged and ask.
- Cite file:line for claims about code; don't invent identifiers.
- Repo layering (eslint-enforced):
  - pure logic and types go in `src/core` (browser-safe, exported from `src/core/index.ts`)
  - storage ports go in `src/core/ports.ts`
  - fs adapters go in `src/store`
  - composition and services go in `src/server` (exported from `src/server/index.ts`)
  - routes in `app/api` import only `@/src/core` and `@/src/server`
  - `components/` imports only `@/src/core`
- Store writes use `writeFileAtomicSync`. List-shaped changes `emit()` an event; content writes stay silent (see `src/store/chats.ts` header).
- Plans/specs go in the vault; agent briefs go in `docs/scoping/`.

## Remaining work

Each task lists the files it owns. Tasks that share files must not run in parallel.

T1–T5 are done (see Status). Their rows stay for file-ownership reference.

| ID | Task | Owns | Depends on | Parallel with |
| --- | --- | --- | --- | --- |
| **T1** (done) | Hub UI (P1b) | `components/hub/*` (new), `app/page.tsx`, `components/home.tsx`, sidebar entry | P1 (done) | T2, T3, T5 |
| **T2** (done) | Session start + lesson brief | `app/api/hub/start/route.ts` (new), `src/server/hub.ts`, `src/core/native-messages.ts` (marker), `src/core/view.ts`, golden fixtures | P1 | T1, T5 |
| **T3** (done) | Skip-probe routing (`startsInTeach`) | `src/server/chat-handler.ts`, `src/core/phases.ts`, `src/store/chats.ts:111`, `components/chat.tsx`, `app/chat/[id]/page.tsx` | P1 | T1, T5 |
| **T4** (done) | `tutor` agent kind for Ask mode | `src/agent/teacher-agent.ts`, `src/agent/tools.ts`, `src/agent/prompt-segments.ts`, `src/core/prompt-segments.ts`, compaction, settings prompt tabs, `src/agent/prompts/tutor/` (new) | **T3** (shares chat-handler) | T1 |
| **T5** (done) | `report_outcome` tool → evidence + explore items | new tool module under `src/agent/tools/`, registration in `src/agent/tools.ts`, `src/server/hub.ts` writer | P1 | T1, T3; **not** with T4 (`tools.ts`) or T2 (`server/hub.ts`) unless coordinated |
| **T6** (planner done) | Planner agent + explore queue from the graph (P3) | `src/agent/tools/planner.ts`, `src/core/hub-plan-draft.ts`, `src/agent/prompts/planner/`, milestone screens in `components/hub/*` | T4 | none |

### T1: Hub UI

Make the hub the home screen and move the knowledge graph to a secondary "Map" view.
- **Screens:**
  - Home: a Continue card (each active plan's next lesson from `mastery.plans[id].nextLessonId`), Review due (concepts with `reviewDue`), the topic tree and plans.
  - Topic/lesson view: lessons with concept dots (status colours), sessions list, and Continue / New session / Practice / Go deeper buttons. Start buttons can be stubs until T2 lands.
  - Create and edit: topic, subtopic, lesson (with concepts), plan (with milestones). Adopt an existing chat into a lesson.
- **Data:** `GET /api/hub`. Refetch on the `hub-changed` and `chats-changed` events (see `components/server-events.tsx`). Edits go through `POST /api/hub`.
- **Design reference:** the course-page mockup (milestone track, concept dots solid/shaky/gap/not-yet, expandable lesson with checks and actions), described in `Course Hub Design.md` → UI.
- **Done when:**
  - the home renders the hub with an empty state that invites creating a topic
  - you can create topic → lesson → plan, adopt a chat, and see mastery update after a check in a linked chat
  - the graph is still reachable
  - no console errors; typecheck clean

### T2: Session start + brief

`POST /api/hub/start { mode, lessonId?, topicId?, planId?, prompt? }`.
- **Creates the chat:** with `origin`, decides `skipProbe` from evidence freshness (the probe policy in `Hub P2 Mode Routing.md`), and writes a new `session-brief` marker as message[0]. The brief carries the goal, concept slugs (the teacher must use them as `plan_init` node ids), known mastery and mode rules.
- **The new marker touches:**
  - the `LhMarkerMessage.customType` union (`src/core/native-messages.ts:71-88`)
  - `toLlmMessages`
  - `view.ts`
  - the input-cause list (`native-messages.ts:~991`)
  - golden fixtures, since `tests/golden-fixtures.test.ts:115` requires every marker type to appear in a fixture
- **Done when:** a hub-started deep dive's prober sees the brief and doesn't re-probe recorded concepts; the brief is visible but quiet in the transcript; tests cover skipProbe selection.

### T3: Skip-probe routing

Add `startsInTeach(record) = hasProbeDone(messages) || record.origin?.skipProbe === true`.
- **Use it at** `src/server/chat-handler.ts:643` (agent choice), `:392` and `:940` (compaction kind).
- **Phase folds:** `phaseAt3`, `phaseTimeline` and `phaseAt3Lh` in `src/core/phases.ts` take an optional initial phase `"plan"`. Wire it from `src/store/chats.ts:111` and `components/chat.tsx` (pass `origin` from `app/chat/[id]/page.tsx`).
- **Don't fake a `probe_done` pair.** It would render an empty assessment card.
- **Done when:** an `origin.skipProbe` chat starts with the teacher, shows plan/teach phases correctly, and check reveal works (`questionNeedsReveal` needs phase `teach`).

### T4: `tutor` agent kind

A new chat kind and agent for Ask mode: answer-first, no probe, plan or quiz tools; read/ls/find/grep plus optional `ask_user_question`.
- **Prompts:** `src/agent/prompts/tutor/` with a curated shared allowlist, like practice (`src/agent/prompt-segments.ts:44,87`).
- **Blast radius:** every place that switches on agent or session kind is listed in `Hub P2 Mode Routing.md` → "Blast radius".
- **Skip** extraction and the phase UI. Plugins stay off (leave `PluginAgentKind` alone).
- **Done when:** an Ask session answers immediately, can offer to escalate to Explain or Deep dive, and its prompt is editable in Settings.

### T5: `report_outcome`

A tool for the teacher (and later prober and tutor): `{ summary, concepts: [{ slug, status: solid|shaky|gap, note }], explore: [{ title, why }], deeperDives: [{ title, goal, fromSlug }] }`.
- **Writes** `assessment` evidence for concepts of the chat's `origin.lessonId`, and explore items with `source: "teacher"`.
- **Deterministic ids**, so a retried tool call doesn't duplicate.
- **Prober findings:** either parse the `probe_done` report or call this tool, so probes aren't repeated.
- **Done when:** a teacher call updates mastery in `GET /api/hub`, and tests cover the slug mapping and de-duplication.

## Open questions for the owner

- **Ask sessions:** should they always attach to a topic, or may they float until filed?
- **Upstream sync cadence:** merge `upstream/main` before each phase?
