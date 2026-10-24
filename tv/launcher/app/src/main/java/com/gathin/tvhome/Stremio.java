package com.gathin.tvhome;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

/**
 * The owner's Stremio account, for a real "Continue watching": linked once with Stremio's own phone link (a code
 * or QR at link.stremio.com, approved on a phone where Stremio is signed in; no password on the TV), then the
 * library's titles in progress, newest first, with the episode and how far in.
 * Only the account's auth key is kept, in the app's private prefs.
 */
final class Stremio {

    private Stremio() { }

    private static final String PREFS = "stremio";
    private static final String LINK = "https://link.stremio.com/api/v2/";
    private static final String API = "https://api.strem.io/api/";
    private static final ExecutorService POOL = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    static boolean linked(Context c) {
        return !prefs(c).getString("authKey", "").isEmpty();
    }

    static void unlink(Context c) {
        prefs(c).edit().remove("authKey").apply();
        new File(c.getCacheDir(), "stremio_library.json").delete();
    }

    /** A new link code: done gets {code, qr image url}, or null when Stremio cannot be reached. */
    static void newCode(Consumer<String[]> done) {
        POOL.execute(() -> {
            String[] out = null;
            try {
                JSONObject r = new JSONObject(get(LINK + "create?type=Create")).getJSONObject("result");
                out = new String[]{r.getString("code"), r.getString("qrcode")};
            } catch (Exception ignored) { }
            String[] res = out;
            MAIN.post(() -> done.accept(res));
        });
    }

    /** Asks once whether the code was approved; done gets true when the account is now linked. */
    static void checkCode(Context c, String code, Consumer<Boolean> done) {
        Context app = c.getApplicationContext();
        POOL.execute(() -> {
            boolean ok = false;
            try {
                JSONObject o = new JSONObject(get(LINK + "read?type=Read&code=" + code));
                JSONObject r = o.optJSONObject("result");
                String key = r == null ? "" : r.optString("authKey");
                if (!key.isEmpty()) {
                    prefs(app).edit().putString("authKey", key).apply();
                    ok = true;
                }
            } catch (Exception ignored) { }
            boolean res = ok;
            MAIN.post(() -> done.accept(res));
        });
    }

    /**
     * The library's titles in progress, newest first: from the cache at once when there is one, then fresh from the
     * account. Nothing is called back when the account is not linked.
     */
    static void inProgress(Context c, Consumer<List<Titles.Title>> done) {
        Context app = c.getApplicationContext();
        String key = prefs(app).getString("authKey", "");
        if (key.isEmpty()) return;
        File cache = new File(app.getCacheDir(), "stremio_library.json");
        POOL.execute(() -> {
            try {
                if (cache.exists()) {
                    List<Titles.Title> old = parse(new String(Files.readAllBytes(cache.toPath()), StandardCharsets.UTF_8));
                    MAIN.post(() -> done.accept(old));
                }
            } catch (Exception ignored) { }
            try {
                JSONObject body = new JSONObject().put("authKey", key).put("collection", "libraryItem")
                        .put("all", true).put("ids", new JSONArray());
                String text = post(API + "datastoreGet", body.toString());
                JSONObject o = new JSONObject(text);
                if (o.opt("error") instanceof JSONObject) {
                    // A key the account no longer accepts (signed out everywhere): link again.
                    if (o.getJSONObject("error").optInt("code") == 1) unlink(app);
                    return;
                }
                List<Titles.Title> fresh = parse(text);
                try (FileOutputStream out = new FileOutputStream(cache)) { out.write(text.getBytes(StandardCharsets.UTF_8)); }
                MAIN.post(() -> done.accept(fresh));
            } catch (Exception e) {
                android.util.Log.w("Stremio", "library failed", e);
            }
        });
    }

    /** Stremio's own rule for Continue watching: in the library, not removed, watched part way (or a series under way). */
    private static List<Titles.Title> parse(String text) throws Exception {
        JSONArray items = new JSONObject(text).getJSONArray("result");
        List<JSONObject> going = new ArrayList<>();
        for (int i = 0; i < items.length(); i++) {
            JSONObject it = items.getJSONObject(i);
            if (it.optBoolean("removed") && !it.optBoolean("temp")) continue;
            JSONObject st = it.optJSONObject("state");
            if (st == null || st.optString("lastWatched").isEmpty()) continue;
            boolean partWay = st.optLong("timeOffset") > 0;
            boolean seriesUnderway = "series".equals(it.optString("type")) && !st.optString("video_id").isEmpty();
            if (partWay || seriesUnderway) going.add(it);
        }
        going.sort((a, b) -> b.optJSONObject("state").optString("lastWatched")
                .compareTo(a.optJSONObject("state").optString("lastWatched")));
        List<Titles.Title> out = new ArrayList<>();
        for (JSONObject it : going) {
            if (out.size() == 20) break;
            String id = it.optString("_id");
            JSONObject st = it.getJSONObject("state");
            String bg = id.startsWith("tt") ? "https://images.metahub.space/background/small/" + id + "/img" : it.optString("poster");
            String logo = id.startsWith("tt") ? "https://images.metahub.space/logo/medium/" + id + "/img" : "";
            Titles.Title t = new Titles.Title(id, it.optString("type", "movie"), it.optString("name"), bg, logo, "", "");
            t.videoId = st.optString("video_id");
            try { t.time = java.time.Instant.parse(st.optString("lastWatched")).toEpochMilli(); } catch (Exception ignored) { }
            long dur = st.optLong("duration"), off = st.optLong("timeOffset");
            t.progress = dur > 0 && off > 0 ? Math.min(1f, off / (float) dur) : -1f;
            String[] parts = t.videoId.split(":");
            if ("series".equals(t.type) && parts.length >= 3) {
                t.sub = "‏עונה " + parts[parts.length - 2] + " · פרק " + parts[parts.length - 1];
            } else if (t.progress > 0 && dur > 0) {
                long left = Math.max(1, (dur - off) / 60000);
                t.sub = "‏נשארו " + left + " דקות";
            }
            out.add(t);
        }
        return out;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static String get(String url) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(8000);
        con.setReadTimeout(12000);
        return read(con);
    }

    private static String post(String url, String json) throws Exception {
        HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
        con.setConnectTimeout(8000);
        con.setReadTimeout(20000);
        con.setRequestMethod("POST");
        con.setDoOutput(true);
        con.setRequestProperty("Content-Type", "application/json");
        try (OutputStream out = con.getOutputStream()) { out.write(json.getBytes(StandardCharsets.UTF_8)); }
        return read(con);
    }

    private static String read(HttpURLConnection con) throws Exception {
        int code = con.getResponseCode();
        try (InputStream in = code < 400 ? con.getInputStream() : con.getErrorStream()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16384];
            int n;
            while (in != null && (n = in.read(chunk)) > 0) {
                buf.write(chunk, 0, n);
                if (buf.size() > 8 * 1024 * 1024) throw new Exception("too big");
            }
            return buf.toString("UTF-8");
        }
    }
}
