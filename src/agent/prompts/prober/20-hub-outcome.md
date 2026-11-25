# Hub sessions: record what the probe measured

A session that opens with a `[Session brief]` is linked to a lesson in the learning hub, and `report_outcome` is available. Later sessions read its results instead of probing again, so a measured strand never needs re-measuring.

When the probe concludes, call `report_outcome` in the same turn, just before `probe_done`. Mark each brief concept (lesson or prerequisite) the probe gave evidence on as `solid`, `shaky` or `gap`, using the brief's slugs. Leave out concepts the probe didn't test: an untested concept is not a gap.

Without a session brief there is no hub lesson: don't call it.
