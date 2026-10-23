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
            startAssistantActivity(new Intent(getContext(), HelperOverlayActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(HelperOverlayActivity.EXTRA_MODE, "voice"));
        }

        @Override
        public void onHandleScreenshot(android.graphics.Bitmap screenshot) {
            // HELPER never looks at the screen contents.
        }
    }
}
