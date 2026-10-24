package com.gathin.tvhome;

import android.content.Context;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The app gallery: every app's TV banner, five to a row, read right to left. Used by Home's "Apps" and "Live" tabs
 * and by the All apps screen. OK opens an app; holding OK opens its app info.
 */
final class AppsGallery {

    private AppsGallery() { }

    static final int PER_ROW = 5;

    /** Apps with live TV channels, for the "Live" tab. */
    static final Set<String> LIVE = new HashSet<>(Arrays.asList(
            "com.applicaster.il.ch1", "com.keshet.mako.VODAndroidTV", "com.applicaster.iReshet", "il.co.stingtv.atv",
            "il.co.yes.yesplus", "il.co.hot.hottv", "com.google.android.tv", "com.partner.tv", "il.co.cellcom.tv",
            "com.kan.kan", "il.co.i24news", "tv.pluto.android", "com.tubitv"));

    /**
     * Fills col with rows of app cards in a strip width px wide; live keeps only the live-TV apps. Returns the
     * first card (the right end of the first row), or null when there are none.
     */
    static View fill(Context c, LinearLayout col, boolean live, int width) {
        List<String[]> apps = AppCards.byUse(c);
        if (live) apps.removeIf(a -> !LIVE.contains(a[0]));
        apps.sort((a, b) -> a[1].compareToIgnoreCase(b[1]));
        int gap = AppCards.px(c, 22);
        int w = (width - gap * (PER_ROW - 1)) / PER_ROW, h = Math.round(w * 9 / 16f);
        View first = null;
        for (int i = 0; i < apps.size(); i += PER_ROW) {
            LinearLayout row = new LinearLayout(c);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.RIGHT);
            row.setClipChildren(false);
            row.setClipToPadding(false);
            // Right to left by hand: the row's first app is added last so it sits on the right.
            int end = Math.min(apps.size(), i + PER_ROW);
            for (int j = end - 1; j >= i; j--) {
                View card = AppCards.app(c, apps.get(j)[0], apps.get(j)[1], w, h);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.leftMargin = j == end - 1 ? 0 : gap;   // the leftmost card has nothing to its left
                row.addView(card, lp);
                if (j == i && i == 0) first = ((ViewGroup) card).getChildAt(0);
            }
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rp.bottomMargin = AppCards.px(c, 6);
            col.addView(row, rp);
        }
        return first;
    }
}
