# Record

How the Record surface browses the record root, plays its videos, photos, and
audio, and deletes its files; the backend side is
[Record Library](../record-library.md).

## Browsing

`features/records` owns the Record surface and the Record section of
System → Library, which turns Record on and initializes the independent record
root. The navigation offers Record only while the runtime settings report it
on. The browser walks the root one folder at a time, showing subfolders,
videos, and photos in the natural name order the listing arrives in, and
lists the folder's audio, subtitle, metadata, and other files below them,
where audio rows open the player. A visit reads the first page of each
section; the end of a section with more to read reads the next page as it
nears the viewport, and again while it stays near, and offers Retry when a
page fails. A refresh reads each section again as far as it was read. A
section heading counts the whole section.

The `/records` URL keeps the open folder and an open video (`?play=`) or photo
(`?photo=`). Opening a folder or an overlay pushes a history entry; previous or
next inside an overlay replaces it; closing an overlay the page opened goes
back, and closing one opened from a pasted link replaces it with its folder.
Each entry carries the breadcrumb trail, which shows until the folder's
listing arrives with the trail the server names; a pasted folder link takes
its trail from that listing.

The single-row header places the breadcrumb on the left and the Continue
watching picker and Scan (or Refresh without `library:write`) on the right.
Scan follows the queued run through the root's scan generation and
last-scanned time with bounded polling. Tiles show the server's thumbnails,
falling back to an icon for a video and to the full image for a photo, and the
folder's artwork images stay out of the photos. Group headings appear only when
a folder contains more than one kind of item. Saved progress arrives with the
folder listing; the positions the video player and the global player save
during the visit overlay it, so tiles update without reading the folder again.

The Continue watching picker lists the viewer's unfinished videos and audio
files in a popover on wide screens or a sheet on phones. It opens a video over
its own folder in a new entry, resuming without asking, so closing it returns
to the folder where it was opened; an audio file opens its folder and plays
once that listing arrives.

## Video and Photo Overlays

The full-screen Record video player plays videos in the shared full-screen
layout of the [work video player](player-and-video.md#video-player): it asks
whether to continue from a saved position, reads Record playback info while it
asks, plays the chosen source, and asks for a transcode after a direct file or
a remux fails to decode. It saves progress every ten seconds, on pause, at the
end, and when it closes. A same-name subtitle sidecar the server serves as
WebVTT is the video's sidecar track, a WebVTT file before a SubRip one, and
embedded text subtitles from playback info follow it.

Both overlays place their file in its whole section through the siblings
route, so the position, count, and previous and next files cover pages the
folder has not read yet; until it answers, the listed files stand in. The
photo viewer steps through photos by button, arrow key, or touch swipe and
shows each photo in the shared zoomable stage of the work file viewer. Both
overlays are modal dialogs over authenticated asset routes; a record video that
starts playing pauses the global audio player, and pauses when that player
starts again.

## Record Audio

Record audio plays in the global audio player. A Record track carries `record`
(the asset and its folder), a negative location id apart from library
locations, the `record` location type, the folder's name as its subtitle, and
the asset's thumbnail as its cover, which for an audio file is its embedded
cover art and otherwise absent. Selecting an audio row queues the folder's
audio files; **Play as audio** in the video player queues the folder's videos
as sound from the position the video reached and closes the overlay. The
files already listed play at once and the section's later pages join the
queue as they arrive, unless something else plays by then. Such a
track has no work, so listening history, lyrics, queue restoration, and
display-name refresh skip it, and the cover leads to its Record folder instead
of a work.

## Deleting

The Record video player keeps its actions in a row under the stage: **Play as
audio** and an action menu. For an account with `downloads:manage`, that
menu, one at the top of the photo viewer, one at the end of each file row,
which is narrowed to a readable width, and one beside each folder tile's name
hold Delete. The delete dialog renders outside the overlay, so its keys never
reach the viewer, and the media overlay leaves Escape to a dialog opened over
it. The dialog is the shared two-step delete review (`components/delete-review`)
that work detail's media batch delete also uses; it shows only the path inside
the record root. Once the item is in the trash, the tracks of the files removed
leave the global player queue, an open viewer steps to the next sibling, or
the previous one, or closes, and the folder and Continue watching list load
again.
