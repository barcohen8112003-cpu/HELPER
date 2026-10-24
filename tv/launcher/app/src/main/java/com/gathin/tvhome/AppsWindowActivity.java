package com.gathin.tvhome;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Process;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Long press on Home: the recent apps as a row of cards, like the phone's app switcher. Left and right move along
 * the row, OK opens the app, Up throws the card away (the app is stopped), and a "close all" button sits on the
 * right. Android gives another app's window to nobody, so a card shows the app's banner or icon, not a picture of
 * what was on its screen. The list comes from usage stats (access granted with appops, or from Settings); closing is
 * killBackgroundProcesses, which stops an app that is in the background.
 */
public class AppsWindowActivity extends Activity {

    private static final long WINDOW_MS = 4L * 60 * 60 * 1000;
    private static final int CARD_W = 330, CARD_H = 186;

    private float d;
    private FrameLayout root;
    private LinearLayout strip;
    private HorizontalScrollView scroll;
    private TextView closeAll, hint;
    private final List<View> cards = new ArrayList<>();
    private final List<String> pkgs = new ArrayList<>();
    /** The selected card, or CLOSE_ALL for the button on the right. */
    private int selected;
    private static final int CLOSE_ALL = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;
        root = new FrameLayout(this);
        root.setBackgroundColor(0xE6070A10);
        root.setOnClickListener(v -> finish());
        setContentView(root);

