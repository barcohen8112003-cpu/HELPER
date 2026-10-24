package com.gathin.tvhome;

import android.app.Activity;
import android.content.Context;
import android.graphics.Outline;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.IntConsumer;

/**
 * NOW design: Home shows only the dock. Down from the dock brings up carousels of series and movies from the bottom:
 * "Continue watching" (what was opened from here), then recommended series and movies, the first title on the right.
 * Down and Up move between the carousels; Up from the first one, or Back, puts them away. A title opens in Stremio.
 */
final class ContinueRow {

    private static final int STREMIO_PURPLE = 0xFF8B5CF6;

    final FrameLayout view;
    private final Activity activity;
    private final ScrollView scroll;
    private final LinearLayout column;
    private final IntConsumer onColor;
    private final int w, h;
    private final List<HorizontalScrollView> rows = new ArrayList<>();
    private List<Titles.Title> series = Collections.emptyList(), movies = Collections.emptyList();
    private int row;
    boolean shown;

    ContinueRow(Activity a, FrameLayout root, IntConsumer onColor) {
        activity = a;
        this.onColor = onColor;
        w = AppCards.px(a, 220);
        h = AppCards.px(a, 124);
        view = new FrameLayout(a);
        view.setClipChildren(false);
        view.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0x99000000, 0xE6000000}));
        scroll = new ScrollView(a);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipChildren(false);
        scroll.setClipToPadding(false);
        scroll.setFocusable(false);
        column = new LinearLayout(a);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setClipChildren(false);
        column.setClipToPadding(false);
        column.setPadding(0, AppCards.px(a, 14), 0, AppCards.px(a, 120));
        scroll.addView(column, new ScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        view.addView(scroll, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.setVisibility(View.GONE);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, lift() + AppCards.px(a, 10), Gravity.BOTTOM));

        // Fetch the catalogs now, so the carousels are full by the time Down is pressed.
        Titles.top(a, "series", list -> { series = list; if (shown) refill(); });
        Titles.top(a, "movie", list -> { movies = list; if (shown) refill(); });
    }

    /** How far Home moves up to make room for the carousels. */
    int lift() {
        return h + AppCards.px(activity, 112);
    }

    void show() {
        shown = true;
        row = 0;
        fill();
        view.setVisibility(View.VISIBLE);
        view.setAlpha(0f);
        view.setTranslationY(lift() / 2f);
        view.animate().alpha(1f).translationY(0).setDuration(260).setInterpolator(new DecelerateInterpolator(2f)).start();
        scroll.scrollTo(0, 0);
        focusRow(0);
    }

    void hide(boolean animate) {
        shown = false;
        if (!animate) { view.setVisibility(View.GONE); return; }
        view.animate().alpha(0f).translationY(lift() / 2f).setDuration(180)
                .withEndAction(() -> { if (!shown) view.setVisibility(View.GONE); }).start();
    }

    /** Down: the next carousel, if there is one. */
    void rowDown() {
        if (row < rows.size() - 1) focusRow(row + 1);
    }

    /** Up: the carousel above; false on the first one (Home then puts the carousels away). */
    boolean rowUp() {
        if (row == 0) return false;
        focusRow(row - 1);
        return true;
    }

    private void focusRow(int i) {
        if (i < 0 || i >= rows.size()) return;
        row = i;
        HorizontalScrollView r = rows.get(i);
        LinearLayout cards = (LinearLayout) r.getChildAt(0);
        if (cards.getChildCount() == 0) return;
        // The carousel's first title is its rightmost card; come back to the one last focused there.
        Object last = r.getTag();
        View target = last instanceof View && ((View) last).getParent() != null ? (View) last
                : ((ViewGroup) cards.getChildAt(cards.getChildCount() - 1)).getChildAt(0);
        target.requestFocus();
        View block = (View) r.getParent();
        scroll.smoothScrollTo(0, block.getTop() - AppCards.px(activity, 14));
        if (last == null) r.post(() -> r.scrollTo(cards.getWidth(), 0));
    }

    /** New catalog data while the carousels are up: rebuild, keeping the focus on the same carousel. */
    private void refill() {
        int keep = row;
        // Hold the focus on the panel while its cards are swapped: dropped, it lands on the dock and Home
        // puts the carousels away.
        view.setFocusable(true);
        view.requestFocus();
        fill();
        focusRow(Math.max(0, Math.min(keep, rows.size() - 1)));
        view.setFocusable(false);
    }

    private void fill() {
        column.removeAllViews();
        rows.clear();
        List<Titles.Title> watching = Titles.watching(activity);
        if (!watching.isEmpty()) addRow("‏המשך צפייה", watching, true);
        if (!series.isEmpty()) addRow(watching.isEmpty() ? "‏סדרות מומלצות בשבילך" : "‏סדרות מומלצות", series, false);
        if (!movies.isEmpty()) addRow("‏סרטים מומלצים", movies, false);
        if (rows.isEmpty()) {
            TextView wait = text(activity, "‏טוען סדרות וסרטים…", 17, 0xB3FFFFFF, R.font.outfit_light);
            wait.setPadding(0, AppCards.px(activity, 40), 0, 0);
            column.addView(wait, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }
    }

    private void addRow(String name, List<Titles.Title> titles, boolean watching) {
        LinearLayout block = new LinearLayout(activity);
        block.setOrientation(LinearLayout.VERTICAL);
        block.setClipChildren(false);
        block.setClipToPadding(false);
        TextView title = text(activity, name, 19, 0xFFFFFFFF, R.font.outfit_medium);
        title.setGravity(Gravity.RIGHT);
        title.setPadding(AppCards.px(activity, 44), 0, AppCards.px(activity, 44), AppCards.px(activity, 8));
        block.addView(title, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        HorizontalScrollView hs = new HorizontalScrollView(activity);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipChildren(false);
        hs.setClipToPadding(false);
        hs.setFillViewport(true);
        hs.setFocusable(false);
        LinearLayout cards = new LinearLayout(activity);
        cards.setOrientation(LinearLayout.HORIZONTAL);
        cards.setGravity(Gravity.RIGHT);
        cards.setClipChildren(false);
        cards.setClipToPadding(false);
        cards.setPadding(AppCards.px(activity, 40), AppCards.px(activity, 10), AppCards.px(activity, 40), 0);
        hs.addView(cards, new HorizontalScrollView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        block.addView(hs, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        int index = rows.size();
        int gap = AppCards.px(activity, 18);
        // Right to left by hand: the first title is added last, so it sits on the right.
        for (int i = titles.size() - 1; i >= 0; i--) {
            View card = card(titles.get(i), watching, index, hs, i == titles.size() - 1, i == 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.leftMargin = i == titles.size() - 1 ? 0 : gap;
            cards.addView(card, lp);
        }
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        bp.bottomMargin = AppCards.px(activity, 18);
        column.addView(block, bp);
        rows.add(hs);
    }

    /** A title's card: its artwork, its logo over the artwork's foot, and its name and kind under the card. */
    private View card(Titles.Title t, boolean watching, int rowIndex, HorizontalScrollView hs, boolean leftEnd, boolean rightEnd) {
        Context c = activity;
        float r = AppCards.px(c, 14);
        LinearLayout item = new LinearLayout(c);
        item.setOrientation(LinearLayout.VERTICAL);
        item.setClipChildren(false);
        item.setClipToPadding(false);

        FrameLayout frame = new FrameLayout(c);
        frame.setFocusable(true);
        frame.setClickable(true);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF1B1E24);
        bg.setCornerRadius(r);
        frame.setBackground(bg);
        frame.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setRoundRect(0, 0, v.getWidth(), v.getHeight(), r); }
        });
        frame.setClipToOutline(true);
        ImageView art = new ImageView(c);
        art.setScaleType(ImageView.ScaleType.CENTER_CROP);
        frame.addView(art, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        View shade = new View(c);
        shade.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x00000000, 0xB3000000}));
        frame.addView(shade, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.round(h * 0.6f), Gravity.BOTTOM));
        ImageView logo = new ImageView(c);
        logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        FrameLayout.LayoutParams llp = new FrameLayout.LayoutParams(Math.round(w * 0.6f), Math.round(h * 0.34f), Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        llp.bottomMargin = AppCards.px(c, 10);
        frame.addView(logo, llp);
        View ring = new View(c);
        GradientDrawable stroke = new GradientDrawable();
        stroke.setColor(0x00000000);
        stroke.setCornerRadius(r);
        stroke.setStroke(AppCards.px(c, 3), 0xFFFFFFFF);
        ring.setBackground(stroke);
        ring.setAlpha(0f);
        frame.addView(ring, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        item.addView(frame, new LinearLayout.LayoutParams(w, h));

        int[] color = {STREMIO_PURPLE};
        Titles.image(art, t.background, w, bmp -> color[0] = AppAdapter.vividColor(new BitmapDrawable(c.getResources(), bmp)));
        if (!t.logo.isEmpty()) Titles.image(logo, t.logo, Math.round(w * 0.6f), null);

        TextView name = text(c, t.name, 15, 0xF2FFFFFF, R.font.outfit_medium);
        name.setPadding(0, AppCards.px(c, 10), 0, 0);
        name.setAlpha(0.75f);
        item.addView(name, new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));
        String kind = "movie".equals(t.type) ? "סרט" : "סדרה";
        String sub = watching ? "‏" + kind + " · המשך ב־Stremio"
                : "‏" + kind + (t.year.isEmpty() ? "" : " · " + t.year) + (t.rating.isEmpty() ? "" : " · ★ " + t.rating);
        item.addView(text(c, sub, 12, 0x99FFFFFF, R.font.outfit_light), new LinearLayout.LayoutParams(w, ViewGroup.LayoutParams.WRAP_CONTENT));

        frame.setOnClickListener(v -> Titles.open(c, t));
        if (watching) {
            // Holding OK takes it off Continue watching.
            frame.setOnLongClickListener(v -> {
                Titles.forget(c, t.id);
                refill();
                return true;
            });
        }
        frame.setOnKeyListener((v, keyCode, event) -> event.getAction() == KeyEvent.ACTION_DOWN
                && (keyCode == KeyEvent.KEYCODE_DPAD_LEFT && leftEnd || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT && rightEnd));
        frame.setOnFocusChangeListener((v, has) -> {
            float s = has ? 1.08f : 1f;
            v.animate().scaleX(s).scaleY(s).setDuration(220).setInterpolator(new DecelerateInterpolator(2f)).start();
            v.setElevation(has ? AppCards.px(c, 10) : 0);
            ring.animate().alpha(has ? 1f : 0f).setDuration(160).start();
            name.animate().alpha(has ? 1f : 0.75f).setDuration(160).start();
            if (has) {
                row = rowIndex;
                hs.setTag(v);
                if (onColor != null) onColor.accept(color[0]);
            }
        });
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
}
