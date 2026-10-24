package com.gathin.tvhome;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.graphics.drawable.GradientDrawable;
import android.media.MediaPlayer;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.widget.FrameLayout;

import java.io.File;

/**
 * A looping, muted video behind Home: wallpaper.mp4 in the theme folder (next to config.json). It plays only while
 * Home is on screen, so an app in front never shares the decoder with it. Centre-cropped to the screen, with the NOW
 * design's bottom gradient over it (0 -> 35% -> 70% -> 85% black from 45% of the height) so the dock reads.
 * The side panel has a switch for it. Keep the video at 1080p30 H.264 for a Chromecast HD (tv/README).
 *
 * A SurfaceView was tried instead of this TextureView: it showed nothing behind Home's opaque window and did not
 * make Home any smoother (31 ms against 30 ms per frame), so the TextureView stays.
 */
final class VideoWallpaper implements TextureView.SurfaceTextureListener {

    static final String FILE = "wallpaper.mp4";

    private final TextureView texture;
    private final View shade;
    private final File file;
    private MediaPlayer player;
    private Surface surface;
    private boolean wanted;
    /** start() and pause() are only legal once prepared; before that, onPrepared reads wanted. */
    private boolean prepared;
    private int videoW, videoH;

    /** Whether the side panel has the video on (default on). */
    static boolean enabled(Context c) {
        return Helper.prefs(c).getBoolean("video_wallpaper", true);
    }

    static void setEnabled(Context c, boolean on) {
        Helper.prefs(c).edit().putBoolean("video_wallpaper", on).apply();
    }

    private static File fileOf(Context c) {
        File dir = Config.dir(c);
        File f = dir == null ? null : new File(dir, FILE);
        return f != null && f.isFile() && f.length() > 0 ? f : null;
    }

    /** Whether Home should be showing a video right now: a file, and the switch on. */
    static boolean desired(Context c) {
        return enabled(c) && fileOf(c) != null;
    }

    /** Null when the theme has no video, or the switch is off. */
    static VideoWallpaper attach(Context c, FrameLayout root) {
        File f = desired(c) ? fileOf(c) : null;
        return f == null ? null : new VideoWallpaper(c, root, f);
    }

    private VideoWallpaper(Context c, FrameLayout root, File file) {
        this.file = file;
        texture = new TextureView(c);
        texture.setSurfaceTextureListener(this);
        texture.setAlpha(0f);
        root.addView(texture, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        shade = new View(c);
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0x26000000, 0x1A000000, 0x00000000, 0x59000000, 0xB3000000, 0xD9000000});
        shade.setBackground(g);
        root.addView(shade, 1, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        texture.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> fit());
    }

    void start() {
        wanted = true;
        if (player != null) {
            if (prepared) try { player.start(); } catch (IllegalStateException ignored) { }
        } else if (surface != null) {
            open();
        }
    }

    void stop() {
        wanted = false;
        if (player != null && prepared) {
            try { player.pause(); } catch (IllegalStateException ignored) { }
        }
    }

    void close() {
        wanted = false;
        release();
        if (surface != null) surface.release();
        surface = null;
    }

    private void open() {
        release();
        try {
            MediaPlayer mp = new MediaPlayer();
            mp.setDataSource(file.getAbsolutePath());
            mp.setSurface(surface);
            mp.setLooping(true);
            mp.setVolume(0f, 0f);
            mp.setOnVideoSizeChangedListener((p, w, h) -> { videoW = w; videoH = h; fit(); });
            mp.setOnPreparedListener(p -> {
                prepared = true;
                if (wanted) p.start();
                texture.animate().alpha(1f).setDuration(400).start();
            });
            mp.setOnErrorListener((p, what, extra) -> { release(); return true; });
            mp.prepareAsync();
            player = mp;
        } catch (Exception e) {
            release();
        }
    }

    private void release() {
        prepared = false;
        if (player != null) {
            try { player.release(); } catch (Exception ignored) { }
            player = null;
        }
    }

    /** Centre-crop: scale the video to cover the view, keeping its shape. */
    private void fit() {
        int vw = texture.getWidth(), vh = texture.getHeight();
        if (vw == 0 || vh == 0 || videoW == 0 || videoH == 0) return;
        float scale = Math.max(vw / (float) videoW, vh / (float) videoH);
        Matrix m = new Matrix();
        m.setScale(videoW * scale / vw, videoH * scale / vh, vw / 2f, vh / 2f);
        texture.setTransform(m);
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
        surface = new Surface(st);
        if (wanted) open();
    }

    @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { fit(); }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
        release();
        if (surface != null) surface.release();
        surface = null;
        return true;
    }

    @Override public void onSurfaceTextureUpdated(SurfaceTexture st) { }
}
