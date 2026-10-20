# Unreleased

> [!NOTE]
> The first start after upgrading reads every work's stored DLsite metadata again to fill staff credits and voice actor ids, and rebuilds the Library search index in the background. No DLsite request is made. Existing searches keep working during the rebuild; only matches on staff names fill in as it finishes.

<details>
<summary><strong>Library and work detail</strong></summary>

- Copying a work code, file preview text, or diagnostics works when Kikoto is opened over plain HTTP on a LAN address, where browsers withhold the Clipboard API, including in Safari on iPhone and iPad. A work without a known code shows a plain badge instead of a copy button.
- **Edit files** can add a lyrics file from another folder or edition as lyrics of a language you choose, into that language's folder inside `lyrics_kikoto`, and can assign the added lyrics to matching tracks, including tracks the same edit adds.
- **Edit files** arranges **Final folder** like a file manager: drag files and folders onto a folder, drag files from the middle column onto a folder to add them there, create, rename, and delete folders, or use each row's **Move to**. Deleting a folder that holds something asks first and moves its contents up one level, and a moved file keeps its playback progress and lyrics, also when it takes the path of a file the same edit removes.
- **Merge into this folder** on another local folder of the work copies the files you select from it, then deletes that folder. Before applying, Kikoto compares the merged files by content with the final folder, lists every file that has no identical copy there, and asks twice before deleting. An edit whose merged folder or final folder changed after the comparison is not applied and asks for the review again, and a folder that changed since, whose storage pool is offline, or whose work a Fetch is still filling is not deleted. Just before deleting, the edit checks again that every file the review found a copy of still has that identical copy in the final folder, and otherwise stops and asks for a new review. A file an added file replaces under a name that differs only in letter case no longer counts as a copy on Windows, macOS, and other case-insensitive disks.
- A stopped or retried **Edit files** run continues where it stopped: files it already put into the folder are not collected or downloaded again, so a retry no longer fails on its own published files or on a merged folder it already deleted. Cancelling a run that waits for a retry or for recovery after a restart deletes the files it had collected and returns merged folders to the work, also while the edited folder's disk is offline.
- **Edit files** compares paths ignoring letter case and Unicode composition, as the server does, so two files that would land on one path show as a conflict in the preview instead of failing when the edit is applied.
- **Manage files** on a work with several local folders lists only the chosen folder's files. A file at the same path in another folder no longer shows that folder's copy, or a labelled sub-folder for it, inside the chosen one.
- The metadata editor's Title section edits a work's description in every language, starting from the introduction it shows, and **Revert** restores the provider introduction. It does not need **Fetch for edit**, so a work without provider metadata can have a description.
- The metadata editor's Title section sets a work's age rating. A manual rating fills in a rating the provider does not give, such as for a custom work or a delisted product, or makes the provider's rating stricter, never less strict. The detail, Library search, and the content safety assessment for LLM translation and ASR use it unless the provider's rating is stricter, so a work without a provider rating can be transcribed and translated once it has one.
- The work detail stat and the Library's age search clause read **Age rating** in every language, such as 年龄分级, 年齡分級, 年齢区分, and 연령 등급.
- Work detail shows a **Credits** card below Source info with the staff DLsite credits besides the voice actors: author, scenario, illustration, music, and other staff, showing only the roles a work credits. Selecting a name searches the Library for works crediting it in any staff role.
- Library search adds `staff:`, which matches a name in any staff role, and `author:`, `scenario:`, and `illust:` for one role, each with a `-` form that leaves matching works out; plain text also finds staff names. `creator:` still searches voice actors.
- Works on a disk that is not mounted, in either library mode, show **Local · Offline** on their cards, and their local files say that the disk is not mounted instead of looking missing. Until the disk is back, Kikoto refuses to play, download, edit, refresh, or delete their files, and **Edit files** and **Manage lyrics** show such a folder as offline and take nothing from it, so nothing on the disk is marked missing, deleted, or replaced while it cannot be seen. Once the disk is mounted again the files are available without a scan.
- **Manage lyrics → Transcribe** chooses the **Lyrics language** beside the audio language. **Same as audio language** is on by default; turned off, it saves the lyrics in another language with a model that translates, such as a Kikoto Helper model that writes Simplified Chinese lyrics from Japanese audio. Choosing that model sets its languages, and **Transcribe** stays unavailable for a combination the model does not write.
- On a phone, the work code and its language chips fit on one line: the chips name a language by its code, such as `JA`, `SC`, or `TC`, while their lists keep full names. Language names on work detail follow the interface language instead of always reading in English.
- On a phone, the Library header takes two rows: a source button beside the search field names the current source and opens every source, including disabled ones, in a menu, and a **Mark filter** button beside sort shows or hides the Quick mark chips, which start hidden. While a mark filter is set, the button shows that mark. **Continue listening** moves into the sort row as a button that opens the strip of recently played covers on any page and source; it starts closed. As on wide screens, the phone sort button carries the refresh for the Recommended and Random orders, so a random order reshuffles in one tap.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- A remote source tab folds the editions of a known work family into one card that lists every edition the source returned. The card presents the searched edition, then your metadata language, then the family's own code, and its code, title, cover, Track, and Fetch all come from that one edition. A one-page result counts cards instead of upstream entries.
- Fetch on a work without a local folder builds the new folder from several places for users who manage local files: the source's edition, the work's other editions, sources, and local folders, and lyrics files added as lyrics of a language. The edition's files are one Fetch, and the rest is added by an **Edit files** run once the Fetch has published the folder. Its **Final folder** is arranged as in **Edit files**.
- Fetch opens for a work whose source lists an empty file, such as a 0-byte notice text: the free disk space check counts it as 0 bytes instead of refusing the Fetch as having an unknown size. A source that leaves a file's size out still stops the Fetch, and the message now says that free space cannot be checked instead of a generic, untranslated failure.
- When DLsite sells an edition under a new code that it verifies as the same edition, source checks and Fetch find the new product for the existing edition, and its folder, cache, and files stay under the edition's own code instead of becoming a second work.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- Kikoto stores each voice actor's DLsite creator id from DLsite metadata, also for a work a remote source fetched after DLsite. When DLsite renames a voice actor, the person follows the new name and keeps the former one as an alias instead of splitting into a second voice actor. Staff credits keep their DLsite creator ids as well.
- A voice actor page's address carries the voice actor's DLsite creator id, such as `/voices/00000001`, instead of Kikoto's own person number, so a link names the same voice actor on any Kikoto. A voice actor without a DLsite id uses `local-` and the person number, such as `/voices/local-7`. Another DLsite id of the same voice actor, such as one a merge moved to it, opens its page and shows its main id in the address. A bare number in a voice address is always read as a DLsite id, so an address saved with a person number from an earlier version no longer opens that voice actor, and the phone's bottom tabs open at their main pages once after upgrading instead of resuming a saved page.
- The Metadata page's **Custom works** view lists library folders whose names carry no work code and turns one into a custom work. Kikoto assigns it a `KT` code and appends the code to the folder's name, such as `Example Work [KT00000001]`, so every scan finds it. Scans read a `KT` code only in that bracketed form, so a folder name such as `Projekt 20241019` names no work. The view opens with a notice describing the rename, and an administrator accepts it before custom works can be created. Creation refuses a Fetch folder and a folder a running Fetch or **Edit files** writes into, and asks to try again while another job is changing library folders. A custom work has no DLsite link, provider metadata, or remote source: its detail shows no rating, sales, metadata refresh, Fetch for edit, Metadata source section, remote source tabs, or source checks, **Edit files** and **Lyrics files** list only local places, and its title, description, age rating, and other fields come from the metadata editor. The server refuses metadata sync, metadata previews, metadata links, purchase bonus and bundle changes, and source checks for a custom work, and per-source metadata runs and source presence checks leave it out.
- Scans, file lists, and folder watching skip the folders and files NAS systems and operating systems add: `@eaDir`, `#recycle`, `#snapshot`, `__MACOSX`, `.Trash-*`, `$RECYCLE.BIN`, `System Volume Information`, `lost+found`, `._*`, `.DS_Store`, and `Thumbs.db`. A Synology thumbnail folder no longer appears as a second folder of a work, a work in a recycle bin is not found again, and a work already recorded in one of these places keeps its state instead of being marked missing. Such files that an earlier version indexed inside a work folder, such as a `._01.mp3` track that cannot play, are marked missing by the next scan.
- A DLsite translation made from a local edition in another language stays its own edition instead of folding into the local edition and replacing its title and description.
- A folder the scan cannot read, such as a `lost+found` folder the container user has no permission for, or a folder removed during the scan, no longer stops the whole scan. The scan skips it, finishes as partial naming it, and leaves the works inside it unchanged.
- A media file FFprobe cannot read, such as a damaged file or a macOS `._` file, is probed once per file version instead of on every pass. A timeout or an interrupted probe is tried again, and a changed file is probed again.

