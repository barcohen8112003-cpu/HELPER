package com.gathin.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;
import android.widget.ImageView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The apps' rows on Google TV's own Home (Disney+'s titles, YouTube's picks), which only Google's Home may read from
 * the system. Through the accessibility service, Google's Home is opened for a moment under a cover (a still of our
 * Home, so nothing seems to happen), its rows are read with each card's picture cut from a screenshot of its window,
 * and our Home comes back. Opening a title does the same and clicks the card there, so the app opens on that title.
 * Keys are held while it works. Needs Google's Home enabled (pm enable com.google.android.apps.tv.launcherx).
 */
final class GtvRows {

    private GtvRows() { }

    static final String GTV = "com.google.android.apps.tv.launcherx";
    private static final ComponentName GTV_HOME = new ComponentName(GTV, GTV + ".home.HomeActivity");
    private static final String PREFS = "gtv_rows";
    private static final long STALE_MS = 30L * 60 * 1000;
    private static final long GIVE_UP_MS = 9000;

    /** Google's row titles and the app each is from; rows not here (our apps, Stremio's, which comes from its account) are skipped. */
    private static final Map<String, String> ROWS = new HashMap<>();
    static {
        ROWS.put("Disney+", "com.disney.disneyplus");
        ROWS.put("YouTube", "com.google.android.youtube.tv");
        ROWS.put("Netflix", "com.netflix.ninja");
    }

    /** True while Google's Home is up under the cover: the service holds every key. */
    static volatile boolean busy;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static View cover;

