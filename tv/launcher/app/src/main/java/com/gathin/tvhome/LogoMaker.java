package com.gathin.tvhome;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.util.LruCache;

/**
 * The NOW dock: every app as a plain white logo, no tile. Made from the app's own banner (or icon): the banner's
 * background colour is read from its border, every pixel far enough from it becomes white with an alpha that grows
 * with the distance, and the result is cropped to the logo. "Sized by visual weight": logoScale() says how much of
 * the box a logo may fill, so a thin wordmark and a solid emblem look equally heavy.
 */
final class LogoMaker {

    static final class Logo {
        final Bitmap bitmap;
        final float scale;      // 0..1 of the box, by ink coverage
        Logo(Bitmap bitmap, float scale) { this.bitmap = bitmap; this.scale = scale; }
    }

    private static final LruCache<String, Logo> CACHE = new LruCache<>(24);
    private static final int WORK_W = 320;

    private LogoMaker() { }

    static Logo logo(String key, Drawable art) {
        if (art == null) return null;
        Logo cached = CACHE.get(key);
        if (cached != null) return cached;
        Logo made = make(art);
        if (made != null) CACHE.put(key, made);
        return made;
    }

    static void clear() { CACHE.evictAll(); }

    private static Logo make(Drawable art) {
        int iw = Math.max(1, art.getIntrinsicWidth()), ih = Math.max(1, art.getIntrinsicHeight());
        int w = WORK_W, h = Math.max(1, Math.round(WORK_W * ih / (float) iw));
        if (h > 400) { h = 400; w = Math.max(1, Math.round(400 * iw / (float) ih)); }
        Bitmap src = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(src);
        art.setBounds(0, 0, w, h);
        art.draw(c);
        int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        src.recycle();

        int bg = borderColor(px, w, h);
        boolean[] back = background(px, w, h);
        int[] out = new int[w * h];
        int minX = w, minY = h, maxX = -1, maxY = -1;
        long ink = 0;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                int i = y * w + x;
                if (back[i]) continue;
                int p = px[i];
                int a = Color.alpha(p);
                if (a < 40) continue;
                // Solid inside the logo; edges that are close to the background fade, which keeps antialiasing.
                int alpha = Math.max(0, Math.min(255, Math.round(80 + distance(p, bg) * 1.6f)));
                alpha = alpha * a / 255;
                if (alpha > 30) {
                    out[i] = Color.argb(alpha, 255, 255, 255);
                    ink += alpha;
                    if (x < minX) minX = x;
                    if (y < minY) minY = y;
                    if (x > maxX) maxX = x;
                    if (y > maxY) maxY = y;
                }
            }
        }
        if (maxX < 0) return null;
        // Specks: bits of the banner's art that survived the background fill (dots under the Disney+ logo). Drop
        // every blob much smaller than the largest one, then crop again to what is left.
        int[] box = despeck(out, w, h);
        if (box == null) return null;
        minX = box[0]; minY = box[1]; maxX = box[2]; maxY = box[3];
        ink = box[4];
        int cw = maxX - minX + 1, ch = maxY - minY + 1;
        Bitmap logo = Bitmap.createBitmap(cw, ch, Bitmap.Config.ARGB_8888);
        logo.setPixels(out, minY * w + minX, w, 0, 0, cw, ch);
        // Ink coverage of the cropped box: a solid emblem (~0.6) is drawn smaller than a thin wordmark (~0.2).
        float coverage = ink / (255f * cw * ch);
        float scale = Math.max(0.55f, Math.min(1f, 0.45f / (float) Math.sqrt(Math.max(0.05f, coverage))));
        return new Logo(logo, scale);
    }

    /**
     * Clears blobs (8-connected) smaller than 1.5% of the largest one and never smaller than 6 pixels' worth. A logo's
     * letters are all far larger than that; stray dots are not. Returns {minX, minY, maxX, maxY, ink} of what stays.
     */
    private static int[] despeck(int[] px, int w, int h) {
        int[] label = new int[w * h];
        int[] queue = new int[w * h];
        java.util.List<int[]> blobs = new java.util.ArrayList<>();     // {area, id}
        int id = 0, largest = 0;
        for (int start = 0; start < w * h; start++) {
            if (px[start] == 0 || label[start] != 0) continue;
            id++;
            int head = 0, tail = 0, area = 0;
            queue[tail++] = start;
            label[start] = id;
            while (head < tail) {
                int i = queue[head++];
                area++;
                int x = i % w, y = i / w;
                for (int dy = -1; dy <= 1; dy++) {
                    for (int dx = -1; dx <= 1; dx++) {
                        int nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int j = ny * w + nx;
                        if (px[j] != 0 && label[j] == 0) { label[j] = id; queue[tail++] = j; }
                    }
                }
            }
            blobs.add(new int[]{area, id});
            largest = Math.max(largest, area);
        }
        int keepFrom = Math.max(6, Math.round(largest * 0.015f));
        boolean[] keep = new boolean[id + 1];
        for (int[] b : blobs) keep[b[1]] = b[0] >= keepFrom;
        int minX = w, minY = h, maxX = -1, maxY = -1;
        long ink = 0;
        for (int i = 0; i < w * h; i++) {
            if (px[i] == 0) continue;
            if (!keep[label[i]]) { px[i] = 0; continue; }
            int x = i % w, y = i / w;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            ink += (px[i] >>> 24);
        }
        if (maxX < 0) return null;
        return new int[]{minX, minY, maxX, maxY, (int) Math.min(Integer.MAX_VALUE, ink)};
    }

    /**
     * The banner's background: everything reachable from the border through small colour steps, so a gradient or a
     * soft glow behind the logo counts as background while the logo's sharp edge stops the fill.
     */
    private static boolean[] background(int[] px, int w, int h) {
        boolean[] back = new boolean[w * h];
        int[] queue = new int[w * h];
        int head = 0, tail = 0;
        for (int x = 0; x < w; x++) { queue[tail++] = x; queue[tail++] = (h - 1) * w + x; }
        for (int y = 1; y < h - 1; y++) { queue[tail++] = y * w; queue[tail++] = y * w + w - 1; }
        for (int i = 0; i < tail; i++) back[queue[i]] = true;
        while (head < tail) {
            int i = queue[head++];
            int x = i % w, y = i / w;
            int p = px[i];
            for (int k = 0; k < 4; k++) {
                int nx = x + (k == 0 ? 1 : k == 1 ? -1 : 0), ny = y + (k == 2 ? 1 : k == 3 ? -1 : 0);
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                int j = ny * w + nx;
                if (back[j]) continue;
                int q = px[j];
                boolean bothClear = Color.alpha(p) < 40 && Color.alpha(q) < 40;
                if (bothClear || (Math.abs(Color.alpha(p) - Color.alpha(q)) < 40 && distance(p, q) < 14)) {
                    back[j] = true;
                    queue[tail++] = j;
                }
            }
        }
        return back;
    }

    /** The most common colour along the outer 3% of the image, roughly quantised. */
    private static int borderColor(int[] px, int w, int h) {
        java.util.HashMap<Integer, Integer> counts = new java.util.HashMap<>();
        int band = Math.max(1, Math.round(Math.min(w, h) * 0.03f));
        int best = 0, bestN = -1;
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (x >= band && x < w - band && y >= band && y < h - band) continue;
                int p = px[y * w + x];
                int q = Color.alpha(p) < 40 ? 0 : (0xFF000000 | ((Color.red(p) >> 4) << 20) | ((Color.green(p) >> 4) << 12) | ((Color.blue(p) >> 4) << 4));
                int n = counts.merge(q, 1, Integer::sum);
                if (n > bestN) { bestN = n; best = p; }
            }
        }
        return best;
    }

    private static float distance(int a, int b) {
        int dr = Color.red(a) - Color.red(b), dg = Color.green(a) - Color.green(b), db = Color.blue(a) - Color.blue(b);
        return (float) Math.sqrt(dr * dr + dg * dg + db * db);
    }
}
