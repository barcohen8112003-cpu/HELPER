package com.gathin.tvhome;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.EditText;
import android.widget.TextView;

import java.io.File;
import java.io.FileOutputStream;

/**
 * HELPER over whatever is on screen: the remote's Assistant button (InputKeyService) opens it listening, the HELPER
 * pill on Home opens it for typing, and the server can show a line in it (tv_show). OK listens again, Back closes.
 */
public class HelperOverlayActivity extends Activity {

    static final String EXTRA_MODE = "mode";      // "voice" (default), "type", "show"
    static final String EXTRA_TEXT = "text";
    private static final long CLOSE_AFTER_MS = 9000;

    private WaveView waves;
    private TextView status, heard, reply;
    private EditText input;
    private final VoiceCapture mic = new VoiceCapture();
    private MediaPlayer player;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable autoClose = this::finish;
    private boolean busy;

    static void open(android.content.Context c, String mode, String text) {
        Intent i = new Intent(c, HelperOverlayActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .putExtra(EXTRA_MODE, mode);
        if (text != null) i.putExtra(EXTRA_TEXT, text);
        c.startActivity(i);
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.overlay_helper);
        waves = findViewById(R.id.helperWaves);
        status = findViewById(R.id.helperStatus);
        heard = findViewById(R.id.helperHeard);
        reply = findViewById(R.id.helperReply);
        input = findViewById(R.id.helperInput);
        input.setOnEditorActionListener((v, actionId, event) -> {
            boolean send = actionId == EditorInfo.IME_ACTION_SEND || actionId == EditorInfo.IME_ACTION_DONE
                    || (event != null && event.getKeyCode() == KeyEvent.KEYCODE_ENTER && event.getAction() == KeyEvent.ACTION_DOWN);
            if (!send) return false;
            String text = input.getText().toString().trim();
            if (!text.isEmpty()) {
                input.setText("");
                hideKeyboard();
                askHelper(text, false);
            }
            return true;
        });
        View panel = findViewById(R.id.helperPanel);
        panel.setTranslationY(-60 * getResources().getDisplayMetrics().density);
        panel.setAlpha(0f);
        panel.animate().translationY(0).alpha(1f).setDuration(260).start();
        handle(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        main.removeCallbacks(autoClose);
        String mode = intent.getStringExtra(EXTRA_MODE);
        if ("show".equals(mode)) {
            stopListening();
            showReply(intent.getStringExtra(EXTRA_TEXT));
            heard.setText("");
            status.setText("HELPER");
            waves.setMode(WaveView.SPEAKING);
            main.postDelayed(() -> waves.setMode(WaveView.IDLE), 2500);
            main.postDelayed(autoClose, CLOSE_AFTER_MS);
        } else if ("type".equals(mode)) {
            startTyping(null);
        } else {
            startListening();
        }
    }

    // ---- voice ----

    private void startListening() {
        if (busy || mic.running()) return;
        stopSpeaking();
        main.removeCallbacks(autoClose);
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            startTyping("אין הרשאה למיקרופון. אפשר להקליד.");
            return;
        }
        input.setVisibility(View.GONE);
        reply.setVisibility(View.GONE);
        heard.setText("");
        status.setText("מקשיב…");
        waves.setMode(WaveView.LISTENING);
        // Google's own online recognizer (the one Google Assistant uses on this TV) knows Hebrew: the words go to
        // HELPER as text, which every HELPER version takes. The recording below is the fallback.
        if (!triedGoogle && startGoogleRecognizer()) return;
        triedGoogle = false;
        recordForHelper();
    }

    private static final android.content.ComponentName KATNISS = new android.content.ComponentName(
            "com.google.android.katniss", "com.google.android.apps.tvsearch.voice.recognition.KatnissRecognitionService");
    private android.speech.SpeechRecognizer recognizer;
    private boolean triedGoogle;

