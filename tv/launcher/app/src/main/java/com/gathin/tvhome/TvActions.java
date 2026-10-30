package com.gathin.tvhome;

import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.net.Uri;
import android.os.SystemClock;
import android.view.KeyEvent;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What HELPER can do on the TV from the overlay, without the HELPER server knowing anything about TVs:
 * <ul>
 *   <li>Quick commands in Hebrew run here at once: open an app, search or play on YouTube, search the whole TV,
 *       volume, pause and play, back and Home.</li>
 *   <li>Anything else goes to HELPER with a short note on what the TV can do. HELPER may end its answer with action
 *       tags, [[open:package]], [[youtube:query]], [[search:query]], [[key:name]], [[volume:0-100]], which run here
 *       and are taken out of what is shown and said.</li>
 * </ul>
 */
final class TvActions {

    private TvActions() { }

    /** Hebrew and English names people use, mapped to words found in app labels. */
    private static final Map<String, String> ALIASES = new LinkedHashMap<>();
    static {
        ALIASES.put("נטפליקס", "netflix");
        ALIASES.put("יוטיוב", "youtube");
        ALIASES.put("דיסני", "disney");
        ALIASES.put("דיסני פלוס", "disney");
        ALIASES.put("ספוטיפיי", "spotify");
        ALIASES.put("יס", "yes");
        ALIASES.put("יס פלוס", "yes");
        ALIASES.put("סטינג", "sting");
        ALIASES.put("סטרמיו", "stremio");
        ALIASES.put("וי אל סי", "vlc");
        ALIASES.put("קשת", "12");
        ALIASES.put("ערוץ 12", "12");
        ALIASES.put("12", "12");
        ALIASES.put("רשת", "13");
        ALIASES.put("ערוץ 13", "13");
        ALIASES.put("13", "13");
        ALIASES.put("כאן", "כאן");
        ALIASES.put("כאן 11", "כאן");
        ALIASES.put("גוגל פליי", "play store");
        ALIASES.put("פליי", "play store");
        ALIASES.put("חנות", "play store");
        ALIASES.put("הגדרות", "settings");
    }

    // ---- quick commands ----

    private static final Pattern OPEN = Pattern.compile("^(?:תפתח|פתח|תפתחי|תכנס ל|תיכנס ל|תעבור ל|תדליק|תפעיל)\\s*(?:את\\s+)?(?:ה)?(.+)$");
    private static final Pattern YT = Pattern.compile("^(?:תחפש|חפש|תשים|שים|תנגן|נגן|תפעיל)\\s+(?:ב|ביו|ב-)?(?:יוטיוב|youtube)\\s+(?:את\\s+)?(.+)$");
    private static final Pattern YT_AFTER = Pattern.compile("^(?:תחפש|חפש|תשים|שים|תנגן|נגן)\\s+(?:את\\s+)?(.+?)\\s+(?:ב|ב-)(?:יוטיוב|youtube)$");
    private static final Pattern SEARCH = Pattern.compile("^(?:תחפש|חפש)\\s+(?:לי\\s+)?(?:את\\s+)?(.+)$");
    private static final Pattern VOLUME = Pattern.compile("(?:ווליום|עוצמה|ווליום ל|תשים ווליום)\\s*(?:על\\s+|ל\\s*)?(\\d{1,3})");

    /** A spoken answer for a command done here, or null to pass the words to HELPER. */
    static String tryQuick(Context c, String said) {
        String t = said.trim().replaceAll("[.!?,]+$", "").replaceAll("\\s+", " ");
        String low = t.toLowerCase(Locale.ROOT);
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);

