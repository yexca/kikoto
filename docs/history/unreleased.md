# Unreleased

<details>
<summary><strong>Interface</strong></summary>

- The Android app leaves exactly one status bar's height above the header, on
  every Android and WebView version, instead of counting the status bar twice
  on some phones.

</details>

<details>
<summary><strong>Library and work detail</strong></summary>

- Video in the file viewer has its own on-screen controls on every device:
  back and forward by the seek steps from Settings, play and pause, a seek bar
  that shows what has buffered, Subtitles and Playback speed menus, Mute, Full
  screen, and picture in picture and AirPlay where the browser offers them. On
  a touch screen a tap shows or hides them and a double tap on either side
  seeks, adding a step for each further quick tap; with a mouse a click plays
  or pauses and a double click switches fullscreen. Fullscreen keeps the
  controls, except on iPhone and iPad, which still use the system player.
- A video shows one subtitle track at a time. A track the browser turns on by
  itself, such as one in the device language, is switched off instead of
  showing beside the chosen track and extracting its stream from the video.

</details>

<details>
<summary><strong>Workflows and Activity</strong></summary>

- A selected workflow shows one **Latest run** card in place of the run
  summary, success rate, typical duration, run monitor, and Recent runs list.
  The card states the latest run's status, number, time, and duration, lists
  its stages, and keeps its log folded after a success; the log opens by
  itself while a run is active and after a failed or partial run. The run
  history bars close the card, and **All runs** opens Activity with only that
  workflow's runs. The header leaves out the category and step count.
- The Workflows status strip shows what is running and what needs attention,
  and leaves a workflow's next start to its triggers. Every workflow in the
  list is one line, with the latest run as a dot on its icon. The ranking pulls,
  Availability Watch, and the subscription refresh, which are configured on
  the Discover page, form their own Discover group at the end of the list.
- Activity is the first entry of the workflow list instead of a popover over
  the page. It replaces the selected workflow with every run, shows a run's
  details beside the list on wide screens, and opens like a workflow on
  phones; the status strip drops its separate Activity button. Starting a run
  keeps its workflow open, where the Latest run card reports it.

</details>

<details>
<summary><strong>Operations and reliability</strong></summary>

- Automatic database cleanup of expired sessions, old workflow runs, and old
  ranking history runs shortly after the server starts and then every 10 days
  instead of every day.

</details>
