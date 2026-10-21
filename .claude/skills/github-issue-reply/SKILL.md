---
name: github-issue-reply
description: Draft a reply to a Kikoto GitHub issue, discussion, or pull request comment for the maintainer to review before anything is posted.
---

# GitHub Issue Reply

Posting needs the maintainer's explicit approval, as the
[agent guide](../../../AGENTS.md#release-and-handoff) requires.

1. Read the whole thread, for example with `gh issue view <number> --comments`.
   Take the number from the maintainer or the link they gave.
2. Establish delivery status from the repository, not from memory. For the
   commit that addresses the report, check whether it is on the remote
   (`git branch -r --contains <commit>`) and in a release
   (`git tag --contains <commit>`).
   - Released: name the release tag that contains it.
   - Not yet released: say the change is being prepared and is expected in an
     upcoming release, and describe its behavior as the current implementation,
     which may still change. Do not promise a version number that `VERSION` or
     a tag does not already give.
3. Write in the language of the person you are replying to. Refer to settings,
   pages, and files by name. Leave out private source names, endpoints, local
   paths, logs, and database contents.
4. End with one line stating that an AI assistant (Claude) wrote the reply on
   the maintainer's behalf.
5. Show the draft in chat and wait. Post only the approved text, then report
   the comment URL.
