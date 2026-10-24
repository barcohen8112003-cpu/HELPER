package com.gathin.tvhome;

import android.app.Activity;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Outline;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.IntConsumer;

/**
 * NOW design: Home shows only the dock. Down from the dock brings this row up from the bottom: "Continue watching"
 * with a card for each streaming service (Disney+, YouTube, Netflix, Stremio) in its own colour, newest on the
 * right, and an "All apps" card at the end. Up or Back puts it away.
 *
 * The services don't share what was being watched with other apps on this TV (nothing in the system's Watch Next),
 * so a card opens the service, where its own Continue watching row is, and says when it was last watched.
 */
final class ContinueRow {

    /** The services, each with the packages it may be installed as (the first one found wins). */
    private static final String[][] SERVICES = {
            {"Disney+", "com.disneyplus.mea", "com.disney.disneyplus"},
            {"YouTube", "com.google.android.youtube.tv"},
            {"Netflix", "com.netflix.ninja"},
            {"Stremio", "com.stremio.one"},
    };

    final LinearLayout view;
    private final Activity activity;
    private final LinearLayout cards;
    private final HorizontalScrollView scroll;
    private final IntConsumer onColor;
    private final int w, h;
    boolean shown;

    ContinueRow(Activity a, FrameLayout root, IntConsumer onColor) {
        activity = a;
        this.onColor = onColor;
        w = AppCards.px(a, 168);
        h = AppCards.px(a, 95);
        view = new LinearLayout(a);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setClipChildren(false);
        view.setClipToPadding(false);
        view.setPadding(0, AppCards.px(a, 16), 0, AppCards.px(a, 22));
        view.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0x99000000, 0xD9000000}));

        TextView title = new TextView(a);
        title.setText("‏המשך צפייה");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setTypeface(a.getResources().getFont(R.font.outfit_medium));
        title.setGravity(Gravity.RIGHT);
        title.setPadding(AppCards.px(a, 44), 0, AppCards.px(a, 44), AppCards.px(a, 8));
        view.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        scroll = new HorizontalScrollView(a);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setClipChildren(false);
        scroll.setClipToPadding(false);
        scroll.setFillViewport(true);
        cards = new LinearLayout(a);
        cards.setOrientation(LinearLayout.HORIZONTAL);
        cards.setGravity(Gravity.RIGHT);
        cards.setClipChildren(false);
        cards.setClipToPadding(false);
        cards.setPadding(AppCards.px(a, 36), AppCards.px(a, 10), AppCards.px(a, 36), 0);
        scroll.addView(cards, new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        view.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        view.setVisibility(View.GONE);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
    }

    /** How far Home moves up to make room for the row. */
    int lift() {
        return h + AppCards.px(activity, 112);
    }

    void show() {
        fill();
        shown = true;
        view.setVisibility(View.VISIBLE);
        view.setAlpha(0f);
        view.setTranslationY(lift() / 2f);
        view.animate().alpha(1f).translationY(0).setDuration(260).setInterpolator(new DecelerateInterpolator(2f)).start();
        // Newest is the rightmost card: start there.
        View first = cards.getChildCount() > 0 ? ((ViewGroup) cards.getChildAt(cards.getChildCount() - 1)).getChildAt(0) : null;
        if (first != null) first.requestFocus();
        // Show the right end, where the newest card is (fullScroll would also move the focus).
        scroll.post(() -> {
            scroll.scrollTo(cards.getWidth(), 0);
            if (first != null) first.requestFocus();
        });
    }

    void hide(boolean animate) {
        shown = false;
        if (!animate) { view.setVisibility(View.GONE); return; }
        view.animate().alpha(0f).translationY(lift() / 2f).setDuration(180)
                .withEndAction(() -> { if (!shown) view.setVisibility(View.GONE); }).start();
    }

    private void fill() {
        cards.removeAllViews();
        Map<String, Long> used = lastUsed(activity);
        PackageManager pm = activity.getPackageManager();
        List<String[]> found = new ArrayList<>();   // {name, package, last used}
        for (String[] s : SERVICES) {
            for (int i = 1; i < s.length; i++) {
                if (pm.getLeanbackLaunchIntentForPackage(s[i]) == null && pm.getLaunchIntentForPackage(s[i]) == null) continue;
                Long t = used.get(s[i]);
                found.add(new String[]{s[0], s[i], String.valueOf(t == null ? 0 : t)});
                break;
            }
        }
        // Reading order: the one watched last first (it ends up on the right).
        found.sort((x, y) -> Long.compare(Long.parseLong(y[2]), Long.parseLong(x[2])));
        List<View> row = new ArrayList<>();
        for (String[] f : found) row.add(service(f[0], f[1], Long.parseLong(f[2])));
        row.add(allApps());
        int gap = AppCards.px(activity, 20);
        // Right to left by hand: the newest card is added last, so it sits on the right.
        for (int i = row.size() - 1; i >= 0; i--) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = i == row.size() - 1 ? 0 : gap;
            cards.addView(row.get(i), lp);
        }
    }

    /** A service's card: its colour, its white logo, and under it the name and when it was last watched. */
    private View service(String name, String pkg, long lastUsed) {
        int color = Brand.color(pkg);
        Drawable art = AppCards.banner(activity, pkg);
        if (art == null) {
            try { art = activity.getPackageManager().getApplicationIcon(pkg); } catch (PackageManager.NameNotFoundException ignored) { }
        }
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TL_BR,
                new int[]{Brand.lighter(color, 0.08f), Brand.darker(color, 0.55f)});
        LogoMaker.Logo logo = art != null ? LogoMaker.logo(pkg, art) : null;
        ImageView image = new ImageView(activity);
        if (logo != null) {
            image.setImageBitmap(logo.bitmap);
            image.setScaleType(ImageView.ScaleType.FIT_CENTER);
            int padX = Math.round(w * (1f - logo.scale * 0.6f) / 2f), padY = Math.round(h * (1f - logo.scale * 0.5f) / 2f);
            image.setPadding(padX, padY, padX, padY);
        } else {
            image.setImageDrawable(art);
            image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        }
        LinearLayout item = card(bg, image, color, name, lastUsed > 0 ? ago(lastUsed) : "‏לא נצפה לאחרונה", w);
        item.getChildAt(0).setOnClickListener(v -> Helper.openApp(activity, pkg));
        return item;
    }

    private View allApps() {
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x33FFFFFF, 0x14FFFFFF});
        ImageView image = new ImageView(activity);
        image.setImageDrawable(activity.getDrawable(R.drawable.ic_qs_input));
        image.setScaleType(ImageView.ScaleType.CENTER);
        image.setScaleX(1.6f);
        image.setScaleY(1.6f);
        LinearLayout item = card(bg, image, 0xFFE8EAED, "‏כל האפליקציות", "", h + AppCards.px(activity, 16));
        item.getChildAt(0).setOnClickListener(v -> activity.startActivity(new Intent(activity, AllAppsActivity.class)));
        return item;
    }

    /** Child 0: the focusable card (glow behind it, ring on focus); then the name and the line under it. */
    private LinearLayout card(GradientDrawable bg, ImageView image, int color, String name, String sub, int w) {
        Context c = activity;
        float r = AppCards.px(c, 16);
        int spread = AppCards.px(c, 20);
        LinearLayout item = new LinearLayout(c);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setClipChildren(false);
        item.setClipToPadding(false);

        FrameLayout holder = new FrameLayout(c);
        holder.setClipChildren(false);
        holder.setClipToPadding(false);
        ImageView glow = new ImageView(c);
        glow.setImageBitmap(Brand.glow(w, h, spread, r));
        glow.setImageTintList(ColorStateList.valueOf(color));
        glow.setAlpha(0f);
        FrameLayout.LayoutParams glp = new FrameLayout.LayoutParams(w + 2 * spread, h + 2 * spread);
        glp.leftMargin = -spread;
        glp.topMargin = -spread;
        holder.addView(glow, glp);

        FrameLayout frame = new FrameLayout(c);
        frame.setFocusable(true);
        frame.setClickable(true);
        bg.setCornerRadius(r);
        frame.setBackground(bg);
        frame.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), r); }
        });
        frame.setClipToOutline(true);
        frame.addView(image, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View ring = new View(c);
        GradientDrawable stroke = new GradientDrawable();
        stroke.setColor(0x00000000);
        stroke.setCornerRadius(r);
        stroke.setStroke(AppCards.px(c, 2), 0xE6FFFFFF);
        ring.setBackground(stroke);
        ring.setAlpha(0.25f);
        frame.addView(ring, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        holder.addView(frame, new FrameLayout.LayoutParams(w, h));
        item.addView(holder, new LinearLayout.LayoutParams(w, h));

        TextView title = text(c, name, 15, 0xF2FFFFFF, R.font.outfit_medium);
        title.setPadding(0, AppCards.px(c, 12), 0, 0);
        item.addView(title, new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));
        TextView line = text(c, sub, 12, 0x99FFFFFF, R.font.outfit_light);
        item.addView(line, new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));
        title.setAlpha(0.75f);

        // The holder takes focus through its card, so the glow scales with it.
        holder.setFocusable(false);
        frame.setOnFocusChangeListener((v, has) -> {
            float s = has ? 1.08f : 1f;
            v.animate().scaleX(s).scaleY(s).setDuration(220).setInterpolator(new DecelerateInterpolator(2f)).start();
            glow.animate().alpha(has ? 0.9f : 0f).scaleX(s).scaleY(s).setDuration(has ? 240 : 140).start();
            ring.animate().alpha(has ? 1f : 0.25f).setDuration(160).start();
            title.animate().alpha(has ? 1f : 0.75f).setDuration(160).start();
            if (has && onColor != null) onColor.accept(color);
        });
        // ContinueRow.show() focuses child 0 of the item: hand that on to the card.
        item.setFocusable(false);
        return item;
    }

    private static TextView text(Context c, String s, int sp, int color, int font) {
        TextView t = new TextView(c);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(c.getResources().getFont(font));
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.CENTER);
        return t;
    }

    /** "watched 3 hours ago" in Hebrew. */
    private static String ago(long t) {
        long min = Math.max(0, (System.currentTimeMillis() - t) / 60000);
        if (min < 2) return "‏נצפה עכשיו";
        if (min < 60) return "‏נצפה לפני " + min + " דקות";
        long hours = min / 60;
        if (hours == 1) return "‏נצפה לפני שעה";
        if (hours < 24) return "‏נצפה לפני " + hours + " שעות";
        long days = hours / 24;
        if (days == 1) return "‏נצפה אתמול";
        return "‏נצפה לפני " + days + " ימים";
    }

    private static Map<String, Long> lastUsed(Context c) {
        Map<String, Long> used = new HashMap<>();
        try {
            UsageStatsManager usm = (UsageStatsManager) c.getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, now - 30L * 24 * 3600 * 1000, now);
            if (stats != null) for (UsageStats s : stats) {
                if (s.getTotalTimeInForeground() <= 0) continue;
                Long prev = used.get(s.getPackageName());
                if (prev == null || s.getLastTimeUsed() > prev) used.put(s.getPackageName(), s.getLastTimeUsed());
            }
        } catch (Exception ignored) { }
        return used;
    }
}
