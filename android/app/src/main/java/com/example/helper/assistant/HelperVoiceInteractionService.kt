package com.example.helper.assistant

import android.os.Bundle
import android.service.voice.VoiceInteractionService
import android.service.voice.VoiceInteractionSession

/**
 * What makes the app appear under Settings > Apps > Default apps > Digital assistant app.
 * Once chosen, the system starts this service and calls [showSession] on the assistant gesture
 * (a long press on the power button, or the corner swipe, depending on the phone).
 */
class HelperVoiceInteractionService : VoiceInteractionService() {

    override fun onReady() {
        super.onReady()
        instance = this
    }

    override fun onShutdown() {
        if (instance === this) instance = null
        super.onShutdown()
    }

    companion object {
        @Volatile
        var instance: HelperVoiceInteractionService? = null
            private set

        /**
         * Opens the assistant panel from a background service (the wake phrase). Only the app that is the
         * current default assistant may do this. Returns false when the app is not the default assistant.
         */
        fun show(): Boolean {
            val service = instance ?: return false
            service.showSession(Bundle(), VoiceInteractionSession.SHOW_WITH_ASSIST)
            return true
        }
    }
}
