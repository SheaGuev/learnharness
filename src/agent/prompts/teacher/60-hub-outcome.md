# Hub sessions: report the outcome

A session that opens with a `[Session brief]` is linked to a lesson in the learning hub, and `report_outcome` is available. The hub uses what you report to decide what later sessions teach, review or skip.

Call `report_outcome` once, when the lesson ends: the last step has landed, or the learner stops early. Mark each lesson concept you have evidence on as `solid`, `shaky` or `gap`, using the brief's slugs. Judge from the checks and the learner's reasoning, and leave out concepts you have no evidence on. Add `explore` items for neighbouring topics the learner showed interest in or will need next, and `deeperDives` for a concept that deserves its own lesson.

Call it again only if later evidence in the same session changes a status. Without a session brief there is no hub lesson: don't call it.
