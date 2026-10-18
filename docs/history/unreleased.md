# Unreleased

<details>
<summary><strong>Library and work detail</strong></summary>

- Copying a work code, file preview text, or diagnostics works when Kikoto is opened over plain HTTP on a LAN address, where browsers withhold the Clipboard API. A work without a known code shows a plain badge instead of a copy button.
- **Edit files** can add a lyrics file from another folder or edition as lyrics of a language you choose, into that language's folder inside `lyrics_kikoto`, and can assign the added lyrics to matching tracks, including tracks the same edit adds.
- The metadata editor's Title section edits a work's description in every language, starting from the introduction it shows, and **Revert** restores the provider introduction. It does not need **Fetch for edit**, so a work without provider metadata can have a description.
- On a phone, the work code and its language chips fit on one line: the chips name a language by its code, such as `JA`, `SC`, or `TC`, while their lists keep full names. Language names on work detail follow the interface language instead of always reading in English.

</details>

<details>
<summary><strong>Sources and remote fetch</strong></summary>

- A remote source tab folds the editions of a known work family into one card that lists every edition the source returned. The card presents the searched edition, then your metadata language, then the family's own code, and its code, title, cover, Track, and Fetch all come from that one edition. A one-page result counts cards instead of upstream entries.
- Fetch on a work without a local folder builds the new folder from several places for users who manage local files: the source's edition, the work's other editions, sources, and local folders, and lyrics files added as lyrics of a language. The edition's files are one Fetch, and the rest is added by an **Edit files** run once the Fetch has published the folder.

</details>

<details>
<summary><strong>Metadata and scans</strong></summary>

- The Metadata page's **Custom works** view lists library folders whose names carry no work code and turns one into a custom work. Kikoto assigns it a `KT` code and appends the code to the folder's name, such as `Example Work [KT00000001]`, so every scan finds it. The view opens with a notice describing the rename, and an administrator accepts it before custom works can be created. A custom work has no DLsite link or DLsite metadata sync, and its title and description come from the metadata editor.

</details>

<details>
<summary><strong>Settings and interface</strong></summary>

- Demo's **LLM & ASR** tab lists example LLM providers and ASR services at addresses no request reaches, and the content safety policy. Selecting one opens its dialog with every option visible; adding, editing, switching, deleting, fetching models, and saving the policy stay unavailable.

</details>
