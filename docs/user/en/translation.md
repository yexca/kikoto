# Translation
[English](../en/translation.md) · [简体中文](../zh-Hans/translation.md) · [繁體中文](../zh-Hant/translation.md) · [日本語](../ja/translation.md) · [한국어](../ko/translation.md)

The **Translation** page (`/translation`) follows [Translate with AI](work-detail.md#translate-with-ai) across the whole library: what is running or queued, what stopped, what finished translations wrote, and how much of each language the works already cover. It opens from the sidebar for accounts with library write permission; it does not need workflow permission. Everyone who can open it sees every account's translations. Each item takes effect as soon as it finishes, as described under [Results](work-detail.md#results).

The page is a view of the Translate with AI runs and their items. Activity in [Workflows](workflows.md) lists the same runs with their diagnostics.

## In progress

**In progress** (`?view=running`), which the page opens on, lists the runs that are translating, then those still queued, one card per work. The card's first row is the transcription (ASR) stage, with how many tracks are transcribed and the progress of the current one. Each target language follows on its own row with its stage: waiting for transcription, queued, translating with how many items are done, or done.

**Cancel** is available for your own runs without workflow permission; workflow administrators can also cancel other accounts' runs. It stops everything not yet sent, and a speech or translation request already out keeps an unknown result. Accounts with workflow permission also see **Activity**, which opens the run's diagnostics.

## Stopped

**Stopped** (`?view=attention`) lists the items that failed, whose result is unknown, that went out of date, or that the content safety policy blocked, grouped by work, language and category, each with the reason. **Send again** queues a failed item, or a transcription and the translations waiting for it, in the same run. An item whose result could not be written, such as lyrics whose folder was blocked, is written from its kept result without another request. A request whose response was lost, including during a connection failure, server stop or cancellation, may already have been charged by the provider, so **Send again** first asks you to confirm. An item whose source, provider or content policy changed is translated again by a new request from the work.

## History

**History** (`?view=history`) lists what finished items wrote, newest first, grouped by work with a link to each work: the title, description, tag name or display name in its language, and the file each lyrics item became.

## Coverage

**Coverage** (`?view=coverage`, with `&language=` and `&missing=`) shows how far every work, catalog and custom alike, is available in one target language; `/metadata?view=translation` links open it. **Target language** starts as the interface language. **Show** lists the works missing anything, which it starts on, or missing their title, description, tag names, file names, or lyrics, the complete works, or every work. **Title** and **Description** name where the language's text comes from: **Original** when it is the language of the work's original edition, **Edition** for a language edition of the work, **Manual** for a manual title or description in that language, **LLM** for an AI translation, or **Missing**. **Tags** counts the work's shared tags that have a name in the language, **File names** its local files that have a display name in it, and **Lyrics** its local tracks with lyrics assigned in it; a dash means the work has none to count, and file names read **Original** in the work's original language. A check marks what is complete; missing parts take the attention color. A row also shows the work's translations into the language that are running. Wide screens give each part its own column; narrower screens list them under the title.

Select works and press the translate button in the header to translate what each of them lacks in the language with a chosen model: title, description, shared tag names, and file and folder names. The categories start on the parts some selected work lacks. A work with nothing missing is skipped. Lyrics are chosen track by track in each work's own Translate with AI. Results appear under **History**.

The page refreshes itself every few seconds while a run is in progress. On phones, the views form one row that scrolls sideways.
