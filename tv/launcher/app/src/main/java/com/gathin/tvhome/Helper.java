package com.gathin.tvhome;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.view.KeyEvent;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * HELPER on the TV: the server address and bridge token (pushed once from the computer, see HelperSetupReceiver),
 * asking HELPER a question over /bridge/ask, and which app each remote button opens.
 */
final class Helper {

    static final String PREFS = "helper";
    private static final String KEY_URL = "url";
    private static final String KEY_TOKEN = "token";
    private static final String BUTTON_PREFIX = "button.";

    /** Named remote buttons and the keycodes they send on the Chromecast voice remote and common Google TV remotes. */
    static final Map<String, int[]> BUTTONS = new LinkedHashMap<>();
    static {
        BUTTONS.put("assistant", new int[]{KeyEvent.KEYCODE_ASSIST, KeyEvent.KEYCODE_VOICE_ASSIST, KeyEvent.KEYCODE_SEARCH});
        BUTTONS.put("youtube", new int[]{KeyEvent.KEYCODE_BUTTON_3});
        BUTTONS.put("netflix", new int[]{KeyEvent.KEYCODE_BUTTON_4});
        BUTTONS.put("bookmark", new int[]{KeyEvent.KEYCODE_BOOKMARK, KeyEvent.KEYCODE_BUTTON_5});
        BUTTONS.put("input", new int[]{KeyEvent.KEYCODE_TV_INPUT});
        BUTTONS.put("guide", new int[]{KeyEvent.KEYCODE_GUIDE});
        BUTTONS.put("red", new int[]{KeyEvent.KEYCODE_PROG_RED});
        BUTTONS.put("green", new int[]{KeyEvent.KEYCODE_PROG_GREEN});
        BUTTONS.put("yellow", new int[]{KeyEvent.KEYCODE_PROG_YELLOW});
        BUTTONS.put("blue", new int[]{KeyEvent.KEYCODE_PROG_BLUE});
    }

    /** Hebrew names for the buttons screen. */
    static String buttonTitle(String name) {
        switch (name) {
            case "assistant": return "כפתור העוזר";
            case "youtube": return "כפתור YouTube";
            case "netflix": return "כפתור Netflix";
            case "bookmark": return "כפתור הכוכבית";
            case "input": return "כפתור המקור";
            case "guide": return "כפתור המדריך";
            case "red": return "הכפתור האדום";
            case "green": return "הכפתור הירוק";
            case "yellow": return "הכפתור הצהוב";
            case "blue": return "הכפתור הכחול";
            default: return name;
        }
    }

    private Helper() { }

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String url(Context c) {
        String u = prefs(c).getString(KEY_URL, "").trim();
        if (u.isEmpty()) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    static String token(Context c) {
        return prefs(c).getString(KEY_TOKEN, "").trim();
    }

    static boolean configured(Context c) {
        return !url(c).isEmpty() && !token(c).isEmpty();
    }

    static void save(Context c, String url, String token) {
        SharedPreferences.Editor e = prefs(c).edit();
        if (url != null) e.putString(KEY_URL, url.trim());
        if (token != null) e.putString(KEY_TOKEN, token.trim());
        e.apply();
    }

    // ---- remote buttons ----

    /** Package a named button opens, "" for its default. Learned keycodes are stored as "button.learned.<name>". */
    static String buttonApp(Context c, String name) {
        String set = prefs(c).getString(BUTTON_PREFIX + name, null);
        if (set != null) return set;
        // With the stock launcher off nothing answers the remote's YouTube button, so it opens YouTube by default.
        return "youtube".equals(name) ? "com.google.android.youtube.tv" : "";
    }

    static void setButtonApp(Context c, String name, String pkg) {
        prefs(c).edit().putString(BUTTON_PREFIX + name, pkg == null ? "" : pkg).apply();
    }

    static void learnButton(Context c, String name, int keyCode, int scanCode) {
        prefs(c).edit().putInt(BUTTON_PREFIX + "learned." + name, keyCode)
                .putInt(BUTTON_PREFIX + "scan." + name, scanCode).apply();
    }

    /** The button a key event belongs to, by a learned scancode first, then a learned keycode, then the table. */
    static String buttonFor(Context c, KeyEvent event) {
        SharedPreferences p = prefs(c);
        for (String name : BUTTONS.keySet()) {
            int scan = p.getInt(BUTTON_PREFIX + "scan." + name, 0);
            if (scan > 0 && scan == event.getScanCode() && p.getInt(BUTTON_PREFIX + "learned." + name, 0) == event.getKeyCode()) return name;
        }
        for (String name : BUTTONS.keySet()) {
            if (p.getInt(BUTTON_PREFIX + "learned." + name, 0) == event.getKeyCode()) return name;
        }
        for (Map.Entry<String, int[]> e : BUTTONS.entrySet()) {
            for (int code : e.getValue()) if (code == event.getKeyCode()) return e.getKey();
        }
        return null;
    }

    static boolean openApp(Context c, String pkg) {
        PackageManager pm = c.getPackageManager();
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        if (i == null) return false;
        c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        return true;
    }

    // ---- asking HELPER ----

    static final class Reply {
        final String text;
        final String audioBase64;
        final String heard;     // what HELPER understood from a recording, or null
        Reply(String text, String audioBase64, String heard) { this.text = text; this.audioBase64 = audioBase64; this.heard = heard; }
    }

    /** Blocking: call off the UI thread. */
    static Reply ask(Context c, String text, boolean voice) throws Exception {
        return post(c, new JSONObject().put("text", text).put("source", "tv").put("voice", voice).put("audio", voice));
    }

    /** A spoken request: the WAV goes to HELPER, which transcribes it and answers with speech. Blocking. */
    static Reply askSpeech(Context c, byte[] wav) throws Exception {
        return post(c, new JSONObject().put("speech", android.util.Base64.encodeToString(wav, android.util.Base64.NO_WRAP))
                .put("speechMime", "audio/wav").put("source", "tv").put("voice", true).put("audio", true));
    }

    private static Reply post(Context c, JSONObject body) throws Exception {
        if (!configured(c)) throw new Exception("HELPER עוד לא מחובר לטלוויזיה. צריך להגדיר כתובת וקוד מהמחשב.");
        HttpURLConnection conn = (HttpURLConnection) new URL(url(c) + "/bridge/ask").openConnection();
        conn.setRequestMethod("POST");
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(120000);
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setRequestProperty("Authorization", "Bearer " + token(c));
        try (OutputStream out = conn.getOutputStream()) {
            out.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code;
        try {
            code = conn.getResponseCode();
        } catch (java.io.IOException e) {
            throw new Exception("אין חיבור ל-HELPER. בדוק שהמחשב דלוק ו-HELPER רץ.");
        }
        String response = read(code < 400 ? conn.getInputStream() : conn.getErrorStream());
        if (code == 403) throw new Exception("קוד הגישה ל-HELPER לא נכון.");
        if (code >= 400) {
            String why = "";
            try { why = new JSONObject(response).optString("error", ""); } catch (Exception ignored) { }
            throw new Exception(why.isEmpty() ? "שגיאה מ-HELPER (" + code + ")" : why);
        }
        JSONObject json = new JSONObject(response);
        return new Reply(json.optString("reply", ""), json.isNull("audio") ? null : json.optString("audio", null),
                json.isNull("heard") ? null : json.optString("heard", null));
    }

    private static String read(InputStream in) throws java.io.IOException {
        if (in == null) return "";
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return buf.toString("UTF-8");
    }
}
