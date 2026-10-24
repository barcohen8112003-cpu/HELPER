package com.gathin.tvhome;

import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
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
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * App cards for the "Continue watching" row and the All apps screen: the app's TV banner in a rounded card (or its
 * icon on a dark card), a white ring and a small zoom on focus, and the name under the focused card.
 */
final class AppCards {

    private AppCards() { }

    static int px(Context c, float dp) {
        return Math.round(dp * c.getResources().getDisplayMetrics().density);
    }

    /** {package, label} of every launchable app, most recently used first (usage access granted with appops). */
    static List<String[]> byUse(Context c) {
        Map<String, Long> used = new HashMap<>();
        try {
            UsageStatsManager usm = (UsageStatsManager) c.getSystemService(Context.USAGE_STATS_SERVICE);
            long now = System.currentTimeMillis();
            List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_BEST, now - 14L * 24 * 3600 * 1000, now);
            if (stats != null) for (UsageStats s : stats) {
                if (s.getTotalTimeInForeground() <= 0) continue;
                Long prev = used.get(s.getPackageName());
                if (prev == null || s.getLastTimeUsed() > prev) used.put(s.getPackageName(), s.getLastTimeUsed());
            }
        } catch (Exception ignored) { }
        List<String[]> out = new ArrayList<>();
        try {
            JSONArray a = HelperLink.apps(c);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new String[]{o.getString("pkg"), o.getString("label"), String.valueOf(used.containsKey(o.getString("pkg")) ? used.get(o.getString("pkg")) : 0)});
            }
        } catch (Exception ignored) { }
        out.sort((x, y) -> {
            int t = Long.compare(Long.parseLong(y[2]), Long.parseLong(x[2]));
            return t != 0 ? t : x[1].compareToIgnoreCase(y[1]);
        });
        return out;
    }

    static boolean usedLately(String[] app) {
        return Long.parseLong(app[2]) > 0;
    }

    /** The app's TV banner, or null when it has none. */
    static Drawable banner(Context c, String pkg) {
        PackageManager pm = c.getPackageManager();
        try {
            Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
            Drawable b = i != null ? pm.getActivityBanner(i) : null;
            if (b == null) b = pm.getApplicationBanner(pkg);
            return b;
        } catch (Exception e) {
            return null;
        }
    }

    /** A card for an app, opening it on OK; holding OK opens its app info. */
    static View app(Context c, String pkg, String label, int w, int h) {
        Drawable art = banner(c, pkg);
        boolean icon = art == null;
        if (icon) {
            try { art = c.getPackageManager().getApplicationIcon(pkg); } catch (PackageManager.NameNotFoundException ignored) { }
        }
        View card = card(c, art, icon, label, w, h);
        View frame = ((ViewGroup) card).getChildAt(0);
        frame.setOnClickListener(v -> Helper.openApp(c, pkg));
        frame.setOnLongClickListener(v -> {
            try {
                c.startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + pkg)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) { }
            return true;
        });
        return card;
    }

    /** The card itself: child 0 is the focusable frame, child 1 the name shown while focused. */
    static LinearLayout card(Context c, Drawable art, boolean artIsIcon, String label, int w, int h) {
        LinearLayout item = new LinearLayout(c);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setClipChildren(false);
        item.setClipToPadding(false);
        FrameLayout frame = new FrameLayout(c);
        frame.setFocusable(true);
        frame.setClickable(true);
        float r = px(c, 12);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF22262E);
        bg.setCornerRadius(r);
        frame.setBackground(bg);
        frame.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), r); }
        });
        frame.setClipToOutline(true);
        ImageView image = new ImageView(c);
        image.setScaleType(artIsIcon ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
        int p = artIsIcon ? h / 4 : 0;
        image.setPadding(p, p, p, p);
        image.setImageDrawable(art);
        frame.addView(image, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View ring = new View(c);
        GradientDrawable stroke = new GradientDrawable();
        stroke.setColor(Color.TRANSPARENT);
        stroke.setCornerRadius(r);
        stroke.setStroke(px(c, 3), Color.WHITE);
        ring.setBackground(stroke);
        ring.setAlpha(0f);
        frame.addView(ring, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        item.addView(frame, new LinearLayout.LayoutParams(w, h));

        TextView name = new TextView(c);
        name.setText(label.matches(".*[\u0590-\u05FF].*") ? "‏" + label : label);   // RTL mark only for Hebrew names
        name.setTextColor(0xF2FFFFFF);
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        name.setTypeface(c.getResources().getFont(R.font.outfit_medium));
        name.setSingleLine(true);
        name.setEllipsize(TextUtils.TruncateAt.END);
        name.setGravity(Gravity.CENTER);
        name.setAlpha(0f);
        name.setPadding(0, px(c, 10), 0, 0);
        item.addView(name, new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));

        frame.setOnFocusChangeListener((v, has) -> {
            float s = has ? 1.08f : 1f;
            v.animate().scaleX(s).scaleY(s).setDuration(200).setInterpolator(new DecelerateInterpolator(2f)).start();
            v.setElevation(has ? px(c, 10) : 0);
            ring.animate().alpha(has ? 1f : 0f).setDuration(160).start();
            name.animate().alpha(has ? 1f : 0f).setDuration(has ? 220 : 120).start();
        });
        return item;
    }
}
