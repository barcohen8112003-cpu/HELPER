package com.gathin.tvhome;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;

/**
 * The HELPER waves: four soft sine bands in blue, red, yellow and green that drift across the bottom of the overlay
 * and swell with the voice (setLevel from the recognizer's RMS). Idle they breathe slowly; thinking they ripple
 * faster at a steady height. Plain gradient fills, no blur: a Chromecast HD has a small GPU.
 */
public class WaveView extends View {

    static final int IDLE = 0, LISTENING = 1, THINKING = 2, SPEAKING = 3;

    private static final int[] COLORS = {0xFF4285F4, 0xFFEA4335, 0xFFFBBC05, 0xFF34A853};
    private static final float[] SPEED = {0.9f, -1.25f, 1.6f, -0.7f};
    private static final float[] FREQ = {1.3f, 1.9f, 1.1f, 2.4f};

    private final Paint[] paints = new Paint[COLORS.length];
    private final Path path = new Path();
    private float level;        // 0..1, eased
    private float target;       // 0..1 from setLevel
    private int mode = IDLE;
    private long start = System.nanoTime();

    public WaveView(Context context) { this(context, null); }

    public WaveView(Context context, AttributeSet attrs) {
        super(context, attrs);
        for (int i = 0; i < paints.length; i++) {
            paints[i] = new Paint(Paint.ANTI_ALIAS_FLAG);
            paints[i].setStyle(Paint.Style.FILL);
        }
    }

    void setMode(int mode) {
        this.mode = mode;
        if (mode == IDLE) target = 0;
        if (mode == THINKING) target = 0.35f;
        if (mode == SPEAKING) target = 0.55f;
        postInvalidateOnAnimation();
    }

    /** Recognizer RMS in dB (about -2..10) or a plain 0..1 level. */
    void setRms(float rmsDb) {
        target = Math.max(0.08f, Math.min(1f, (rmsDb + 2f) / 12f));
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        for (int i = 0; i < paints.length; i++) {
            int c = COLORS[i];
            int clear = c & 0x00FFFFFF;
            paints[i].setShader(new LinearGradient(0, 0, 0, h,
                    new int[]{clear, (c & 0x00FFFFFF) | 0x8C000000, (c & 0x00FFFFFF) | 0x26000000},
                    new float[]{0f, 0.55f, 1f}, Shader.TileMode.CLAMP));
        }
    }

    @Override
    protected void onDraw(Canvas canvas) {
        int w = getWidth(), h = getHeight();
        if (w == 0 || h == 0) return;
        float t = (System.nanoTime() - start) / 1e9f;
        if (mode == SPEAKING) target = 0.35f + 0.3f * (float) Math.abs(Math.sin(t * 3.1f));
        level += (target - level) * 0.12f;
        float base = mode == IDLE ? 0.12f + 0.05f * (float) Math.sin(t * 1.2f) : 0.18f;
        float speedUp = mode == THINKING ? 2.2f : 1f;

        for (int i = 0; i < COLORS.length; i++) {
            float amp = h * (base + level * (0.55f + 0.1f * i));
            float phase = t * SPEED[i] * speedUp * 2.2f + i * 1.7f;
            path.rewind();
            path.moveTo(0, h);
            int steps = 48;
            for (int s = 0; s <= steps; s++) {
                float x = w * s / (float) steps;
                float u = s / (float) steps;
                // Taper at both ends so the bands rise from the middle, like a voice.
                float envelope = (float) Math.sin(Math.PI * u);
                float y = h - amp * envelope * (0.6f + 0.4f * (float) Math.sin(FREQ[i] * Math.PI * 2 * u + phase));
                path.lineTo(x, y);
            }
            path.lineTo(w, h);
            path.close();
            canvas.drawPath(path, paints[i]);
        }
        postInvalidateOnAnimation();
    }
}
