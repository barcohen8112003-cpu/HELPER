package com.gathin.tvhome;

import java.util.HashMap;
import java.util.Map;
import java.util.Random;

/** NOW design: one line above the dock for the focused app, picked fresh on each visit. */
final class Taglines {
    private static final Map<String, String[]> LINES = new HashMap<>();
    private static final Random RANDOM = new Random();
    static {
        LINES.put("com.netflix.ninja", new String[]{"Legen... wait for it... dary.", "עוד פרק אחד. רק אחד.", "Are you still watching?"});
        LINES.put("com.google.android.youtube.tv", new String[]{"עוד סרטון אחד ואני הולך לישון.", "Like and subscribe.", "מה נראה היום?"});
        LINES.put("com.disneyplus.mea", new String[]{"To infinity and beyond.", "Hakuna matata.", "I am your father."});
        LINES.put("com.keshet.mako.VODAndroidTV", new String[]{"כל מה שפספסת ב-12.", "החדשות, הריאליטי והדרמות.", "מה רץ הערב ב-12?"});
        LINES.put("com.applicaster.iReshet", new String[]{"רשת 13, מתי שבא לך.", "כל התוכניות של 13 במקום אחד."});
        LINES.put("com.applicaster.il.ch1", new String[]{"כאן. השידור הציבורי.", "תיעודה, דרמה וחדשות מכאן."});
        LINES.put("il.co.yes.yesplus", new String[]{"yes+ כבר מחכה לך.", "Don't have time to browse?"});
        LINES.put("il.co.stingtv.atv", new String[]{"STING TV, ישר לספה.", "ערוצים וסדרות בלי כבלים."});
        LINES.put("com.stremio.one", new String[]{"Everything, all at once.", "מה בא לך לראות?"});
        LINES.put("org.videolan.vlc", new String[]{"The cone never lies.", "כל קובץ, כל פורמט."});
        LINES.put("com.spotify.tv.android", new String[]{"Turn it up.", "מוזיקה לסלון."});
        LINES.put("com.android.vending", new String[]{"משהו חדש לטלוויזיה?"});
    }

    private Taglines() { }

    static String pick(String pkg, String label) {
        String[] lines = pkg == null ? null : LINES.get(pkg);
        if (lines == null || lines.length == 0) return label;
        return lines[RANDOM.nextInt(lines.length)];
    }
}
