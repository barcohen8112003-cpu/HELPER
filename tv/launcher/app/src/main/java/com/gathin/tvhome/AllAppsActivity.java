package com.gathin.tvhome;

import android.app.Activity;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.List;

/**
 * Every app on the TV, from the last card of "Continue watching": banners five to a row, read right to left, in the
 * NOW design's dark. OK opens an app; holding OK opens its app info.
 */
public class AllAppsActivity extends Activity {

    private static final int PER_ROW = 5;
    /** Extra: true opens the "Live" tab, the apps with live TV channels. */
    static final String EXTRA_LIVE = "live";
    private static final java.util.Set<String> LIVE = new java.util.HashSet<>(java.util.Arrays.asList(
            "com.applicaster.il.ch1", "com.keshet.mako.VODAndroidTV", "com.applicaster.iReshet", "il.co.stingtv.atv",
            "il.co.yes.yesplus", "il.co.hot.hottv", "com.google.android.tv", "com.partner.tv", "il.co.cellcom.tv",
            "com.kan.kan", "il.co.i24news", "tv.pluto.android", "com.tubitv"));

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int side = AppCards.px(this, 56);
        FrameLayout root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0xF5101319, 0xFA07090D}));
        ScrollView scroll = new ScrollView(this);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipToPadding(false);
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setClipChildren(false);
        col.setPadding(side, AppCards.px(this, 44), side, AppCards.px(this, 44));
        scroll.addView(col);
        root.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        TextView title = new TextView(this);
        boolean live = getIntent().getBooleanExtra(EXTRA_LIVE, false);
        title.setText(live ? "‏שידור חי" : "‏כל האפליקציות");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTypeface(getResources().getFont(R.font.outfit_light));
        title.setGravity(Gravity.RIGHT);
        title.setPadding(0, 0, AppCards.px(this, 8), AppCards.px(this, 18));
        col.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        List<String[]> apps = AppCards.byUse(this);
        if (live) apps.removeIf(a -> !LIVE.contains(a[0]));
        apps.sort((a, b) -> a[1].compareToIgnoreCase(b[1]));
        int width = getResources().getDisplayMetrics().widthPixels - 2 * side;
        int gap = AppCards.px(this, 22);
        int w = (width - gap * (PER_ROW - 1)) / PER_ROW, h = Math.round(w * 9 / 16f);
        View first = null;
        for (int i = 0; i < apps.size(); i += PER_ROW) {
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.RIGHT);
            row.setClipChildren(false);
            // Right to left by hand: the row's first app is added last so it sits on the right.
            int end = Math.min(apps.size(), i + PER_ROW);
            for (int j = end - 1; j >= i; j--) {
                View card = AppCards.app(this, apps.get(j)[0], apps.get(j)[1], w, h);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.leftMargin = j == i ? 0 : gap;
                row.addView(card, lp);
                if (j == i && i == 0) first = ((ViewGroup) card).getChildAt(0);
            }
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            rp.bottomMargin = AppCards.px(this, 6);
            col.addView(row, rp);
        }
        if (first != null) first.requestFocus();
    }
}
