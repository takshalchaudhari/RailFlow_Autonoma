"""AI middleware package for RailFlow (STEP I).

STRICT ARCHITECTURAL BOUNDARY:
Modules in `app.ai` are strictly restricted to:
1. Parsing free-text disruption descriptions into unconfirmed structured event proposals.
2. Explaining verified schedule revisions and trade-offs using read-only result data.

`app.ai` MUST NEVER import or call `app.engine.scheduler`, `app.engine.validator`, or any database
write functions, and MUST NEVER generate or modify platform assignments.
"""
