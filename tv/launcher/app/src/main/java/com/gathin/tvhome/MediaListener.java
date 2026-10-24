package com.gathin.tvhome;

import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.service.notification.NotificationListenerService;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Notes what plays in the streaming apps, for Continue watching: Netflix, Disney+ and YouTube don't share their
 * history, but while a title plays each app tells the system what it is (its media session: title, episode, artwork,
 * position). This listener (enabled with `cmd notification allow_listener`) keeps the last ones, newest first.
 * Stremio is left out: its history comes from the account (Stremio.java).
 */
public class MediaListener extends NotificationListenerService {

    static final String PREFS = "played";
    private static final int MAX = 20;
    private static final long SAVE_EVERY_MS = 30_000;
    /** Apps whose titles are worth remembering; others (music, the TV's own) are not "watching". */
    static final String[] APPS = {"com.netflix.ninja", "com.disneyplus.mea", "com.disney.disneyplus",
            "com.google.android.youtube.tv"};

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<MediaController, MediaController.Callback> watched = new HashMap<>();
    private MediaSessionManager msm;
    private final MediaSessionManager.OnActiveSessionsChangedListener sessions = this::watch;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            for (MediaController mc : watched.keySet()) save(mc);
            handler.postDelayed(this, SAVE_EVERY_MS);
        }
    };

    @Override
    public void onListenerConnected() {
        msm = getSystemService(MediaSessionManager.class);
        ComponentName me = new ComponentName(this, MediaListener.class);
        try {
            msm.addOnActiveSessionsChangedListener(sessions, me, handler);
            watch(msm.getActiveSessions(me));
        } catch (SecurityException ignored) { }
        handler.postDelayed(tick, SAVE_EVERY_MS);
    }

    @Override
    public void onListenerDisconnected() {
        handler.removeCallbacks(tick);
        if (msm != null) msm.removeOnActiveSessionsChangedListener(sessions);
        for (Map.Entry<MediaController, MediaController.Callback> e : watched.entrySet()) e.getKey().unregisterCallback(e.getValue());
        watched.clear();
    }

    private void watch(List<MediaController> list) {
        if (list == null) return;
        for (MediaController mc : list) {
            if (!wanted(mc.getPackageName())) continue;
            boolean known = false;
            for (MediaController w : watched.keySet()) if (w.getSessionToken().equals(mc.getSessionToken())) known = true;
            if (known) continue;
            MediaController.Callback cb = new MediaController.Callback() {
                @Override public void onMetadataChanged(MediaMetadata m) { save(mc); }
                @Override public void onPlaybackStateChanged(PlaybackState s) {
                    if (s != null && s.getState() != PlaybackState.STATE_BUFFERING) save(mc);
                }
                @Override public void onSessionDestroyed() {
                    save(mc);
                    mc.unregisterCallback(this);
                    watched.remove(mc);
                }
            };
            mc.registerCallback(cb, handler);
            watched.put(mc, cb);
            save(mc);
        }
    }

    private static boolean wanted(String pkg) {
        for (String a : APPS) if (a.equals(pkg)) return true;
        return false;
    }

    /** Records the session's title, episode, artwork and position, first in the list. */
    private void save(MediaController mc) {
        MediaMetadata m = mc.getMetadata();
        PlaybackState st = mc.getPlaybackState();
        if (m == null) return;
        String title = text(m, MediaMetadata.METADATA_KEY_DISPLAY_TITLE, MediaMetadata.METADATA_KEY_TITLE);
        if (title.isEmpty()) return;
        String sub = text(m, MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, MediaMetadata.METADATA_KEY_ARTIST);
        long duration = m.getLong(MediaMetadata.METADATA_KEY_DURATION);
        long position = 0;
        boolean playing = false;
        if (st != null) {
            position = st.getPosition();
            playing = st.getState() == PlaybackState.STATE_PLAYING;
            if (playing && st.getLastPositionUpdateTime() > 0) {
                position += (long) ((SystemClock.elapsedRealtime() - st.getLastPositionUpdateTime()) * st.getPlaybackSpeed());
            }
        }
        String pkg = mc.getPackageName();
        String key = pkg + "|" + title;
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray old = new JSONArray(prefs.getString("list", "[]"));
            JSONObject prev = null;
            for (int i = 0; i < old.length(); i++) if (key.equals(old.getJSONObject(i).optString("key"))) prev = old.getJSONObject(i);
            // Not playing and nothing played yet (a paused app restoring its last title): leave the order alone.
            if (!playing && prev == null && position <= 0) return;
            String art = prev != null ? prev.optString("art") : "";
            Bitmap bmp = m.getBitmap(MediaMetadata.METADATA_KEY_ART);
            if (bmp == null) bmp = m.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
            if (bmp == null) bmp = m.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
            if (bmp != null) art = saveArt(key, bmp);
            else {
                String uri = text(m, MediaMetadata.METADATA_KEY_ART_URI, MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI);
                if (uri.startsWith("http")) art = uri;
            }
            JSONObject o = new JSONObject().put("key", key).put("pkg", pkg).put("title", title).put("sub", sub)
                    .put("art", art).put("position", position).put("duration", duration)
                    .put("time", System.currentTimeMillis());
            JSONArray next = new JSONArray().put(o);
            for (int i = 0; i < old.length() && next.length() < MAX; i++) {
                if (!key.equals(old.getJSONObject(i).optString("key"))) next.put(old.getJSONObject(i));
            }
            prefs.edit().putString("list", next.toString()).apply();
        } catch (Exception ignored) { }
    }

    private String saveArt(String key, Bitmap bmp) {
        File dir = new File(getFilesDir(), "played");
        dir.mkdirs();
        File f = new File(dir, Integer.toHexString(key.hashCode()) + ".jpg");
        try (FileOutputStream out = new FileOutputStream(f)) {
            Bitmap small = bmp.getWidth() > 640 ? Bitmap.createScaledBitmap(bmp, 640, Math.round(bmp.getHeight() * 640f / bmp.getWidth()), true) : bmp;
            small.compress(Bitmap.CompressFormat.JPEG, 85, out);
        } catch (Exception ignored) { }
        return f.getAbsolutePath();
    }

    private static String text(MediaMetadata m, String... keys) {
        for (String k : keys) {
            CharSequence s = m.getText(k);
            if (s != null && s.toString().trim().length() > 0) return s.toString().trim();
        }
        return "";
    }

    /** The titles played lately in Netflix, Disney+ and YouTube, newest first, as Continue watching cards. */
    static List<Titles.Title> played(Context c) {
        List<Titles.Title> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(c.getSharedPreferences(PREFS, MODE_PRIVATE).getString("list", "[]"));
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                long dur = o.optLong("duration"), pos = o.optLong("position");
                // Watched to the end (or nearly): not something to continue.
                if (dur > 0 && pos > dur * 0.95) continue;
                Titles.Title t = new Titles.Title(o.optString("key"), "played", o.optString("title"), o.optString("art"), "", "", "");
                t.pkg = o.optString("pkg");
                t.time = o.optLong("time");
                t.progress = dur > 0 && pos > 0 ? Math.min(1f, pos / (float) dur) : -1f;
                String sub = o.optString("sub");
                t.sub = sub.isEmpty() ? null : sub;
                out.add(t);
            }
        } catch (Exception ignored) { }
        return out;
    }

    /** Takes a title off Continue watching. */
    static void forget(Context c, String key) {
        try {
            SharedPreferences prefs = c.getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray a = new JSONArray(prefs.getString("list", "[]"));
            JSONArray next = new JSONArray();
            for (int i = 0; i < a.length(); i++) if (!key.equals(a.getJSONObject(i).optString("key"))) next.put(a.getJSONObject(i));
            prefs.edit().putString("list", next.toString()).apply();
        } catch (Exception ignored) { }
    }
}
