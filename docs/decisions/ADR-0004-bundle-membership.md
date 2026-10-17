# ADR-0004: Bundle Membership

## Status

Accepted.

## Context

A circle sometimes sells an official bundle (`コンプリートパック`, `セット`,
`総集編`) as its own DLsite product with its own code, files, and price. The
bundle contains works that are also sold on their own. DLsite declares the
relationship only for some products (`work_pack_children` on the bundle and
`work_pack_parent` on a member); many bundles leave both empty and share only
the series with their members.

Every family reader treats the editions of a family as interchangeable
language editions of one work: playback, availability, folder edits, and the
file sources all assume that. A bundle and its members have different files.

## Decision

Record bundle membership as a relationship between DLsite codes in
`work_bundle_member`, not as an edition, alias, or second identity.

- A bundle and each member keep their own work, edition family, playback,
  availability, Library card, and deletion. Neither code has to be a work.
- Metadata sync records the members DLsite declares. A user adds members by
  code, or from suggestions drawn from the bundle's series, and removes them.
  Detection never replaces a user's decision and does not add a member the
  user removed.
- Readers resolve each code to a library work at read time, through the work
  with that code or the family declaring it.
- Membership never makes files of one work available to another.

## Consequences

- A bundle's detail lists its members, and a member's detail names the bundles
  that include it.
- Most bundles need one manual decision, because DLsite rarely declares the
  members.
- Searching for a member finds its bundles, because a bundle's search
  document holds its members' codes and library titles.
- Playback, availability, and file sources stay unaware of bundles. Using a
  bundle's files for one of its members needs a separate decision.
