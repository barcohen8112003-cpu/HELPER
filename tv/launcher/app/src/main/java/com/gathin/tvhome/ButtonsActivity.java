package com.gathin.tvhome;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Remote buttons, set from the sofa: pick a button, press it once on the remote so the TV learns its code, then
 * choose the app it opens. HELPER can do the same from WhatsApp (tv_set_button).
 */
public class ButtonsActivity extends Activity {

    private LinearLayout list;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        float d = getResources().getDisplayMetrics().density;
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xF20B0D12);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        list.setLayoutDirection(View.LAYOUT_DIRECTION_RTL);
        int pad = Math.round(56 * d);
        list.setPadding(pad * 2, pad / 2, pad * 2, pad / 2);
        scroll.addView(list);
        setContentView(scroll);
        build();
    }

    @Override
    protected void onDestroy() {
        InputKeyService.learner = null;
        super.onDestroy();
    }

    private void build() {
        list.removeAllViews();
        float d = getResources().getDisplayMetrics().density;
        TextView title = new TextView(this);
        title.setText("כפתורי השלט");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTypeface(Typeface.create("sans-serif-light", Typeface.NORMAL));
        list.addView(title);
        TextView hint = new TextView(this);
        hint.setText(InputKeyService.instance == null
                ? "שירות הכפתורים כבוי. צריך להפעיל אותו מהמחשב (נגישות)."
                : "בחר כפתור, לחץ עליו פעם אחת בשלט, ואז בחר מה הוא יפתח. כפתור העוזר פותח את HELPER.");
        hint.setTextColor(0x99FFFFFF);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        hint.setPadding(0, Math.round(8 * d), 0, Math.round(20 * d));
        list.addView(hint);

        for (String name : Helper.BUTTONS.keySet()) {
            String pkg = Helper.buttonApp(this, name);
            String now = !pkg.isEmpty() ? HelperLink.label(this, pkg) : "assistant".equals(name) ? "HELPER" : "ברירת מחדל";
            TextView row = new TextView(this, null, 0, R.style.SettingsRow);
            row.setLayoutParams(new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, Math.round(56 * d)));
            ((LinearLayout.LayoutParams) row.getLayoutParams()).bottomMargin = Math.round(8 * d);
            row.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            row.setText(Helper.buttonTitle(name) + "   ·   " + now);
            row.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
            row.setFocusable(true);
            row.setOnClickListener(v -> learn(name, row));
            list.addView(row);
        }
        if (list.getChildCount() > 2) list.getChildAt(2).requestFocus();
    }

    private void learn(String name, TextView row) {
        if (InputKeyService.instance == null) {
            chooseApp(name);
            return;
        }
        row.setText("לחץ עכשיו על " + Helper.buttonTitle(name) + " בשלט…");
        InputKeyService.learner = event -> runOnUiThread(() -> {
            Helper.learnButton(this, name, event.getKeyCode(), event.getScanCode());
            chooseApp(name);
        });
    }

    private void chooseApp(String name) {
        List<String> labels = new ArrayList<>();
        List<String> pkgs = new ArrayList<>();
        labels.add("assistant".equals(name) ? "HELPER (ברירת מחדל)" : "ברירת מחדל");
        pkgs.add("");
        try {
            JSONArray apps = HelperLink.apps(this);
            for (int i = 0; i < apps.length(); i++) {
                JSONObject a = apps.getJSONObject(i);
                labels.add(a.getString("label"));
                pkgs.add(a.getString("pkg"));
            }
        } catch (Exception ignored) { }
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
                .setTitle(Helper.buttonTitle(name) + " יפתח את…")
                .setItems(labels.toArray(new String[0]), (dialog, which) -> {
                    Helper.setButtonApp(this, name, pkgs.get(which));
                    build();
                })
                .setOnCancelListener(dialog -> build())
                .show();
    }
}
