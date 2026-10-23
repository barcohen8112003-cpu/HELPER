package com.gathin.tvhome;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The settings panel, from the gear on Home, after Google TV's quick settings: a floating rounded panel with a
 * profile row (HELPER and whether it is connected), small two-column tiles with the icon right next to the label,
 * a screensaver tile drawn with waves and a moon, and a wordmark at the foot. The focused tile turns white with dark
 * ink. Everything fits on one screen, so nothing scrolls.
 *
 * The app does not declare RTL support (Home's Hebrew layout is mirrored by hand in layout-iw), so this panel lays
 * itself out right to left by hand too: in every row the item that reads first is added last.
 */
public class SidePanelActivity extends Activity {

    // Colours measured off Google TV's panel: a deep blue slate, tiles a step lighter, white when focused.
    private static final int PANEL = 0xF2283550;
    private static final int PANEL_EDGE = 0x1FFFFFFF;
    private static final int TILE = 0xFF3A4868;
    private static final int TILE_FOCUSED = 0xFFF1F3F8;
    private static final int INK = 0xFF1B2232;
    private static final int TEXT = 0xFFF1F3F8;
    private static final int TEXT_DIM = 0xB3F1F3F8;

    private float d;
    private LinearLayout column;
    private Tile videoTile;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;

        FrameLayout root = new FrameLayout(this);
        root.setOnClickListener(v -> finish());
        // A light veil so the panel reads as above Home, not a hard black.
        root.setBackgroundColor(0x40000000);

        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(px(20), px(20), px(20), px(14));
        column.setClipChildren(false);
        column.setClipToPadding(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(PANEL);
        bg.setCornerRadius(px(28));
        bg.setStroke(px(1), PANEL_EDGE);
        column.setBackground(bg);
        column.setElevation(px(16));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(420), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.LEFT | Gravity.CENTER_VERTICAL);
        lp.leftMargin = px(28);
        root.addView(column, lp);
        setContentView(root);

        // Profile row, like Google TV's account row.
        boolean connected = Helper.configured(this);
        Tile profile = new Tile(R.drawable.ic_helper, "HELPER", connected ? "מחובר · לחץ כדי לשאול" : "לא מחובר", true,
                () -> { HelperOverlayActivity.open(this, "type", null); finish(); });
        add(profile, px(68));
        space(px(12));

        Tile screensaver = new Tile(0, "שומר מסך", null, false, () -> settings("android.settings.DREAM_SETTINGS"));
        screensaver.waves();
        row(screensaver, new Tile(R.drawable.ic_tile_apps, "אפליקציות", null, false, () -> open(new Intent(this, AppsWindowActivity.class))));
        row(new Tile(R.drawable.ic_tile_display, "תמונה", null, false, () -> settings(Settings.ACTION_DISPLAY_SETTINGS)),
                new Tile(R.drawable.ic_tile_sound, "צליל", null, false, () -> settings(Settings.ACTION_SOUND_SETTINGS)));
        row(new Tile(R.drawable.ic_wifi, "Wi-Fi", null, false, () -> settings(Settings.ACTION_WIFI_SETTINGS)),
                new Tile(R.drawable.ic_tile_bluetooth, "Bluetooth", null, false, () -> settings(Settings.ACTION_BLUETOOTH_SETTINGS)));
        row(new Tile(R.drawable.ic_tile_accessibility, "נגישות", null, false, () -> settings(Settings.ACTION_ACCESSIBILITY_SETTINGS)),
                new Tile(R.drawable.ic_tile_remote, "כפתורי השלט", null, false, () -> open(new Intent(this, ButtonsActivity.class))));
        videoTile = new Tile(R.drawable.ic_tile_video, "טפט וידאו", null, false, this::toggleVideo);
        Tile settings = new Tile(R.drawable.ic_settings, "הגדרות", null, false, () -> settings(Settings.ACTION_SETTINGS));
        settings.view.setOnLongClickListener(v -> { open(new Intent(this, LauncherSettingsActivity.class)); return true; });
        row(videoTile, settings);
        refreshVideo();

        // Wordmark at the foot, where Google TV puts its own.
        TextView mark = new TextView(this);
        mark.setText("HELPER TV");
        mark.setTextColor(TEXT_DIM);
        mark.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        mark.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        mark.setLetterSpacing(0.08f);
        mark.setGravity(Gravity.RIGHT);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        mp.topMargin = px(4);
        mp.rightMargin = px(6);
        column.addView(mark, mp);

        column.setAlpha(0f);
        column.setTranslationX(-px(40));
        column.animate().alpha(1f).translationX(0).setDuration(220).setInterpolator(new DecelerateInterpolator(1.6f)).start();
        profile.view.requestFocus();
    }

    // ---- tiles ----

    /** A tile: an icon (or the profile circle) right next to a label, and an optional second line. */
    private final class Tile {
        final FrameLayout view;
        final GradientDrawable bg = new GradientDrawable();
        final TextView title;
        final TextView subtitle;
        final ImageView icon;
        final GradientDrawable circle;
        WavesDrawable waves;

        Tile(int iconRes, String text, String sub, boolean profile, Runnable action) {
            view = new FrameLayout(SidePanelActivity.this);
            view.setFocusable(true);
            view.setClickable(true);
            bg.setColor(TILE);
            bg.setCornerRadius(px(profile ? 22 : 18));
            view.setBackground(bg);
            view.setClipToOutline(true);

            LinearLayout line = new LinearLayout(SidePanelActivity.this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            line.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
            line.setPadding(px(16), 0, px(16), 0);

            LinearLayout texts = new LinearLayout(SidePanelActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setGravity(Gravity.RIGHT);
            title = label(text, profile ? 17 : 15, TEXT, "sans-serif-medium");
            texts.addView(title);
            subtitle = sub == null ? null : label(sub, 12, TEXT_DIM, "sans-serif");
            if (subtitle != null) texts.addView(subtitle);

            icon = new ImageView(SidePanelActivity.this);
            icon.setScaleType(ImageView.ScaleType.CENTER_INSIDE);
            if (iconRes != 0) icon.setImageResource(iconRes);
            icon.setColorFilter(TEXT);
            int box = px(profile ? 40 : 22);
            LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(box, box);
            ip.leftMargin = px(12);
            circle = profile ? new GradientDrawable() : null;
            if (circle != null) {
                circle.setShape(GradientDrawable.OVAL);
                circle.setColor(0x33FFFFFF);
                icon.setBackground(circle);
                icon.setPadding(px(9), px(9), px(9), px(9));
            }
            // Right to left by hand: the texts first, so the icon ends up on the right of them.
            line.addView(texts, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            if (iconRes != 0) line.addView(icon, ip);
            view.addView(line, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

            view.setOnFocusChangeListener((v, focused) -> paint(focused));
            view.setOnClickListener(v -> action.run());
        }

        /** Google TV's screensaver tile: rolling waves along the bottom and a moon in the corner. */
        void waves() {
            waves = new WavesDrawable();
            View art = new View(SidePanelActivity.this);
            art.setBackground(waves);
            view.addView(art, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            ((FrameLayout.LayoutParams) ((View) title.getParent().getParent()).getLayoutParams()).gravity = Gravity.TOP;
        }

        void paint(boolean focused) {
            bg.setColor(focused ? TILE_FOCUSED : TILE);
            title.setTextColor(focused ? INK : TEXT);
            if (subtitle != null) subtitle.setTextColor(focused ? 0xB31B2232 : TEXT_DIM);
            icon.setColorFilter(focused ? INK : TEXT);
            if (circle != null) circle.setColor(focused ? 0x1F1B2232 : 0x33FFFFFF);
            if (waves != null) waves.setFocused(focused);
            view.animate().scaleX(focused ? 1.03f : 1f).scaleY(focused ? 1.03f : 1f).setDuration(150).start();
        }
    }

    private TextView label(String s, int sp, int color, String family) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(Typeface.create(family, Typeface.NORMAL));
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.RIGHT);
        t.setTextDirection(View.TEXT_DIRECTION_RTL);
        return t;
    }

    private void add(Tile t, int height) {
        column.addView(t.view, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, height));
    }

    private void space(int h) {
        column.addView(new View(this), new LinearLayout.LayoutParams(1, h));
    }

    /** Two tiles side by side: {@code first} reads first, so it goes on the right. */
    private void row(Tile first, Tile second) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setClipChildren(false);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, px(first.waves != null ? 64 : 56), 1f);
        LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, px(first.waves != null ? 64 : 56), 1f);
        a.leftMargin = px(5);
        b.rightMargin = px(5);
        r.addView(second.view, b);
        r.addView(first.view, a);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(10);
        column.addView(r, lp);
        // Right to left: Left moves to the second tile, Right back to the first.
        first.view.setId(View.generateViewId());
        second.view.setId(View.generateViewId());
        first.view.setNextFocusLeftId(second.view.getId());
        second.view.setNextFocusRightId(first.view.getId());
    }

    // ---- actions ----

    private void open(Intent i) {
        try {
            startActivity(i);
            finish();
        } catch (ActivityNotFoundException ignored) { }
    }

    /** A system settings screen, or the main Settings when this TV has no such screen. */
    private void settings(String action) {
        try {
            startActivity(new Intent(action));
        } catch (ActivityNotFoundException e) {
            try { startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (ActivityNotFoundException ignored) { }
        }
        finish();
    }

    private void toggleVideo() {
        VideoWallpaper.setEnabled(this, !VideoWallpaper.enabled(this));
        refreshVideo();
    }

    private void refreshVideo() {
        videoTile.title.setText(VideoWallpaper.enabled(this) ? "טפט וידאו · דלוק" : "טפט וידאו · כבוי");
    }

    private int px(float dp) {
        return Math.round(dp * d);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isFinishing()) finish();
    }

    // ---- the screensaver tile's art ----

    /** Three soft waves along the bottom and a small moon, in light blue; darker ink when the tile is focused. */
    private final class WavesDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private boolean focused;

        void setFocused(boolean f) { focused = f; invalidateSelf(); }

        @Override
        public void draw(Canvas c) {
            Rect b = getBounds();
            int w = b.width(), h = b.height();
            int[] colors = focused
                    ? new int[]{0x553A6FD8, 0x773A6FD8, 0xAA3A6FD8}
                    : new int[]{0x3399C2FF, 0x5599C2FF, 0x8899C2FF};
            for (int i = 0; i < 3; i++) {
                float base = h * (0.62f + i * 0.12f);
                float amp = h * (0.07f - i * 0.012f);
                path.rewind();
                path.moveTo(0, h);
                path.lineTo(0, base);
                int steps = 24;
                for (int s = 0; s <= steps; s++) {
                    float x = w * s / (float) steps;
                    float y = base + amp * (float) Math.sin((s / (float) steps) * Math.PI * 2 * (1.2f + i * 0.35f) + i * 1.3f);
                    path.lineTo(x, y);
                }
                path.lineTo(w, h);
                path.close();
                paint.setColor(colors[i]);
                c.drawPath(path, paint);
            }
            // The moon, top left (the label is on the right).
            paint.setColor(focused ? 0xCC3A6FD8 : 0xE6DCE8FF);
            c.drawCircle(px(20), px(18), px(6), paint);
        }

        @Override public void setAlpha(int alpha) { }
        @Override public void setColorFilter(ColorFilter cf) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
