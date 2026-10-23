package com.gathin.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;

/**
 * The TV's line to the HELPER server: one WebSocket to /bridge/tv, dialled out with the bridge token, so the TV
 * listens for nothing. Lives inside InputKeyService, which Android keeps running (a plain background service would
 * be stopped a minute after another app comes to the front). Reconnects with a growing pause, up to a minute.
 */
final class HelperLink {

    private static final String TAG = "HelperLink";
    private final AccessibilityService service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient client = new OkHttpClient.Builder()
            .pingInterval(30, TimeUnit.SECONDS)
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    private WebSocket socket;
    private long backoffMs = 2000;
    private boolean stopped;

    HelperLink(AccessibilityService service) {
        this.service = service;
    }

    void start() {
        stopped = false;
        connect();
    }

    void stop() {
        stopped = true;
        main.removeCallbacksAndMessages(null);
        if (socket != null) socket.close(1000, "bye");
        socket = null;
    }

    /** After new settings from the computer: drop the old line and dial again now. */
    void restart() {
        if (socket != null) socket.cancel();
        socket = null;
        backoffMs = 2000;
        main.removeCallbacksAndMessages(null);
        connect();
    }

    private void connect() {
        if (stopped || socket != null) return;
        if (!Helper.configured(service)) return;
        String base = Helper.url(service);
        String ws = base.startsWith("https://") ? "wss://" + base.substring(8) : "ws://" + base.substring(7);
        Request req = new Request.Builder().url(ws + "/bridge/tv")
                .addHeader("Authorization", "Bearer " + Helper.token(service)).build();
        socket = client.newWebSocket(req, new Listener());
    }

    private void retry() {
        socket = null;
        if (stopped) return;
        main.postDelayed(this::connect, backoffMs);
        backoffMs = Math.min(60000, backoffMs * 2);
    }

    private class Listener extends WebSocketListener {
        @Override
        public void onOpen(WebSocket ws, Response response) {
            backoffMs = 2000;
            try {
                ws.send(new JSONObject().put("type", "hello").put("device", Build.MODEL).put("version", "2.6-helper").toString());
            } catch (Exception ignored) { }
            Log.i(TAG, "connected");
        }

        @Override
        public void onMessage(WebSocket ws, String text) {
            main.post(() -> answer(ws, text));
        }

        @Override
        public void onClosed(WebSocket ws, int code, String reason) {
            if (ws == socket) retry();
        }

        @Override
        public void onFailure(WebSocket ws, Throwable t, Response response) {
            Log.w(TAG, "link failed: " + t.getMessage());
            if (ws == socket) main.post(HelperLink.this::retry);
        }
    }

    private void answer(WebSocket ws, String text) {
        JSONObject reply = new JSONObject();
        try {
            JSONObject msg = new JSONObject(text);
            reply.put("id", msg.optInt("id"));
            JSONObject args = msg.optJSONObject("args");
            if (args == null) args = new JSONObject();
            reply.put("result", run(msg.optString("op"), args));
            reply.put("ok", true);
        } catch (Exception e) {
            try {
                reply.put("ok", false).put("error", e.getMessage() == null ? e.toString() : e.getMessage());
            } catch (Exception ignored) { }
        }
        ws.send(reply.toString());
    }