</details>

<details>
<summary><strong>Playback</strong></summary>

- **Loudness normalization** in Settings → Playback evens out loudness between local tracks. **Turn loud tracks down** lowers loud tracks through the player's own volume and works during background playback; **Turn loud tracks down and quiet tracks up** also raises quiet tracks through Web Audio, never past the measured peak, in the browser. Kikoto measures each file's EBU R 128 loudness once, the first time it plays with normalization on, and measures the next queued track ahead. Playback stays audible after a call, Siri, or another app interrupts it. It is off by default.
- The lyrics view has timing buttons that move timed lyrics 0.5 seconds earlier or later, up to 30 seconds either way. The offset is your own, saved per audio file, applies to screen lyrics too, and never changes the lyrics file.
- ASS and SSA lyrics show as timed lyrics, read from their `Dialogue` lines. `.ssa` files match tracks and are listed, managed, and translated as lyrics files like `.ass` files.
- Lyrics matching ignores sound effect and music switches such as `SEあり`, `SE無し`, `SE ON`, or `BGMなし`, so `本編_SEなし.lrc` serves `本編_SEあり.wav`, and matches names macOS stores decomposed. A lyrics file whose name differs from the track's only in its numbers, such as `02_opening.lrc` for `01_opening.wav`, is no longer chosen.
- When FFmpeg cannot convert a file, repeated requests for it fail at once for 30 seconds instead of occupying one of the two encode slots.
- AIFF (`.aiff`, `.aif`) and Matroska audio (`.mka`) files are audio tracks in local folders and remote sources: they show in the track list and queue, get their duration, match lyrics, and count toward folder choice. The browser cannot play them directly, so they play through compatibility conversion.
- A long next track that needs conversion starts warming earlier, a fortieth of its length before the current track ends, so a two-hour file is ready when it starts.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- On Windows, [Kikoto Helper](../operations/docker.md#windows-helper) deploys and manages Kikoto and runs local speech recognition and translation for it. The PowerShell helper in `kikoto-helper/` is retired: its v0.2.1 says so when it starts and in its main menu, and **9** in the main menu opens Kikoto Helper. Existing launchers keep working, since they still download their language script and check for updates from this repository.

</details>

<details>
<summary><strong>Settings and interface</strong></summary>

- About lists Number178/kikoeru-express under **Design**, as a design reference for quick listening-status marks, work cards and work detail, and some feature behavior, instead of as the interface remote sources follow.
- Demo's **LLM & ASR** tab lists example LLM providers and ASR services at addresses no request reaches, and the content safety policy. Selecting one opens its dialog with every option visible; adding, editing, switching, deleting, fetching models, and saving the policy stay unavailable.

</details>
