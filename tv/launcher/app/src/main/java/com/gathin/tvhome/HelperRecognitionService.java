package com.gathin.tvhome;

import android.content.Intent;
import android.speech.RecognitionService;
import android.speech.SpeechRecognizer;

/**
 * Android requires an assistant app to name a recognizer of its own. HELPER listens through Google's speech service
 * instead (HelperOverlayActivity binds it by name), so this one only says it cannot help.
 */
public class HelperRecognitionService extends RecognitionService {
    @Override
    protected void onStartListening(Intent recognizerIntent, Callback listener) {
        try { listener.error(SpeechRecognizer.ERROR_CLIENT); } catch (Exception ignored) { }
    }
    @Override protected void onCancel(Callback listener) { }
    @Override protected void onStopListening(Callback listener) { }
}
