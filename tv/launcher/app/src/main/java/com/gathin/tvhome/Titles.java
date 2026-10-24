package com.gathin.tvhome;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;
import android.util.LruCache;
import android.widget.ImageView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
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
 * Series and movies for the rows under the dock: the top titles from Stremio's public catalog (Cinemeta, no key),
 * cached for 12 hours, and the titles opened from Home ("Continue watching"), newest first. Each opens in Stremio.
 */
final class Titles {

    private Titles() { }

    static final class Title {
        final String id, type, name, background, logo, year, rating;
        /** From the Stremio library: the episode under way ("tt123:2:5"), how far in (0..1, -1 unknown), the line under the card. */
        String videoId = "";
        float progress = -1f;
        String sub;
        /** Played in an app (MediaListener): that app, which opens on OK. When it was watched, for the order. */
        String pkg;
        long time;
        /** Read from Google TV's Home (GtvRows): the card's description there, to click it again. */
        String gtvDesc;
        Title(String id, String type, String name, String background, String logo, String year, String rating) {
            this.id = id; this.type = type; this.name = name; this.background = background; this.logo = logo;
            this.year = year; this.rating = rating;
        }

        JSONObject json() throws Exception {
            return new JSONObject().put("id", id).put("type", type).put("name", name).put("background", background)
                    .put("logo", logo).put("year", year).put("rating", rating);
        }

        static Title from(JSONObject o, String type) {
            String id = o.optString("id", o.optString("imdb_id"));
            String bg = o.optString("background");
            if (bg.isEmpty()) bg = "https://images.metahub.space/background/medium/" + id + "/img";
            // The small artwork (480 x 270, ~20 KB) is all a card needs; medium is half a megabyte.
            bg = bg.replace("/background/medium/", "/background/small/");
            String year = o.optString("year", o.optString("releaseInfo"));
            return new Title(id, o.optString("type", type), o.optString("name"), bg, o.optString("logo"),
                    year.length() >= 4 && year.substring(0, 4).matches("\\d{4}") ? year.substring(0, 4) : "", o.optString("imdbRating", o.optString("rating")));
        }
    }

