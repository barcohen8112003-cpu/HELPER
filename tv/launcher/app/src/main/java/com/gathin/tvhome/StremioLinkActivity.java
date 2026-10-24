package com.gathin.tvhome;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Links the owner's Stremio account with Stremio's phone link: a QR code and a short code for link.stremio.com.
 * Approved on a phone where Stremio is signed in, the TV gets the account's key; no password is typed here.
 * The code is checked every 3 seconds while this screen is open.
 */
public class StremioLinkActivity extends Activity {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private String code;
    private TextView codeView, status;
    private ImageView qr;
    private boolean done;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        FrameLayout root = new FrameLayout(this);
        root.setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[]{0xFF2A1B4E, 0xFF0B0A14}));
        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(col, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));
        setContentView(root);

        col.addView(text("‏חיבור Stremio", 32, 0xFFFFFFFF, R.font.outfit_light));
        TextView how = text("‏סרקו את הקוד בטלפון שמחובר ל-Stremio ואשרו,\n‏או היכנסו ל-link.stremio.com והקלידו:", 17, 0xCCFFFFFF, R.font.outfit_light);
        how.setPadding(0, AppCards.px(this, 10), 0, AppCards.px(this, 18));
        col.addView(how);

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        qr = new ImageView(this);
        GradientDrawable white = new GradientDrawable();
        white.setColor(0xFFFFFFFF);
        white.setCornerRadius(AppCards.px(this, 12));
        qr.setBackground(white);
        int pad = AppCards.px(this, 10);
        qr.setPadding(pad, pad, pad, pad);
        qr.setScaleType(ImageView.ScaleType.FIT_CENTER);
        int s = AppCards.px(this, 190);
        row.addView(qr, new LinearLayout.LayoutParams(s, s));
        codeView = text("…", 64, 0xFFFFFFFF, R.font.outfit_medium);
        codeView.setLetterSpacing(0.25f);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cp.leftMargin = AppCards.px(this, 40);
        row.addView(codeView, cp);
        col.addView(row);

        status = text("‏מחכה לאישור מהטלפון…", 16, 0x99FFFFFF, R.font.outfit_light);
        status.setPadding(0, AppCards.px(this, 22), 0, 0);
        col.addView(status);
        start();
    }

    private void start() {
        Stremio.newCode(res -> {
            if (isFinishing()) return;
            if (res == null) {
                status.setText("‏אין חיבור ל-Stremio כרגע. מנסה שוב…");
                handler.postDelayed(this::start, 5000);
                return;
            }
            code = res[0];
            codeView.setText(code);
            Titles.image(qr, res[1], 400, bmp -> {
                // The QR is a tiny image: scale it up with hard pixel edges, not blurred.
                BitmapDrawable d = new BitmapDrawable(getResources(), bmp);
                d.setFilterBitmap(false);
                qr.setImageDrawable(d);
            });
            handler.postDelayed(this::check, 3000);
        });
    }

    private void check() {
        if (done || isFinishing() || code == null) return;
        Stremio.checkCode(this, code, ok -> {
            if (ok) {
                done = true;
                status.setText("‏מחובר ✓");
                status.setTextColor(0xFF8BE28B);
                handler.postDelayed(this::finish, 1200);
            } else {
                handler.postDelayed(this::check, 3000);
            }
        });
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private TextView text(String s, int sp, int color, int font) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTypeface(getResources().getFont(font));
        t.setGravity(Gravity.CENTER);
        return t;
    }
}
