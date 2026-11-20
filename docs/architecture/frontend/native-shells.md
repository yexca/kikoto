# Native Shells

What the Android and iOS shells add around the web app: media controls and
screen lyrics, asset and session credentials, device privacy, and version
states.

## Media Controls and Screen Lyrics

Keep high-frequency playback position out of bridge and notification rebuild
paths. Browser time rendering is sampled, Android bridge updates are
coalesced and periodically calibrated, and the Android build does not register
a second browser Media Session. Native media controls exist only on Android;
the iOS shell keeps the WebView Media Session.

Screen lyrics use a native surface in both shells, chosen by registered
capability (`lib/nativeLyricsOverlay`): the Android overlay, or on iOS an
app-local Picture-in-Picture plugin that draws the current line into an
`AVSampleBufferDisplayLayer`, because WKWebView reports no web
Picture-in-Picture and rejects `requestPictureInPicture`. Both receive the
timed track once plus playback corrections and advance lines on their own
clock, so they stay in sync while the web view is in the background. The
Picture-in-Picture window's play and pause go back to the web player rather
than to a second media session. When the track length is known, the iOS
window drives its layer timebase from the playback position, so the system
shows progress and skip buttons; a skip moves the lines at once and reports
the new absolute position to the web player's `seekTo`. iOS chooses the skip
interval, and without a known length the window stays live with play and
pause only. The Android overlay payload carries no duration. iOS composites
Picture-in-Picture frames as opaque video, so the window cannot be
transparent; it uses a wide 4:1 frame to cover less of the screen and draws a
gradient from the active theme's background, foreground, and primary tokens,
which the web side resolves to `#rrggbb` when it opens the window. Missing or
malformed colors fall back to the dark default.

The Android media notification redacts itself natively while the device is
locked. The iOS lock screen and Control Center read the page's Media
Session, which cannot tell a locked device, so on iOS the Media Session
takes its text and artwork from `systemMediaDetails` with the device's
media controls choice at all times. A browser Media Session shows
everything.

## Credentials and Assets

Native shells attach the session credential to media and image requests on
the configured server, limited to fixed cover, manual, media, and HLS routes.
Android intercepts those WebView requests. WKWebView cannot intercept its own
http(s) requests, so `assetURL` rewrites the same routes to the app-owned
`kikoto-asset://asset` scheme on iOS, and the native handler re-validates
each route and redirect hop before streaming from the configured origin.
When the asset transport session is removed or replaced, or the server
changes, the Android shell clears the WebView HTTP cache.

Native shells hold the bearer session in memory and in a native credential
store, never in WebView storage (`lib/nativeSessionCredential`): the iOS
Keychain with after-first-unlock, this-device-only access, or Android's
private app preferences. iOS hydration moves a session found in app
preferences into the Keychain, and removes a Keychain session when no server
is configured, because Keychain items outlive app removal.

## Device Privacy

The device privacy settings (`lib/nativePrivacy`) are one contract that both
native shells implement through their `KikotoPrivacy` plugin, and they live in
native storage rather than account-scoped browser storage, because the recent
apps or app switcher cover, the capture cover, the app lock, and the media
notification apply them without the web view. The plugin's status declares
whether the shell offers the app lock; only Android does. The app lock is
native: it covers the window and authenticates through the system biometric or
device credential prompt, storing no secret of its own; the web app only
supplies its localized prompt labels.

On Android 13 and later, the recent apps choice uses the task-preview API and
does not affect other capture paths. On Android 12 and earlier, it protects the
activity window with `FLAG_SECURE`, so it also blocks screenshots, screen
recording, and casting, including in split-screen and freeform windows. The
floating lyrics window follows `screenSecure` independently.

The iOS privacy plugin covers the scene with a blur window while it is
inactive (the recent apps choice) and while its scene capture state is
active (the screen capture choice). iOS cannot block a screenshot and gives
no warning before one, so the window's root controller hosts the bridge
inside the text canvas of a secure text field, the view the system leaves
out of captures, and the screen capture choice switches that field's secure
entry: a screenshot shows the root background in place of the page. The
plugin's status declares whether the canvas exists; without it the choice
only covers captures, and Settings names it accordingly.
A capture that begins also closes the Picture-in-Picture lyrics window. The
same plugin pauses page media when the audio route loses its output device,
as Android does on `ACTION_AUDIO_BECOMING_NOISY`, and reports whether the
device speaker is the output.

## Version States

Distinguish native client-old, server-old, and network-disconnected states;
version actions open signed GitHub Releases and never imply silent install.
The client kind shown in the account panel, version messages, and copied
diagnostics comes from the running shell (`Capacitor.getPlatform()`), so the
iOS shell reports `ios` and Android keeps `android`. Every shell runs the same
bundle version, so `minAndroidClientVersion` (falling back to
`minClientVersion`) remains the shared minimum.
