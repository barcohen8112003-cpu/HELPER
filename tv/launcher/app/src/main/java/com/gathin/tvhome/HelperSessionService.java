package com.gathin.tvhome;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.service.voice.VoiceInteractionSession;
import android.service.voice.VoiceInteractionSessionService;

/** One press of the Assistant button: open the HELPER overlay listening, then step aside. */
public class HelperSessionService extends VoiceInteractionSessionService {
    @Override
    public VoiceInteractionSession onNewSession(Bundle args) {
        return new Session(this);
    }

    static final class Session extends VoiceInteractionSession {
        Session(Context context) { super(context); }

        @Override
        public void onShow(Bundle args, int showFlags) {
            super.onShow(args, showFlags);
            HelperOverlayActivity open = HelperOverlayActivity.current;
            if (open != null && !open.isFinishing()) {
                // The overlay is up: this press means "I'm done talking" (or listen again).
                open.runOnUiThread(open::assistantPressed);
            } else {
                Intent i = new Intent(getContext(), HelperOverlayActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                        .putExtra(HelperOverlayActivity.EXTRA_MODE, "voice");
                try {
                    getContext().startActivity(i);
                } catch (RuntimeException e) {
                    startAssistantActivity(i);
                }
            }
            // Close the session at once: otherwise Android takes the next press as "close the assistant", and the
            // overlay would never hear it.
            finish();
        }

        @Override
        public void onHandleScreenshot(android.graphics.Bitmap screenshot) {
            // HELPER never looks at the screen contents.
        }
    }
}