    static boolean available(Context c) {
        try {
            return c.getPackageManager().getApplicationInfo(GTV, 0).enabled && Build.VERSION.SDK_INT >= 34;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean stale(Context c) {
        long now = System.currentTimeMillis();
        // Not again within 10 minutes of a try, even one that read nothing.
        return now - prefs(c).getLong("time", 0) > STALE_MS && now - prefs(c).getLong("tried", 0) > 10 * 60 * 1000;
    }

    /** The cards read last time, as Continue watching titles (pkg set, picture in background). */
    static List<Titles.Title> items(Context c, String onlyPkg) {
        List<Titles.Title> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs(c).getString("items", "[]"));
            long time = prefs(c).getLong("time", 0);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                String pkg = o.optString("pkg");
                if (onlyPkg != null && !samePkg(c, onlyPkg, pkg)) continue;
                Titles.Title t = new Titles.Title("gtv:" + o.optString("desc"), "gtv", o.optString("title"), o.optString("art"), "", "", "");
                t.pkg = installed(c, pkg);
                t.sub = o.optString("sub").isEmpty() ? null : o.optString("sub");
                t.gtvDesc = o.optString("desc");
                // After today's watching: these rows say what is on, not when it was watched.
                t.time = time - 6L * 3600 * 1000 - i * 1000L;
                out.add(t);
            }
        } catch (Exception ignored) { }
        return out;
    }

    private static boolean samePkg(Context c, String a, String b) {
        return installed(c, a).equals(installed(c, b));
    }

    /** Disney+ is installed as one of two packages. */
    private static String installed(Context c, String pkg) {
        if (pkg.equals("com.disneyplus.mea") || pkg.equals("com.disney.disneyplus")) {
            // The new app (com.disney.disneyplus) when it is there; the old one only asks to install it.
            try { c.getPackageManager().getPackageInfo("com.disney.disneyplus", 0); return "com.disney.disneyplus"; }
            catch (Exception e) { return "com.disneyplus.mea"; }
        }
        return pkg;
    }

    // ---- reading the rows ----------------------------------------------------------------------------

    /** Reads Google's rows under a cover showing still (a picture of our Home), then comes back Home. */
    static void refresh(AccessibilityService s, Bitmap still) {
        if (busy || !available(s)) return;
        prefs(s).edit().putLong("tried", System.currentTimeMillis()).apply();
        begin(s, still);
        long start = System.currentTimeMillis();
        int[] seen = {-1};
        Runnable poll = new Runnable() {
            @Override public void run() {
                AccessibilityWindowInfo w = gtvWindow(s);
                List<Card> cards = w == null ? null : read(w.getRoot());
                long waited = System.currentTimeMillis() - start;
                // Wait until the rows have loaded and stopped changing (and Google's dim fade is over).
                boolean settled = cards != null && !cards.isEmpty() && cards.size() == seen[0] && waited > 3500;
                if (cards != null) seen[0] = cards.size();
                if (settled) { shoot(s, w, cards); return; }
                if (waited > GIVE_UP_MS) { end(s, true); return; }
                MAIN.postDelayed(this, 500);
            }
        };
        MAIN.postDelayed(poll, 1200);
    }

    /** A card on Google's Home: its row's app, its description (title, then details) and where it is. */
    private static final class Card {
        String pkg, desc;
        Rect bounds = new Rect();
    }

    private static List<Card> read(AccessibilityNodeInfo root) {
        if (root == null) return null;
        // Row titles (short single-line texts) and cards (pictures with a description), with where they are.
        List<String> titles = new ArrayList<>();
        List<Rect> titleAt = new ArrayList<>();
        List<Card> cards = new ArrayList<>();
        collect(root, titles, titleAt, cards);
        List<Card> out = new ArrayList<>();
        for (Card c : cards) {
            // A card's row is the title right above it.
            String row = null;
            int best = Integer.MIN_VALUE;
            for (int i = 0; i < titles.size(); i++) {
                Rect t = titleAt.get(i);
                if (t.top <= c.bounds.top && t.top > best) { best = t.top; row = titles.get(i); }
            }
            String pkg = row == null ? null : ROWS.get(row);
            if (pkg == null) continue;
            c.pkg = pkg;
            out.add(c);
        }
        return out;
    }

    private static void collect(AccessibilityNodeInfo n, List<String> titles, List<Rect> titleAt, List<Card> cards) {
        if (n == null) return;
        Rect r = new Rect();
        n.getBoundsInScreen(r);
        CharSequence text = n.getText(), desc = n.getContentDescription();
        if (text != null && text.length() > 0 && r.height() < 70 && r.height() > 0) {
            titles.add(clean(text.toString()));
            titleAt.add(r);
        }
        if (desc != null && desc.length() > 0 && n.getChildCount() == 0 && r.width() > 150 && r.height() > 100) {
            Card c = new Card();
            c.bounds = r;
            c.desc = desc.toString();
            cards.add(c);
        }
        for (int i = 0; i < n.getChildCount(); i++) collect(n.getChild(i), titles, titleAt, cards);
    }

    private static String clean(String s) {
        return s.replaceAll("[\\u200E\\u200F\\u202A-\\u202E]", "").trim();
    }

    private static void shoot(AccessibilityService s, AccessibilityWindowInfo w, List<Card> cards) {
        if (Build.VERSION.SDK_INT < 34) { save(s, cards, null); end(s, true); return; }
        try {
            s.takeScreenshotOfWindow(w.getId(), s.getMainExecutor(), new AccessibilityService.TakeScreenshotCallback() {
                @Override public void onSuccess(AccessibilityService.ScreenshotResult r) {
                    Bitmap shot = null;
                    try {
                        Bitmap hw = Bitmap.wrapHardwareBuffer(r.getHardwareBuffer(), r.getColorSpace());
                        if (hw != null) shot = hw.copy(Bitmap.Config.ARGB_8888, false);
                        r.getHardwareBuffer().close();
                    } catch (Exception ignored) { }
                    save(s, cards, shot);
                    end(s, true);
                }
                @Override public void onFailure(int error) {
                    android.util.Log.w("GtvRows", "screenshot failed " + error);
                    save(s, cards, null);
                    end(s, true);
                }
            });
        } catch (Exception e) {
            save(s, cards, null);
            end(s, true);
        }
    }

    private static void save(Context c, List<Card> cards, Bitmap shot) {
        try {
            File dir = new File(c.getFilesDir(), "gtv");
            dir.mkdirs();
            JSONArray a = new JSONArray();
            for (Card card : cards) {
                String desc = clean(card.desc);
                // "Title, details": the details may be empty (Disney+), "Season 1 , Episode 5" or the views.
                int comma = desc.indexOf(", ");
                if (comma < 0 && desc.endsWith(",")) comma = desc.length() - 1;
                String title = comma > 0 ? desc.substring(0, comma).trim() : desc;
                String sub = comma > 0 && comma + 1 < desc.length()
                        ? clean(desc.substring(comma + 1)).replace(" ,", " ·").replaceAll("^[,\\s]+", "") : "";
                String art = "";
                // Only whole cards on screen give a whole picture.
                if (shot != null && card.bounds.left >= 0 && card.bounds.right <= shot.getWidth()
                        && card.bounds.top >= 0 && card.bounds.bottom <= shot.getHeight()) {
                    // The picture is the card's top, 16:9; Google draws the title on a dark band under it.
                    int ph = Math.min(card.bounds.height(), Math.round(card.bounds.width() * 9 / 16f));
                    Bitmap crop = Bitmap.createBitmap(shot, card.bounds.left, card.bounds.top, card.bounds.width(), ph);
                    File f = new File(dir, Integer.toHexString(card.desc.hashCode()) + ".jpg");
                    try (FileOutputStream out = new FileOutputStream(f)) { crop.compress(Bitmap.CompressFormat.JPEG, 88, out); }
                    art = f.getAbsolutePath();
                }
                if (art.isEmpty()) continue;   // a card cut off at the screen's edge: left out
                a.put(new JSONObject().put("pkg", card.pkg).put("desc", card.desc).put("title", title).put("sub", sub).put("art", art));
            }
            prefs(c).edit().putString("items", a.toString()).putLong("time", System.currentTimeMillis()).apply();
            android.util.Log.i("GtvRows", "read " + a.length() + " cards");
        } catch (Exception e) {
            android.util.Log.w("GtvRows", "save failed", e);
        }
    }

    // ---- opening a title -----------------------------------------------------------------------------

    /** Opens the title the way Google's Home does: its card there is clicked under a cover. Falls back to the app. */
    static void open(AccessibilityService s, String desc, String pkg) {
        if (busy) return;
        if (!available(s)) { Helper.openApp(s, pkg); return; }
        // Google's Disney+ row is the old app's: a click there lands on "install the new app". Open the new one.
        if ("com.disney.disneyplus".equals(pkg)) { Helper.openApp(s, pkg); return; }
        begin(s, null);
        long start = System.currentTimeMillis();
        Runnable poll = new Runnable() {
            @Override public void run() {
                AccessibilityWindowInfo w = gtvWindow(s);
                AccessibilityNodeInfo card = w == null ? null : find(w.getRoot(), desc);
                if (card != null && System.currentTimeMillis() - start > 1500) {
                    boolean ok = card.performAction(AccessibilityNodeInfo.ACTION_CLICK);
                    if (!ok) Helper.openApp(s, pkg);
                    MAIN.postDelayed(() -> end(s, false), 1800);   // the app is opening over it
                    return;
                }
                if (System.currentTimeMillis() - start > GIVE_UP_MS) {
                    Helper.openApp(s, pkg);
                    MAIN.postDelayed(() -> end(s, false), 1200);
                    return;
                }
                MAIN.postDelayed(this, 400);
            }
        };
        MAIN.postDelayed(poll, 800);
    }

    private static AccessibilityNodeInfo find(AccessibilityNodeInfo n, String desc) {
        if (n == null) return null;
        if (n.getContentDescription() != null && desc.equals(n.getContentDescription().toString())) return n;
        for (int i = 0; i < n.getChildCount(); i++) {
            AccessibilityNodeInfo f = find(n.getChild(i), desc);
            if (f != null) return f;
        }
        return null;
    }

    // ---- the cover -----------------------------------------------------------------------------------

    private static void begin(AccessibilityService s, Bitmap still) {
        busy = true;
        try {
            WindowManager wm = s.getSystemService(WindowManager.class);
            ImageView v = new ImageView(s);
            v.setScaleType(ImageView.ScaleType.FIT_XY);
            if (still != null) v.setImageBitmap(still);
            v.setBackgroundColor(0xFF000000);
            WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT,
                    WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.OPAQUE);
            lp.gravity = Gravity.TOP | Gravity.LEFT;
            wm.addView(v, lp);
            cover = v;
        } catch (Exception e) {
            android.util.Log.w("GtvRows", "no cover", e);
        }
        try {
            s.startActivity(new Intent(Intent.ACTION_MAIN).setComponent(GTV_HOME)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION));
        } catch (Exception e) {
            end(s, true);
        }
        // Never hold the keys for long, whatever happens.
        MAIN.postDelayed(() -> { if (busy) end(s, true); }, GIVE_UP_MS + 4000);
    }

    /** Takes the cover away; home true goes back to our Home first. */
    private static void end(AccessibilityService s, boolean home) {
        if (home) InputKeyService.goHome(s);
        MAIN.postDelayed(() -> {
            try {
                if (cover != null) s.getSystemService(WindowManager.class).removeView(cover);
            } catch (Exception ignored) { }
            cover = null;
            busy = false;
        }, home ? 700 : 0);
    }

    private static String describeWindows(AccessibilityService s) {
        StringBuilder b = new StringBuilder();
        try {
            for (AccessibilityWindowInfo w : s.getWindows()) {
                AccessibilityNodeInfo r = w.getRoot();
                b.append(w.getType()).append(':').append(r == null ? "null" : r.getPackageName()).append(' ');
            }
            AccessibilityNodeInfo active = s.getRootInActiveWindow();
            b.append("active=").append(active == null ? "null" : active.getPackageName());
        } catch (Exception e) { b.append(e); }
        return b.toString();
    }

    private static AccessibilityWindowInfo gtvWindow(AccessibilityService s) {
        try {
            for (AccessibilityWindowInfo w : s.getWindows()) {
                AccessibilityNodeInfo r = w.getRoot();
                if (w.getType() == AccessibilityWindowInfo.TYPE_APPLICATION && r != null && r.getPackageName() != null
                        && GTV.contentEquals(r.getPackageName())) return w;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
