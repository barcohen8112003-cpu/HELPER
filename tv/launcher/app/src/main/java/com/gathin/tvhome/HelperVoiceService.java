package com.gathin.tvhome;

import android.service.voice.VoiceInteractionService;

/**
 * What makes the home screen the TV's assistant app: with it as the ASSISTANT role holder, the remote's Assistant
 * button reaches HELPER through the system itself (Google TV handles that button before any accessibility service).
 */
public class HelperVoiceService extends VoiceInteractionService {
}
