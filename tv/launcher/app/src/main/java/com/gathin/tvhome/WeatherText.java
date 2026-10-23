package com.gathin.tvhome;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;
import java.util.Scanner;

/**
 * NOW design: an outline weather icon and "26°C" beside the clock. Open-Meteo (no key), every 30 minutes while
 * Home is on screen, for the latitude and longitude in config.xml or a theme. No place name. Hidden until the first
 * answer, and when no location is set.
 */
final class WeatherText {

    private static final long EVERY_MS = 30 * 60 * 1000L;
    private final TextView view;
    private final String lat, lon;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable refresh = this::refresh;
    private long last;

    WeatherText(TextView view, String lat, String lon) {
        this.view = view;
        this.lat = lat == null ? "" : lat.trim();
        this.lon = lon == null ? "" : lon.trim();
        view.setVisibility(TextView.GONE);
    }

    void onResume() {
        if (lat.isEmpty() || lon.isEmpty()) return;
        main.removeCallbacks(refresh);
        long since = System.currentTimeMillis() - last;
        main.postDelayed(refresh, last == 0 || since >= EVERY_MS ? 0 : EVERY_MS - since);
    }

    void onPause() { main.removeCallbacks(refresh); }

    private void refresh() {
        new Thread(() -> {
            long next = EVERY_MS;
            try {
                URL url = new URL("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon
                        + "&current=temperature_2m,weather_code,is_day");
                HttpURLConnection c = (HttpURLConnection) url.openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                String body;
                try (InputStream in = c.getInputStream(); Scanner s = new Scanner(in, "UTF-8").useDelimiter("\\A")) {
                    body = s.hasNext() ? s.next() : "";
                }
                JSONObject cur = new JSONObject(body).getJSONObject("current");
                int temp = (int) Math.round(cur.getDouble("temperature_2m"));
                int code = cur.getInt("weather_code");
                boolean day = cur.optInt("is_day", 1) == 1;
                last = System.currentTimeMillis();
                main.post(() -> show(temp, code, day));
            } catch (Exception ignored) {
                next = 5 * 60 * 1000L;   // try again in 5 minutes
            }
            long wait = next;
            main.post(() -> {
                main.removeCallbacks(refresh);
                main.postDelayed(refresh, wait);
            });
        }, "weather").start();
    }

    private void show(int temp, int code, boolean day) {
        Context ctx = view.getContext();
        int icon = code >= 95 ? R.drawable.ic_wx_storm
                : (code >= 71 && code <= 77) || code == 85 || code == 86 ? R.drawable.ic_wx_snow
                : code >= 51 ? R.drawable.ic_wx_rain
                : code == 45 || code == 48 ? R.drawable.ic_wx_fog
                : code >= 2 ? R.drawable.ic_wx_cloud
                : code == 1 ? R.drawable.ic_wx_partly
                : day ? R.drawable.ic_wx_sun : R.drawable.ic_wx_moon;
        Drawable d = ctx.getDrawable(icon);
        int size = Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 25, ctx.getResources().getDisplayMetrics()));
        if (d != null) d.setBounds(0, 0, size, size);
        view.setCompoundDrawablesRelative(d, null, null, null);
        view.setText(String.format(Locale.ROOT, "%d°C", temp));
        view.setVisibility(TextView.VISIBLE);
    }
}