        if (low.matches("^(?:תגביר|תעלה ווליום|יותר חזק|הגבר)( קצת| עוד)?$")) { volumeStep(am, +2); return "הגברתי"; }
        if (low.matches("^(?:תנמיך|תוריד ווליום|יותר חלש|הנמך|תחליש)( קצת| עוד)?$")) { volumeStep(am, -2); return "הנמכתי"; }
        if (low.matches("^(?:תשתיק|השתק|בלי קול|שקט)$")) { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI); return "השתקתי"; }
        if (low.matches("^(?:תבטל השתקה|תחזיר קול|בטל השתקה)$")) { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI); return "החזרתי את הקול"; }
        Matcher v = VOLUME.matcher(low);
        if (v.find()) { int p = Math.min(100, Integer.parseInt(v.group(1))); volume(am, p); return "ווליום " + p; }
        if (low.matches("^(?:תעצור|עצור|תשהה|הפסק|תפסיק|פאוז)$")) { media(am, KeyEvent.KEYCODE_MEDIA_PAUSE); return "עצרתי"; }
        if (low.matches("^(?:תמשיך|המשך|תנגן|נגן|פליי)$")) { media(am, KeyEvent.KEYCODE_MEDIA_PLAY); return "ממשיך"; }
        if (low.matches("^(?:הבא|השיר הבא|הפרק הבא|תעביר)$")) { media(am, KeyEvent.KEYCODE_MEDIA_NEXT); return "הבא"; }
        if (low.matches("^(?:הקודם|השיר הקודם|תחזיר אחורה)$")) { media(am, KeyEvent.KEYCODE_MEDIA_PREVIOUS); return "הקודם"; }
        if (low.matches("^(?:מסך הבית|תחזור הביתה|הביתה|בית)$")) { home(c); return "מסך הבית"; }

        Matcher m = YT.matcher(low);
        if (!m.matches()) m = YT_AFTER.matcher(low);
        if (m.matches()) { youtube(c, m.group(1)); return "מחפש ביוטיוב: " + m.group(1); }
        m = OPEN.matcher(low);
        if (m.matches()) {
            String pkg = findApp(c, m.group(1));
            if (pkg != null) { Helper.openApp(c, pkg); return "פותח את " + HelperLink.label(c, pkg); }
        }
        m = SEARCH.matcher(low);
        if (m.matches() && !m.group(1).contains("סרט") && !m.group(1).contains("המלצה")) {
            search(c, m.group(1));
            return "מחפש: " + m.group(1);
        }
        return null;
    }

    // ---- HELPER's answers ----

    /** The note sent with a question from the TV, so HELPER can answer with actions. */
    static String note(Context c) {
        StringBuilder apps = new StringBuilder();
        try {
            JSONArray a = HelperLink.apps(c);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                if (apps.length() > 0) apps.append(", ");
                apps.append(o.getString("label")).append('=').append(o.getString("pkg"));
            }
        } catch (Exception ignored) { }
        return "[מהטלוויזיה בסלון, בקול. ענה במשפט או שניים. אם הוא מבקש לעשות משהו בטלוויזיה, או שאתה ממליץ ויש מה להפעיל,"
                + " הוסף בסוף שורה עם פעולה אחת: [[open:package]] לפתיחת אפליקציה, [[youtube:חיפוש]] לחיפוש והפעלה ביוטיוב,"
                + " [[key:pause|play|next|previous|back|home]], [[volume:0-100]]."
                + " אל תמציא חבילות. אפליקציות מותקנות: " + apps + "]\n";
    }

    private static final Pattern TAG = Pattern.compile("\\[\\[\\s*(open|youtube|search|key|volume)\\s*:\\s*([^\\]]+?)\\s*\\]\\]");

    /** The reply without its action tags. */
    static String clean(String reply) {
        return reply == null ? "" : TAG.matcher(reply).replaceAll("").replaceAll("\\n{3,}", "\n\n").trim();
    }

    /** Runs the action tags in a reply; returns how many ran. */
    static int run(Context c, String reply) {
        if (reply == null) return 0;
        Matcher m = TAG.matcher(reply);
        int n = 0;
        AudioManager am = (AudioManager) c.getSystemService(Context.AUDIO_SERVICE);
        while (m.find()) {
            String kind = m.group(1), arg = m.group(2).trim();
            try {
                switch (kind) {
                    case "open":
                        String pkg = arg.contains(".") ? arg : findApp(c, arg);
                        if (pkg != null && Helper.openApp(c, pkg)) n++;
                        break;
                    case "youtube": youtube(c, arg); n++; break;
                    case "search": search(c, arg); n++; break;
                    case "volume": volume(am, Math.max(0, Math.min(100, Integer.parseInt(arg.replaceAll("\\D", ""))))); n++; break;
                    case "key":
                        switch (arg) {
                            case "pause": media(am, KeyEvent.KEYCODE_MEDIA_PAUSE); break;
                            case "play": media(am, KeyEvent.KEYCODE_MEDIA_PLAY); break;
                            case "next": media(am, KeyEvent.KEYCODE_MEDIA_NEXT); break;
                            case "previous": media(am, KeyEvent.KEYCODE_MEDIA_PREVIOUS); break;
                            case "home": home(c); break;
                            case "back": back(); break;
                            default: continue;
                        }
                        n++;
                        break;
                    default:
                        break;
                }
            } catch (Exception ignored) { }
        }
        return n;
    }

    // ---- doing things ----

    static String findApp(Context c, String spoken) {
        String q = spoken.trim().toLowerCase(Locale.ROOT).replaceFirst("^(?:אפליקציה של|אפליקציית|האפליקציה)\\s+", "");
        String want = ALIASES.containsKey(q) ? ALIASES.get(q) : q;
        List<String[]> apps = new ArrayList<>();
        try {
            JSONArray a = HelperLink.apps(c);
            for (int i = 0; i < a.length(); i++) apps.add(new String[]{a.getJSONObject(i).getString("pkg"), a.getJSONObject(i).getString("label")});
        } catch (Exception ignored) { }
        for (String[] a : apps) if (a[1].toLowerCase(Locale.ROOT).equals(want)) return a[0];
        for (String[] a : apps) if (a[1].toLowerCase(Locale.ROOT).contains(want)) return a[0];
        for (String[] a : apps) if (a[0].toLowerCase(Locale.ROOT).contains(want.replace(" ", ""))) return a[0];
        if (want.equals("settings")) return "com.android.tv.settings";
        return null;
    }

    /** YouTube's results for a query (YouTube for TV takes a results link; it has no ACTION_SEARCH). */
    static void youtube(Context c, String query) {
        Intent view = new Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query)))
                .setPackage("com.google.android.youtube.tv").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try { c.startActivity(view); } catch (Exception ignored) { }
    }

    /** Search. Google TV's own search only opens for the assistant app Google no longer is, so it goes to YouTube. */
    static void search(Context c, String query) {
        youtube(c, query);
    }

    private static void volume(AudioManager am, int percent) {
        int max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
        am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(max * percent / 100f), AudioManager.FLAG_SHOW_UI);
    }

    private static void volumeStep(AudioManager am, int steps) {
        for (int i = 0; i < Math.abs(steps); i++) {
            am.adjustStreamVolume(AudioManager.STREAM_MUSIC, steps > 0 ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI);
        }
    }

    private static void media(AudioManager am, int code) {
        long now = SystemClock.uptimeMillis();
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0));
        am.dispatchMediaKeyEvent(new KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0));
    }

    private static void home(Context c) {
        InputKeyService s = InputKeyService.instance;
        if (s != null) s.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME);
        else c.startActivity(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    private static void back() {
        InputKeyService s = InputKeyService.instance;
        if (s != null) s.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK);
    }
}