    private boolean startGoogleRecognizer() {
        try {
            getPackageManager().getServiceInfo(KATNISS, 0);
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
        triedGoogle = true;
        try {
            if (recognizer == null) {
                recognizer = android.speech.SpeechRecognizer.createSpeechRecognizer(this, KATNISS);
                recognizer.setRecognitionListener(new android.speech.RecognitionListener() {
                    @Override public void onReadyForSpeech(Bundle b) { status.setText("מקשיב…"); }
                    @Override public void onBeginningOfSpeech() { }
                    @Override public void onRmsChanged(float db) { waves.setRms(db); }
                    @Override public void onBufferReceived(byte[] buf) { }
                    @Override public void onEndOfSpeech() { waves.setMode(WaveView.THINKING); status.setText("חושב…"); }
                    @Override public void onEvent(int type, Bundle b) { }

                    @Override
                    public void onError(int error) {
                        if (isFinishing() || busy) return;
                        if (error == android.speech.SpeechRecognizer.ERROR_NO_MATCH
                                || error == android.speech.SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                            triedGoogle = false;
                            waves.setMode(WaveView.IDLE);
                            status.setText("לא שמעתי. לחץ OK כדי לנסות שוב");
                            main.postDelayed(autoClose, CLOSE_AFTER_MS);
                            return;
                        }
                        // Google's recognizer is not usable here: record and let HELPER transcribe instead.
                        android.util.Log.i("HelperMic", "Google recognizer error " + error + ", recording instead");
                        recordForHelper();
                    }

                    @Override
                    public void onPartialResults(Bundle b) {
                        String t = firstResult(b);
                        if (t != null) heard.setText(t);
                    }

                    @Override
                    public void onResults(Bundle b) {
                        triedGoogle = false;
                        String t = firstResult(b);
                        if (t == null || t.trim().isEmpty()) { onError(android.speech.SpeechRecognizer.ERROR_NO_MATCH); return; }
                        heard.setText(t);
                        askHelper(t, true);
                    }
                });
            }
            Intent i = new Intent(android.speech.RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                    .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_MODEL, android.speech.RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                    .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE, "iw-IL")
                    .putExtra(android.speech.RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "iw-IL")
                    .putExtra(android.speech.RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                    .putExtra(android.speech.RecognizerIntent.EXTRA_CALLING_PACKAGE, getPackageName());
            recognizer.startListening(i);
            return true;
        } catch (RuntimeException e) {
            triedGoogle = false;
            return false;
        }
    }

    private static String firstResult(Bundle b) {
        java.util.ArrayList<String> list = b == null ? null : b.getStringArrayList(android.speech.SpeechRecognizer.RESULTS_RECOGNITION);
        return list == null || list.isEmpty() ? null : list.get(0);
    }

    /** The fallback: record here, and HELPER transcribes it (needs the HELPER version with /bridge/ask "speech"). */
    private void recordForHelper() {
        status.setText("מקשיב…");
        waves.setMode(WaveView.LISTENING);
        mic.start(new VoiceCapture.Callback() {
            @Override public void level(float level) { waves.setRms(level * 12f - 2f); }

            @Override
            public void done(byte[] wav) {
                if (isFinishing()) return;
                if (wav == null) {
                    waves.setMode(WaveView.IDLE);
                    status.setText("לא שמעתי. לחץ OK כדי לנסות שוב");
                    main.postDelayed(autoClose, CLOSE_AFTER_MS);
                    return;
                }
                askSpeech(wav);
            }

            @Override
            public void failed(String why) {
                if (!isFinishing()) startTyping(why + ". אפשר להקליד.");
            }
        });
    }

    private void stopListening() {
        mic.stop();
        if (recognizer != null) {
            try { recognizer.cancel(); } catch (RuntimeException ignored) { }
        }
        triedGoogle = false;
    }

    private void askSpeech(byte[] wav) {
        busy = true;
        status.setText("חושב…");
        waves.setMode(WaveView.THINKING);
        new Thread(() -> {
            try {
                Helper.Reply r = Helper.askSpeech(this, wav);
                main.post(() -> {
                    busy = false;
                    if (isFinishing()) return;
                    if (r.heard != null) heard.setText(r.heard);
                    showReply(r.text);
                    if (r.audioBase64 != null) speak(r.audioBase64);
                    else { waves.setMode(WaveView.IDLE); main.postDelayed(autoClose, CLOSE_AFTER_MS * 2); }
                });
            } catch (Exception e) {
                main.post(() -> {
                    busy = false;
                    if (isFinishing()) return;
                    waves.setMode(WaveView.IDLE);
                    showReply(e.getMessage());
                    main.postDelayed(autoClose, CLOSE_AFTER_MS);
                });
            }
        }, "helper-ask").start();
    }

    // ---- typing ----

    private void startTyping(String note) {
        stopListening();
        waves.setMode(WaveView.IDLE);
        status.setText(note != null ? note : "HELPER");
        input.setVisibility(View.VISIBLE);
        input.requestFocus();
        main.postDelayed(() -> {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT);
        }, 200);
    }

    private void hideKeyboard() {
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.hideSoftInputFromWindow(input.getWindowToken(), 0);
    }

    // ---- HELPER ----

    private void askHelper(String text, boolean voice) {
        busy = true;
        heard.setText(text);
        reply.setVisibility(View.GONE);
        status.setText("חושב…");
        waves.setMode(WaveView.THINKING);
        new Thread(() -> {
            try {
                Helper.Reply r = Helper.ask(this, text, voice);
                main.post(() -> {
                    busy = false;
                    if (isFinishing()) return;
                    showReply(r.text);
                    if (voice && r.audioBase64 != null) speak(r.audioBase64);
                    else { waves.setMode(WaveView.IDLE); main.postDelayed(autoClose, CLOSE_AFTER_MS * 2); }
                });
            } catch (Exception e) {
                main.post(() -> {
                    busy = false;
                    if (isFinishing()) return;
                    waves.setMode(WaveView.IDLE);
                    status.setText("HELPER");
                    showReply(e.getMessage());
                    main.postDelayed(autoClose, CLOSE_AFTER_MS);
                });
            }
        }, "helper-ask").start();
    }

    private void showReply(String text) {
        status.setText("HELPER");
        reply.setText(text == null ? "" : text);
        reply.setVisibility(View.VISIBLE);
        reply.setAlpha(0f);
        reply.animate().alpha(1f).setDuration(220).start();
    }

    private void speak(String base64) {
        try {
            File f = new File(getCacheDir(), "helper-reply.mp3");
            try (FileOutputStream out = new FileOutputStream(f)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            stopSpeaking();
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
            player.setDataSource(f.getAbsolutePath());
            player.setOnCompletionListener(mp -> {
                waves.setMode(WaveView.IDLE);
                main.postDelayed(autoClose, CLOSE_AFTER_MS);
            });
            player.prepare();
            waves.setMode(WaveView.SPEAKING);
            player.start();
        } catch (Exception e) {
            waves.setMode(WaveView.IDLE);
            main.postDelayed(autoClose, CLOSE_AFTER_MS);
        }
    }

    private void stopSpeaking() {
        if (player != null) {
            try { player.stop(); } catch (RuntimeException ignored) { }
            player.release();
            player = null;
        }
    }

    // ---- keys ----

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        main.removeCallbacks(autoClose);
        boolean typing = input.getVisibility() == View.VISIBLE && input.hasFocus();
        if (!typing && (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER)) {
            startListening();
            return true;
        }
        if (!typing && keyCode == KeyEvent.KEYCODE_DPAD_DOWN) {
            startTyping(null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopListening();
        stopSpeaking();
        if (!isChangingConfigurations()) finish();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        mic.stop();
        if (recognizer != null) recognizer.destroy();
        stopSpeaking();
        super.onDestroy();
    }
}
