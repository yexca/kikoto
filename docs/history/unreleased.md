# Unreleased

- Remote recommendation badges score both known and transient works from the
  displayed page in one batch and appear progressively. Toggling badges does
  not reload the remote source; a scoring failure keeps the cards available and
  offers a retry.
- Recommendation heuristic v5 strengthens repeated positive evidence, reduces
  common-tag weight, favors weaker evidence in exploration, and mildly spreads
  creators within each listening lane. Affinity badges stay separate from
  ranking adjustments. Migration 060 and its generated schema-060 baseline
  preserve frozen affinity, diversity, and remote name matching per session.

- Narrow work cards, such as two mobile columns or six or more desktop
  columns, use tighter type and spacing. Personal tags lead a single tag row
  shared with DLsite tags, and the remaining tags open from the overflow
  control. The cover names only the first file source and counts the rest,
  and the rating and Sales row uses smaller type. A two-column phone card is
  about a fifth shorter, so a second row of works fits on screen. Wider cards
  keep their layout.
