package com.gathin.tvhome;

import android.app.Activity;
import android.content.Intent;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * NOW design: Home shows only the dock. Down from the dock brings this row up from the bottom: the apps used most
 * recently ("Continue watching"), newest on the right, and an "All apps" card at the end. Up or Back puts it away.
 */
final class ContinueRow {

    private static final int MAX = 8;
    final LinearLayout view;
    private final Activity activity;
    private final LinearLayout cards;
    private final HorizontalScrollView scroll;
    private final int w, h;
    boolean shown;

    ContinueRow(Activity a, FrameLayout root) {
        activity = a;
        w = AppCards.px(a, 176);
        h = AppCards.px(a, 99);
        view = new LinearLayout(a);
        view.setOrientation(LinearLayout.VERTICAL);
        view.setClipChildren(false);
        view.setClipToPadding(false);
        view.setPadding(0, AppCards.px(a, 16), 0, AppCards.px(a, 26));
        view.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0xCC000000, 0xF2000000}));

        TextView title = new TextView(a);
        title.setText("‏המשך צפייה");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19);
        title.setTypeface(a.getResources().getFont(R.font.outfit_medium));
        title.setGravity(Gravity.RIGHT);
        title.setPadding(AppCards.px(a, 56), 0, AppCards.px(a, 56), AppCards.px(a, 6));
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
        cards.setPadding(AppCards.px(a, 50), AppCards.px(a, 8), AppCards.px(a, 50), 0);
        scroll.addView(cards, new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        view.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        view.setVisibility(View.GONE);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
    }

    /** How far Home moves up to make room for the row. */
    int lift() {
        return h + AppCards.px(activity, 96);
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
        scroll.post(() -> scroll.fullScroll(View.FOCUS_RIGHT));
        if (first != null) first.requestFocus();
    }

    void hide(boolean animate) {
        shown = false;
        if (!animate) { view.setVisibility(View.GONE); return; }
        view.animate().alpha(0f).translationY(lift() / 2f).setDuration(180)
                .withEndAction(() -> { if (!shown) view.setVisibility(View.GONE); }).start();
    }

    private void fill() {
        cards.removeAllViews();
        List<View> row = new ArrayList<>();       // in reading order: newest first
        for (String[] app : AppCards.byUse(activity)) {
            if (!AppCards.usedLately(app)) break;
            row.add(AppCards.app(activity, app[0], app[1], w, h));
            if (row.size() == MAX) break;
        }
        LinearLayout all = AppCards.card(activity, activity.getDrawable(R.drawable.ic_qs_input), true, "כל האפליקציות", w, h);
        all.getChildAt(0).setOnClickListener(v -> activity.startActivity(new Intent(activity, AllAppsActivity.class)));
        row.add(all);
        int gap = AppCards.px(activity, 18);
        // Right to left by hand: the newest card is added last, so it sits on the right.
        for (int i = row.size() - 1; i >= 0; i--) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = i == row.size() - 1 ? 0 : gap;
            cards.addView(row.get(i), lp);
        }
    }
}
