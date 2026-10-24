package com.gathin.tvhome;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The Apps screen behind the Google Play button, after Google TV's own Apps tab (Google TV has no store app: the
 * store is part of the system). Your apps in a row of round icons, then rows by category. An installed app opens;
 * any other opens Play's small install window over this screen. Icons of apps not on the TV come from each app's
 * public Play page and are kept on disk, so a row fills in once and is instant after.
 */
public class AppsStoreActivity extends Activity {

    private static final int BG = 0xFF0E1014;
    private static final int TEXT = 0xFFE8EAED;
    private static final int TEXT_DIM = 0x99E8EAED;
    private static final int SIDE = 56;

    /** Rows of apps worth having, chosen by hand: {title, package, package, ...}. Names come from Play. */
    private static final String[][] ROWS = {
            {"מומלצות בישראל", "com.applicaster.il.ch1", "com.keshet.mako.VODAndroidTV", "com.applicaster.iReshet",
                    "il.co.yes.yesplus", "il.co.stingtv.atv", "com.netflix.ninja", "com.disneyplus.mea"},
            {"סטרימינג", "com.netflix.ninja", "com.disneyplus.mea", "com.amazon.amazonvideo.livingroom",
                    "com.apple.atve.androidtv.appletv", "com.wbd.stream", "com.cbs.ott", "tv.pluto.android",
                    "com.tubitv", "com.crunchyroll.crunchyroid", "com.plexapp.android"},
            {"מוזיקה", "com.spotify.tv.android", "com.google.android.youtube.tvmusic", "com.aspiro.tidal",
                    "deezer.android.tv"},
            {"ילדים", "com.google.android.youtube.tvkids", "com.disneyplus.mea", "org.pbskids.video"},
            {"כלים", "org.videolan.vlc", "org.xbmc.kodi", "tv.twitch.android.app", "com.yablio.sendfilestotv",
                    "com.esaba.downloader", "com.cloudmosa.puffinTV", "com.lonelycatgames.Xplore"},
    };

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService net = Executors.newFixedThreadPool(3);
    private static final LruCache<String, Bitmap> ICONS = new LruCache<String, Bitmap>(6 * 1024 * 1024) {
        @Override protected int sizeOf(String k, Bitmap b) { return b.getByteCount(); }
    };
    private float d;
    private Typeface light, regular, medium;
    private LinearLayout page;
    private View firstFocus;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;
        light = getResources().getFont(R.font.outfit_light);
        regular = getResources().getFont(R.font.outfit_regular);
        medium = getResources().getFont(R.font.outfit_medium);

