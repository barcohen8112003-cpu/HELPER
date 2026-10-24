package com.gathin.tvhome;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * The Google Play button's panel, a part of Home rather than the Play app: search for apps, apps worth having in
 * Israel (installed ones open, the rest go to Play's small install window), updates, and the apps on this TV with
 * open, Play page and app info (where uninstall is). It looks and moves like the settings panel; Back steps out of a
 * menu, then closes.
 */
public class PlayPanelActivity extends Activity {

    private static final int PANEL = 0xF2263148;
    private static final int TILE = 0x1FFFFFFF;
    private static final int TILE_FOCUSED = 0xFFE8EAED;
    private static final int TEXT = 0xFFE8EAED;
    private static final int TEXT_DIM = 0x99E8EAED;
    private static final int INK = 0xFF202124;
    private static final int ACCENT = 0xFF8AB4F8;

    /** Worth having on a TV in Israel: {package, name, what it is}. */
    private static final String[][] PICKS = {
            {"com.applicaster.il.ch1", "כאן BOX", "תאגיד השידור"},
            {"com.keshet.mako.VODAndroidTV", "mako 12+", "קשת 12"},
            {"com.applicaster.iReshet", "13+", "רשת 13"},
            {"il.co.yes.yesplus", "yes+", "yes"},
            {"il.co.stingtv.atv", "STING+", "סטינג"},
            {"com.netflix.ninja", "Netflix", "סדרות וסרטים"},
            {"com.disneyplus.mea", "Disney+", "דיסני, מארוול, סטאר וורס"},
            {"com.amazon.amazonvideo.livingroom", "Prime Video", "אמזון"},
            {"com.apple.atve.androidtv.appletv", "Apple TV", "Apple TV+"},
            {"com.wbd.stream", "Max", "HBO"},
            {"com.spotify.tv.android", "Spotify", "מוזיקה"},
            {"com.google.android.youtube.tvmusic", "YouTube Music", "מוזיקה"},
            {"com.google.android.youtube.tvkids", "YouTube Kids", "לילדים"},
            {"com.plexapp.android", "Plex", "הספרייה שלך"},
    };

    private float d;
    private Typeface regular, medium;
    private LinearLayout body;
    private TextView header;
    private ScrollView scroller;
    private boolean inMenu;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;
        regular = getResources().getFont(R.font.outfit_regular);
        medium = getResources().getFont(R.font.outfit_medium);

        FrameLayout root = new FrameLayout(this);
        root.setOnClickListener(v -> finish());
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(px(12), px(12), px(12), px(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(PANEL);
        bg.setCornerRadius(px(24));
        panel.setBackground(bg);
        panel.setElevation(px(8));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(372), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.LEFT | Gravity.TOP);
        lp.leftMargin = px(16);
        lp.topMargin = px(16);
        lp.bottomMargin = px(16);
        root.addView(panel, lp);

        // Header: the Play mark beside the name, as in the settings panel's account row.
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.HORIZONTAL);
        head.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        head.setPadding(px(10), px(4), px(10), px(12));
        header = label("Google Play", 17, TEXT, medium);
        head.addView(header, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        ImageView mark = new ImageView(this);
        mark.setImageResource(R.drawable.ic_play_store);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(px(22), px(22));
        mp.leftMargin = px(10);
        head.addView(mark, mp);
        panel.addView(head);

        scroller = new ScrollView(this);
        scroller.setVerticalScrollBarEnabled(false);
        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        scroller.addView(body);
        panel.addView(scroller, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        showMain();
        panel.setAlpha(0f);
        panel.setTranslationX(-px(24));
        panel.animate().alpha(1f).translationX(0).setDuration(200).setInterpolator(new DecelerateInterpolator(1.5f)).start();
    }

    // ---- pages ----

    private void showMain() {
        inMenu = false;
        header.setText("‏Google Play");
        body.removeAllViews();
        searchField();
        row(null, "העדכונים שלי", "אפליקציות שיש להן גרסה חדשה", () -> play(new Intent("com.google.android.finsky.VIEW_MY_DOWNLOADS")));
        row(null, "האפליקציות שלי", installed().size() + " אפליקציות בטלוויזיה", this::showMine);
        section("מומלצות");
        PackageManager pm = getPackageManager();
        for (String[] pick : PICKS) {
            boolean has = launchable(pm, pick[0]);
            row(has ? "מותקן" : "התקנה", pick[1], pick[2], () -> {
                if (has) { Helper.openApp(this, pick[0]); finish(); }
                else details(pick[0]);
            });
        }
        row(null, "לחנות המלאה", null, () -> play(getPackageManager().getLeanbackLaunchIntentForPackage("com.android.vending")));
        scroller.scrollTo(0, 0);
        body.getChildAt(0).requestFocus();
    }

    private void showMine() {
        inMenu = true;
        header.setText("‏האפליקציות שלי");
        body.removeAllViews();
        for (String[] app : installed()) {
            row(null, app[1], app[0], () -> showApp(app[0], app[1]));
        }
        scroller.scrollTo(0, 0);
        if (body.getChildCount() > 0) body.getChildAt(0).requestFocus();
    }

    private void showApp(String pkg, String label) {
        inMenu = true;
        header.setText("‏" + label);
        body.removeAllViews();
        row(null, "פתח", null, () -> { Helper.openApp(this, pkg); finish(); });
        row(null, "הדף ב-Google Play", "עדכון, דירוג ותיאור", () -> details(pkg));
        row(null, "פרטי האפליקציה", "אחסון, הרשאות והסרה", () -> {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg)));
                finish();
            } catch (ActivityNotFoundException ignored) { }
        });
        body.getChildAt(0).requestFocus();
    }

    @Override
    public void onBackPressed() {
        if (inMenu) showMain();
        else finish();
    }

    // ---- Play ----

    /** Play's own small install window for one app. */
    private void details(String pkg) {
        play(new Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=" + pkg)).setPackage("com.android.vending"));
    }

    private void search(String q) {
        if (q.trim().isEmpty()) return;
        play(new Intent(Intent.ACTION_VIEW, Uri.parse("market://search?q=" + Uri.encode(q.trim()) + "&c=apps")).setPackage("com.android.vending"));
    }

    private void play(Intent i) {
        if (i == null) return;
        try {
            startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            finish();
        } catch (ActivityNotFoundException e) {
            Intent store = getPackageManager().getLeanbackLaunchIntentForPackage("com.android.vending");
            if (store != null) { startActivity(store); finish(); }
        }
    }

    /** Apps this TV's owner installed (not part of the system), with a TV or phone launcher entry. */
    private List<String[]> installed() {
        List<String[]> out = new ArrayList<>();
        PackageManager pm = getPackageManager();
        try {
            JSONArray a = HelperLink.apps(this);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                String pkg = o.getString("pkg");
                try {
                    ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                    boolean system = (ai.flags & ApplicationInfo.FLAG_SYSTEM) != 0 && (ai.flags & ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) == 0;
                    if (!system) out.add(new String[]{pkg, o.getString("label")});
                } catch (PackageManager.NameNotFoundException ignored) { }
            }
        } catch (Exception ignored) { }
        out.sort((x, y) -> x[1].compareToIgnoreCase(y[1]));
        return out;
    }

    private static boolean launchable(PackageManager pm, String pkg) {
        return pm.getLeanbackLaunchIntentForPackage(pkg) != null || pm.getLaunchIntentForPackage(pkg) != null;
    }

    // ---- rows ----

    private void searchField() {
        EditText f = new EditText(this);
        f.setHint("‏חיפוש אפליקציות");
        f.setHintTextColor(TEXT_DIM);
        f.setTextColor(TEXT);
        f.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        f.setTypeface(regular);
        f.setSingleLine(true);
        f.setGravity(Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        f.setTextDirection(View.TEXT_DIRECTION_RTL);
        f.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        f.setPadding(px(16), 0, px(16), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(px(14));
        bg.setColor(TILE);
        bg.setStroke(px(1), 0x33FFFFFF);
        f.setBackground(bg);
        f.setOnFocusChangeListener((v, has) -> bg.setStroke(px(has ? 2 : 1), has ? ACCENT : 0x33FFFFFF));
        f.setOnEditorActionListener((v, id, e) -> {
            boolean go = id == EditorInfo.IME_ACTION_SEARCH || id == EditorInfo.IME_ACTION_DONE
                    || (e != null && e.getKeyCode() == KeyEvent.KEYCODE_ENTER && e.getAction() == KeyEvent.ACTION_DOWN);
            if (!go) return false;
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(f.getWindowToken(), 0);
            search(f.getText().toString());
            return true;
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(52));
        lp.bottomMargin = px(8);
        body.addView(f, lp);
    }

    /** A list row: title and subtitle on the right, an optional status on the left. */
    private void row(String status, String title, String subtitle, Runnable action) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(px(16), px(10), px(16), px(10));
        r.setMinimumHeight(px(56));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(px(14));
        bg.setColor(TILE);
        r.setBackground(bg);
        r.setFocusable(true);
        r.setClickable(true);
        TextView st = null;
        if (status != null) {
            st = label(status, 12, "מותקן".equals(status) ? TEXT_DIM : ACCENT, medium);
            st.setGravity(Gravity.LEFT);
            r.addView(st, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        }
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setGravity(Gravity.RIGHT);
        TextView t = label(title, 14, TEXT, regular);
        texts.addView(t);
        TextView s = null;
        if (subtitle != null) {
            s = label(subtitle, 12, TEXT_DIM, regular);
            s.setPadding(0, px(3), 0, 0);
            texts.addView(s);
        }
        r.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView sub = s, stat = st;
        int statColor = st == null ? 0 : st.getCurrentTextColor();
        r.setOnFocusChangeListener((v, f) -> {
            bg.setColor(f ? TILE_FOCUSED : TILE);
            t.setTextColor(f ? INK : TEXT);
            if (sub != null) sub.setTextColor(f ? 0x99202124 : TEXT_DIM);
            if (stat != null) stat.setTextColor(f ? 0xFF1A73E8 : statColor);
        });
        r.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(6);
        body.addView(r, lp);
    }

    private void section(String title) {
        TextView t = label(title, 12, TEXT_DIM, medium);
        t.setPadding(px(10), px(10), px(10), px(6));
        body.addView(t);
    }

    private TextView label(String s, int sp, int color, Typeface face) {
        TextView t = new TextView(this);
        // Hebrew reads right to left; a Latin name ("yes+", "mako 12+") keeps its own order and is only aligned right.
        t.setText(s.matches(".*[֐-׿].*") ? "‏" + s : s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(face);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.RIGHT);
        t.setIncludeFontPadding(false);
        return t;
    }

    private int px(float dp) {
        return Math.round(dp * d);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isFinishing()) finish();
    }
}
