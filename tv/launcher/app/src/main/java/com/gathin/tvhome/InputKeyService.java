package com.gathin.tvhome;

import android.accessibilityservice.AccessibilityService;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.view.KeyEvent;
import android.view.accessibility.AccessibilityEvent;
import java.util.Collections;
import java.util.Map;

/**
 * The remote, from any app, plus HELPER's line to the TV.
 * - The Assistant button opens the HELPER overlay instead of Google Assistant.
 * - Each named button (Helper.BUTTONS) can open an app chosen on the TV (ButtonsActivity) or from HELPER.
 * - The Input button opens the system input switcher, as in CleanYourTV; app_keys from config.xml still work.
 * - HelperLink keeps the WebSocket to the HELPER server while the service runs, which Android does at all times.
 * Every other key passes through untouched.
 */
public class InputKeyService extends AccessibilityService {

    private static final String TAG = "HelperKeys";
    private static final String ACTION_VIEW_INPUTS = "com.android.tv.action.VIEW_INPUTS";

    /** The running service, for HelperSetupReceiver and ButtonsActivity. */
    static volatile InputKeyService instance;
    /** The app in front, from window changes: tv_status reads it. */
    static volatile String currentPackage = "";

    /** ButtonsActivity sets this to learn the next button pressed. */
    interface Learner { void learned(KeyEvent event); }
    static volatile Learner learner;

    private int[] inputKeycodes = new int[0];
    private Map<Integer, String> appKeys = Collections.emptyMap();
    private Map<Integer, String> appScancodes = Collections.emptyMap();
    private Map<Integer, String> holdAppKeys = Collections.emptyMap();
    private Map<Integer, String> holdAppScancodes = Collections.emptyMap();
    private HelperLink link;
    private final android.os.Handler homeHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean homeLong;
    private final Runnable homeHold = () -> {
        homeLong = true;
        startActivity(new Intent(this, AppsWindowActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
    };
    /** The button whose DOWN we consumed, so its UP is consumed too and nothing else sees half a press. */
    private String pressed;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Config config = Config.load(this);
        inputKeycodes = config.inputKeycodes;
        appKeys = RemoteKeys.parseAppKeys(config.appKeys);
        appScancodes = RemoteKeys.parseAppScancodes(config.appKeys);
        RemoteKeys.applyKeyFilter(this, config.keyFilter);
        holdAppKeys = RemoteKeys.parseHoldAppKeys(config.appKeys);
        holdAppScancodes = RemoteKeys.parseHoldAppScancodes(config.appKeys);
        link = new HelperLink(this);
        link.start();
    }

    /** New server address or code from the computer. */
    void reconnectHelper() {
        if (link != null) link.restart();
    }

    private boolean isInputKey(int keyCode) {
        if (keyCode == KeyEvent.KEYCODE_TV || keyCode == KeyEvent.KEYCODE_TV_INPUT) return true;
        for (int code : inputKeycodes) if (keyCode == code) return true;
        return false;
    }

    private static boolean isNavigation(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_UP: case KeyEvent.KEYCODE_DPAD_DOWN: case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT: case KeyEvent.KEYCODE_DPAD_CENTER: case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_BACK: case KeyEvent.KEYCODE_HOME: case KeyEvent.KEYCODE_VOLUME_UP:
            case KeyEvent.KEYCODE_VOLUME_DOWN: case KeyEvent.KEYCODE_VOLUME_MUTE: case KeyEvent.KEYCODE_POWER:
                return true;
            default:
                return false;
        }
    }

