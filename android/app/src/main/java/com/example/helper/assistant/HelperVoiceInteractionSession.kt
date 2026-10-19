package com.example.helper.assistant

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.service.voice.VoiceInteractionSession

/**
 * One invocation of the assistant. The panel itself is an ordinary activity, which keeps the interface in
 * Compose and lets it share the voice engine with the main screen.
 */
class HelperVoiceInteractionSession(context: Context) : VoiceInteractionSession(context) {

    override fun onShow(args: Bundle?, showFlags: Int) {
        super.onShow(args, showFlags)
        startAssistantActivity(
            Intent(context, AssistantActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        )
    }

    override fun onHandleScreenshot(screenshot: android.graphics.Bitmap?) {
        // The assistant never looks at the screen contents.
    }
}
