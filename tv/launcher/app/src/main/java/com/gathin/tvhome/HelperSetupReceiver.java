package com.gathin.tvhome;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * The HELPER server address and bridge token, pushed once from the computer so nobody types a token with a remote:
 *   adb shell am broadcast -a com.gathin.tvhome.HELPER_SETUP -n com.gathin.tvhome/.HelperSetupReceiver \
 *       --es url http://192.168.0.199:3210 --es token <bridge token>
 * The manifest guards it with WRITE_SECURE_SETTINGS, which adb's shell holds and ordinary apps cannot get.
 */
public class HelperSetupReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // From the computer: read Google TV's rows again now (--ez gtv_refresh true).
        if (intent.getBooleanExtra("gtv_refresh", false)) {
            context.getSharedPreferences("gtv_rows", Context.MODE_PRIVATE).edit().remove("time").remove("tried").apply();
            setResultData("Google TV rows will be read when Home is next shown");
            return;
        }
        Helper.save(context, intent.getStringExtra("url"), intent.getStringExtra("token"));
        InputKeyService service = InputKeyService.instance;
        if (service != null) service.reconnectHelper();
        setResultData(Helper.configured(context) ? "HELPER configured: " + Helper.url(context) : "HELPER not configured");
    }
}
