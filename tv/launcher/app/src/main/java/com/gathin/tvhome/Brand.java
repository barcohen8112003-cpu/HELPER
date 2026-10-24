package com.gathin.tvhome;

import android.graphics.Bitmap;
import android.graphics.BlurMaskFilter;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;

import java.util.HashMap;
import java.util.Map;

/**
 * Each app's own colour, for the glass dock (the focused tile glows in it and the screen takes it on) and the
 * Continue watching cards. Apps not listed here get a colour sampled from their banner instead.
 */
final class Brand {

    private Brand() { }

    private static final Map<String, Integer> COLORS = new HashMap<>();
    static {
        COLORS.put("com.netflix.ninja", 0xFFE50914);
        COLORS.put("com.google.android.youtube.tv", 0xFFFF1E1E);
        COLORS.put("com.google.android.youtube.tvkids", 0xFFFF1E1E);
        COLORS.put("com.google.android.youtube.tvmusic", 0xFFFF1E1E);
        COLORS.put("com.disneyplus.mea", 0xFF1FC6F2);
        COLORS.put("com.disney.disneyplus", 0xFF1FC6F2);
        COLORS.put("com.stremio.one", 0xFF8B5CF6);
        COLORS.put("com.spotify.tv.android", 0xFF1DB954);
        COLORS.put("com.amazon.amazonvideo.livingroom", 0xFF00A8E1);
        COLORS.put("com.apple.atve.androidtv.appletv", 0xFFE8E8ED);
        COLORS.put("com.plexapp.android", 0xFFE5A00D);
        COLORS.put("org.xbmc.kodi", 0xFF17B2E7);
        COLORS.put("tv.twitch.android.app", 0xFF9146FF);
        COLORS.put("com.wbd.stream", 0xFF2F5BFF);
        COLORS.put("com.hbo.hbonow", 0xFF7B2FF7);
        COLORS.put("com.android.vending", 0xFF34A853);
        COLORS.put("com.android.chrome", 0xFF4285F4);
        COLORS.put("com.google.android.apps.tv.launcherx", 0xFF4285F4);
        COLORS.put("com.android.tv.settings", 0xFF9AA0A6);
        COLORS.put("com.google.android.play.games", 0xFF01875F);
        COLORS.put("com.tubitv", 0xFFFA382F);
        COLORS.put("com.pluto.tv", 0xFFFFF200);
    }

    /** The app's colour, or 0 when it has none of its own here. */
    static int color(String pkg) {
        Integer c = pkg == null ? null : COLORS.get(pkg);
        return c == null ? 0 : c;
    }

    /** Old apps that a newer one replaces: the old Disney+ asks to install the new one. */
    private static final String[][] REPLACED = {{"com.disney.disneyplus", "com.disneyplus.mea"}};

    /** True for an old app whose replacement is installed: it stays off Home and the app lists. */
    static boolean replaced(android.content.Context c, String pkg) {
        for (String[] r : REPLACED) {
            if (!r[0].equals(pkg)) continue;
            try {
                c.getPackageManager().getPackageInfo(r[1], 0);
                return true;
            } catch (Exception e) {
                return false;
            }
        }
        return false;
    }

    /** The colour mixed toward white by t (0..1). */
    static int lighter(int color, float t) {
        int r = Color.red(color), g = Color.green(color), b = Color.blue(color);
        return Color.rgb(Math.round(r + (255 - r) * t), Math.round(g + (255 - g) * t), Math.round(b + (255 - b) * t));
    }

    /** The colour mixed toward black by t (0..1). */
    static int darker(int color, float t) {
        return Color.rgb(Math.round(Color.red(color) * (1 - t)), Math.round(Color.green(color) * (1 - t)),
                Math.round(Color.blue(color) * (1 - t)));
    }

    /** A glass tile: frosted white that fades downwards and a thin light edge; focused, filled with the app's colour. */
    static GradientDrawable glass(float radius, float density, int color, boolean focused) {
        GradientDrawable d;
        if (focused) {
            d = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                    new int[]{(0x8C << 24) | (lighter(color, 0.15f) & 0xFFFFFF), (0x59 << 24) | (darker(color, 0.25f) & 0xFFFFFF)});
            d.setStroke(Math.round(2 * density), lighter(color, 0.55f));
        } else {
            d = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, new int[]{0x33FFFFFF, 0x14FFFFFF});
            d.setStroke(Math.max(1, Math.round(density)), 0x38FFFFFF);
        }
        d.setCornerRadius(radius);
        return d;
    }

    private static Bitmap glowCache;
    private static int glowW, glowH;

    /** A soft white halo around a w x h rounded tile, spread px outside it; tint it with the app's colour. */
    static Bitmap glow(int w, int h, int spread, float radius) {
        int bw = w + 2 * spread, bh = h + 2 * spread;
        if (glowCache != null && glowW == bw && glowH == bh) return glowCache;
        Bitmap bmp = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(Color.WHITE);
        p.setMaskFilter(new BlurMaskFilter(spread * 0.7f, BlurMaskFilter.Blur.NORMAL));
        float in = spread * 0.55f;
        c.drawRoundRect(new RectF(in, in, bw - in, bh - in), radius + spread * 0.3f, radius + spread * 0.3f, p);
        glowCache = bmp;
        glowW = bw;
        glowH = bh;
        return bmp;
    }
}
