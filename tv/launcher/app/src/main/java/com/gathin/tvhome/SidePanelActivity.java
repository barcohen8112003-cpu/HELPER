package com.gathin.tvhome;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.ComponentName;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.media.AudioManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Display;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The settings panel from the gear on Home, after Google TV's quick settings: a narrow panel against the edge of
 * the screen, an account row, low tiles with thin line icons, and a darker card at the foot. A tile opens its menu
 * in the same place (Bluetooth devices, Wi-Fi networks, the volume, the screensaver...), and Back returns to the
 * tiles. Focus only turns a row white; nothing grows.
 *
 * Some menus write system settings: they need WRITE_SECURE_SETTINGS and the WRITE_SETTINGS app op, granted once
 * from the computer over adb (tv/README). Without them those rows say so instead of failing.
 *
 * The app does not declare RTL support (Home's Hebrew layout is mirrored by hand in layout-iw), so rows are built
 * right to left by hand: what reads first is added last.
 */
public class SidePanelActivity extends Activity {

    private static final int PANEL = 0xF2263148;
    private static final int TILE = 0x1FFFFFFF;
    private static final int TILE_FOCUSED = 0xFFE8EAED;
    private static final int CARD = 0x33000000;
    private static final int TEXT = 0xFFE8EAED;
    private static final int TEXT_DIM = 0x99E8EAED;
    private static final int INK = 0xFF202124;
    private static final int ACCENT = 0xFF8AB4F8;

    private float d;
    private Typeface regular, medium;
    private LinearLayout panel, body;
    private ScrollView scroller;
    private TextView header;
    /** The tile that opened the menu on screen, to focus again on Back; null while the tiles show. */
    private View openedFrom;
    private Runnable refreshMenu;
    private BroadcastReceiver btReceiver;
    private final Map<String, BluetoothDevice> found = new LinkedHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        d = getResources().getDisplayMetrics().density;
        regular = getResources().getFont(R.font.outfit_regular);
        medium = getResources().getFont(R.font.outfit_medium);

        FrameLayout root = new FrameLayout(this);
        root.setOnClickListener(v -> finish());

        panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(px(12), px(12), px(12), px(12));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(PANEL);
        bg.setCornerRadius(px(24));
        panel.setBackground(bg);
        panel.setElevation(px(8));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(px(332), FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.LEFT | Gravity.TOP);
        lp.leftMargin = px(16);
        lp.topMargin = px(16);
        lp.bottomMargin = px(16);
        root.addView(panel, lp);

        header = label("", 17, TEXT, medium);
        header.setPadding(px(10), px(6), px(10), px(12));
        panel.addView(header, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        scroller = new ScrollView(this);
        scroller.setVerticalScrollBarEnabled(false);
        body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        scroller.addView(body);
        panel.addView(scroller, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        setContentView(root);

        showTiles(null);
        panel.setAlpha(0f);
        panel.setTranslationX(-px(24));
        panel.animate().alpha(1f).translationX(0).setDuration(200).setInterpolator(new DecelerateInterpolator(1.5f)).start();
    }

    // =====================================================================================================
    // The tiles
    // =====================================================================================================

    private void showTiles(Integer focusIndex) {
        stopBluetoothScan();
        refreshMenu = null;
        openedFrom = null;
        header.setVisibility(View.GONE);
        body.removeAllViews();
        List<View> order = new ArrayList<>();

        Tile account = new Tile(R.drawable.ic_qs_spark, "HELPER", Helper.configured(this) ? "מחובר" : "לא מחובר", true,
                () -> { HelperOverlayActivity.open(this, "type", null); finish(); });
        body.addView(account.view, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(60)));
        order.add(account.view);
        gap(8);

        Tile screensaver = new Tile(0, "שומר מסך", null, false, null);
        screensaver.waves();
        Tile apps = new Tile(R.drawable.ic_qs_input, "אפליקציות", null, false, () -> launch(new Intent(this, AppsWindowActivity.class)));
        Tile picture = new Tile(R.drawable.ic_qs_picture, "תמונה", null, false, null);
        Tile sound = new Tile(R.drawable.ic_qs_sound, "צליל", null, false, null);
        Tile wifi = new Tile(R.drawable.ic_qs_wifi, "Wi-Fi", null, false, null);
        Tile access = new Tile(R.drawable.ic_qs_access, "נגישות", null, false, null);
        Tile bt = new Tile(R.drawable.ic_qs_bt, "Bluetooth", null, false, null);
        Tile remote = new Tile(R.drawable.ic_qs_remote, "שלט", null, false, null);
        Tile wall = new Tile(R.drawable.ic_qs_wallpaper, "טפט", null, false, null);
        Tile settings = new Tile(R.drawable.ic_qs_gear, "הגדרות", null, false, () -> system(Settings.ACTION_SETTINGS));
        settings.view.setOnLongClickListener(v -> { launch(new Intent(this, LauncherSettingsActivity.class)); return true; });

        menu(screensaver, "שומר מסך", this::screensaverMenu);
        menu(picture, "תמונה", this::pictureMenu);
        menu(sound, "צליל", this::soundMenu);
        menu(wifi, "Wi-Fi", this::wifiMenu);
        menu(access, "נגישות", this::accessibilityMenu);
        menu(bt, "Bluetooth", this::bluetoothMenu);
        menu(remote, "כפתורי השלט", this::remoteMenu);
        menu(wall, "טפט", this::wallpaperMenu);

        tileRow(screensaver, apps, order);
        tileRow(picture, sound, order);
        tileRow(wifi, access, order);
        tileRow(bt, remote, order);
        tileRow(wall, settings, order);

        gap(4);
        Tile ask = new Tile(R.drawable.ic_qs_spark, "לשאול את HELPER", "כפתור העוזר בשלט, ואז לדבר", true,
                () -> { HelperOverlayActivity.open(this, "voice", null); finish(); });
        ask.base = CARD;
        ask.paint(false);
        body.addView(ask.view, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, px(60)));
        order.add(ask.view);

        View focus = focusIndex != null && focusIndex >= 0 && focusIndex < order.size() ? order.get(focusIndex) : account.view;
        focus.requestFocus();
        lastTileOrder = order;
    }

    private List<View> lastTileOrder = new ArrayList<>();
    private int openedIndex = -1;

    /** A tile that opens a menu in place. */
    private void menu(Tile t, String title, Runnable build) {
        t.action = () -> {
            openedIndex = lastTileOrder.indexOf(t.view);
            openMenu(title, build);
        };
    }

    private void openMenu(String title, Runnable build) {
        body.removeAllViews();
        header.setText("‏" + title);
        header.setVisibility(View.VISIBLE);
        openedFrom = header;
        refreshMenu = () -> {
            View f = getCurrentFocus();
            int index = f == null ? 0 : Math.max(0, body.indexOfChild(f));
            body.removeAllViews();
            build.run();
            View again = index < body.getChildCount() ? body.getChildAt(index) : null;
            if (again != null && again.isFocusable()) again.requestFocus();
        };
        build.run();
        body.setAlpha(0f);
        body.setTranslationX(-px(12));
        body.animate().alpha(1f).translationX(0).setDuration(160).start();
        scroller.scrollTo(0, 0);
        for (int i = 0; i < body.getChildCount(); i++) {
            if (body.getChildAt(i).isFocusable()) { body.getChildAt(i).requestFocus(); break; }
        }
    }

    @Override
    public void onBackPressed() {
        if (openedFrom != null) showTiles(openedIndex);
        else finish();
    }

    // =====================================================================================================
    // Menus
    // =====================================================================================================

    private void bluetoothMenu() {
        BluetoothAdapter adapter = btAdapter();
        if (adapter == null) { note("אין Bluetooth בטלוויזיה הזו."); return; }
        if (!has(Manifest.permission.BLUETOOTH_CONNECT)) { note("צריך הרשאת Bluetooth. היא ניתנת מהמחשב בהתקנה."); return; }
        boolean on = adapter.isEnabled();
        row(null, "Bluetooth", on ? "פועל" : "כבוי", null, () -> system(Settings.ACTION_BLUETOOTH_SETTINGS));
        if (!on) return;

        section("מכשירים מצומדים");
        Set<BluetoothDevice> bonded = bondedDevices(adapter);
        if (bonded.isEmpty()) note("אין מכשירים מצומדים.");
        for (BluetoothDevice dev : bonded) {
            boolean connected = isConnected(dev);
            row(null, name(dev), connected ? "מחובר" : "לא מחובר", null, () -> deviceMenu(dev));
        }

        section("מכשירים חדשים");
        boolean scanning = has(Manifest.permission.BLUETOOTH_SCAN) && adapter.isDiscovering();
        row(null, scanning ? "מחפש מכשירים…" : "חיפוש מכשירים", scanning ? "שים את המכשיר במצב צימוד" : null, null, this::startBluetoothScan);
        for (BluetoothDevice dev : found.values()) {
            if (bonded.contains(dev)) continue;
            int state = bondState(dev);
            row(null, name(dev), state == BluetoothDevice.BOND_BONDING ? "מצמד…" : "לחץ כדי לצמד", null, () -> {
                try { dev.createBond(); } catch (SecurityException ignored) { }
                refresh();
            });
        }
    }

    private void deviceMenu(BluetoothDevice dev) {
        openMenu(name(dev), () -> {
            row(null, isConnected(dev) ? "מחובר" : "לא מחובר", dev.getAddress(), null, null);
            row(null, "שכח את המכשיר", "הסרת הצימוד", null, () -> {
                try { dev.getClass().getMethod("removeBond").invoke(dev); } catch (Exception ignored) { }
                openMenu("Bluetooth", this::bluetoothMenu);
            });
        });
    }

    private void wifiMenu() {
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null) { note("אין Wi-Fi."); return; }
        boolean on = wm.isWifiEnabled();
        row(null, "Wi-Fi", on ? "פועל" : "כבוי", null, () -> system(Settings.ACTION_WIFI_SETTINGS));
        if (!on) return;
        WifiInfo info = wm.getConnectionInfo();
        String current = info == null ? null : info.getSSID();
        if (current != null) current = current.replace("\"", "");
        if (current != null && !current.isEmpty() && !"<unknown ssid>".equals(current)) {
            section("מחובר ל");
            int level = WifiManager.calculateSignalLevel(info.getRssi(), 5);
            row(null, current, bars(level) + "   " + ip(info.getIpAddress()) + "   " + info.getLinkSpeed() + " Mbps", null, null);
        }
        section("רשתות זמינות");
        Set<String> seen = new HashSet<>();
        List<ScanResult> results;
        try { results = wm.getScanResults(); } catch (SecurityException e) { results = new ArrayList<>(); }
        results.sort((a, b) -> Integer.compare(b.level, a.level));
        int shown = 0;
        for (ScanResult r : results) {
            String ssid = r.SSID;
            if (ssid == null || ssid.isEmpty() || ssid.equals(current) || !seen.add(ssid)) continue;
            boolean locked = r.capabilities != null && (r.capabilities.contains("WPA") || r.capabilities.contains("WEP") || r.capabilities.contains("SAE"));
            row(null, ssid, bars(WifiManager.calculateSignalLevel(r.level, 5)) + (locked ? "   מוגנת" : "   פתוחה"), null,
                    () -> system(Settings.ACTION_WIFI_SETTINGS));
            if (++shown == 8) break;
        }
        if (shown == 0) note("לא נמצאו רשתות נוספות.");
        try { wm.startScan(); } catch (Exception ignored) { }
        row(null, "הגדרות Wi-Fi נוספות", null, null, () -> system(Settings.ACTION_WIFI_SETTINGS));
    }

    private void soundMenu() {
        AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        int max = Math.max(1, am.getStreamMaxVolume(AudioManager.STREAM_MUSIC));
        int level = Math.round(100f * am.getStreamVolume(AudioManager.STREAM_MUSIC) / max);
        View vol = slider("ווליום", level, delta -> {
            int now = am.getStreamVolume(AudioManager.STREAM_MUSIC);
            int step = Math.max(1, Math.round(max * 0.05f));
            am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.max(0, Math.min(max, now + (delta > 0 ? step : -step))), 0);
            return Math.round(100f * am.getStreamVolume(AudioManager.STREAM_MUSIC) / max);
        });
        body.addView(vol);
        boolean muted = am.isStreamMute(AudioManager.STREAM_MUSIC);
        toggle("השתקה", null, muted, on -> am.adjustStreamVolume(AudioManager.STREAM_MUSIC,
                on ? AudioManager.ADJUST_MUTE : AudioManager.ADJUST_UNMUTE, 0));
        boolean clicks = Settings.System.getInt(getContentResolver(), Settings.System.SOUND_EFFECTS_ENABLED, 1) == 1;
        toggle("צלילי מערכת", "צליל בכל לחיצה בשלט", clicks, on -> putSystem(Settings.System.SOUND_EFFECTS_ENABLED, on ? 1 : 0));
        row(null, "הגדרות צליל נוספות", "פורמט שמע, סראונד", null, () -> system(Settings.ACTION_SOUND_SETTINGS));
    }

    private void pictureMenu() {
        Display display = getWindowManager().getDefaultDisplay();
        Display.Mode mode = display.getMode();
        row(null, "רזולוציה", mode.getPhysicalWidth() + "×" + mode.getPhysicalHeight() + "   ·   "
                + Math.round(mode.getRefreshRate()) + "Hz", null, null);
        int timeout = Settings.System.getInt(getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, 0);
        choice("כיבוי מסך אחרי", timeout, new int[]{15 * 60000, 30 * 60000, 60 * 60000, 4 * 3600000, Integer.MAX_VALUE},
                new String[]{"15 דקות", "30 דקות", "שעה", "4 שעות", "אף פעם"}, v -> {
                    putSystem(Settings.System.SCREEN_OFF_TIMEOUT, v);
                    putSecure("sleep_timeout", v == Integer.MAX_VALUE ? -1 : v);
                });
        row(null, "הגדרות תצוגה נוספות", "רזולוציה, HDR, התאמת קצב", null, () -> system(Settings.ACTION_DISPLAY_SETTINGS));
    }

    private void screensaverMenu() {
        ContentResolver cr = getContentResolver();
        String comp = Settings.Secure.getString(cr, "screensaver_components");
        boolean enabled = Settings.Secure.getInt(cr, "screensaver_enabled", 1) == 1;
        String clock = new ComponentName(this, ClockDream.class).flattenToShortString();
        String now = !enabled ? "כבוי" : comp != null && comp.contains("ClockDream") ? "השעון" : "אחר";
        choice("שומר מסך", now.equals("כבוי") ? 0 : now.equals("השעון") ? 1 : 2, new int[]{1, 0},
                new String[]{"השעון", "כבוי"}, v -> {
                    if (v == 1) {
                        putSecureString("screensaver_components", clock);
                        putSecure("screensaver_enabled", 1);
                    } else {
                        putSecure("screensaver_enabled", 0);
                    }
                });
        int timeout = Settings.System.getInt(cr, Settings.System.SCREEN_OFF_TIMEOUT, 0);
        choice("להפעיל אחרי", timeout, new int[]{5 * 60000, 15 * 60000, 30 * 60000},
                new String[]{"5 דקות", "15 דקות", "30 דקות"}, v -> putSystem(Settings.System.SCREEN_OFF_TIMEOUT, v));
        row(null, "להפעיל עכשיו", null, null, () -> launch(new Intent(this, ClockActivity.class)));
    }

    private void accessibilityMenu() {
        ContentResolver cr = getContentResolver();
        toggle("כתוביות", "בסרטונים שיש בהם", Settings.Secure.getInt(cr, "accessibility_captioning_enabled", 0) == 1,
                on -> putSecure("accessibility_captioning_enabled", on ? 1 : 0));
        toggle("טקסט בניגודיות גבוהה", null, Settings.Secure.getInt(cr, "high_text_contrast_enabled", 0) == 1,
                on -> putSecure("high_text_contrast_enabled", on ? 1 : 0));
        float scale = Settings.System.getFloat(cr, Settings.System.FONT_SCALE, 1f);
        choice("גודל טקסט", Math.round(scale * 100), new int[]{85, 100, 115, 130},
                new String[]{"קטן", "רגיל", "גדול", "הכי גדול"}, v -> {
                    if (canWriteSystem()) Settings.System.putFloat(cr, Settings.System.FONT_SCALE, v / 100f);
                });
        row(null, "נגישות נוספת", null, null, () -> system(Settings.ACTION_ACCESSIBILITY_SETTINGS));
    }

    private void remoteMenu() {
        if (InputKeyService.instance == null) note("שירות הכפתורים כבוי, אז ההגדרה תחול כשהוא יפעל.");
        for (String name : Helper.BUTTONS.keySet()) {
            String pkg = Helper.buttonApp(this, name);
            String now = !pkg.isEmpty() ? HelperLink.label(this, pkg) : "assistant".equals(name) ? "HELPER" : "ברירת מחדל";
            row(null, Helper.buttonTitle(name), now, null, () -> learnButton(name));
        }
    }

    private void learnButton(String name) {
        if (InputKeyService.instance == null) { chooseButtonApp(name); return; }
        openMenu(Helper.buttonTitle(name), () -> note("לחץ עכשיו על " + Helper.buttonTitle(name) + " בשלט…"));
        InputKeyService.learner = event -> runOnUiThread(() -> {
            Helper.learnButton(this, name, event.getKeyCode(), event.getScanCode());
            chooseButtonApp(name);
        });
    }

    private void chooseButtonApp(String name) {
        openMenu(Helper.buttonTitle(name) + " יפתח את…", () -> {
            row(null, "assistant".equals(name) ? "HELPER (ברירת מחדל)" : "ברירת מחדל", null, null, () -> {
                Helper.setButtonApp(this, name, "");
                openMenu("כפתורי השלט", this::remoteMenu);
            });
            try {
                JSONArray apps = HelperLink.apps(this);
                for (int i = 0; i < apps.length(); i++) {
                    JSONObject a = apps.getJSONObject(i);
                    String pkg = a.getString("pkg");
                    row(null, a.getString("label"), null, null, () -> {
                        Helper.setButtonApp(this, name, pkg);
                        openMenu("כפתורי השלט", this::remoteMenu);
                    });
                }
            } catch (Exception ignored) { }
        });
    }

    private void wallpaperMenu() {
        toggle("טפט וידאו", "הסרטון שמתנגן מאחורי מסך הבית", VideoWallpaper.enabled(this),
                on -> VideoWallpaper.setEnabled(this, on));
        note("כדי להחליף סרטון, שלח אותו מהמחשב (tv/theme-now/wallpaper.mp4).");
    }

    // =====================================================================================================
    // Rows
    // =====================================================================================================

    /** A list row: title and subtitle on the right, an optional value or switch on the left. */
    private LinearLayout row(Integer icon, String title, String subtitle, View trailing, Runnable action) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(px(16), px(10), px(16), px(10));
        r.setMinimumHeight(px(56));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(px(14));
        bg.setColor(TILE);
        r.setBackground(bg);
        boolean focusable = action != null || trailing != null;
        r.setFocusable(focusable);
        r.setClickable(focusable);
        if (trailing != null) r.addView(trailing);
        LinearLayout texts = new LinearLayout(this);
        texts.setOrientation(LinearLayout.VERTICAL);
        texts.setGravity(Gravity.RIGHT);
        TextView t = label(title, 14, TEXT, regular);
        texts.addView(t);
        TextView s = null;
        if (subtitle != null) {
            s = label(subtitle, 12, TEXT_DIM, regular);
            s.setPadding(0, px(3), 0, 0);
            texts.addView(s);
        }
        r.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView sub = s;
        r.setOnFocusChangeListener((v, f) -> {
            bg.setColor(f ? TILE_FOCUSED : TILE);
            t.setTextColor(f ? INK : TEXT);
            if (sub != null) sub.setTextColor(f ? 0x99202124 : TEXT_DIM);
            if (trailing instanceof Switch) ((Switch) trailing).focused(f);
        });
        if (action != null) r.setOnClickListener(v -> action.run());
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(6);
        body.addView(r, lp);
        return r;
    }

    interface OnToggle { void set(boolean on); }

    private void toggle(String title, String subtitle, boolean on, OnToggle change) {
        Switch sw = new Switch(on);
        final boolean[] state = {on};
        row(null, title, subtitle, sw, () -> {
            state[0] = !state[0];
            change.set(state[0]);
            sw.set(state[0]);
        });
    }

    interface OnChoice { void set(int value); }

    /** A row that steps through choices with OK, like Google TV's value rows. */
    private void choice(String title, int current, int[] values, String[] names, OnChoice change) {
        int idx = 0;
        for (int i = 0; i < values.length; i++) if (values[i] == current) idx = i;
        final int[] at = {idx};
        TextView value = label(names[idx], 13, ACCENT, medium);
        LinearLayout r = row(null, title, null, value, null);
        r.setFocusable(true);
        r.setClickable(true);
        r.setOnClickListener(v -> {
            at[0] = (at[0] + 1) % values.length;
            change.set(values[at[0]]);
            value.setText("‏" + names[at[0]]);
        });
    }

    interface OnSlide { int step(int delta); }

    /** A row with a bar: Left and Right change it (the panel reads right to left, so Left lowers). */
    private View slider(String title, int percent, OnSlide slide) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(px(16), px(12), px(16), px(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadius(px(14));
        bg.setColor(TILE);
        box.setBackground(bg);
        box.setFocusable(true);
        TextView t = label(title + "   " + percent + "%", 14, TEXT, regular);
        box.addView(t);
        FrameLayout bar = new FrameLayout(this);
        GradientDrawable track = new GradientDrawable();
        track.setColor(0x33FFFFFF);
        track.setCornerRadius(px(3));
        bar.setBackground(track);
        View fill = new View(this);
        GradientDrawable fg = new GradientDrawable();
        fg.setColor(ACCENT);
        fg.setCornerRadius(px(3));
        fill.setBackground(fg);
        int width = px(332 - 24 - 32);
        bar.addView(fill, new FrameLayout.LayoutParams(Math.round(width * percent / 100f), px(6), Gravity.RIGHT));
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(width, px(6));
        bp.topMargin = px(10);
        box.addView(bar, bp);
        box.setOnFocusChangeListener((v, f) -> {
            bg.setColor(f ? TILE_FOCUSED : TILE);
            t.setTextColor(f ? INK : TEXT);
            track.setColor(f ? 0x33202124 : 0x33FFFFFF);
            fg.setColor(f ? 0xFF1A73E8 : ACCENT);
        });
        box.setOnKeyListener((v, code, e) -> {
            if (e.getAction() != KeyEvent.ACTION_DOWN) return false;
            int delta = code == KeyEvent.KEYCODE_DPAD_RIGHT ? 1 : code == KeyEvent.KEYCODE_DPAD_LEFT ? -1 : 0;
            if (delta == 0) return false;
            int p = slide.step(delta);
            t.setText("‏" + title + "   " + p + "%");
            FrameLayout.LayoutParams fl = (FrameLayout.LayoutParams) fill.getLayoutParams();
            fl.width = Math.round(width * p / 100f);
            fill.setLayoutParams(fl);
            return true;
        });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(6);
        box.setLayoutParams(lp);
        return box;
    }

    private void section(String title) {
        TextView t = label(title, 12, TEXT_DIM, medium);
        t.setPadding(px(10), px(10), px(10), px(6));
        body.addView(t);
    }

    private void note(String text) {
        TextView t = label(text, 13, TEXT_DIM, regular);
        t.setSingleLine(false);
        t.setPadding(px(10), px(6), px(10), px(10));
        body.addView(t);
    }

    /** Google TV's small switch: a track and a knob; on is blue with the knob at the reading end. */
    private final class Switch extends View {
        private final GradientDrawable track = new GradientDrawable();
        private final GradientDrawable knob = new GradientDrawable();
        private boolean on, focused;

        Switch(boolean on) {
            super(SidePanelActivity.this);
            this.on = on;
            track.setCornerRadius(px(10));
            knob.setShape(GradientDrawable.OVAL);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(px(36), px(20));
            lp.rightMargin = px(12);
            setLayoutParams(lp);
        }

        void set(boolean v) { on = v; invalidate(); }
        void focused(boolean f) { focused = f; invalidate(); }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            track.setColor(on ? (focused ? 0xFF1A73E8 : ACCENT) : (focused ? 0x40202124 : 0x40FFFFFF));
            track.setBounds(0, 0, w, h);
            track.draw(c);
            int k = h - px(4);
            int x = on ? px(2) : w - k - px(2);    // right to left: on puts the knob on the left
            knob.setColor(on ? (focused ? 0xFFFFFFFF : 0xFF202124) : (focused ? 0xFF5F6368 : 0xFFE8EAED));
            knob.setBounds(x, px(2), x + k, px(2) + k);
            knob.draw(c);
        }
    }

    // =====================================================================================================
    // Tiles (the first page)
    // =====================================================================================================

    private final class Tile {
        final FrameLayout view;
        final GradientDrawable bg = new GradientDrawable();
        final TextView title, subtitle;
        final ImageView icon;
        final GradientDrawable circle;
        int base = TILE;
        Runnable action;
        WavesDrawable waves;

        Tile(int iconRes, String text, String sub, boolean twoLine, Runnable onClick) {
            action = onClick;
            view = new FrameLayout(SidePanelActivity.this);
            view.setFocusable(true);
            view.setClickable(true);
            bg.setCornerRadius(px(16));
            view.setBackground(bg);
            view.setClipToOutline(true);

            LinearLayout line = new LinearLayout(SidePanelActivity.this);
            line.setOrientation(LinearLayout.HORIZONTAL);
            line.setGravity(Gravity.CENTER_VERTICAL | Gravity.RIGHT);
            line.setPadding(px(14), 0, px(14), 0);
            LinearLayout texts = new LinearLayout(SidePanelActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            texts.setGravity(Gravity.RIGHT);
            title = label(text, twoLine ? 15 : 14, TEXT, twoLine ? medium : regular);
            texts.addView(title);
            subtitle = sub == null ? null : label(sub, 12, TEXT_DIM, regular);
            if (subtitle != null) texts.addView(subtitle);
            line.addView(texts, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

            icon = new ImageView(SidePanelActivity.this);
            icon.setScaleType(ImageView.ScaleType.FIT_CENTER);
            circle = twoLine ? new GradientDrawable() : null;
            if (iconRes != 0) {
                icon.setImageResource(iconRes);
                int box = px(twoLine ? 36 : 20);
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(box, box);
                ip.leftMargin = px(twoLine ? 12 : 10);
                if (circle != null) {
                    circle.setShape(GradientDrawable.OVAL);
                    icon.setBackground(circle);
                    icon.setPadding(px(8), px(8), px(8), px(8));
                }
                line.addView(icon, ip);
            }
            view.addView(line, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
            view.setOnFocusChangeListener((v, focused) -> paint(focused));
            view.setOnClickListener(v -> { if (action != null) action.run(); });
            paint(false);
        }

        void waves() {
            waves = new WavesDrawable();
            View art = new View(SidePanelActivity.this);
            art.setBackground(waves);
            view.addView(art, 0, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        }

        void paint(boolean focused) {
            bg.setColor(focused ? TILE_FOCUSED : base);
            title.setTextColor(focused ? INK : TEXT);
            if (subtitle != null) subtitle.setTextColor(focused ? 0x99202124 : TEXT_DIM);
            icon.setColorFilter(focused ? INK : TEXT);
            if (circle != null) circle.setColor(focused ? 0x14202124 : 0x1FFFFFFF);
            if (waves != null) waves.setFocused(focused);
        }
    }

    /** Two tiles side by side: {@code first} reads first, so it goes on the right. */
    private void tileRow(Tile first, Tile second, List<View> order) {
        LinearLayout r = new LinearLayout(this);
        r.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, px(52), 1f);
        LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, px(52), 1f);
        a.leftMargin = px(4);
        b.rightMargin = px(4);
        r.addView(second.view, b);
        r.addView(first.view, a);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.bottomMargin = px(8);
        body.addView(r, lp);
        first.view.setId(View.generateViewId());
        second.view.setId(View.generateViewId());
        first.view.setNextFocusLeftId(second.view.getId());
        second.view.setNextFocusRightId(first.view.getId());
        order.add(first.view);
        order.add(second.view);
    }

    // =====================================================================================================
    // Helpers
    // =====================================================================================================

    private TextView label(String s, int sp, int color, Typeface face) {
        TextView t = new TextView(this);
        t.setText("‏" + s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(face);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setGravity(Gravity.RIGHT);
        t.setIncludeFontPadding(false);
        return t;
    }

    private void gap(int dp) {
        body.addView(new View(this), new LinearLayout.LayoutParams(1, px(dp)));
    }

    private void refresh() {
        if (refreshMenu != null) refreshMenu.run();
    }

    private void launch(Intent i) {
        try {
            startActivity(i);
            finish();
        } catch (ActivityNotFoundException ignored) { }
    }

    /** A system settings screen, or the main Settings when this TV has no such screen. */
    private void system(String action) {
        try {
            startActivity(new Intent(action));
        } catch (ActivityNotFoundException e) {
            try { startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (ActivityNotFoundException ignored) { }
        }
        finish();
    }

    private boolean has(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean canWriteSystem() {
        return Settings.System.canWrite(this);
    }

    private void putSystem(String key, int value) {
        if (canWriteSystem()) Settings.System.putInt(getContentResolver(), key, value);
    }

    private void putSecure(String key, int value) {
        try { Settings.Secure.putInt(getContentResolver(), key, value); } catch (SecurityException ignored) { }
    }

    private void putSecureString(String key, String value) {
        try { Settings.Secure.putString(getContentResolver(), key, value); } catch (SecurityException ignored) { }
    }

    private static String bars(int level) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 4; i++) b.append(i < level ? "▮" : "▯");
        return b.toString();
    }

    private static String ip(int a) {
        return String.format(Locale.ROOT, "%d.%d.%d.%d", a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff, (a >> 24) & 0xff);
    }

    // ---- Bluetooth ----

    private BluetoothAdapter btAdapter() {
        BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    @SuppressLint("MissingPermission")
    private Set<BluetoothDevice> bondedDevices(BluetoothAdapter a) {
        try { return a.getBondedDevices(); } catch (SecurityException e) { return new HashSet<>(); }
    }

    @SuppressLint("MissingPermission")
    private String name(BluetoothDevice dev) {
        try {
            String n = dev.getName();
            return n == null || n.isEmpty() ? dev.getAddress() : n;
        } catch (SecurityException e) {
            return dev.getAddress();
        }
    }

    @SuppressLint("MissingPermission")
    private int bondState(BluetoothDevice dev) {
        try { return dev.getBondState(); } catch (SecurityException e) { return BluetoothDevice.BOND_NONE; }
    }

    private static boolean isConnected(BluetoothDevice dev) {
        try { return (Boolean) dev.getClass().getMethod("isConnected").invoke(dev); } catch (Exception e) { return false; }
    }

    @SuppressLint("MissingPermission")
    private void startBluetoothScan() {
        BluetoothAdapter a = btAdapter();
        if (a == null || !has(Manifest.permission.BLUETOOTH_SCAN)) return;
        if (btReceiver == null) {
            btReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context c, Intent i) {
                    BluetoothDevice dev = i.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                    if (BluetoothDevice.ACTION_FOUND.equals(i.getAction()) && dev != null) found.put(dev.getAddress(), dev);
                    refresh();
                }
            };
            IntentFilter f = new IntentFilter(BluetoothDevice.ACTION_FOUND);
            f.addAction(BluetoothDevice.ACTION_BOND_STATE_CHANGED);
            f.addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED);
            f.addAction(BluetoothAdapter.ACTION_DISCOVERY_STARTED);
            registerReceiver(btReceiver, f);
        }
        try { a.startDiscovery(); } catch (SecurityException ignored) { }
        refresh();
    }

    @SuppressLint("MissingPermission")
    private void stopBluetoothScan() {
        BluetoothAdapter a = btAdapter();
        try { if (a != null && has(Manifest.permission.BLUETOOTH_SCAN) && a.isDiscovering()) a.cancelDiscovery(); } catch (SecurityException ignored) { }
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (!isFinishing()) finish();
    }

    @Override
    protected void onDestroy() {
        stopBluetoothScan();
        if (btReceiver != null) unregisterReceiver(btReceiver);
        InputKeyService.learner = null;
        super.onDestroy();
    }

    private int px(float dp) {
        return Math.round(dp * d);
    }

    /** Google TV's screensaver tile: pale waves across the lower half and a small moon in the far corner. */
    private final class WavesDrawable extends Drawable {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private boolean focused;

        void setFocused(boolean f) { focused = f; invalidateSelf(); }

        @Override
        public void draw(Canvas c) {
            Rect b = getBounds();
            int w = b.width(), h = b.height();
            int tint = focused ? 0x6F8AB4F8 : 0x4D8AB4F8;
            for (int i = 0; i < 2; i++) {
                float base = h * (0.70f + i * 0.13f);
                float amp = h * (0.08f - i * 0.02f);
                path.rewind();
                path.moveTo(0, h);
                path.lineTo(0, base);
                for (int s = 0; s <= 20; s++) {
                    float u = s / 20f;
                    path.lineTo(w * u, base + amp * (float) Math.sin(u * Math.PI * 2 * (1.1f + i * 0.4f) + i * 1.7f));
                }
                path.lineTo(w, h);
                path.close();
                paint.setColor(tint);
                c.drawPath(path, paint);
            }
            paint.setColor(focused ? 0x99202124 : 0xCCE8EAED);
            c.drawCircle(px(16), px(15), px(4.5f), paint);
        }

        @Override public void setAlpha(int alpha) { }
        @Override public void setColorFilter(ColorFilter cf) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
