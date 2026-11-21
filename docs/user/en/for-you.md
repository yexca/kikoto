# For You
[English](../en/for-you.md) · [简体中文](../zh-Hans/for-you.md) · [繁體中文](../zh-Hant/for-you.md) · [日本語](../ja/for-you.md) · [한국어](../ko/for-you.md)

**For you** answers what to play next with small, changing sets of local
works, where the Library's **Recommended** order is a stable way to browse
all of them. Both read the same taste profile: your ratings, favorites, and
marks, as described in [Library](library.md), and the same recommendation
tuning. Drawing in For you never changes what the Library recommends. For you
is in the sidebar beside [Discover](discover.md), and on a phone in the
account menu behind your avatar. Links to `/discover?view=for-you` open it.

## Draws

- Three columns hold about six works each: **Maybe like**, works you have not
  played yet that are close to what you like; **Try new**, works you have not
  played whose circles, voices, and tags you rarely hear, leaving out works
  like the ones you rated low or shelved; and **Listen again**, works you have
  played, the more likely the more you liked them (your rating, favorite,
  Relisten, and listening time) and the longer ago you played them. A work you are listening to now, or
  stopped in the last two weeks, is left to **Recently played** in the
  Library. Works you rated one or two stars are never offered.
- A work appears in one column only. Every column holds works with local
  files; works only on a remote source or only in a catalog are not drawn.
- Above each card is why it was drawn, such as **A circle you like: …**,
  **A tag you rarely hear: …**, or **4 months since last played, rated 5**.
- The temperature, from 1 to 5, sets how far the draws stray. At 1 the draws
  keep to the best matches and **Try new** stays near what you know; at 5 they
  come from every candidate and **Try new** goes as far from your usual
  listening as the library allows. **Listen again** offers finished works you
  liked or heard more than once at 1 and 2, adds finished works heard once at
  3, and adds works left half-finished at 4 and 5. The default is 3, and the
  choice is saved for your account. The five steps follow **Temperature** at
  the top of the page.
- The columns stay as drawn while you use Kikoto in the same browser tab,
  including when you open another page or a work, or reload the page. A new
  tab, a fresh start of the app, or saving your own preferences, such as the
  tuning in [Settings](#settings), draws all three anew.
- The shuffle button beside a column's heading draws that column anew from
  your current ratings and marks, leaving out what the other columns show.
  Each draw is random, and works shown recently that you neither opened nor
  played are drawn less often for three days, so the columns rotate.
- Before you have rated, favorited, or marked anything, **Maybe like** follows
  the DLsite rating and sales, and **Listen again** waits for works you play.
- On a narrow window or a phone, the switch under the temperature chooses the
  column to show, with that column's shuffle button beside it.
- In the demo, For you is a random sample of the demo works, labelled as
  sample data, with example reasons taken from a work's DLsite rating or
  circle. Nothing learns from what you open, and the temperature applies only
  to the draws in this browser.

## Cards and Display Options

For you shows works as [Discover](discover.md#cards-and-display-options)
does, and the two share one **Display options** choice. With **Compact**
cards on a wide screen, the three columns stand side by side. **Simple**,
**Full**, and **Mini** cards are too wide or too small for a third of the
page, so the columns follow one another, each in the card grid.

## Settings

The settings icon beside **Display options** opens the For you settings, a
dialog on a wide screen and a sheet on a phone: the tuning, followed by your
recommendation activity. `/for-you?panel=tuning` and
`/settings?tab=recommendation` open them, and `/for-you?panel=activity` opens
them at the activity.

- The tuning holds recommendation presets, a live preview, ordering variety,
  and advanced scoring. The live preview scores an adjustable example work on
  a gauge beside the highlight threshold and shows its composition; ordering
  variety shows how variation and discovery boost can move that example's
  ranking. Advanced scoring shows the mix slots as one proportional bar, the
  possible score range, how much evidence each rating and unrated Favorite,
  Relisten, or Shelved work carries, and each tag, voice, and circle weight as
  a meter of per-match steps up to its cap. The tuning applies to For you and
  to the Library's **Recommended** order. Saving draws For you anew and creates
  a new recommendation session for the current tab; other open tabs keep their
  snapshots until a new session is created. Tuning is stored for your account
  on the server and shared across devices.
- **Your recommendation activity** reports your own last 30 days of Library
  recommendations: how impressions turned into opens and plays, the marks and
  reshuffles given, and the affinity score distribution. For you draws are not
  counted.

In the demo, the settings are shown read-only.
