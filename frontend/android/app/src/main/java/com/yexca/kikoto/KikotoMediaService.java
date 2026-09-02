package com.yexca.kikoto;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.Objects;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class KikotoMediaService extends Service {
    public static final String ACTION_UPDATE = "com.yexca.kikoto.media.UPDATE";
    public static final String ACTION_STOP = "com.yexca.kikoto.media.STOP";
    public static final String ACTION_CONTROL = "com.yexca.kikoto.media.CONTROL";
    public static final String BROADCAST_CONTROL = "com.yexca.kikoto.media.BROADCAST_CONTROL";
    public static final String EXTRA_COMMAND = "command";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_ALBUM = "album";
    public static final String EXTRA_COVER_URL = "coverUrl";
    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_POSITION_MS = "positionMs";
    public static final String EXTRA_DURATION_MS = "durationMs";
    public static final String EXTRA_PLAYBACK_RATE = "playbackRate";
    public static final String EXTRA_CAN_PREVIOUS = "canPrevious";
    public static final String EXTRA_CAN_NEXT = "canNext";
    public static final String EXTRA_SEEK_BACKWARD_SECONDS = "seekBackwardSeconds";
    public static final String EXTRA_SEEK_FORWARD_SECONDS = "seekForwardSeconds";

    private static final String CHANNEL_ID = "kikoto_playback";
    private static final int NOTIFICATION_ID = 1001;
    private static final int MAX_COVER_BYTES = 8 * 1024 * 1024;
    private static final int MAX_COVER_DIMENSION = 8192;
    private static final long MAX_COVER_PIXELS = 32_000_000L;
    private static final int COVER_TARGET_SIZE = 512;

    private MediaSessionCompat mediaSession;
    private ExecutorService coverExecutor;
    private Handler mainHandler;
    private String title = "Kikoto";
    private String artist = "";
    private String album = "";
    private String coverUrl = "";
    private Bitmap coverBitmap;
    private int coverRequestVersion = 0;
    private boolean playing = false;
    private long positionMs = 0L;
    private long durationMs = 0L;
    private float playbackRate = 1.0F;
    private boolean canPrevious = false;
    private boolean canNext = false;
    private int seekBackwardSeconds = 10;
    private int seekForwardSeconds = 30;
    private boolean foregroundStarted = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        coverExecutor = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());
        mediaSession = new MediaSessionCompat(this, "Kikoto");
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setSessionActivity(PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class),
            pendingIntentFlags()
        ));
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                sendCommand("play");
            }

            @Override
            public void onPause() {
                sendCommand("pause");
            }

            @Override
            public void onSkipToNext() {
                sendCommand("next");
            }

            @Override
            public void onSkipToPrevious() {
                sendCommand("previous");
            }

            @Override
            public void onSeekTo(long pos) {
                Intent intent = new Intent(BROADCAST_CONTROL);
                intent.setPackage(getPackageName());
                intent.putExtra(EXTRA_COMMAND, "seekTo");
                intent.putExtra("positionMs", pos);
                sendBroadcast(intent);
            }

            @Override
            public void onRewind() {
                sendCommand("seekBackward");
            }

            @Override
            public void onFastForward() {
                sendCommand("seekForward");
            }
        });
        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? "" : intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopPlaybackService();
            return START_NOT_STICKY;
        }
        if (ACTION_CONTROL.equals(action)) {
            String command = intent.getStringExtra(EXTRA_COMMAND);
            if (command != null) sendCommand(command);
            return START_NOT_STICKY;
        }
        if (ACTION_UPDATE.equals(action) && intent != null) {
            String nextTitle = value(intent, EXTRA_TITLE, title);
            String nextArtist = value(intent, EXTRA_ARTIST, artist);
            String nextAlbum = value(intent, EXTRA_ALBUM, album);
            boolean nextPlaying = intent.getBooleanExtra(EXTRA_PLAYING, playing);
            long nextPositionMs = Math.max(0L, intent.getLongExtra(EXTRA_POSITION_MS, positionMs));
            long nextDurationMs = Math.max(0L, intent.getLongExtra(EXTRA_DURATION_MS, durationMs));
            float nextPlaybackRate = intent.getFloatExtra(EXTRA_PLAYBACK_RATE, playbackRate);
            boolean nextCanPrevious = intent.getBooleanExtra(EXTRA_CAN_PREVIOUS, canPrevious);
            boolean nextCanNext = intent.getBooleanExtra(EXTRA_CAN_NEXT, canNext);
            int nextSeekBackwardSeconds = boundedSeekSeconds(
                intent.getIntExtra(EXTRA_SEEK_BACKWARD_SECONDS, seekBackwardSeconds),
                seekBackwardSeconds
            );
            int nextSeekForwardSeconds = boundedSeekSeconds(
                intent.getIntExtra(EXTRA_SEEK_FORWARD_SECONDS, seekForwardSeconds),
                seekForwardSeconds
            );
            boolean textChanged = !Objects.equals(title, nextTitle)
                || !Objects.equals(artist, nextArtist)
                || !Objects.equals(album, nextAlbum);
            boolean coverChanged = updateCover(value(intent, EXTRA_COVER_URL, ""));
            boolean metadataChanged = textChanged || coverChanged || durationMs != nextDurationMs;
            boolean notificationChanged = textChanged
                || coverChanged
                || playing != nextPlaying
                || canPrevious != nextCanPrevious
                || canNext != nextCanNext
                || seekBackwardSeconds != nextSeekBackwardSeconds
                || seekForwardSeconds != nextSeekForwardSeconds;

            title = nextTitle;
            artist = nextArtist;
            album = nextAlbum;
            playing = nextPlaying;
            positionMs = nextPositionMs;
            durationMs = nextDurationMs;
            playbackRate = nextPlaybackRate;
            canPrevious = nextCanPrevious;
            canNext = nextCanNext;
            seekBackwardSeconds = nextSeekBackwardSeconds;
            seekForwardSeconds = nextSeekForwardSeconds;
            if (!foregroundStarted || metadataChanged) updateMediaMetadata();
            updatePlaybackState();
            if (!foregroundStarted || notificationChanged) publishNotification();
            return START_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        coverRequestVersion++;
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        if (coverExecutor != null) {
            coverExecutor.shutdownNow();
            coverExecutor = null;
        }
        foregroundStarted = false;
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, pendingIntentFlags());
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setLargeIcon(coverBitmap)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setShowWhen(false)
            .setStyle(new androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(mediaSession == null ? null : mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 2, 4));

        builder.addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_media_previous, "Previous", controlIntent("previous")).build());
        builder.addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_media_rew, "Back " + seekBackwardSeconds + "s", controlIntent("seekBackward")).build());
        builder.addAction(new NotificationCompat.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pause" : "Play", controlIntent(playing ? "pause" : "play")).build());
        builder.addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_media_ff, "Forward " + seekForwardSeconds + "s", controlIntent("seekForward")).build());
        builder.addAction(new NotificationCompat.Action.Builder(android.R.drawable.ic_media_next, "Next", controlIntent("next")).build());
        return builder.build();
    }

    private PendingIntent controlIntent(String command) {
        Intent intent = new Intent(this, KikotoMediaService.class);
        intent.setAction(ACTION_CONTROL);
        intent.putExtra(EXTRA_COMMAND, command);
        return PendingIntent.getService(this, command.hashCode(), intent, pendingIntentFlags());
    }

    private int boundedSeekSeconds(int value, int fallback) {
        return value >= 1 && value <= 300 ? value : fallback;
    }

    private int pendingIntentFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }

    private void updateMediaMetadata() {
        if (mediaSession == null) return;
        MediaMetadataCompat.Builder metadata = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, album);
        if (durationMs > 0) metadata.putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (coverBitmap != null) {
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ART, coverBitmap);
            metadata.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, coverBitmap);
        }
        mediaSession.setMetadata(metadata.build());
    }

    private void updatePlaybackState() {
        if (mediaSession == null) return;
        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SEEK_TO
            | PlaybackStateCompat.ACTION_REWIND
            | PlaybackStateCompat.ACTION_FAST_FORWARD;
        if (canPrevious) actions |= PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS;
        if (canNext) actions |= PlaybackStateCompat.ACTION_SKIP_TO_NEXT;
        int state = playing ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        float speed = playing ? Math.max(0.25F, playbackRate) : 0F;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(state, positionMs, speed)
            .build());
    }

    private void sendCommand(String command) {
        Intent intent = new Intent(BROADCAST_CONTROL);
        intent.setPackage(getPackageName());
        intent.putExtra(EXTRA_COMMAND, command);
        sendBroadcast(intent);
    }

    private void stopPlaybackService() {
        coverRequestVersion++;
        playing = false;
        updatePlaybackState();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        foregroundStarted = false;
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Kikoto playback", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Playback controls for Kikoto");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private boolean updateCover(String nextCoverUrl) {
        if (Objects.equals(coverUrl, nextCoverUrl)) return false;
        coverUrl = nextCoverUrl;
        coverBitmap = null;
        int requestVersion = ++coverRequestVersion;
        if (coverUrl.isEmpty() || coverExecutor == null) return true;
        String requestedCoverUrl = coverUrl;
        coverExecutor.execute(() -> {
            Bitmap bitmap = downloadCover(requestedCoverUrl);
            if (bitmap == null || mainHandler == null) return;
            mainHandler.post(() -> {
                if (requestVersion != coverRequestVersion) return;
                coverBitmap = bitmap;
                updateMediaMetadata();
                publishNotification();
            });
        });
        return true;
    }

    private void publishNotification() {
        Notification notification = buildNotification();
        if (!foregroundStarted) {
            startForeground(NOTIFICATION_ID, notification);
            foregroundStarted = true;
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, notification);
    }

    private Bitmap downloadCover(String sourceUrl) {
        try (KikotoAssetTransport.Response response = KikotoAssetTransport.open(
            sourceUrl,
            "GET",
            Collections.emptyMap()
        )) {
            if (response.status() < 200 || response.status() >= 300) return null;
            return decodeCover(readBounded(response.body(), MAX_COVER_BYTES));
        } catch (Exception ignored) {
            return null;
        }
    }

    private static byte[] readBounded(InputStream input, int maxBytes) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(Math.min(maxBytes, 64 * 1024));
        byte[] buffer = new byte[16 * 1024];
        int total = 0;
        int count;
        while ((count = input.read(buffer)) >= 0) {
            if (count == 0) continue;
            if (count > maxBytes - total) throw new IOException("Cover image exceeds the size limit.");
            output.write(buffer, 0, count);
            total += count;
        }
        return output.toByteArray();
    }

    private static Bitmap decodeCover(byte[] data) {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
        if (
            bounds.outWidth <= 0 ||
            bounds.outHeight <= 0 ||
            bounds.outWidth > MAX_COVER_DIMENSION ||
            bounds.outHeight > MAX_COVER_DIMENSION ||
            (long) bounds.outWidth * bounds.outHeight > MAX_COVER_PIXELS
        ) {
            return null;
        }
        BitmapFactory.Options options = new BitmapFactory.Options();
        int sampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / sampleSize > COVER_TARGET_SIZE * 2) {
            sampleSize *= 2;
        }
        options.inSampleSize = sampleSize;
        return scaleCover(BitmapFactory.decodeByteArray(data, 0, data.length, options));
    }

    private static Bitmap scaleCover(Bitmap bitmap) {
        if (bitmap == null) return null;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int maxSide = Math.max(width, height);
        if (maxSide <= COVER_TARGET_SIZE) return bitmap;
        float scale = (float) COVER_TARGET_SIZE / maxSide;
        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), true);
        if (scaled != bitmap) bitmap.recycle();
        return scaled;
    }

    private static String value(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
