# Agent Skills

Each subdirectory holds one `SKILL.md`: a procedure for a workflow that recurs
across the repository. Claude Code loads these from `.claude/skills/`; other
agents find them through the [agent guide](../../AGENTS.md).

A skill's `description` loads into every agent session, so a skill must earn
that cost:

- Add a skill only for a workflow that recurs repository-wide and whose steps
  are not already one link away in the docs.
- Keep the description narrow: name the task that triggers it, not a general
  topic, and do not use imperative "always use this skill" phrasing.
- Keep the body procedural. Link to the docs that own a rule instead of
  restating it, so the rule stays in one place.
- Use only generic examples, reserved domains, and synthetic identifiers, as
  for any tracked file.
