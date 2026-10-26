package com.gathin.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.graphics.Rect;
import android.os.Bundle;
import android.util.Base64;
import android.view.Display;
import android.view.accessibility.AccessibilityNodeInfo;
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

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
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
    /** What the last "observe" listed, by index, for "act". */
    private final List<AccessibilityNodeInfo> lastNodes = new ArrayList<>();

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
                ws.send(new JSONObject().put("type", "hello").put("device", Build.MODEL).put("version", "2.7-helper").toString());
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
            if ("capture".equals(msg.optString("op"))) { capture(ws, msg.optInt("id"), args == null ? 960 : args.optInt("width", 960)); return; }
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
            case "open_url": {
                String url = args.optString("url");
                if (!Helper.openUrl(service, url, args.optString("pkg"))) throw new Exception("אין בטלוויזיה אפליקציה שפותחת את " + url);
                return new JSONObject();
            }
            case "observe": return observe();
            case "act": return act(args, audio);
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

    // ---- eyes and hands for the TV agent ----

    /** The screen as a numbered list: what can be read, focused, selected or typed into, with where it is. */
    private JSONObject observe() throws Exception {
        for (AccessibilityNodeInfo n : lastNodes) { try { n.recycle(); } catch (Exception ignored) { } }
        lastNodes.clear();
        JSONArray nodes = new JSONArray();
        AccessibilityNodeInfo root = service.getRootInActiveWindow();
        if (root != null) walk(root, nodes, 0);
        android.util.DisplayMetrics dm = service.getResources().getDisplayMetrics();
        String pkg = InputKeyService.currentPackage;
        return new JSONObject().put("nodes", nodes).put("pkg", pkg == null ? "" : pkg).put("label", label(service, pkg))
                .put("width", dm.widthPixels).put("height", dm.heightPixels);
    }

    private void walk(AccessibilityNodeInfo n, JSONArray out, int depth) throws Exception {
        if (n == null || depth > 40 || out.length() >= 150) return;
        if (!n.isVisibleToUser()) return;
        CharSequence text = n.getText(), desc = n.getContentDescription();
        boolean useful = (text != null && text.length() > 0) || (desc != null && desc.length() > 0) || n.isEditable() || n.isFocused()
                || ((n.isClickable() || n.isFocusable()) && n.getChildCount() == 0);
        if (useful) {
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            JSONObject o = new JSONObject().put("i", lastNodes.size());
            if (text != null && text.length() > 0) o.put("text", text.toString().substring(0, Math.min(120, text.length())));
            if (desc != null && desc.length() > 0) o.put("desc", desc.toString().substring(0, Math.min(120, desc.length())));
            if (n.getViewIdResourceName() != null) o.put("id", n.getViewIdResourceName().replaceAll("^.*:id/", ""));
            if (n.isClickable()) o.put("click", true);
            if (n.isFocusable()) o.put("focusable", true);
            if (n.isFocused()) o.put("focused", true);
            if (n.isSelected()) o.put("selected", true);
            if (n.isEditable()) o.put("editable", true);
            o.put("box", r.left + "," + r.top + "," + r.right + "," + r.bottom);
            out.put(o);
            lastNodes.add(AccessibilityNodeInfo.obtain(n));
        }
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo c = n.getChild(i);
            if (c != null) { walk(c, out, depth + 1); c.recycle(); }
        }
    }

    /** One step: select an element (it is clicked, or focused and OK pressed), type into a field, or press a key. */
    private JSONObject act(JSONObject a, AudioManager audio) throws Exception {
        String type = a.optString("type");
        if (type.equals("key")) {
            int times = Math.max(1, Math.min(20, a.optInt("times", 1)));
            for (int i = 0; i < times; i++) key(audio, a.optString("keys", a.optString("key")));
            return new JSONObject().put("ok", true);
        }
        if (type.equals("select") || type.equals("tap")) {
            AccessibilityNodeInfo n = node(a);
            if (n == null) throw new Exception("אין רכיב " + a.optInt("index", -1) + " ברשימה");
            for (AccessibilityNodeInfo p = n; p != null; p = p.getParent()) {
                if (p.isClickable() && p.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return new JSONObject().put("ok", true).put("info", "clicked");
            }
            // Not clickable: give it the focus and press OK, the way the remote would.
            n.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            n.performAction(AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS);
            key(audio, "ok");
            return new JSONObject().put("ok", true).put("info", "focused and pressed OK");
        }
        if (type.equals("type")) {
            AccessibilityNodeInfo n = a.has("index") ? node(a) : null;
            if (n == null) {
                AccessibilityNodeInfo root = service.getRootInActiveWindow();
                n = root == null ? null : root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
            }
            if (n == null || !n.isEditable()) throw new Exception("אין שדה טקסט פעיל");
            Bundle b = new Bundle();
            b.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, a.optString("text"));
            if (!n.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, b)) throw new Exception("השדה לא קיבל את הטקסט");
            return new JSONObject().put("ok", true);
        }
        if (type.equals("scroll")) {
            AccessibilityNodeInfo n = a.has("index") ? node(a) : null;
            boolean back = a.optString("direction").equals("up") || a.optString("direction").equals("left");
            for (AccessibilityNodeInfo p = n; p != null; p = p.getParent()) {
                if (p.isScrollable() && p.performAction(back ? AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD : AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return new JSONObject().put("ok", true);
            }
            key(audio, back ? "up" : "down");
            return new JSONObject().put("ok", true).put("info", "pressed " + (back ? "up" : "down"));
        }
        throw new Exception("פעולה לא מוכרת: " + type);
    }

    private AccessibilityNodeInfo node(JSONObject a) {
        int i = a.optInt("index", -1);
        if (i < 0 || i >= lastNodes.size()) return null;
        AccessibilityNodeInfo n = lastNodes.get(i);
        n.refresh();
        return n;
    }

    /** A JPEG of the screen, scaled to `width`, sent when it is ready (Android 11+). */
    private void capture(WebSocket ws, int id, int width) {
        final JSONObject reply = new JSONObject();
        try { reply.put("id", id); } catch (Exception ignored) { }
        if (Build.VERSION.SDK_INT < 30) { fail(ws, reply, "צילום מסך דורש Android 11"); return; }
        try {
            service.takeScreenshot(Display.DEFAULT_DISPLAY, service.getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
                @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
                    new Thread(() -> {
                        try {
                            Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                            r.getHardwareBuffer().close();
                            if (hw == null) { fail(ws, reply, "צילום המסך ריק"); return; }
                            Bitmap soft = hw.copy(Bitmap.Config.ARGB_8888, false);
                            hw.recycle();
                            int w = Math.max(320, Math.min(1920, width));
                            int h = Math.round(soft.getHeight() * (w / (float) soft.getWidth()));
                            Bitmap small = Bitmap.createScaledBitmap(soft, w, h, true);
                            if (small != soft) soft.recycle();
                            ByteArrayOutputStream out = new ByteArrayOutputStream();
                            small.compress(Bitmap.CompressFormat.JPEG, 60, out);
                            small.recycle();
                            reply.put("ok", true).put("result", new JSONObject()
                                    .put("image", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)).put("width", w).put("height", h));
                            ws.send(reply.toString());
                        } catch (Exception e) {
                            fail(ws, reply, String.valueOf(e.getMessage()));
                        }
                    }).start();
                }
                @Override public void onFailure(int error) { fail(ws, reply, "צילום המסך נכשל (" + error + ")"); }
            });
        } catch (Exception e) {
            fail(ws, reply, String.valueOf(e.getMessage()));
        }
    }

    private static void fail(WebSocket ws, JSONObject reply, String error) {
        try { reply.put("ok", false).put("error", error); } catch (Exception ignored) { }
        ws.send(reply.toString());
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