        TextView title = text("אפליקציות אחרונות", 30, 0xFFFFFFFF, "sans-serif-light");
        title.setTextDirection(View.TEXT_DIRECTION_RTL);
        FrameLayout.LayoutParams tp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.RIGHT);
        tp.topMargin = px(40);
        tp.rightMargin = px(64);
        root.addView(title, tp);

        scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setFocusable(false);
        scroll.setClipChildren(false);
        scroll.setClipToPadding(false);
        strip = new LinearLayout(this);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        strip.setGravity(Gravity.CENTER_VERTICAL);
        strip.setClipChildren(false);
        scroll.addView(strip);
        FrameLayout.LayoutParams sp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, px(CARD_H + 140), Gravity.CENTER_VERTICAL);
        sp.rightMargin = px(210);
        root.addView(scroll, sp);

        closeAll = text("סגור הכול", 20, Color.WHITE, "sans-serif-medium");
        closeAll.setGravity(Gravity.CENTER);
        closeAll.setPadding(px(22), px(12), px(22), px(12));
        closeAll.setTextDirection(View.TEXT_DIRECTION_RTL);
        FrameLayout.LayoutParams cp = new FrameLayout.LayoutParams(px(150), px(64), Gravity.CENTER_VERTICAL | Gravity.RIGHT);
        cp.rightMargin = px(36);
        root.addView(closeAll, cp);
        applyCloseAllLook(false);

        hint = text("", 15, 0x99FFFFFF, "sans-serif");
        hint.setTextDirection(View.TEXT_DIRECTION_RTL);
        FrameLayout.LayoutParams hp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        hp.bottomMargin = px(36);
        root.addView(hint, hp);

        load();
    }

    private void load() {
        cards.clear();
        pkgs.clear();
        strip.removeAllViews();
        if (!hasUsageAccess()) {
            hint.setText("‏כדי להציג אפליקציות צריך הרשאת שימוש באפליקציות (הגדרות ← אפליקציות ← גישה מיוחדת).");
            closeAll.setVisibility(View.GONE);
            return;
        }
        pkgs.addAll(recentPackages());      // newest first
        if (pkgs.isEmpty()) {
            hint.setText("‏אין אפליקציות פתוחות.");
            closeAll.setVisibility(View.GONE);
            return;
        }
        // Oldest on the left, newest next to the button on the right.
        for (int i = pkgs.size() - 1; i >= 0; i--) {
            View card = card(pkgs.get(i));
            cards.add(card);
            strip.addView(card);
        }
        // pkgs follows the order of the cards: oldest first.
        List<String> ordered = new ArrayList<>();
        for (int i = pkgs.size() - 1; i >= 0; i--) ordered.add(pkgs.get(i));
        pkgs.clear();
        pkgs.addAll(ordered);
        closeAll.setVisibility(View.VISIBLE);
        hint.setText("‏◂ ▸ לבחירה   ·   OK לפתיחה   ·   ▲ לסגירת האפליקציה");
        select(cards.size() - 1);
    }

    // ---- cards ----

    private View card(String pkg) {
        FrameLayout c = new FrameLayout(this);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(px(CARD_W), px(CARD_H));
        lp.setMargins(px(18), 0, px(18), 0);
        c.setLayoutParams(lp);
        c.setClipChildren(true);
        c.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), px(18)); }
        });
        c.setClipToOutline(true);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFF1E2636, 0xFF10141E});
        c.setBackground(bg);

        ImageView art = new ImageView(this);
        art.setScaleType(ImageView.ScaleType.CENTER_CROP);
        Drawable banner = banner(pkg);
        if (banner != null) {
            art.setImageDrawable(banner);
        } else {
            art.setScaleType(ImageView.ScaleType.FIT_CENTER);
            art.setPadding(px(110), px(40), px(110), px(60));
            try { art.setImageDrawable(getPackageManager().getApplicationIcon(pkg)); } catch (PackageManager.NameNotFoundException ignored) { }
        }
        c.addView(art, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        TextView name = text(HelperLink.label(this, pkg), 16, Color.WHITE, "sans-serif-medium");
        name.setPadding(px(14), px(26), px(14), px(10));
        name.setSingleLine(true);
        name.setGravity(Gravity.CENTER);
        name.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0xCC000000}));
        c.addView(name, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
        c.setAlpha(0.72f);
        return c;
    }

    private Drawable banner(String pkg) {
        PackageManager pm = getPackageManager();
        try {
            Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
            Drawable b = i != null ? pm.getActivityBanner(i) : null;
            if (b == null) b = pm.getApplicationBanner(pkg);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    // ---- selection ----

    private void select(int index) {
        selected = index;
        for (int i = 0; i < cards.size(); i++) {
            View c = cards.get(i);
            boolean on = i == index;
            c.animate().scaleX(on ? 1.1f : 0.94f).scaleY(on ? 1.1f : 0.94f).alpha(on ? 1f : 0.62f).setDuration(160).start();
            ((GradientDrawable) c.getBackground()).setStroke(on ? px(3) : 0, 0xFFFFFFFF);
        }
        applyCloseAllLook(index == CLOSE_ALL);
        if (index >= 0 && index < cards.size()) {
            View c = cards.get(index);
            c.post(() -> scroll.smoothScrollTo(c.getLeft() - (scroll.getWidth() - c.getWidth()) / 2, 0));
        }
    }

    private void applyCloseAllLook(boolean focused) {
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(px(32));
        g.setColor(focused ? 0xFFF4F6FA : 0x33FFFFFF);
        closeAll.setBackground(g);
        closeAll.setTextColor(focused ? 0xFF16233E : Color.WHITE);
        closeAll.animate().scaleX(focused ? 1.08f : 1f).scaleY(focused ? 1.08f : 1f).setDuration(140).start();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (cards.isEmpty()) return super.onKeyDown(keyCode, event);
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_LEFT:
                if (selected == CLOSE_ALL) select(cards.size() - 1);
                else if (selected > 0) select(selected - 1);
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (selected >= 0 && selected < cards.size() - 1) select(selected + 1);
                else if (selected == cards.size() - 1) select(CLOSE_ALL);
                return true;
            case KeyEvent.KEYCODE_DPAD_UP:
                if (selected >= 0) throwAway(selected);
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
                if (selected == CLOSE_ALL) closeEverything();
                else if (selected >= 0) {
                    String pkg = pkgs.get(selected);
                    finish();
                    Helper.openApp(this, pkg);
                }
                return true;
            case KeyEvent.KEYCODE_HOME:
                finish();
                return true;
            default:
                return super.onKeyDown(keyCode, event);
        }
    }

    /** Up: the card flies off the top, and the app is stopped. */
    private void throwAway(int index) {
        View c = cards.get(index);
        String pkg = pkgs.get(index);
        kill(pkg);
        c.animate().translationY(-px(CARD_H + 120)).alpha(0f).setDuration(220).withEndAction(() -> {
            strip.removeView(c);
            int i = cards.indexOf(c);
            cards.remove(c);
            if (i >= 0) pkgs.remove(i);
            if (cards.isEmpty()) { finish(); return; }
            select(Math.min(Math.max(i, 0), cards.size() - 1));
        }).start();
    }

    private void closeEverything() {
        for (String p : pkgs) kill(p);
        for (View c : cards) c.animate().translationY(-px(CARD_H + 120)).alpha(0f).setDuration(240).start();
        root.postDelayed(this::finish, 260);
    }

    private void kill(String pkg) {
        ActivityManager am = (ActivityManager) getSystemService(Context.ACTIVITY_SERVICE);
        if (am != null) am.killBackgroundProcesses(pkg);
    }

    // ---- which apps ----

    private boolean hasUsageAccess() {
        AppOpsManager ops = (AppOpsManager) getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return false;
        return ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), getPackageName()) == AppOpsManager.MODE_ALLOWED;
    }

    /** Apps brought to the front in the last few hours, newest first, only ones that have a launcher entry. */
    private List<String> recentPackages() {
        UsageStatsManager usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
        long now = System.currentTimeMillis();
        UsageEvents events = usm.queryEvents(now - WINDOW_MS, now);
        Map<String, Long> last = new LinkedHashMap<>();
        UsageEvents.Event e = new UsageEvents.Event();
        PackageManager pm = getPackageManager();
        while (events.hasNextEvent()) {
            events.getNextEvent(e);
            if (e.getEventType() != UsageEvents.Event.ACTIVITY_RESUMED && e.getEventType() != UsageEvents.Event.MOVE_TO_FOREGROUND) continue;
            String p = e.getPackageName();
            if (p.equals(getPackageName()) || p.startsWith("com.android.systemui") || p.equals("android")) continue;
            if (pm.getLeanbackLaunchIntentForPackage(p) == null && pm.getLaunchIntentForPackage(p) == null) continue;
            last.put(p, e.getTimeStamp());
        }
        List<Map.Entry<String, Long>> sorted = new ArrayList<>(last.entrySet());
        sorted.sort((a, b) -> Long.compare(b.getValue(), a.getValue()));
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, Long> en : sorted) out.add(en.getKey());
        return out;
    }

    private TextView text(String s, int sp, int color, String family) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        t.setTypeface(Typeface.create(family, Typeface.NORMAL));
        return t;
    }

    private int px(int dp) {
        return Math.round(dp * d);
    }
}
