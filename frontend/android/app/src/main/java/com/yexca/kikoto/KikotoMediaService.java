package com.yexca.kikoto;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.annotation.Nullable;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
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

    private static final String CHANNEL_ID = "kikoto_playback";
    private static final int NOTIFICATION_ID = 1001;

    private MediaSession mediaSession;
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

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        coverExecutor = Executors.newSingleThreadExecutor();
        mainHandler = new Handler(Looper.getMainLooper());
        mediaSession = new MediaSession(this, "Kikoto");
        mediaSession.setCallback(new MediaSession.Callback() {
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
            title = value(intent, EXTRA_TITLE, title);
            artist = value(intent, EXTRA_ARTIST, artist);
            album = value(intent, EXTRA_ALBUM, album);
            updateCover(value(intent, EXTRA_COVER_URL, ""));
            playing = intent.getBooleanExtra(EXTRA_PLAYING, playing);
            positionMs = Math.max(0L, intent.getLongExtra(EXTRA_POSITION_MS, positionMs));
            durationMs = Math.max(0L, intent.getLongExtra(EXTRA_DURATION_MS, durationMs));
            playbackRate = intent.getFloatExtra(EXTRA_PLAYBACK_RATE, playbackRate);
            canPrevious = intent.getBooleanExtra(EXTRA_CAN_PREVIOUS, canPrevious);
            canNext = intent.getBooleanExtra(EXTRA_CAN_NEXT, canNext);
            updateMediaSession();
            startForeground(NOTIFICATION_ID, buildNotification());
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
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, pendingIntentFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setContentIntent(contentIntent)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setLargeIcon(coverBitmap)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setShowWhen(false)
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(mediaSession == null ? null : mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 2, 4));

        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Previous", controlIntent("previous")).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_rew, "Back 5s", controlIntent("seekBackward")).build());
        builder.addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pause" : "Play", controlIntent(playing ? "pause" : "play")).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_ff, "Forward 10s", controlIntent("seekForward")).build());
        builder.addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Next", controlIntent("next")).build());
        return builder.build();
    }

    private PendingIntent controlIntent(String command) {
        Intent intent = new Intent(this, KikotoMediaService.class);
        intent.setAction(ACTION_CONTROL);
        intent.putExtra(EXTRA_COMMAND, command);
        return PendingIntent.getService(this, command.hashCode(), intent, pendingIntentFlags());
    }

    private int pendingIntentFlags() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        return flags;
    }

    private void updateMediaSession() {
        if (mediaSession == null) return;
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        if (durationMs > 0) metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (coverBitmap != null) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, coverBitmap);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, coverBitmap);
        }
        mediaSession.setMetadata(metadata.build());

        long actions = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_REWIND
            | PlaybackState.ACTION_FAST_FORWARD;
        if (canPrevious) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        if (canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        int state = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
        float speed = playing ? Math.max(0.25F, playbackRate) : 0F;
        mediaSession.setPlaybackState(new PlaybackState.Builder()
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
        updateMediaSession();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Kikoto playback", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Playback controls for Kikoto");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private void updateCover(String nextCoverUrl) {
        if (Objects.equals(coverUrl, nextCoverUrl)) return;
        coverUrl = nextCoverUrl;
        coverBitmap = null;
        int requestVersion = ++coverRequestVersion;
        if (coverUrl.isEmpty() || coverExecutor == null) return;
        String requestedCoverUrl = coverUrl;
        coverExecutor.execute(() -> {
            Bitmap bitmap = downloadCover(requestedCoverUrl);
            if (bitmap == null || mainHandler == null) return;
            mainHandler.post(() -> {
                if (requestVersion != coverRequestVersion) return;
                coverBitmap = bitmap;
                updateMediaSession();
                startForeground(NOTIFICATION_ID, buildNotification());
            });
        });
    }

    private Bitmap downloadCover(String sourceUrl) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL(sourceUrl);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(10000);
            connection.setInstanceFollowRedirects(true);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) return null;
            try (InputStream input = connection.getInputStream()) {
                return scaleCover(BitmapFactory.decodeStream(input));
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static Bitmap scaleCover(Bitmap bitmap) {
        if (bitmap == null) return null;
        int width = bitmap.getWidth();
        int height = bitmap.getHeight();
        int maxSide = Math.max(width, height);
        if (maxSide <= 512) return bitmap;
        float scale = 512F / maxSide;
        Bitmap scaled = Bitmap.createScaledBitmap(bitmap, Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)), true);
        if (scaled != bitmap) bitmap.recycle();
        return scaled;
    }

    private static String value(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
