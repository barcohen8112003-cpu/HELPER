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


/**
 * Every app on the TV, from the last card of "Continue watching": banners five to a row, read right to left, in the
 * NOW design's dark. OK opens an app; holding OK opens its app info.
 */
public class AllAppsActivity extends Activity {

    /** Extra: true opens the "Live" tab, the apps with live TV channels. */
    static final String EXTRA_LIVE = "live";

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

        View first = AppsGallery.fill(this, col, live, getResources().getDisplayMetrics().widthPixels - 2 * side);
        if (first != null) first.requestFocus();
    }
}