    static final String STREMIO = "com.stremio.one";
    private static final String PREFS = "titles";
    private static final long FRESH_MS = 12L * 3600 * 1000;
    private static final int MAX_WATCHING = 15;
    private static final ExecutorService POOL = Executors.newFixedThreadPool(3);
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final LruCache<String, Bitmap> IMAGES = new LruCache<String, Bitmap>(8 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap b) { return b.getByteCount(); }
    };

    /** The top titles of one kind ("series" or "movie"), from the cache at once and fresh from the net when old. */
    static void top(Context c, String type, Consumer<List<Title>> done) {
        Context app = c.getApplicationContext();
        File file = new File(app.getCacheDir(), "cinemeta_" + type + ".json");
        POOL.execute(() -> {
            List<Title> cached = null;
            try {
                if (file.exists()) cached = parse(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8), type);
            } catch (Exception ignored) { }
            if (cached != null && !cached.isEmpty()) {
                List<Title> out = cached;
                MAIN.post(() -> done.accept(out));
                if (System.currentTimeMillis() - file.lastModified() < FRESH_MS) return;
            }
            try {
                String body = new String(get("https://v3-cinemeta.strem.io/catalog/" + type + "/top.json", 4 * 1024 * 1024),
                        StandardCharsets.UTF_8);
                List<Title> fresh = parse(body, type);
                if (fresh.isEmpty()) return;
                // Keep only what the rows use: the full catalog is half a megabyte.
                JSONArray slim = new JSONArray();
                for (Title t : fresh) slim.put(t.json());
                try (FileOutputStream out = new FileOutputStream(file)) {
                    out.write(new JSONObject().put("metas", slim).toString().getBytes(StandardCharsets.UTF_8));
                }
                if (cached == null || cached.isEmpty()) MAIN.post(() -> done.accept(fresh));
            } catch (Exception e) { android.util.Log.w("Titles", "catalog " + type + " failed", e); }
        });
    }

    private static List<Title> parse(String body, String type) throws Exception {
        JSONArray metas = new JSONObject(body).getJSONArray("metas");
        List<Title> out = new ArrayList<>();
        for (int i = 0; i < metas.length() && out.size() < 24; i++) {
            Title t = Title.from(metas.getJSONObject(i), type);
            if (!t.id.startsWith("tt") || t.name.isEmpty()) continue;
            out.add(t);
        }
        return out;
    }

    /** Titles opened from Home, newest first. */
    static List<Title> watching(Context c) {
        List<Title> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("watching", "[]"));
            for (int i = 0; i < a.length(); i++) out.add(Title.from(a.getJSONObject(i), "series"));
        } catch (Exception ignored) { }
        return out;
    }

    /** Opens the title in Stremio (or Stremio's Play page when it is not installed) and puts it first in watching. */
    static void open(Context c, Title t) {
        try {
            JSONArray a = new JSONArray(prefs(c).getString("watching", "[]"));
            JSONArray next = new JSONArray().put(t.json());
            for (int i = 0; i < a.length() && next.length() < MAX_WATCHING; i++) {
                if (!t.id.equals(a.getJSONObject(i).optString("id"))) next.put(a.getJSONObject(i));
            }
            prefs(c).edit().putString("watching", next.toString()).apply();
        } catch (Exception ignored) { }
        android.content.Intent i = new android.content.Intent(android.content.Intent.ACTION_VIEW,
                android.net.Uri.parse("stremio:///detail/" + t.type + "/" + t.id
                        + (t.videoId.isEmpty() ? "" : "/" + android.net.Uri.encode(t.videoId)))).setPackage(STREMIO)
                .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            c.startActivity(i);
        } catch (Exception e) {
            try {
                c.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,
                        android.net.Uri.parse("market://details?id=" + STREMIO)).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) { }
        }
    }

    /** Takes a title off Continue watching. */
    static void forget(Context c, String id) {
        try {
            JSONArray a = new JSONArray(prefs(c).getString("watching", "[]"));
            JSONArray next = new JSONArray();
            for (int i = 0; i < a.length(); i++) if (!id.equals(a.getJSONObject(i).optString("id"))) next.put(a.getJSONObject(i));
            prefs(c).edit().putString("watching", next.toString()).apply();
        } catch (Exception ignored) { }
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Loads an image into the view (memory, then disk, then the net), about maxW pixels wide; then calls done. */
    static void image(ImageView view, String url, int maxW, Consumer<Bitmap> done) {
        if (url == null || url.isEmpty()) return;
        view.setTag(R.id.card, url);
        Bitmap hit = IMAGES.get(url);
        if (hit != null) {
            view.setImageBitmap(hit);
            if (done != null) done.accept(hit);
            return;
        }
        File dir = new File(view.getContext().getCacheDir(), "art");
        POOL.execute(() -> {
            Bitmap b = null;
            try {
                dir.mkdirs();
                File f = new File(dir, Integer.toHexString(url.hashCode()) + ".img");
                byte[] data;
                if (url.startsWith("/")) {
                    data = Files.readAllBytes(new File(url).toPath());   // artwork MediaListener saved
                } else if (f.exists()) {
                    data = Files.readAllBytes(f.toPath());
                } else {
                    data = get(url, 3 * 1024 * 1024);
                    try (FileOutputStream out = new FileOutputStream(f)) { out.write(data); }
                }
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(data, 0, data.length, o);
                int sample = 1;
                while (o.outWidth / (sample * 2) >= maxW) sample *= 2;
                boolean photo = "image/jpeg".equals(o.outMimeType);
                o = new BitmapFactory.Options();
                o.inSampleSize = sample;
                // A photo in half the memory of full colour (no difference on a card); logos keep their transparency.
                if (photo) o.inPreferredConfig = Bitmap.Config.RGB_565;
                b = BitmapFactory.decodeByteArray(data, 0, data.length, o);
            } catch (Exception ignored) { }
            if (b == null) return;
            IMAGES.put(url, b);
            Bitmap out = b;
            MAIN.post(() -> {
                if (!url.equals(view.getTag(R.id.card))) return;   // the view shows another title now
                view.setImageBitmap(out);
                view.setAlpha(0f);
                view.animate().alpha(1f).setDuration(200).start();
                if (done != null) done.accept(out);
            });
        });
    }

    private static byte[] get(String url, int max) throws Exception {
        for (int hop = 0; hop < 4; hop++) {
            HttpURLConnection con = (HttpURLConnection) new URL(url).openConnection();
            con.setConnectTimeout(8000);
            con.setReadTimeout(12000);
            con.setInstanceFollowRedirects(false);
            int code = con.getResponseCode();
            if (code >= 300 && code < 400 && con.getHeaderField("Location") != null) {
                url = new URL(new URL(url), con.getHeaderField("Location")).toString();
                con.disconnect();
                continue;
            }
            if (code != 200) throw new Exception("HTTP " + code);
            try (InputStream in = con.getInputStream()) {
                ByteArrayOutputStream buf = new ByteArrayOutputStream();
                byte[] chunk = new byte[16384];
                int n;
                while ((n = in.read(chunk)) > 0) {
                    buf.write(chunk, 0, n);
                    if (buf.size() > max) throw new Exception("too big");
                }
                return buf.toByteArray();
            }
        }
        throw new Exception("too many redirects");
    }
}
