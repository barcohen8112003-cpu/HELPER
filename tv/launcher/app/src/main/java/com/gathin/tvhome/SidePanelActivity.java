package com.gathin.tvhome;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Canvas;
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
 * The settings panel from the gear on Home, kept as close to Google TV's quick settings as it goes: a narrow panel
 * against the edge of the screen, an account row, low tiles in two columns with thin line icons and plain text, a
 * screensaver tile with its waves, and a darker card at the foot. Focus only turns a tile white; nothing grows.
 *
 * The app does not declare RTL support (Home's Hebrew layout is mirrored by hand in layout-iw), so rows here are
 * built right to left by hand: the item that reads first is added last.
 */
public class SidePanelActivity extends Activity {

    private static final int PANEL = 0xF2263148;
    private static final int TILE = 0x1FFFFFFF;
    private static final int TILE_FOCUSED = 0xFFE8EAED;
    private static final int CARD = 0x33000000;
    private static final int TEXT = 0xFFE8EAED;
    private static final int TEXT_DIM = 0x99E8EAED;
    private static final int INK = 0xFF202124;

    private float d;
    private Typeface regular, medium;
    private LinearLayout column;
    private Tile video;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;
        regular = getResources().getFont(R.font.outfit_regular);
        medium = getResources().getFont(R.font.outfit_medium);

        FrameLayout root = new FrameLayout(this);
        root.setOnClickListener(v -> finish());

        column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(px(12), px(12), px(12), px(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(PANEL);
        bg.setCornerRadius(px(24));
        column.setBackground(bg);
        column.setElevation(px(8));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(332), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.LEFT | Gravity.TOP);
        lp.leftMargin = px(16);
        lp.topMargin = px(16);
        root.addView(column, lp);
        setContentView(root);

        Tile account = new Tile(R.drawable.ic_qs_spark, "HELPER", Helper.configured(this) ? "מחובר" : "לא מחובר", true,
                () -> { HelperOverlayActivity.open(this, "type", null); finish(); });
        column.addView(account.view, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(60)));
        gap(8);

        Tile screensaver = new Tile(0, "שומר מסך", null, false, () -> settings("android.settings.DREAM_SETTINGS"));
        screensaver.waves();
        row(screensaver, new Tile(R.drawable.ic_qs_input, "אפליקציות", null, false, () -> open(new Intent(this, AppsWindowActivity.class))));
        row(new Tile(R.drawable.ic_qs_picture, "תמונה", null, false, () -> settings(Settings.ACTION_DISPLAY_SETTINGS)),
                new Tile(R.drawable.ic_qs_sound, "צליל", null, false, () -> settings(Settings.ACTION_SOUND_SETTINGS)));
        row(new Tile(R.drawable.ic_qs_wifi, "Wi-Fi", null, false, () -> settings(Settings.ACTION_WIFI_SETTINGS)),
                new Tile(R.drawable.ic_qs_access, "נגישות", null, false, () -> settings(Settings.ACTION_ACCESSIBILITY_SETTINGS)));
        row(new Tile(R.drawable.ic_qs_bt, "Bluetooth", null, false, () -> settings(Settings.ACTION_BLUETOOTH_SETTINGS)),
                new Tile(R.drawable.ic_qs_remote, "שלט", null, false, () -> open(new Intent(this, ButtonsActivity.class))));
        video = new Tile(R.drawable.ic_qs_wallpaper, "טפט", null, false, this::toggleVideo);
        Tile settings = new Tile(R.drawable.ic_qs_gear, "הגדרות", null, false, () -> settings(Settings.ACTION_SETTINGS));
        settings.view.setOnLongClickListener(v -> { open(new Intent(this, LauncherSettingsActivity.class)); return true; });
        row(video, settings);
        refreshVideo();

        gap(4);
        // The card at the foot, where Google TV offers AirPlay.
        Tile ask = new Tile(R.drawable.ic_qs_spark, "לשאול את HELPER", "כפתור העוזר בשלט, ואז לדבר", true,
                () -> { HelperOverlayActivity.open(this, "voice", null); finish(); });
        ask.base = CARD;
        ask.paint(false);
        column.addView(ask.view, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(60)));

        column.setAlpha(0f);
        column.setTranslationX(-px(24));
        column.animate().alpha(1f).translationX(0).setDuration(200).setInterpolator(new DecelerateInterpolator(1.5f)).start();
        account.view.requestFocus();
    }

    /** A tile: a line icon right beside its label, and a second, dimmer line on the account row and the card. */
    private final class Tile {
        final FrameLayout view;
        final GradientDrawable bg = new GradientDrawable();
        final TextView title, subtitle;
        final ImageView icon;
        final GradientDrawable circle;
        int base = TILE;
        WavesDrawable waves;

        Tile(int iconRes, String text, String sub, boolean twoLine, Runnable action) {
            view = new FrameLayout(SidePanelActivity.this);
            view.setFocusable(true);
            view.setClickable(true);
            bg.setCornerRadius(px(16));
            view.setBackground(bg);
            view.setClipToOutline(true);

            LinearLayout line = new LinearLayout(SidePanelActivity.this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            line.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
            line.setPadding(px(14), 0, px(14), 0);

            LinearLayout texts = new LinearLayout(SidePanelActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setGravity(Gravity.RIGHT);
            title = label(text, twoLine ? 15 : 14, TEXT, twoLine ? medium : regular);
            texts.addView(title);
            subtitle = sub == null ? null : label(sub, 12, TEXT_DIM, regular);
            if (subtitle != null) texts.addView(subtitle);
            line.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            icon = new ImageView(SidePanelActivity.this);
            icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
            circle = twoLine ? new GradientDrawable() : null;
            if (iconRes != 0) {
                icon.setImageResource(iconRes);
                int box = px(twoLine ? 36 : 20);
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(box, box);
                ip.leftMargin = px(twoLine ? 12 : 10);
                if (circle != null) {
                    circle.setShape(GradientDrawable.OVAL);
                    icon.setBackground(circle);
                    icon.setPadding(px(8), px(8), px(8), px(8));
                }
                line.addView(icon, ip);
            }
            view.addView(line, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            view.setOnFocusChangeListener((v, focused) -> paint(focused));
            view.setOnClickListener(v -> action.run());
            paint(false);
        }

        void waves() {
            waves = new WavesDrawable();
            View art = new View(SidePanelActivity.this);
            art.setBackground(waves);
            view.addView(art, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        }

        void paint(boolean focused) {
            bg.setColor(focused ? TILE_FOCUSED : base);
            title.setTextColor(focused ? INK : TEXT);
            if (subtitle != null) subtitle.setTextColor(focused ? 0x99202124 : TEXT_DIM);
            icon.setColorFilter(focused ? INK : TEXT);
            if (circle != null) circle.setColor(focused ? 0x14202124 : 0x1FFFFFFF);
            if (waves != null) waves.setFocused(focused);
        }
    }

    private TextView label(String s, int sp, int color, Typeface face) {
        TextView t = new TextView(this);
        t.setText("‏" + s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(face);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.RIGHT);
        t.setIncludeFontPadding(false);
        return t;
    }

    private void gap(int dp) {
        column.addView(new View(this), new LinearLayout.LayoutParams(1, px(dp)));
    }

    /** Two tiles side by side: {@code first} reads first, so it goes on the right. */
    private void row(Tile first, Tile second) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, px(52), 1f);
        LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, px(52), 1f);
        a.leftMargin = px(4);
        b.rightMargin = px(4);
        r.addView(second.view, b);
        r.addView(first.view, a);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(8);
        column.addView(r, lp);
        first.view.setId(View.generateViewId());
        second.view.setId(View.generateViewId());
        first.view.setNextFocusLeftId(second.view.getId());
        second.view.setNextFocusRightId(first.view.getId());
    }

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
        video.title.setText(VideoWallpaper.enabled(this) ? "‏טפט וידאו" : "‏טפט כבוי");
    }

    private int px(float dp) {
        return Math.round(dp * d);
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isFinishing()) finish();
    }

    /** Google TV's screensaver tile: pale waves across the lower half and a small moon in the far corner. */
    private final class WavesDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private boolean focused;

        void setFocused(boolean f) { focused = f; invalidateSelf(); }

        @Override
        public void draw(Canvas c) {
            Rect b = getBounds();
            int w = b.width(), h = b.height();
            int tint = focused ? 0x6F8AB4F8 : 0x4D8AB4F8;
            for (int i = 0; i < 2; i++) {
                float base = h * (0.70f + i * 0.13f);
                float amp = h * (0.08f - i * 0.02f);
                path.rewind();
                path.moveTo(0, h);
                path.lineTo(0, base);
                for (int s = 0; s <= 20; s++) {
                    float u = s / 20f;
                    path.lineTo(w * u, base + amp * (float) Math.sin(u * Math.PI * 2 * (1.1f + i * 0.4f) + i * 1.7f));
                }
                path.lineTo(w, h);
                path.close();
                paint.setColor(tint);
                c.drawPath(path, paint);
            }
            paint.setColor(focused ? 0x99202124 : 0xCCE8EAED);
            c.drawCircle(px(16), px(15), px(4.5f), paint);
        }

        @Override public void setAlpha(int alpha) { }
        @Override public void setColorFilter(ColorFilter cf) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
