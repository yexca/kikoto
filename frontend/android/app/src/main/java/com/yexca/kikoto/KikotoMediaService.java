package com.yexca.kikoto;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

public class KikotoMediaService extends Service {
    public static final String ACTION_UPDATE = "com.yexca.kikoto.media.UPDATE";
    public static final String ACTION_STOP = "com.yexca.kikoto.media.STOP";
    public static final String ACTION_CONTROL = "com.yexca.kikoto.media.CONTROL";
    public static final String BROADCAST_CONTROL = "com.yexca.kikoto.media.BROADCAST_CONTROL";
    public static final String EXTRA_COMMAND = "command";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_ARTIST = "artist";
    public static final String EXTRA_ALBUM = "album";
    public static final String EXTRA_PLAYING = "playing";
    public static final String EXTRA_POSITION_MS = "positionMs";
    public static final String EXTRA_DURATION_MS = "durationMs";
    public static final String EXTRA_PLAYBACK_RATE = "playbackRate";
    public static final String EXTRA_CAN_PREVIOUS = "canPrevious";
    public static final String EXTRA_CAN_NEXT = "canNext";

    private static final String CHANNEL_ID = "kikoto_playback";
    private static final int NOTIFICATION_ID = 1001;

    private MediaSession mediaSession;
    private String title = "Kikoto";
    private String artist = "";
    private String album = "";
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
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    private Notification buildNotification() {
        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, pendingIntentFlags());
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title)
            .setContentText(artist)
            .setSubText(album)
            .setContentIntent(contentIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setShowWhen(false);

        builder.addAction(android.R.drawable.ic_media_previous, "Previous", controlIntent("previous"));
        builder.addAction(android.R.drawable.ic_media_rew, "Back 5s", controlIntent("seekBackward"));
        builder.addAction(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, playing ? "Pause" : "Play", controlIntent(playing ? "pause" : "play"));
        builder.addAction(android.R.drawable.ic_media_ff, "Forward 10s", controlIntent("seekForward"));
        builder.addAction(android.R.drawable.ic_media_next, "Next", controlIntent("next"));
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

    private static String value(Intent intent, String key, String fallback) {
        String value = intent.getStringExtra(key);
        return value == null || value.trim().isEmpty() ? fallback : value;
    }
}