        FrameLayout root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0xFF161A22, BG, BG}));
        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        scroll.setSmoothScrollingEnabled(true);
        page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setClipChildren(false);
        page.setPadding(0, px(36), 0, px(48));
        scroll.addView(page);
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        header();
        yourApps();
        for (String[] row : ROWS) categoryRow(row);
        if (firstFocus != null) {
            View f = firstFocus;
            f.requestFocus();
            page.post(f::requestFocus);
        }
    }

    // ---- header ----

    private void header() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(px(SIDE), 0, px(SIDE), px(18));

        // Left: search and updates. Right: the title. Built left to right.
        EditText search = new EditText(this);
        search.setHint("‏חיפוש אפליקציות");
        search.setHintTextColor(TEXT_DIM);
        search.setTextColor(TEXT);
        search.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        search.setTypeface(regular);
        search.setSingleLine(true);
        search.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        search.setTextDirection(View.TEXT_DIRECTION_RTL);
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        search.setCompoundDrawablesWithIntrinsicBounds(0, 0, R.drawable.ic_qs_search, 0);
        search.setCompoundDrawablePadding(px(10));
        search.setPadding(px(18), 0, px(16), 0);
        GradientDrawable sbg = new GradientDrawable();
        sbg.setColor(0x1FFFFFFF);
        sbg.setCornerRadius(px(24));
        search.setBackground(sbg);
        search.setOnFocusChangeListener((v, f) -> sbg.setColor(f ? 0x33FFFFFF : 0x1FFFFFFF));
        // As on Google TV, passing over the field does not open the keyboard; OK does.
        search.setShowSoftInputOnFocus(false);
        search.setOnClickListener(v -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(search, 0);
        });
        search.setOnEditorActionListener((v, id, e) -> {
            boolean go = id == EditorInfo.IME_ACTION_SEARCH || id == EditorInfo.IME_ACTION_DONE
                    || (e != null && e.getKeyCode() == KeyEvent.KEYCODE_ENTER && e.getAction() == KeyEvent.ACTION_DOWN);
            if (!go) return false;
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(search.getWindowToken(), 0);
            String q = search.getText().toString().trim();
            if (!q.isEmpty()) play(new Intent(Intent.ACTION_VIEW, Uri.parse("market://search?q=" + Uri.encode(q) + "&c=apps")));
            return true;
        });
        bar.addView(search, new LinearLayout.LayoutParams(px(300), px(46)));

        TextView updates = chip("עדכונים");
        updates.setOnClickListener(v -> play(new Intent("com.google.android.finsky.VIEW_MY_DOWNLOADS")));
        LinearLayout.LayoutParams up = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, px(46));
        up.leftMargin = px(12);
        bar.addView(updates, up);

        TextView title = text("אפליקציות", 32, TEXT, light);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        page.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private TextView chip(String label) {
        TextView t = text(label, 15, TEXT, medium);
        t.setGravity(Gravity.CENTER);
        t.setFocusable(true);
        t.setClickable(true);
        t.setPadding(px(20), 0, px(20), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x1FFFFFFF);
        bg.setCornerRadius(px(24));
        t.setBackground(bg);
        t.setOnFocusChangeListener((v, f) -> {
            bg.setColor(f ? 0xFFE8EAED : 0x1FFFFFFF);
            t.setTextColor(f ? 0xFF202124 : TEXT);
        });
        return t;
    }

    // ---- rows ----

    /** Your apps: round icons of everything launchable, most recently used first. */
    private void yourApps() {
        List<View> items = new ArrayList<>();
        PackageManager pm = getPackageManager();
        for (String[] app : AppCards.byUse(this)) {
            Drawable icon = null;
            try { icon = pm.getApplicationIcon(app[0]); } catch (PackageManager.NameNotFoundException ignored) { }
            String pkg = app[0];
            items.add(item(icon, null, app[1], null, true, () -> { Helper.openApp(this, pkg); finish(); }));
        }
        addRow("האפליקציות שלך", items);
    }

    private void categoryRow(String[] row) {
        List<View> items = new ArrayList<>();
        PackageManager pm = getPackageManager();
        for (int i = 1; i < row.length; i++) {
            String pkg = row[i];
            boolean has = pm.getLeanbackLaunchIntentForPackage(pkg) != null || pm.getLaunchIntentForPackage(pkg) != null;
            Drawable local = null;
            String name = null;
            if (has) {
                try {
                    local = pm.getApplicationIcon(pkg);
                    name = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)));
                } catch (PackageManager.NameNotFoundException ignored) { }
            }
            View v = item(local, has ? null : pkg, name != null ? name : cachedName(pkg), has ? "מותקן" : "התקנה", false,
                    () -> {
                        if (has) { Helper.openApp(this, pkg); finish(); }
                        else play(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)));
                    });
            items.add(v);
        }
        addRow(row[0], items);
    }

    /** A titled row of items, right to left. */
    private void addRow(String title, List<View> items) {
        if (items.isEmpty()) return;
        TextView t = text(title, 19, TEXT, medium);
        t.setPadding(px(SIDE), px(10), px(SIDE), px(4));
        page.addView(t, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipChildren(false);
        hs.setClipToPadding(false);
        hs.setFillViewport(true);
        LinearLayout line = new LinearLayout(this);
        line.setOrientation(LinearLayout.HORIZONTAL);
        line.setGravity(Gravity.RIGHT);
        line.setClipChildren(false);
        line.setClipToPadding(false);
        line.setPadding(px(SIDE - 14), px(8), px(SIDE - 14), px(10));
        for (int i = items.size() - 1; i >= 0; i--) line.addView(items.get(i));
        hs.addView(line, new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        page.addView(hs, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        hs.post(() -> hs.scrollTo(line.getWidth(), 0));
        if (firstFocus == null) firstFocus = ((ViewGroup) items.get(0)).getChildAt(0);
    }

    /**
     * One app: the icon (round on "your apps", a rounded square elsewhere) with its name under it and a small status
     * line. remotePkg set: the icon and name come from Play.
     */
    private View item(Drawable icon, String remotePkg, String name, String status, boolean round, Runnable open) {
        int box = px(round ? 76 : 84);
        LinearLayout item = new LinearLayout(this);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setGravity(Gravity.CENTER_HORIZONTAL);
        item.setClipChildren(false);
        item.setPadding(px(14), 0, px(14), 0);

        FrameLayout frame = new FrameLayout(this);
        frame.setFocusable(true);
        frame.setClickable(true);
        float r = round ? box / 2f : px(20);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(round ? 0xFFF1F3F4 : 0xFF2A2F3A);
        bg.setCornerRadius(r);
        frame.setBackground(bg);
        frame.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), r); }
        });
        frame.setClipToOutline(true);
        ImageView image = new ImageView(this);
        image.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int pad = round ? px(14) : 0;
        image.setPadding(pad, pad, pad, pad);
        if (icon != null) image.setImageDrawable(icon);
        frame.addView(image, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View ring = new View(this);
        GradientDrawable stroke = new GradientDrawable();
        stroke.setColor(Color.TRANSPARENT);
        stroke.setCornerRadius(r);
        stroke.setStroke(px(3), Color.WHITE);
        ring.setBackground(stroke);
        ring.setAlpha(0f);
        frame.addView(ring, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        item.addView(frame, new LinearLayout.LayoutParams(box, box));

        TextView label = text(name == null ? "" : name, 13, TEXT_DIM, regular);
        label.setGravity(Gravity.CENTER);
        label.setSingleLine(true);
        label.setEllipsize(TextUtils.TruncateAt.END);
        label.setPadding(0, px(10), 0, 0);
        item.addView(label, new LinearLayout.LayoutParams(box + px(24), ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView st = null;
        if (status != null) {
            st = text(status, 11, "מותקן".equals(status) ? 0x66E8EAED : 0xFF8AB4F8, medium);
            st.setGravity(Gravity.CENTER);
            item.addView(st, new LinearLayout.LayoutParams(box + px(24), ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        frame.setOnFocusChangeListener((v, f) -> {
            float s = f ? 1.12f : 1f;
            v.animate().scaleX(s).scaleY(s).setDuration(180).setInterpolator(new DecelerateInterpolator(2f)).start();
            v.setElevation(f ? px(10) : 0);
            ring.animate().alpha(f ? 1f : 0f).setDuration(150).start();
            label.setTextColor(f ? TEXT : TEXT_DIM);
        });
        frame.setOnClickListener(v -> open.run());
        if (remotePkg != null) fetch(remotePkg, image, label, box);
        return item;
    }

    // ---- icons and names from Play ----

    private SharedPreferences cache() {
        return getSharedPreferences("play_meta", Context.MODE_PRIVATE);
    }

    private String cachedName(String pkg) {
        String n = cache().getString(pkg + ".name", null);
        return n != null ? n : pkg.substring(pkg.lastIndexOf('.') + 1);
    }

    private static final Pattern OG_IMAGE = Pattern.compile("property=\"og:image\" content=\"([^\"]+)\"");
    private static final Pattern OG_TITLE = Pattern.compile("property=\"og:title\" content=\"([^\"]+)\"");

    private void fetch(String pkg, ImageView image, TextView label, int box) {
        Bitmap hit = ICONS.get(pkg);
        if (hit != null) { image.setImageBitmap(hit); return; }
        net.execute(() -> {
            try {
                SharedPreferences c = cache();
                String iconUrl = c.getString(pkg + ".icon", null);
                String name = c.getString(pkg + ".name", null);
                if (iconUrl == null) {
                    // The page's head has og:image and og:title; stop reading once both are in.
                    HttpURLConnection conn = (HttpURLConnection) new URL("https://play.google.com/store/apps/details?id=" + pkg + "&hl=iw&gl=IL").openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(12000);
                    conn.setRequestProperty("User-Agent", "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Safari/537.36");
                    if (conn.getResponseCode() != 200) return;
                    // The og tags sit about 950 KB into the page, so read up to 1.6 MB, once per app (then cached).
                    ByteArrayOutputStream raw = new ByteArrayOutputStream();
                    try (InputStream in = conn.getInputStream()) {
                        byte[] buf = new byte[32768];
                        int n;
                        while ((n = in.read(buf)) > 0 && raw.size() < 1_600_000) raw.write(buf, 0, n);
                    }
                    String head = raw.toString("UTF-8");
                    Matcher mi = OG_IMAGE.matcher(head), mt = OG_TITLE.matcher(head);
                    if (!mi.find()) return;
                    iconUrl = mi.group(1).replaceAll("=[ws]\\d+.*$", "") + "=w" + box;
                    if (mt.find()) name = mt.group(1).replaceAll("\\s*[–-]\\s*(אפליקציות ב-Google Play|Apps on Google Play).*$", "").replace("&amp;", "&");
                    c.edit().putString(pkg + ".icon", iconUrl).putString(pkg + ".name", name).apply();
                }
                Bitmap b = bitmap(pkg, iconUrl);
                String shown = name;
                main.post(() -> {
                    if (isFinishing()) return;
                    if (b != null) {
                        ICONS.put(pkg, b);
                        image.setImageBitmap(b);
                        image.setAlpha(0f);
                        image.animate().alpha(1f).setDuration(180).start();
                    }
                    if (shown != null) label.setText(rtl(shown));
                });
            } catch (Exception ignored) { }
        });
    }

    private Bitmap bitmap(String pkg, String url) throws Exception {
        File dir = new File(getCacheDir(), "play_icons");
        if (!dir.isDirectory()) dir.mkdirs();
        File f = new File(dir, pkg + ".png");
        if (!f.isFile() || f.length() == 0) {
            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(12000);
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(f)) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
        return BitmapFactory.decodeFile(f.getPath());
    }

    // ---- helpers ----

    private void play(Intent i) {
        try {
            startActivity(i.setPackage("com.android.vending").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (ActivityNotFoundException e) {
            Intent store = getPackageManager().getLeanbackLaunchIntentForPackage("com.android.vending");
            if (store != null) startActivity(store);
        }
    }

    private static String rtl(String s) {
        return s.matches(".*[\\u0590-\\u05FF].*") ? "‏" + s : s;
    }

    private TextView text(String s, int sp, int color, Typeface face) {
        TextView t = new TextView(this);
        t.setText(rtl(s));
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(face);
        t.setGravity(Gravity.RIGHT);
        t.setIncludeFontPadding(false);
        return t;
    }

    private int px(float dp) {
        return Math.round(dp * d);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Back from Play's install window: rebuild so a newly installed app shows as installed.
        if (page.getChildCount() > 0 && installedSince()) recreate();
    }

    private int lastCount = -1;

    private boolean installedSince() {
        int now = 0;
        try { now = HelperLink.apps(this).length(); } catch (Exception ignored) { }
        boolean changed = lastCount >= 0 && now != lastCount;
        lastCount = now;
        return changed;
    }

    @Override
    protected void onDestroy() {
        net.shutdownNow();
        super.onDestroy();
    }
}
