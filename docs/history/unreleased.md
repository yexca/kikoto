# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- Copying a work code, file preview text, or diagnostics works when Kikoto is opened over plain HTTP on a LAN address, where browsers withhold the Clipboard API. A work without a known code shows a plain badge instead of a copy button.
- **Edit files** can add a lyrics file from another folder or edition as lyrics of a language you choose, into that language's folder inside `lyrics_kikoto`, and can assign the added lyrics to matching tracks, including tracks the same edit adds.
- The metadata editor's Title section edits a work's description in every language, starting from the introduction it shows, and **Revert** restores the provider introduction. It does not need **Fetch for edit**, so a work without provider metadata can have a description.
- The metadata editor's Title section sets a work's age rating. A manual rating fills in a rating the provider does not give, such as for a custom work or a delisted product, or makes the provider's rating stricter, never less strict. The detail, Library search, and the content safety assessment for LLM translation and ASR use it unless the provider's rating is stricter, so a work without a provider rating can be transcribed and translated once it has one.
- The work detail stat and the Library's age search clause read **Age rating** in every language, such as 年龄分级, 年齡分級, 年齢区分, and 연령 등급.
- On a phone, the work code and its language chips fit on one line: the chips name a language by its code, such as `JA`, `SC`, or `TC`, while their lists keep full names. Language names on work detail follow the interface language instead of always reading in English.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- A remote source tab folds the editions of a known work family into one card that lists every edition the source returned. The card presents the searched edition, then your metadata language, then the family's own code, and its code, title, cover, Track, and Fetch all come from that one edition. A one-page result counts cards instead of upstream entries.
- Fetch on a work without a local folder builds the new folder from several places for users who manage local files: the source's edition, the work's other editions, sources, and local folders, and lyrics files added as lyrics of a language. The edition's files are one Fetch, and the rest is added by an **Edit files** run once the Fetch has published the folder.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- The Metadata page's **Custom works** view lists library folders whose names carry no work code and turns one into a custom work. Kikoto assigns it a `KT` code and appends the code to the folder's name, such as `Example Work [KT00000001]`, so every scan finds it. The view opens with a notice describing the rename, and an administrator accepts it before custom works can be created. A custom work has no DLsite link, provider metadata, or remote source: its detail shows no rating, sales, metadata refresh, Fetch for edit, Metadata source section, remote source tabs, or source checks, **Edit files** and **Lyrics files** list only local places, and its title, description, age rating, and other fields come from the metadata editor. The server refuses metadata sync, metadata previews, metadata links, purchase bonus and bundle changes, and source checks for a custom work, and per-source metadata runs and source presence checks leave it out.

</details>

<details>
<summary><strong>Settings and interface</strong></summary>

- Demo's **LLM & ASR** tab lists example LLM providers and ASR services at addresses no request reaches, and the content safety policy. Selecting one opens its dialog with every option visible; adding, editing, switching, deleting, fetching models, and saving the policy stay unavailable.

</details>