    @Override
    protected boolean onKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        // Google's Home is up under a cover for a moment (GtvRows): no key may reach it.
        if (GtvRows.busy) return true;
        // Arrows, OK, Back, volume: nothing here concerns them. Answer at once, because the system waits for this
        // service before it delivers each of these keys to the app, so any work here is added to every key press.
        if (code == KeyEvent.KEYCODE_HOME && learner == null) return onHomeKey(event);
        if (learner == null && isNavigation(code)) return false;
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0 && !isNavigation(code)) {
            // For finding a new remote's buttons: adb logcat -s HelperKeys
            Log.i(TAG, "key " + KeyEvent.keyCodeToString(code) + " (" + code + ") scan " + event.getScanCode());
        }

        Learner l = learner;
        if (l != null && !isNavigation(code)) {
            if (event.getAction() == KeyEvent.ACTION_UP) {
                learner = null;
                l.learned(event);
            }
            return true;
        }

        if (event.getAction() == KeyEvent.ACTION_UP && pressed != null) {
            String name = pressed;
            pressed = null;
            if (!event.isCanceled()) pressButton(name);
            return true;
        }
        String name = Helper.buttonFor(this, event);
        if (name != null && takesOver(name) && event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) pressed = name;
            return true;
        }

        // A scancode entry is more specific than any keycode, so it goes first.
        if (RemoteKeys.handle(this, event, appScancodes.get(event.getScanCode()),
                holdAppScancodes.get(event.getScanCode()))) return true;
        if (RemoteKeys.handle(this, event, appKeys.get(code), holdAppKeys.get(code))) return true;
        if (!isInputKey(code)) return false;
        if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) {
            try {
                startActivity(new Intent(ACTION_VIEW_INPUTS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (ActivityNotFoundException ignored) {
            }
        }
        return true;
    }

    /**
     * Home: a tap goes Home as usual; holding it opens the apps window. Both are decided here, so the key is taken
     * and a tap is replayed as the global Home action (an accessibility service may always do that).
     */
    private boolean onHomeKey(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) {
                homeLong = false;
                homeHandler.removeCallbacks(homeHold);
                homeHandler.postDelayed(homeHold, 600);
            }
            return true;
        }
        homeHandler.removeCallbacks(homeHold);
        if (!homeLong && !event.isCanceled()) goHome(this);
        homeLong = false;
        return true;
    }

    /**
     * Our Home, started directly: with Google TV's own Home enabled (for GtvRows), the system's Home action and
     * the way back from apps lead to Google's, whatever the default.
     */
    static void goHome(Context c) {
        try {
            c.startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
                    .setClassName(c.getPackageName(), MainActivity.class.getName())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_ANIMATION | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
        } catch (Exception e) {
            Log.w(TAG, "cannot open Home", e);
        }
    }

    /** The Assistant button is always HELPER's; other buttons only once an app is chosen for them. */
    private boolean takesOver(String name) {
        return "assistant".equals(name) || !Helper.buttonApp(this, name).isEmpty();
    }

    private void pressButton(String name) {
        String pkg = Helper.buttonApp(this, name);
        if (!pkg.isEmpty() && Helper.openApp(this, pkg)) return;
        if ("assistant".equals(name)) HelperOverlayActivity.open(this, "voice", null);
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED || event.getPackageName() == null) return;
        String pkg = event.getPackageName().toString();
        if (pkg.equals(GtvRows.GTV)) Log.i(TAG, "gtv window " + event.getClassName() + " busy=" + GtvRows.busy);
        // Google's Home came up by itself (Back out of an app, the system's Home): ours instead, at once.
        if (pkg.equals(GtvRows.GTV) && !GtvRows.busy && event.getClassName() != null
                && event.getClassName().toString().contains("HomeActivity")) {
            goHome(this);
            return;
        }
        // The keyboard, the volume bar and our own overlay are not "the app that is open".
        if (pkg.equals("com.android.systemui") || pkg.contains("inputmethod")) return;
        if (pkg.equals(getPackageName())) {
            CharSequence cls = event.getClassName();
            if (cls != null && cls.toString().endsWith(".MainActivity")) currentPackage = "";   // Home
            return;
        }
        currentPackage = pkg;
    }

    @Override
    public void onInterrupt() {
    }

    @Override
    public void onDestroy() {
        if (link != null) link.stop();
        if (instance == this) instance = null;
        super.onDestroy();
    }
}
