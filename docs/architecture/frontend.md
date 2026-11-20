# Frontend

The frontend is a React application focused on library browsing, work detail,
remote source management, and playback, served in a browser and inside the
Android and iOS shells. These pages state the rules, contracts, and
user-visible behavior a change must keep; the code shows how each is wired.
The visual contract is [Design](../development/design.md), and general coding
rules are [Frontend Guidelines](../development/frontend-guidelines.md).

| Page | Open this when… |
| --- | --- |
| [Frontend Structure](frontend/structure.md) | Adding a module or feature folder, changing the build, the API client, the stack, or where errors are contained |
| [App Shell](frontend/app-shell.md) | Changing the sidebar groups, header, account or notification panel, bottom sheets, safe-area insets, or startup and server switching |
| [Major Surfaces](frontend/surfaces.md) | Changing Settings, System, Cleanup, Tags, Insights, Translation, Metadata, Workflows, Favorites, or creator pages, or a route redirect or page permission |
| [Library and Work Detail](frontend/library-and-work-detail.md) | Changing Library loading or toolbars, the work detail layout and Hero action, or the Manage files and Fetch workspaces |
| [Record](frontend/record.md) | Changing the Record browser, its video and photo overlays, Record audio, or Record deletes |
| [Discover and For You](frontend/discover-and-for-you.md) | Changing the release feed, Rankings, Watch, Discover settings and latest-run lines, or For you |
| [Metadata Editor](frontend/metadata-editor.md) | Changing the work metadata editor, tag editing, per-language titles and descriptions, Translate with AI, or remote metadata fallback |
| [Player and Video](frontend/player-and-video.md) | Changing audio delivery, HLS, loudness, playback guards, the resume position, or the full-screen video player |
| [Playback Reports](frontend/playback-reports.md) | Changing listening measurement, playback report sending, the IndexedDB outbox, or acknowledgement handling |
| [Navigation, History, and Scroll](frontend/navigation-and-history.md) | Changing workspace retention, Back and the in-app back stack, detail ownership, or scroll and browse-state restoration |
| [Interaction Principles](frontend/interaction-principles.md) | Changing secondary navigation, mobile fixed surfaces, work collections and cards, account-scoped storage, recommendations, or directory ordering |
| [Native Shells](frontend/native-shells.md) | Changing native media controls, screen lyrics, asset or session credentials, device privacy, or version states |