    private JSONObject run(String op, JSONObject args) throws Exception {
        AudioManager audio = (AudioManager) service.getSystemService(Context.AUDIO_SERVICE);
        switch (op) {
            case "apps": return new JSONObject().put("apps", apps(service));
            case "state": {
                String pkg = InputKeyService.currentPackage;
                int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int vol = audio.getStreamVolume(AudioManager.STREAM_MUSIC);
                return new JSONObject().put("pkg", pkg == null ? "" : pkg).put("label", label(service, pkg))
                        .put("volume", max > 0 ? Math.round(100f * vol / max) : 0)
                        .put("muted", audio.isStreamMute(AudioManager.STREAM_MUSIC));
            }
            case "open_app": {
                String pkg = args.optString("pkg");
                if (!Helper.openApp(service, pkg)) throw new Exception("האפליקציה " + pkg + " לא נפתחת");
                return new JSONObject();
            }
            case "key": {
                int times = Math.max(1, Math.min(20, args.optInt("times", 1)));
                for (int i = 0; i < times; i++) key(audio, args.optString("key"));
                return new JSONObject();
            }
            case "volume": {
                int max = audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
                int level = Math.max(0, Math.min(100, args.optInt("level")));
                audio.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(max * level / 100f), AudioManager.FLAG_SHOW_UI);
                return new JSONObject().put("level", level);
            }
            case "buttons": {
                JSONObject map = new JSONObject();
                for (String name : Helper.BUTTONS.keySet()) map.put(name, Helper.buttonApp(service, name));
                return map;
            }
            case "set_button": {
                String name = args.optString("button");
                if (!Helper.BUTTONS.containsKey(name)) throw new Exception("אין כפתור " + name);
                Helper.setButtonApp(service, name, args.optString("pkg"));
                return new JSONObject();
            }
            case "show":
                HelperOverlayActivity.open(service, "show", args.optString("text"));
                return new JSONObject();
            default:
                throw new Exception("פעולה לא מוכרת: " + op);
        }
    }

    private void key(AudioManager audio, String key) throws Exception {
        switch (key) {
            case "home": service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME); return;
            case "back": service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK); return;
            case "sleep": service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN); return;
            case "mute": audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI); return;
            case "volume_up": audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI); return;
            case "volume_down": audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI); return;
            default: break;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            int dpad = key.equals("up") ? AccessibilityService.GLOBAL_ACTION_DPAD_UP
                    : key.equals("down") ? AccessibilityService.GLOBAL_ACTION_DPAD_DOWN
                    : key.equals("left") ? AccessibilityService.GLOBAL_ACTION_DPAD_LEFT
                    : key.equals("right") ? AccessibilityService.GLOBAL_ACTION_DPAD_RIGHT
                    : key.equals("ok") ? AccessibilityService.GLOBAL_ACTION_DPAD_CENTER : 0;
            if (dpad != 0) { service.performGlobalAction(dpad); return; }
        }
        int media = key.equals("play_pause") ? KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
                : key.equals("play") ? KeyEvent.KEYCODE_MEDIA_PLAY
                : key.equals("pause") ? KeyEvent.KEYCODE_MEDIA_PAUSE
                : key.equals("stop") ? KeyEvent.KEYCODE_MEDIA_STOP
                : key.equals("next") ? KeyEvent.KEYCODE_MEDIA_NEXT
                : key.equals("previous") ? KeyEvent.KEYCODE_MEDIA_PREVIOUS
                : key.equals("rewind") ? KeyEvent.KEYCODE_MEDIA_REWIND
                : key.equals("fast_forward") ? KeyEvent.KEYCODE_MEDIA_FAST_FORWARD : 0;
        if (media == 0) throw new Exception("הכפתור " + key + " לא נתמך בטלוויזיה הזו");
        long now = SystemClock.uptimeMillis();
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, media, 0));
        audio.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, media, 0));
    }

    /** Every app with a TV or phone launcher entry, once each. */
    static JSONArray apps(Context c) throws Exception {
        PackageManager pm = c.getPackageManager();
        JSONArray out = new JSONArray();
        Set<String> seen = new HashSet<>();
        for (String category : new String[]{Intent.CATEGORY_LEANBACK_LAUNCHER, Intent.CATEGORY_LAUNCHER}) {
            List<ResolveInfo> list = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(category), 0);
            for (ResolveInfo ri : list) {
                String pkg = ri.activityInfo.packageName;
                if (pkg.equals(c.getPackageName()) || !seen.add(pkg)) continue;
                out.put(new JSONObject().put("pkg", pkg).put("label", String.valueOf(ri.loadLabel(pm))));
            }
        }
        return out;
    }

    static String label(Context c, String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        try {
            ApplicationInfo ai = c.getPackageManager().getApplicationInfo(pkg, 0);
            return String.valueOf(c.getPackageManager().getApplicationLabel(ai));
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }
}
