package com.gathin.tvhome;

import android.annotation.SuppressLint;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Handler;
import android.os.Looper;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Records one spoken request from the remote's microphone as a 16 kHz mono WAV for HELPER to transcribe (the TV's
 * own recognizer has no Hebrew). Stops by itself after a second of quiet once speech started, after 5 seconds of
 * nothing at all, or at 12 seconds. The level (0..1) drives the waves.
 */
final class VoiceCapture {

    interface Callback {
        void level(float level);
        void done(byte[] wav);      // null when nothing was said
        void failed(String why);
    }

    private static final int RATE = 16000;
    private static final int MAX_MS = 12000;
    private static final int NOTHING_MS = 5000;
    private static final int QUIET_AFTER_SPEECH_MS = 1100;
    private static final double SPEECH_RMS = 900;   // 16-bit samples

    private final Handler main = new Handler(Looper.getMainLooper());
    private volatile boolean running;

    boolean running() { return running; }

    void stop() { running = false; }

    @SuppressLint("MissingPermission")   // RECORD_AUDIO is granted with pm grant at install, and checked by the caller
    void start(Callback cb) {
        if (running) return;
        running = true;
        new Thread(() -> {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            AudioRecord rec;
            try {
                rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT, Math.max(min, RATE));
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) throw new IllegalStateException("mic busy");
                rec.startRecording();
            } catch (Exception e) {
                running = false;
                main.post(() -> cb.failed("המיקרופון לא זמין"));
                return;
            }
            ByteArrayOutputStream pcm = new ByteArrayOutputStream();
            short[] buf = new short[RATE / 20];   // 50 ms
            long started = System.currentTimeMillis();
            long lastSpeech = 0;
            boolean spoke = false;
            double peak = 0;
            while (running) {
                int n = rec.read(buf, 0, buf.length);
                if (n <= 0) continue;
                double sum = 0;
                ByteBuffer bytes = ByteBuffer.allocate(n * 2).order(ByteOrder.LITTLE_ENDIAN);
                for (int i = 0; i < n; i++) {
                    sum += (double) buf[i] * buf[i];
                    bytes.putShort(buf[i]);
                }
                pcm.write(bytes.array(), 0, n * 2);
                double rms = Math.sqrt(sum / n);
                peak = Math.max(peak, rms);
                long now = System.currentTimeMillis();
                if (rms > SPEECH_RMS) { spoke = true; lastSpeech = now; }
                float level = (float) Math.min(1, rms / 6000);
                main.post(() -> cb.level(level));
                if (now - started > MAX_MS) break;
                if (!spoke && now - started > NOTHING_MS) break;
                if (spoke && now - lastSpeech > QUIET_AFTER_SPEECH_MS) break;
            }
            try { rec.stop(); } catch (Exception ignored) { }
            rec.release();
            android.util.Log.i("HelperMic", "recorded " + pcm.size() + " bytes, peak rms " + Math.round(peak) + ", speech " + spoke);
            boolean cancelled = !running;
            running = false;
            if (cancelled) return;
            byte[] wav = spoke ? wav(pcm.toByteArray()) : null;
            main.post(() -> cb.done(wav));
        }, "helper-mic").start();
    }

    private static byte[] wav(byte[] pcm) {
        ByteBuffer h = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes()).putInt(36 + pcm.length).put("WAVE".getBytes());
        h.put("fmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(RATE).putInt(RATE * 2).putShort((short) 2).putShort((short) 16);
        h.put("data".getBytes()).putInt(pcm.length);
        byte[] out = new byte[44 + pcm.length];
        System.arraycopy(h.array(), 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, pcm.length);
        return out;
    }
}
