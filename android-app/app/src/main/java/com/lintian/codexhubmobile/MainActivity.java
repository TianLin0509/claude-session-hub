package com.lintian.codexhubmobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.Html;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.InputType;
import android.text.style.BackgroundColorSpan;
import android.text.style.StyleSpan;
import android.text.style.TypefaceSpan;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import androidx.core.content.FileProvider;

public class MainActivity extends Activity {
    private static final String PREFS = "codex_hub_mobile";
    private static final String KEY_BASE_URL = "base_url";
    private static final String KEY_TOKEN = "token";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_SESSION_ID = "session_id";
    private static final int MAX_MOBILE_SESSION_CHIPS = 12;
    private static final String DEFAULT_URL = "http://138.128.192.245:18080";
    private static final String TEST_URL = "http://138.128.192.245:18082";
    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private final OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(10, TimeUnit.SECONDS)
            .build();
    private SharedPreferences prefs;
    private EditText urlInput;
    private EditText promptInput;
    private TextView statusText;
    private TextView badgeText;
    private LinearLayout messageList;
    private ScrollView outputScroll;
    private View typingRow;
    private LinearLayout connectionPanel;
    private LinearLayout sessionStrip;
    private TextView navTerminal;
    private TextView navNew;
    private TextView navSessions;
    private TextView navSettings;
    private WebSocket socket;
    private String activeSessionId;
    private boolean autoCreateAfterPair;
    private String pendingAutoPrompt;
    private String pairingTokenInFlight;
    private String pairedToken;
    private final ArrayDeque<String> recentOutputLines = new ArrayDeque<>();
    private final HashSet<String> recentOutputSet = new HashSet<>();
    private boolean sessionCreateInFlight;
    private String lastPromptNormalized;
    private long codexReadyAfterMs;
    private boolean mcpWarningShown;
    private boolean workingShown;
    private boolean waitingForAnswer;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        ensureDeviceId();
        activeSessionId = prefs.getString(KEY_SESSION_ID, "");
        buildUi();
        setStatus("\u7b49\u5f85\u8fde\u63a5", false);
        handleLaunchIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleLaunchIntent(intent);
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(color(0xF4F7FA));

        root.addView(buildTopBar());
        connectionPanel = buildConnectionPanel();
        root.addView(connectionPanel);
        root.addView(buildSessionStrip(), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(76)));
        root.addView(buildTerminal(), new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(buildComposer());
        root.addView(buildDock());

        if (!prefs.getString(KEY_TOKEN, "").isEmpty()) {
            connectionPanel.setVisibility(View.GONE);
        }
        setContentView(root);
    }

    private View buildTopBar() {
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setPadding(dp(16), dp(12), dp(16), dp(10));
        top.setBackgroundColor(Color.WHITE);

        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);

        TextView title = new TextView(this);
        title.setText("Codex Hub");
        title.setTextColor(color(0x102A43));
        title.setTextSize(22);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);

        statusText = new TextView(this);
        statusText.setTextColor(color(0x627D98));
        statusText.setTextSize(12);
        statusText.setPadding(0, dp(3), 0, 0);

        titles.addView(title);
        titles.addView(statusText);

        badgeText = chip("VPS", color(0xECFDF5), color(0x047857));
        badgeText.setOnClickListener(v -> toggleConnectionPanel());

        top.addView(titles, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        top.addView(badgeText, new LinearLayout.LayoutParams(dp(78), dp(34)));
        return top;
    }

    private LinearLayout buildConnectionPanel() {
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(14), dp(10), dp(14), dp(12));
        panel.setBackgroundColor(color(0xF7FAFC));

        urlInput = new EditText(this);
        urlInput.setSingleLine(true);
        urlInput.setSelectAllOnFocus(true);
        urlInput.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setText(prefs.getString(KEY_BASE_URL, DEFAULT_URL));
        urlInput.setTextColor(color(0x102A43));
        urlInput.setHintTextColor(color(0x9FB3C8));
        urlInput.setTextSize(14);
        urlInput.setHint("Hub \u5730\u5740");
        urlInput.setBackground(rounded(color(0xFFFFFF), color(0xD9E2EC), 8));
        urlInput.setPadding(dp(12), 0, dp(12), 0);
        panel.addView(urlInput, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(44)));

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setPadding(0, dp(8), 0, 0);
        actions.addView(actionButton("\u8fde\u63a5", v -> connect()), weightButton());
        actions.addView(actionButton("\u6d4b\u8bd5", v -> {
            urlInput.setText(TEST_URL);
            connect();
        }), weightButton());
        actions.addView(actionButton("\u7c98\u8d34\u914d\u5bf9", v -> pairFromClipboard()), weightButton());
        panel.addView(actions);

        LinearLayout releaseRow = new LinearLayout(this);
        releaseRow.setOrientation(LinearLayout.HORIZONTAL);
        releaseRow.setGravity(Gravity.CENTER_VERTICAL);
        releaseRow.setPadding(dp(4), dp(10), dp(4), 0);

        TextView version = new TextView(this);
        version.setText("\u7248\u672c " + BuildConfig.VERSION_NAME + " (" + BuildConfig.VERSION_CODE + ")");
        version.setTextColor(color(0x627D98));
        version.setTextSize(12);
        releaseRow.addView(version, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));

        Button update = actionButton("\u68c0\u67e5\u66f4\u65b0", v -> checkForUpdate());
        releaseRow.addView(update, new LinearLayout.LayoutParams(dp(118), dp(38)));
        panel.addView(releaseRow);
        return panel;
    }

    private View buildSessionStrip() {
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.setHorizontalScrollBarEnabled(false);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setPadding(0, 0, 0, 0);

        sessionStrip = new LinearLayout(this);
        sessionStrip.setOrientation(LinearLayout.HORIZONTAL);
        sessionStrip.setPadding(dp(12), dp(10), dp(12), dp(10));
        addEmptySessionChip();
        scroll.addView(sessionStrip);
        return scroll;
    }

    private View buildTerminal() {
        messageList = new LinearLayout(this);
        messageList.setOrientation(LinearLayout.VERTICAL);
        messageList.setPadding(dp(12), dp(12), dp(12), dp(12));
        addSystemBubble("\u8f93\u51fa\u4f1a\u663e\u793a\u5728\u8fd9\u91cc\u3002", false);

        outputScroll = new ScrollView(this);
        outputScroll.setBackgroundColor(color(0xEFF4F8));
        outputScroll.addView(messageList, new ScrollView.LayoutParams(
                ScrollView.LayoutParams.MATCH_PARENT,
                ScrollView.LayoutParams.WRAP_CONTENT));
        return outputScroll;
    }

    private View buildComposer() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(9), dp(12), dp(9));
        row.setBackgroundColor(Color.WHITE);

        Button command = smallIconButton(">_", v -> {
            promptInput.setText("/");
            promptInput.requestFocus();
            showKeyboard();
        });
        command.setContentDescription("command-shortcut");

        promptInput = new EditText(this);
        promptInput.setSingleLine(false);
        promptInput.setMinLines(1);
        promptInput.setMaxLines(3);
        promptInput.setTextSize(14);
        promptInput.setTextColor(color(0x102A43));
        promptInput.setHintTextColor(color(0x9FB3C8));
        promptInput.setHint("\u8f93\u5165\u7ed9 Codex \u7684\u6d88\u606f");
        promptInput.setContentDescription("codex-message-input");
        promptInput.setBackground(rounded(color(0xF0F4F8), color(0xE6EEF6), 8));
        promptInput.setPadding(dp(10), 0, dp(10), 0);

        Button send = actionButton("\u53d1\u9001", v -> sendPrompt());
        send.setContentDescription("send-message");

        LinearLayout.LayoutParams iconLp = new LinearLayout.LayoutParams(dp(44), dp(48));
        iconLp.setMargins(0, 0, dp(8), 0);
        LinearLayout.LayoutParams inputLp = new LinearLayout.LayoutParams(0, dp(48), 1);
        inputLp.setMargins(0, 0, dp(8), 0);

        row.addView(command, iconLp);
        row.addView(promptInput, inputLp);
        row.addView(send, new LinearLayout.LayoutParams(dp(72), dp(48)));
        return row;
    }

    private View buildDock() {
        LinearLayout dock = new LinearLayout(this);
        dock.setOrientation(LinearLayout.HORIZONTAL);
        dock.setGravity(Gravity.CENTER);
        dock.setPadding(0, dp(3), 0, dp(3));
        dock.setBackgroundColor(Color.WHITE);

        navTerminal = navItem(">\n\u7ec8\u7aef", true, v -> showTerminalTab());
        navNew = navItem("+\n\u65b0\u5efa", false, v -> createCodexSession());
        navSessions = navItem("=\n\u4f1a\u8bdd", false, v -> listSessions());
        navSettings = navItem("*\n\u8bbe\u7f6e", false, v -> toggleConnectionPanel());
        navTerminal.setContentDescription("nav-terminal");
        navNew.setContentDescription("nav-new-session");
        navSessions.setContentDescription("nav-sessions");
        navSettings.setContentDescription("nav-settings");

        dock.addView(navTerminal, new LinearLayout.LayoutParams(0, dp(58), 1));
        dock.addView(navNew, new LinearLayout.LayoutParams(0, dp(58), 1));
        dock.addView(navSessions, new LinearLayout.LayoutParams(0, dp(58), 1));
        dock.addView(navSettings, new LinearLayout.LayoutParams(0, dp(58), 1));
        return dock;
    }

    private Button actionButton(String text, View.OnClickListener listener) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        b.setTextSize(13);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setTextColor(Color.WHITE);
        b.setBackground(rounded(color(0x0D9488), 0, 8));
        b.setOnClickListener(listener);
        return b;
    }

    private Button smallIconButton(String text, View.OnClickListener listener) {
        Button b = actionButton(text, listener);
        b.setTextSize(12);
        b.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        b.setTextColor(color(0x0D9488));
        b.setBackground(rounded(color(0xECFEFF), color(0x99F6E4), 8));
        return b;
    }

    private TextView navItem(String text, boolean active, View.OnClickListener listener) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setGravity(Gravity.CENTER);
        tv.setTextSize(11);
        tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        tv.setTextColor(active ? color(0x0D9488) : color(0x627D98));
        tv.setOnClickListener(listener);
        return tv;
    }

    private TextView chip(String text, int bg, int fg) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setGravity(Gravity.CENTER);
        tv.setTextSize(12);
        tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        tv.setTextColor(fg);
        tv.setBackground(rounded(bg, 0, 999));
        return tv;
    }

    private TextView sessionChip(String title, String meta, boolean active) {
        TextView chip = new TextView(this);
        chip.setText(title + "\n" + meta);
        chip.setTextSize(12);
        chip.setTextColor(active ? color(0x134E4A) : color(0x334E68));
        chip.setGravity(Gravity.CENTER_VERTICAL);
        chip.setPadding(dp(10), 0, dp(10), 0);
        chip.setMinWidth(dp(128));
        chip.setBackground(rounded(active ? color(0xF0FDFA) : color(0xFFFFFF),
                active ? color(0x2DD4BF) : color(0xD9E2EC), 8));
        return chip;
    }

    private void addEmptySessionChip() {
        sessionStrip.removeAllViews();
        TextView empty = sessionChip("\u6682\u65e0\u4f1a\u8bdd", "\u70b9\u51fb\u65b0\u5efa\u5f00\u59cb", true);
        empty.setContentDescription("empty-session-create");
        empty.setOnClickListener(v -> createCodexSession());
        sessionStrip.addView(empty, chipLp());
    }

    private LinearLayout.LayoutParams chipLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(58));
        lp.setMargins(0, 0, dp(8), 0);
        return lp;
    }

    private LinearLayout.LayoutParams weightButton() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, dp(40), 1);
        lp.setMargins(dp(4), 0, dp(4), 0);
        return lp;
    }

    private GradientDrawable rounded(int fill, int stroke, int radiusDp) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(fill);
        gd.setCornerRadius(dp(radiusDp));
        if (stroke != 0) gd.setStroke(dp(1), stroke);
        return gd;
    }

    private void toggleConnectionPanel() {
        if (connectionPanel == null) return;
        connectionPanel.setVisibility(connectionPanel.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
        setDockActive(navSettings);
    }

    private void showTerminalTab() {
        if (connectionPanel != null) connectionPanel.setVisibility(View.GONE);
        setDockActive(navTerminal);
        outputScroll.post(() -> outputScroll.fullScroll(View.FOCUS_DOWN));
    }

    private void setDockActive(TextView active) {
        TextView[] items = { navTerminal, navNew, navSessions, navSettings };
        for (TextView item : items) {
            if (item == null) continue;
            item.setTextColor(item == active ? color(0x0D9488) : color(0x627D98));
        }
    }

    private void connect() {
        hideKeyboard();
        String baseUrl = normalizeBaseUrl(urlInput.getText().toString());
        prefs.edit().putString(KEY_BASE_URL, baseUrl).apply();
        urlInput.setText(baseUrl);
        setStatus("\u6b63\u5728\u8fde\u63a5 " + baseUrl, true);
        authedGet("/api/ping", new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                setStatus("\u5df2\u8fde\u63a5", true);
                listSessions();
            }

            @Override
            public void fail(String message) {
                setStatus("\u672a\u914d\u5bf9\u6216\u8fde\u63a5\u5931\u8d25", false);
            }
        });
    }

    private void pairFromClipboard() {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        ClipData data = cm == null ? null : cm.getPrimaryClip();
        if (data == null || data.getItemCount() == 0) {
            setStatus("\u526a\u8d34\u677f\u6ca1\u6709\u914d\u5bf9\u94fe\u63a5", false);
            return;
        }
        CharSequence text = data.getItemAt(0).coerceToText(this);
        pairFromUrl(text == null ? "" : text.toString());
    }

    private void handleLaunchIntent(Intent intent) {
        if (intent == null) return;
        boolean autoFlag = false;
        Bundle extras = intent.getExtras();
        Object autoValue = extras == null ? null : extras.get("autoCreate");
        if (autoValue instanceof Boolean) {
            autoFlag = (Boolean) autoValue;
        } else if (autoValue instanceof String) {
            autoFlag = "true".equalsIgnoreCase((String) autoValue);
        }
        autoCreateAfterPair = autoFlag;
        pendingAutoPrompt = intent.getStringExtra("prompt");
        String pairUrl = intent.getStringExtra("pairUrl");
        if (pairUrl != null && !pairUrl.trim().isEmpty()) {
            pairFromUrl(pairUrl);
            return;
        }
        connect();
    }

    private void pairFromUrl(String raw) {
        try {
            Uri uri = Uri.parse(raw.trim());
            String token = uri.getQueryParameter("token");
            if (token == null || token.isEmpty()) {
                setStatus("\u914d\u5bf9\u94fe\u63a5\u7f3a\u5c11 token", false);
                return;
            }
            if (token.equals(pairingTokenInFlight) || token.equals(pairedToken)) {
                return;
            }
            List<String> baseUrls = pairBaseUrls(uri);
            if (baseUrls.isEmpty()) {
                setStatus("\u914d\u5bf9\u94fe\u63a5\u7f3a\u5c11\u53ef\u7528\u5730\u5740", false);
                return;
            }
            pairingTokenInFlight = token;
            pairWithCandidate(token, baseUrls, 0, new ArrayList<>());
        } catch (Exception e) {
            setStatus("\u914d\u5bf9\u94fe\u63a5\u683c\u5f0f\u4e0d\u6b63\u786e", false);
        }
    }

    private List<String> pairBaseUrls(Uri uri) throws Exception {
        LinkedHashSet<String> urls = new LinkedHashSet<>();
        addNormalizedUrl(urls, uri.getScheme() + "://" + uri.getAuthority());
        String encoded = uri.getQueryParameter("addresses");
        if (encoded != null && !encoded.trim().isEmpty()) {
            String padded = encoded;
            int remainder = padded.length() % 4;
            if (remainder != 0) padded += "====".substring(remainder);
            byte[] decoded = Base64.decode(padded, Base64.URL_SAFE | Base64.NO_WRAP);
            JSONArray addresses = new JSONArray(new String(decoded, StandardCharsets.UTF_8));
            for (int i = 0; i < addresses.length(); i++) {
                addNormalizedUrl(urls, addresses.optString(i, ""));
            }
        }
        return new ArrayList<>(urls);
    }

    private void addNormalizedUrl(LinkedHashSet<String> urls, String raw) {
        String normalized = normalizePairBaseUrl(raw);
        if (normalized != null) urls.add(normalized);
    }

    private String normalizePairBaseUrl(String raw) {
        if (raw == null) return null;
        String value = raw.trim();
        if (value.isEmpty() || "null".equals(value)) return null;
        if (!value.startsWith("http://") && !value.startsWith("https://")) {
            value = "http://" + value;
        }
        Uri parsed = Uri.parse(value);
        if (parsed.getScheme() == null || parsed.getAuthority() == null) return null;
        return parsed.getScheme() + "://" + parsed.getAuthority();
    }

    private void pairWithCandidate(String token, List<String> baseUrls, int index, List<String> failures) {
        String baseUrl = baseUrls.get(index);
        setStatus("\u6b63\u5728\u914d\u5bf9 " + baseUrl, true);
        urlInput.setText(baseUrl);
        JSONObject body = new JSONObject();
        try {
            body.put("token", token)
                    .put("deviceId", ensureDeviceId())
                    .put("name", "Android Codex Hub");
        } catch (Exception ignored) {}
        post(baseUrl + "/api/devices/register", body, null, new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                if (!token.equals(pairingTokenInFlight)) return;
                pairedToken = token;
                pairingTokenInFlight = null;
                prefs.edit().putString(KEY_BASE_URL, baseUrl).putString(KEY_TOKEN, token).apply();
                setStatus("\u914d\u5bf9\u6210\u529f", true);
                connectionPanel.setVisibility(View.GONE);
                connect();
                if (autoCreateAfterPair) {
                    new Handler(Looper.getMainLooper()).postDelayed(
                            MainActivity.this::createCodexSession,
                            1500
                    );
                }
            }

            @Override
            public void fail(String message) {
                if (!token.equals(pairingTokenInFlight) || token.equals(pairedToken)) return;
                if (isTokenAlreadyRegistered(message)) {
                    tryResumeExistingPair(token, baseUrl);
                    return;
                }
                failures.add(baseUrl + " " + shortFailure(message));
                int next = index + 1;
                if (next < baseUrls.size()) {
                    pairWithCandidate(token, baseUrls, next, failures);
                } else {
                    pairingTokenInFlight = null;
                    setStatus("\u914d\u5bf9\u5931\u8d25 " + summarizeFailures(failures), false);
                }
            }
        });
    }

    private boolean isTokenAlreadyRegistered(String message) {
        return message != null && message.contains("token-not-pending");
    }

    private void tryResumeExistingPair(String token, String baseUrl) {
        prefs.edit().putString(KEY_BASE_URL, baseUrl).putString(KEY_TOKEN, token).apply();
        authedGet("/api/ping", new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                if (!token.equals(pairingTokenInFlight)) return;
                pairedToken = token;
                pairingTokenInFlight = null;
                setStatus("\u5df2\u6062\u590d\u914d\u5bf9", true);
                connectionPanel.setVisibility(View.GONE);
                listSessions();
                if (autoCreateAfterPair) {
                    new Handler(Looper.getMainLooper()).postDelayed(
                            MainActivity.this::createCodexSession,
                            1500
                    );
                }
            }

            @Override
            public void fail(String message) {
                if (!token.equals(pairingTokenInFlight)) return;
                pairingTokenInFlight = null;
                if (message != null && message.contains("bad-auth")) {
                    setStatus("\u914d\u5bf9\u94fe\u63a5\u5df2\u4f7f\u7528\uff0c\u8bf7\u5728\u7535\u8111\u7aef\u91cd\u65b0\u751f\u6210", false);
                } else {
                    setStatus("\u914d\u5bf9\u5931\u8d25 " + shortFailure(message), false);
                }
            }
        });
    }

    private String shortFailure(String message) {
        if (message == null || message.trim().isEmpty()) return "failed";
        String oneLine = message.replace('\n', ' ').trim();
        return oneLine.length() > 42 ? oneLine.substring(0, 42) + "..." : oneLine;
    }

    private String summarizeFailures(List<String> failures) {
        if (failures.isEmpty()) return "";
        String last = failures.get(failures.size() - 1);
        return last.length() > 64 ? last.substring(0, 64) + "..." : last;
    }

    private void listSessions() {
        setDockActive(navSessions);
        authedGet("/api/sessions", new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                JSONArray sessions = obj.optJSONArray("sessions");
                if (sessions == null || sessions.length() == 0) {
                    runOnUiThread(MainActivity.this::addEmptySessionChip);
                    return;
                }
                runOnUiThread(() -> renderSessions(sessions));
            }

            @Override
            public void fail(String message) {
                setStatus("\u5237\u65b0\u5931\u8d25", false);
            }
        });
    }

    private void renderSessions(JSONArray sessions) {
        sessionStrip.removeAllViews();
        int limit = Math.min(sessions.length(), MAX_MOBILE_SESSION_CHIPS);
        for (int i = 0; i < limit; i++) {
            JSONObject s = sessions.optJSONObject(i);
            if (s == null) continue;
            String id = s.optString("id", "");
            if (i == 0 && (activeSessionId == null || activeSessionId.isEmpty())) {
                activeSessionId = id;
                prefs.edit().putString(KEY_SESSION_ID, activeSessionId).apply();
                openSocket();
            }
            boolean active = id.equals(activeSessionId);
            String title = s.optString("title", "Codex");
            String model = s.optString("model", "codex");
            TextView chip = sessionChip(title, model, active);
            chip.setOnClickListener(v -> {
                activeSessionId = id;
                codexReadyAfterMs = 0;
                prefs.edit().putString(KEY_SESSION_ID, activeSessionId).apply();
                resetTerminalOutput();
                renderSessions(sessions);
                openSocket();
                showTerminalTab();
            });
            sessionStrip.addView(chip, chipLp());
        }
        if (sessionStrip.getChildCount() == 0) addEmptySessionChip();
    }

    private void createCodexSession() {
        if (sessionCreateInFlight) {
            setStatus("\u6b63\u5728\u521b\u5efa Codex", true);
            return;
        }
        sessionCreateInFlight = true;
        hideKeyboard();
        if (connectionPanel != null) connectionPanel.setVisibility(View.GONE);
        setDockActive(navNew);
        setStatus("\u6b63\u5728\u521b\u5efa Codex", true);
        JSONObject body = new JSONObject();
        try {
            body.put("kind", "codex");
            body.put("title", "\u624b\u673a Codex");
        } catch (Exception ignored) {}
        authedPost("/api/sessions", body, new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                sessionCreateInFlight = false;
                JSONObject s = obj.optJSONObject("session");
                activeSessionId = s == null ? "" : s.optString("id", "");
                codexReadyAfterMs = System.currentTimeMillis() + 10000;
                prefs.edit().putString(KEY_SESSION_ID, activeSessionId).apply();
                setStatus("Codex \u542f\u52a8\u4e2d", true);
                resetTerminalOutput();
                appendOutput("\n\u5df2\u521b\u5efa\u624b\u673a Codex \u4f1a\u8bdd\n");
                listSessions();
                openSocket();
                showTerminalTab();
                if (pendingAutoPrompt != null && !pendingAutoPrompt.trim().isEmpty()) {
                    String prompt = pendingAutoPrompt;
                    pendingAutoPrompt = null;
                    new Handler(Looper.getMainLooper()).postDelayed(
                            () -> sendPromptText(prompt),
                            3000
                    );
                }
            }

            @Override
            public void fail(String message) {
                sessionCreateInFlight = false;
                setStatus("\u521b\u5efa\u5931\u8d25", false);
            }
        });
    }

    private void openSocket() {
        closeSocket();
        if (activeSessionId == null || activeSessionId.isEmpty()) return;
        String token = prefs.getString(KEY_TOKEN, "");
        String deviceId = ensureDeviceId();
        String wsBase = toWsUrl(prefs.getString(KEY_BASE_URL, DEFAULT_URL));
        String url = wsBase + "/ws?token=" + Uri.encode(token) + "&deviceId=" + Uri.encode(deviceId);
        socket = client.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                JSONObject msg = new JSONObject();
                try {
                    msg.put("type", "subscribe");
                    msg.put("sessionId", activeSessionId);
                    sendSocket(msg);
                } catch (Exception e) {
                    setStatus("\u8ba2\u9605\u5931\u8d25", false);
                }
                setStatus("\u7ec8\u7aef\u5df2\u8fde\u63a5", true);
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                try {
                    JSONObject msg = new JSONObject(text);
                    if ("output".equals(msg.optString("type")) && activeSessionId.equals(msg.optString("sessionId"))) {
                        if (msg.optBoolean("mobileTranscript", false)) {
                            appendTranscriptAnswer(msg.optString("data", ""));
                        } else {
                            appendOutput(renderCleanMobileOutput(msg.optString("data", "")));
                        }
                    }
                } catch (Exception ignored) {}
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                setStatus("\u7ec8\u7aef\u8fde\u63a5\u5931\u8d25", false);
            }
        });
    }

    private void sendPrompt() {
        String text = promptInput.getText().toString();
        if (text.trim().isEmpty()) return;
        if (sendPromptText(text)) {
            promptInput.setText("");
            hideKeyboard();
        }
    }

    private boolean sendPromptText(String text) {
        if (activeSessionId == null || activeSessionId.isEmpty()) {
            setStatus("\u8bf7\u5148\u521b\u5efa\u6216\u9009\u62e9 Codex session", false);
            return false;
        }
        long readyDelay = codexReadyAfterMs - System.currentTimeMillis();
        if (readyDelay > 0) {
            setStatus("Codex \u542f\u52a8\u4e2d\uff0c\u7a0d\u540e\u53d1\u9001", true);
            new Handler(Looper.getMainLooper()).postDelayed(() -> sendPromptText(text), readyDelay);
            return true;
        }
        if (socket == null) openSocket();
        JSONObject msg = new JSONObject();
        try {
            msg.put("type", "input");
            msg.put("sessionId", activeSessionId);
            msg.put("data", text);
            appendUserPrompt(text);
            sendSocket(msg);
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                JSONObject enter = new JSONObject();
                try {
                    enter.put("type", "input");
                    enter.put("sessionId", activeSessionId);
                    enter.put("data", "\r");
                    sendSocket(enter);
                } catch (Exception e) {
                    setStatus("\u53d1\u9001\u56de\u8f66\u5931\u8d25", false);
                }
            }, 1000);
        } catch (Exception e) {
            setStatus("\u53d1\u9001\u5931\u8d25", false);
            return false;
        }
        return true;
    }

    private void sendSocket(JSONObject obj) {
        try {
            if (socket != null) socket.send(obj.toString());
        } catch (Exception e) {
            setStatus("\u53d1\u9001\u5931\u8d25", false);
        }
    }

    private void authedGet(String path, JsonHandler handler) {
        String baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_URL);
        Request request = new Request.Builder()
                .url(baseUrl + path)
                .addHeader("x-mobile-token", prefs.getString(KEY_TOKEN, ""))
                .addHeader("x-mobile-device-id", ensureDeviceId())
                .build();
        enqueue(request, handler);
    }

    private void checkForUpdate() {
        hideKeyboard();
        setStatus("\u6b63\u5728\u68c0\u67e5\u66f4\u65b0", true);
        authedGet("/mobile/update.json", new JsonHandler() {
            @Override
            public void ok(JSONObject obj) {
                int remoteCode = obj.optInt("versionCode", 0);
                String remoteName = obj.optString("versionName", "");
                String apkUrl = obj.optString("apkUrl", "");
                if (remoteCode <= BuildConfig.VERSION_CODE || apkUrl.isEmpty()) {
                    setStatus("\u5df2\u662f\u6700\u65b0\u7248\u672c", true);
                    addSystemBubble("\u5f53\u524d\u5df2\u662f\u6700\u65b0\u7248\u672c " + BuildConfig.VERSION_NAME, false);
                    return;
                }
                addSystemBubble("\u53d1\u73b0\u65b0\u7248\u672c " + remoteName + "\uff0c\u5f00\u59cb\u4e0b\u8f7d\u3002", false);
                downloadAndInstallUpdate(apkUrl, remoteName);
            }

            @Override
            public void fail(String message) {
                setStatus("\u68c0\u67e5\u66f4\u65b0\u5931\u8d25", false);
                addSystemBubble("\u68c0\u67e5\u66f4\u65b0\u5931\u8d25\uff1a" + message, true);
            }
        });
    }

    private void downloadAndInstallUpdate(String apkUrl, String versionName) {
        setStatus("\u6b63\u5728\u4e0b\u8f7d\u66f4\u65b0", true);
        Request request = new Request.Builder()
                .url(apkUrl)
                .addHeader("x-mobile-token", prefs.getString(KEY_TOKEN, ""))
                .addHeader("x-mobile-device-id", ensureDeviceId())
                .build();
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                runOnUiThread(() -> {
                    setStatus("\u4e0b\u8f7d\u5931\u8d25", false);
                    addSystemBubble("\u4e0b\u8f7d\u66f4\u65b0\u5931\u8d25\uff1a" + e.getMessage(), true);
                });
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                if (!response.isSuccessful() || response.body() == null) {
                    String message = response.code() + " " + response.message();
                    runOnUiThread(() -> {
                        setStatus("\u4e0b\u8f7d\u5931\u8d25", false);
                        addSystemBubble("\u4e0b\u8f7d\u66f4\u65b0\u5931\u8d25\uff1a" + message, true);
                    });
                    return;
                }
                File baseDir = getExternalFilesDir(null);
                File dir = baseDir == null ? new File(getCacheDir(), "updates") : new File(baseDir, "updates");
                if (!dir.exists() && !dir.mkdirs()) dir = new File(getCacheDir(), "updates");
                if (!dir.exists()) dir.mkdirs();
                File apkFile = new File(dir, "codex-hub-mobile-" + versionName + ".apk");
                try (InputStream input = response.body().byteStream();
                     FileOutputStream output = new FileOutputStream(apkFile)) {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
                }
                runOnUiThread(() -> {
                    setStatus("\u66f4\u65b0\u5df2\u4e0b\u8f7d", true);
                    installApk(apkFile);
                });
            }
        });
    }

    private void installApk(File apkFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            addSystemBubble("\u9700\u8981\u5141\u8bb8 Codex Hub \u5b89\u88c5\u672a\u77e5\u5e94\u7528\uff0c\u6388\u6743\u540e\u518d\u70b9\u68c0\u67e5\u66f4\u65b0\u3002", true);
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            return;
        }
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (Exception e) {
            addSystemBubble("\u65e0\u6cd5\u6253\u5f00\u5b89\u88c5\u5668\uff1a" + e.getMessage(), true);
        }
    }

    private void authedPost(String path, JSONObject body, JsonHandler handler) {
        String baseUrl = prefs.getString(KEY_BASE_URL, DEFAULT_URL);
        post(baseUrl + path, body, new String[][]{
                {"x-mobile-token", prefs.getString(KEY_TOKEN, "")},
                {"x-mobile-device-id", ensureDeviceId()}
        }, handler);
    }

    private void post(String url, JSONObject body, String[][] headers, JsonHandler handler) {
        Request.Builder builder = new Request.Builder()
                .url(url)
                .post(RequestBody.create(body.toString(), JSON));
        if (headers != null) {
            for (String[] h : headers) builder.addHeader(h[0], h[1]);
        }
        enqueue(builder.build(), handler);
    }

    private void enqueue(Request request, JsonHandler handler) {
        client.newCall(request).enqueue(new Callback() {
            @Override
            public void onFailure(Call call, IOException e) {
                runOnUiThread(() -> handler.fail(e.getMessage()));
            }

            @Override
            public void onResponse(Call call, Response response) throws IOException {
                String body = response.body() == null ? "" : response.body().string();
                if (!response.isSuccessful()) {
                    String message = response.code() + " " + body;
                    runOnUiThread(() -> handler.fail(message));
                    return;
                }
                try {
                    JSONObject parsed = body.isEmpty() ? new JSONObject() : new JSONObject(body);
                    runOnUiThread(() -> handler.ok(parsed));
                } catch (Exception e) {
                    runOnUiThread(() -> handler.fail("not-json"));
                }
            }
        });
    }

    private String ensureDeviceId() {
        String id = prefs == null ? null : prefs.getString(KEY_DEVICE_ID, "");
        if (id != null && !id.isEmpty()) return id;
        id = "android-" + UUID.randomUUID();
        if (prefs != null) prefs.edit().putString(KEY_DEVICE_ID, id).apply();
        return id;
    }

    private String normalizeBaseUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.isEmpty()) url = DEFAULT_URL;
        if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://" + url;
        while (url.endsWith("/")) url = url.substring(0, url.length() - 1);
        return url;
    }

    private String toWsUrl(String baseUrl) {
        try {
            URI uri = URI.create(baseUrl);
            String scheme = "https".equalsIgnoreCase(uri.getScheme()) ? "wss" : "ws";
            return scheme + "://" + uri.getAuthority();
        } catch (Exception e) {
            return baseUrl.replaceFirst("^https://", "wss://").replaceFirst("^http://", "ws://");
        }
    }

    private void setStatus(String text, boolean ok) {
        runOnUiThread(() -> {
            statusText.setText(text);
            statusText.setTextColor(ok ? color(0x0D9488) : color(0x9B2C2C));
            if (badgeText != null) {
                badgeText.setText(ok ? activeRouteLabel() : "OFF");
                badgeText.setTextColor(ok ? color(0x047857) : color(0x9B2C2C));
                badgeText.setBackground(rounded(ok ? color(0xECFDF5) : color(0xFEF2F2), 0, 999));
            }
        });
    }

    private String activeRouteLabel() {
        String baseUrl = prefs == null ? "" : prefs.getString(KEY_BASE_URL, "");
        if (baseUrl.contains("138.128.192.245")) return "VPS";
        if (baseUrl.contains("10.0.2.2") || baseUrl.contains("127.0.0.1") || baseUrl.contains("192.168.")) return "LAN";
        return "ON";
    }

    private void appendOutput(String text) {
        if (text == null || text.isEmpty()) return;
        runOnUiThread(() -> {
            String[] lines = text.split("\\n");
            StringBuilder codexBlock = null;
            for (String rawLine : lines) {
                String line = rawLine == null ? "" : rawLine.trim();
                if (line.isEmpty()) continue;
                if (line.startsWith("Codex\uff1a")) {
                    if (codexBlock != null && codexBlock.length() > 0) {
                        appendRenderedLine("Codex\uff1a" + codexBlock);
                    }
                    codexBlock = new StringBuilder(line.substring(6).trim());
                    continue;
                }
                if (codexBlock != null) {
                    boolean controlLine = line.startsWith("\u4f60\uff1a")
                            || line.startsWith("\u26a0")
                            || line.contains("\u6b63\u5728\u5904\u7406");
                    if (!controlLine) {
                        codexBlock.append('\n').append(line);
                        continue;
                    }
                    appendRenderedLine("Codex\uff1a" + codexBlock);
                    codexBlock = null;
                }
                appendRenderedLine(line);
            }
            if (codexBlock != null && codexBlock.length() > 0) {
                appendRenderedLine("Codex\uff1a" + codexBlock);
            }
            outputScroll.post(() -> outputScroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    private void appendTranscriptAnswer(String text) {
        String clean = text == null ? "" : text.trim();
        if (clean.startsWith("Codex\uff1a")) clean = clean.substring(6).trim();
        if (clean.startsWith("Codex:")) clean = clean.substring(6).trim();
        if (clean.isEmpty()) return;
        String finalClean = clean;
        runOnUiThread(() -> {
            hideTypingBubble();
            addChatBubble("assistant", finalClean, false);
            outputScroll.post(() -> outputScroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    private void resetTerminalOutput() {
        recentOutputLines.clear();
        recentOutputSet.clear();
        mcpWarningShown = false;
        workingShown = false;
        waitingForAnswer = false;
        lastPromptNormalized = null;
        runOnUiThread(() -> {
            messageList.removeAllViews();
            typingRow = null;
            addSystemBubble("\u65b0\u5efa\u6216\u9009\u62e9\u4f1a\u8bdd\u540e\uff0cCodex \u7684\u56de\u7b54\u4f1a\u51fa\u73b0\u5728\u8fd9\u91cc\u3002", false);
        });
    }

    private void appendUserPrompt(String text) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) return;
        lastPromptNormalized = normalizePromptEcho(clean);
        waitingForAnswer = true;
        workingShown = true;
        runOnUiThread(() -> {
            addChatBubble("user", clean, false);
            showTypingBubble();
            outputScroll.post(() -> outputScroll.fullScroll(View.FOCUS_DOWN));
        });
    }

    private void appendRenderedLine(String line) {
        String candidate = line == null ? "" : line.trim();
        if (candidate.startsWith("Codex\uff1a")) {
            candidate = candidate.substring(6).trim();
        }
        if (candidate.startsWith(">")) return;
        if (lastPromptNormalized != null && lastPromptNormalized.equals(normalizePromptEcho(candidate))) return;
        if (candidate.toLowerCase().contains("run /review on my current changes")) return;
        if (line.startsWith("\u4f60\uff1a")) {
            addChatBubble("user", line.substring(2).trim(), false);
            return;
        }
        if (line.startsWith("Codex\uff1a")) {
            hideTypingBubble();
            addChatBubble("assistant", line.substring(6).trim(), false);
            return;
        }
        if (line.startsWith("\u26a0")) {
            addSystemBubble(line, true);
            return;
        }
        if (line.contains("\u6b63\u5728\u5904\u7406")) {
            showTypingBubble();
            return;
        }
        addSystemBubble(line, false);
    }

    private void showTypingBubble() {
        hideTypingBubble();
        typingRow = createChatRow("assistant", "Codex \u6b63\u5728\u5904\u7406...", true);
        messageList.addView(typingRow);
        trimMessageList();
    }

    private void hideTypingBubble() {
        if (typingRow != null) {
            messageList.removeView(typingRow);
            typingRow = null;
        }
    }

    private void addSystemBubble(String text, boolean warning) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) return;
        TextView bubble = new TextView(this);
        bubble.setText(clean);
        bubble.setTextSize(12);
        bubble.setTextColor(warning ? color(0x9B2C2C) : color(0x627D98));
        bubble.setGravity(Gravity.CENTER);
        bubble.setPadding(dp(10), dp(6), dp(10), dp(6));
        bubble.setBackground(rounded(warning ? color(0xFFF5F5) : color(0xE6EEF6), 0, 999));

        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER);
        row.setPadding(dp(12), dp(4), dp(12), dp(4));
        row.addView(bubble, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        messageList.addView(row);
        trimMessageList();
    }

    private void addChatBubble(String role, String text, boolean typing) {
        String clean = text == null ? "" : text.trim();
        if (clean.isEmpty()) return;
        if (!"user".equals(role) && !typing) {
            if (clean.startsWith(">") || clean.startsWith("\u203a")) return;
            if (clean.matches("(?i).*vers\\s+\\d+/\\d+\\):?")) return;
            if (lastPromptNormalized != null && lastPromptNormalized.equals(normalizePromptEcho(clean))) return;
        }
        messageList.addView(createChatRow(role, clean, typing));
        trimMessageList();
    }

    private View createChatRow(String role, String text, boolean typing) {
        boolean user = "user".equals(role);
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(user ? Gravity.RIGHT : Gravity.LEFT);
        row.setPadding(dp(8), dp(5), dp(8), dp(5));

        TextView avatar = avatar(user ? "\u6211" : "C",
                user ? color(0x0D9488) : color(0x102A43),
                Color.WHITE);

        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        bubble.setPadding(dp(12), dp(9), dp(12), dp(9));
        bubble.setBackground(rounded(
                user ? color(0xC6F6D5) : color(0xFFFFFF),
                typing ? color(0xD9E2EC) : 0,
                12));
        String descText = text.length() > 90 ? text.substring(0, 90) : text;
        bubble.setContentDescription((user ? "message-user-" : "message-codex-") + descText);

        TextView bubbleText = new TextView(this);
        bubbleText.setText(renderMarkdownText(text));
        bubbleText.setTextSize(14);
        bubbleText.setLineSpacing(dp(2), 1.0f);
        bubbleText.setTextColor(color(0x102A43));
        bubbleText.setMaxWidth((int) (getResources().getDisplayMetrics().widthPixels * 0.72f));
        bubbleText.setTextIsSelectable(!typing);
        bubble.addView(bubbleText, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));
        if (!user && !typing) {
            addRichPreviewControls(bubble, text);
        }

        LinearLayout.LayoutParams avatarLp = new LinearLayout.LayoutParams(dp(30), dp(30));
        LinearLayout.LayoutParams bubbleLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT);
        if (user) {
            bubbleLp.setMargins(0, 0, dp(8), 0);
            row.addView(bubble, bubbleLp);
            row.addView(avatar, avatarLp);
        } else {
            avatarLp.setMargins(0, 0, dp(8), 0);
            row.addView(avatar, avatarLp);
            row.addView(bubble, bubbleLp);
        }
        return row;
    }

    private CharSequence renderMarkdownText(String text) {
        String display = stripHtmlFence(text == null ? "" : text);
        display = display.replaceAll("(?m)^#{1,6}\\s+", "");
        display = display.replaceAll("(?m)^\\s*[-*]\\s+", "\u2022 ");
        display = display.replaceAll("!\\[([^\\]]*)\\]\\(([^)]+)\\)", "$1");
        SpannableStringBuilder sb = new SpannableStringBuilder(display);
        applyMarkdownSpan(sb, "\\*\\*([^*]+)\\*\\*", 1, new StyleSpan(Typeface.BOLD));
        applyMarkdownSpan(sb, "`([^`]+)`", 1, new TypefaceSpan("monospace"));
        applyCodeBackground(sb);
        applyHeadingStyle(sb);
        return sb;
    }

    private void applyMarkdownSpan(SpannableStringBuilder sb, String regex, int group, Object spanTemplate) {
        Pattern pattern = Pattern.compile(regex);
        Matcher matcher = pattern.matcher(sb.toString());
        while (matcher.find()) {
            int fullStart = matcher.start();
            int fullEnd = matcher.end();
            String inner = matcher.group(group);
            sb.replace(fullStart, fullEnd, inner);
            Object span = spanTemplate;
            if (spanTemplate instanceof StyleSpan) span = new StyleSpan(((StyleSpan) spanTemplate).getStyle());
            if (spanTemplate instanceof TypefaceSpan) span = new TypefaceSpan("monospace");
            sb.setSpan(span, fullStart, fullStart + inner.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            matcher = pattern.matcher(sb.toString());
        }
    }

    private void applyCodeBackground(SpannableStringBuilder sb) {
        TypefaceSpan[] spans = sb.getSpans(0, sb.length(), TypefaceSpan.class);
        for (TypefaceSpan span : spans) {
            int start = sb.getSpanStart(span);
            int end = sb.getSpanEnd(span);
            if (start >= 0 && end > start) {
                sb.setSpan(new BackgroundColorSpan(color(0xE6EEF6)), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
        }
    }

    private void applyHeadingStyle(SpannableStringBuilder sb) {
        String[] lines = sb.toString().split("\\n", -1);
        int pos = 0;
        for (String line : lines) {
            if (!line.trim().isEmpty() && (line.equals(line.trim())) && line.length() <= 64 && line.endsWith(":")) {
                sb.setSpan(new StyleSpan(Typeface.BOLD), pos, pos + line.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            pos += line.length() + 1;
        }
    }

    private void addRichPreviewControls(LinearLayout bubble, String text) {
        String html = extractHtml(text);
        if (html != null && !html.trim().isEmpty()) {
            Button preview = previewButton("\u9884\u89c8 HTML", v -> showHtmlPreview(html, "HTML \u9884\u89c8"));
            preview.setContentDescription("preview-html");
            bubble.addView(preview, previewButtonLp());
        }

        for (String imageUrl : extractImageUrls(text)) {
            addInlineImage(bubble, imageUrl);
        }

        int shown = 0;
        for (String url : extractUrls(text)) {
            if (shown >= 2) break;
            Button open = previewButton(urlLooksLikeHtml(url) ? "\u9884\u89c8\u7f51\u9875" : "\u6253\u5f00\u94fe\u63a5",
                    v -> {
                        if (urlLooksLikeHtml(url)) showUrlPreview(url);
                        else openExternalUrl(url);
                    });
            open.setContentDescription(urlLooksLikeHtml(url) ? "preview-url-html" : "open-url");
            bubble.addView(open, previewButtonLp());
            shown++;
        }
    }

    private Button previewButton(String text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(text);
        button.setTextSize(12);
        button.setTextColor(color(0x047857));
        button.setBackground(rounded(color(0xECFDF5), color(0xA7F3D0), 999));
        button.setOnClickListener(listener);
        return button;
    }

    private LinearLayout.LayoutParams previewButtonLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, dp(34));
        lp.setMargins(0, dp(8), 0, 0);
        return lp;
    }

    private void addInlineImage(LinearLayout bubble, String imageUrl) {
        ImageView image = new ImageView(this);
        image.setAdjustViewBounds(true);
        image.setScaleType(ImageView.ScaleType.CENTER_CROP);
        image.setBackground(rounded(color(0xF0F4F8), color(0xD9E2EC), 10));
        image.setContentDescription("inline-image");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(150));
        lp.setMargins(0, dp(8), 0, 0);
        bubble.addView(image, lp);
        loadImageInto(image, imageUrl);
    }

    private void loadImageInto(ImageView target, String url) {
        if (url == null || url.trim().isEmpty()) return;
        if (url.startsWith("data:image/")) {
            int comma = url.indexOf(',');
            if (comma > 0) {
                byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
                Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                if (bitmap != null) target.setImageBitmap(bitmap);
            }
            return;
        }
        Request request = new Request.Builder().url(url).build();
        client.newCall(request).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {}
            @Override public void onResponse(Call call, Response response) throws IOException {
                if (!response.isSuccessful() || response.body() == null) return;
                Bitmap bitmap = BitmapFactory.decodeStream(response.body().byteStream());
                if (bitmap != null) runOnUiThread(() -> target.setImageBitmap(bitmap));
            }
        });
    }

    private void showHtmlPreview(String html, String title) {
        LinearLayout preview = new LinearLayout(this);
        preview.setOrientation(LinearLayout.VERTICAL);
        preview.setBackgroundColor(Color.WHITE);

        TextView fallback = new TextView(this);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            fallback.setText(Html.fromHtml(html, Html.FROM_HTML_MODE_COMPACT));
        } else {
            fallback.setText(Html.fromHtml(html));
        }
        fallback.setTextColor(color(0x102A43));
        fallback.setTextSize(16);
        fallback.setPadding(dp(14), dp(14), dp(14), dp(12));
        fallback.setContentDescription("html-preview-rendered");
        preview.addView(fallback, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT));

        WebView webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.setBackgroundColor(Color.WHITE);
        webView.setContentDescription("html-preview-webview");
        preview.addView(webView, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1));

        showPreviewDialog(title, preview);
        webView.postDelayed(() -> {
            String encoded = Base64.encodeToString(html.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
            webView.loadData(encoded, "text/html; charset=utf-8", "base64");
        }, 250);
    }

    private void showUrlPreview(String url) {
        WebView webView = new WebView(this);
        webView.getSettings().setJavaScriptEnabled(true);
        webView.setContentDescription("url-preview-webview");
        showPreviewDialog("\u7f51\u9875\u9884\u89c8", webView);
        webView.postDelayed(() -> webView.loadUrl(url), 250);
    }

    private AlertDialog showPreviewDialog(String title, View content) {
        int height = (int) (getResources().getDisplayMetrics().heightPixels * 0.72f);
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Color.WHITE);
        shell.addView(content, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, height));
        shell.setContentDescription(content.getContentDescription());
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(title)
                .setView(shell)
                .setPositiveButton("\u5173\u95ed", null)
                .show();
        return dialog;
    }

    private void openExternalUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            addSystemBubble("\u65e0\u6cd5\u6253\u5f00\u94fe\u63a5", true);
        }
    }

    private String stripHtmlFence(String text) {
        String html = extractHtml(text);
        if (html == null) return text;
        return text.replace(html, "").replace("```html", "").replace("```", "").trim();
    }

    private String extractHtml(String text) {
        if (text == null) return null;
        Matcher fenced = Pattern.compile("(?is)```html\\s*(.*?)\\s*```").matcher(text);
        if (fenced.find()) return fenced.group(1);
        String trimmed = text.trim();
        if (trimmed.startsWith("<!doctype") || trimmed.startsWith("<html") || trimmed.contains("<body")) {
            return trimmed;
        }
        return null;
    }

    private List<String> extractImageUrls(String text) {
        ArrayList<String> urls = new ArrayList<>();
        if (text == null) return urls;
        Matcher md = Pattern.compile("!\\[[^\\]]*\\]\\(([^)]+)\\)").matcher(text);
        while (md.find()) urls.add(md.group(1).trim());
        Matcher data = Pattern.compile("(data:image/[^\\s)]+)").matcher(text);
        while (data.find()) {
            String url = data.group(1).trim();
            if (!urls.contains(url)) urls.add(url);
        }
        for (String url : extractUrls(text)) {
            if (url.matches("(?i).+\\.(png|jpg|jpeg|gif|webp)(\\?.*)?$") && !urls.contains(url)) {
                urls.add(url);
            }
        }
        return urls;
    }

    private List<String> extractUrls(String text) {
        ArrayList<String> urls = new ArrayList<>();
        if (text == null) return urls;
        Matcher matcher = Pattern.compile("(https?://[^\\s)]+)").matcher(text);
        while (matcher.find()) urls.add(matcher.group(1));
        return urls;
    }

    private boolean urlLooksLikeHtml(String url) {
        return url != null && url.matches("(?i).+\\.(html|htm)(\\?.*)?$");
    }

    private TextView avatar(String text, int bg, int fg) {
        TextView avatar = new TextView(this);
        avatar.setText(text);
        avatar.setGravity(Gravity.CENTER);
        avatar.setTextSize(12);
        avatar.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        avatar.setTextColor(fg);
        avatar.setBackground(rounded(bg, 0, 999));
        return avatar;
    }

    private void trimMessageList() {
        while (messageList.getChildCount() > 120) {
            View child = messageList.getChildAt(0);
            if (child == typingRow) {
                typingRow = null;
            }
            messageList.removeViewAt(0);
        }
    }

    private String renderCleanMobileOutput(String raw) {
        String clean = cleanTerminalText(raw);
        if (clean.isEmpty()) return "";
        StringBuilder out = new StringBuilder();
        StringBuilder answerBlock = new StringBuilder();
        String[] lines = clean.split("\\n+");
        for (String line : lines) {
            String rendered = renderCleanOutputLine(line);
            if (rendered == null || rendered.isEmpty()) continue;
            if (isRecentDuplicate(rendered)) continue;
            if (rendered.startsWith("Codex\uff1a")) {
                if (answerBlock.length() > 0) answerBlock.append('\n');
                answerBlock.append(rendered.substring(6).trim());
            } else {
                if (answerBlock.length() > 0) {
                    out.append("Codex\uff1a").append(answerBlock).append('\n');
                    answerBlock.setLength(0);
                }
                out.append(rendered).append('\n');
            }
        }
        if (answerBlock.length() > 0) {
            out.append("Codex\uff1a").append(answerBlock).append('\n');
        }
        return out.toString();
    }

    private String renderCleanOutputLine(String line) {
        String s = line == null ? "" : line
                .replace('\r', '\n')
                .replace('\t', ' ')
                .replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "")
                .replaceAll("\\s{2,}", " ")
                .trim();
        if (s.isEmpty()) return null;

        String compact = s.replace("\u2022", "").replace("\u00B7", "").trim();
        if (compact.startsWith("Codex\uff1a") || compact.startsWith("Codex:")) {
            String answer = compact.startsWith("Codex\uff1a")
                    ? compact.substring(6).trim()
                    : compact.substring(6).trim();
            if (!answer.isEmpty()) return renderAnswerLine(answer);
        }
        if (lastPromptNormalized != null && lastPromptNormalized.equals(normalizePromptEcho(compact))) {
            return null;
        }
        if ("OK".equalsIgnoreCase(compact) || compact.startsWith("OK,") || compact.startsWith("OK.")) {
            return null;
        }
        if (s.contains("MCP startup incomplete") || s.contains("MCP client for `deepseek` failed")) {
            if (mcpWarningShown) return null;
            mcpWarningShown = true;
            return "\u26a0 MCP deepseek \u542f\u52a8\u5931\u8d25\uff0c\u53ef\u6682\u65f6\u5ffd\u7565";
        }
        if (s.toLowerCase().contains("working")) {
            if (workingShown) return null;
            workingShown = true;
            return "Codex \u6b63\u5728\u5904\u7406...";
        }
        if (isInternalToolNoise(s)) return null;
        if (isLowValueTerminalNoise(s)) return null;
        if (s.startsWith("> ") || s.startsWith("PS ") || s.startsWith("codex ")) return null;
        if (isReadableAnswerLine(s)) return renderAnswerLine(s);
        if (isCleanTuiFragmentLine(s)) return null;
        return null;
    }

    private String renderAnswerLine(String text) {
        waitingForAnswer = false;
        workingShown = false;
        return "Codex\uff1a" + text;
    }

    private String normalizePromptEcho(String s) {
        if (s == null) return "";
        String value = s.replace('\r', ' ').replace('\n', ' ').trim();
        while (value.startsWith(">") || value.startsWith("\u203a")) value = value.substring(1).trim();
        while (value.startsWith("\u2022") || value.startsWith("-")) value = value.substring(1).trim();
        return value.replaceAll("[\\s|:;,.!?()\\[\\]{}\"'`]+", "").toLowerCase();
    }

    private boolean isCleanTuiFragmentLine(String s) {
        if (s.length() <= 6) return true;
        if (s.contains("\u00B0") || s.contains("\u2022") || s.contains("...")) return true;
        if (s.length() <= 22 && s.matches("^[A-Za-z0-9 .,/()\\-:;]+$")) return true;
        return s.matches("^[A-Za-z]{1,14}( [A-Za-z0-9]{1,10})?$");
    }

    private boolean isInternalToolNoise(String s) {
        String lower = s.toLowerCase();
        return lower.contains("error executing tool")
                || lower.contains("team_respond")
                || lower.contains("table events has no column")
                || lower.contains("ts_int");
    }

    private boolean isReadableAnswerLine(String s) {
        if (s.length() < 10) return false;
        if (s.contains("\u4e00") || s.matches(".*[\\u4e00-\\u9fff].*")) return true;
        if (s.endsWith(".") || s.endsWith("!") || s.endsWith("?") || s.endsWith(":")) return true;
        return s.length() >= 28 && s.matches(".*[aeiouAEIOU].*");
    }

    private String renderMobileOutput(String raw) {
        String clean = cleanTerminalText(raw);
        if (clean.isEmpty()) return "";

        StringBuilder out = new StringBuilder();
        String[] lines = clean.split("\\n+");
        for (String line : lines) {
            String rendered = renderOutputLine(line);
            if (rendered == null || rendered.isEmpty()) continue;
            if (isRecentDuplicate(rendered)) continue;
            out.append(rendered).append('\n');
        }
        return out.toString();
    }

    private String renderOutputLine(String line) {
        String s = line == null ? "" : line
                .replace('\r', '\n')
                .replace('\t', ' ')
                .replaceAll("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "")
                .replaceAll("[╭╮╰╯│┃┆┊┌┐└┘├┤┬┴┼─━═]+", " ")
                .replaceAll("\\s{2,}", " ")
                .trim();
        if (s.isEmpty()) return null;

        String compact = s.replace("\u2022", "").replace("\u00B7", "").trim();
        if ("OK".equalsIgnoreCase(compact) || compact.startsWith("OK,") || compact.startsWith("OK.")) {
            return null;
        }

        if (looksLikeEncodingNoise(s)) return null;
        if (isLowValueTerminalNoise(s)) return null;
        if (isTuiFragmentLine(s)) return null;

        if (s.contains("MCP startup incomplete") || s.contains("MCP client for `deepseek` failed")) {
            if (mcpWarningShown) return null;
            mcpWarningShown = true;
            return "⚠ MCP deepseek 启动失败，可暂时忽略";
        }

        if (s.startsWith("›")) {
            String prompt = s.substring(1).trim();
            if (prompt.isEmpty() || "Implement {feature}".equals(prompt)) return null;
            workingShown = false;
            return "\n> " + prompt;
        }

        if (s.contains("Working")) {
            if (workingShown) return null;
            workingShown = true;
            return "• Codex 正在处理...";
        }

        if ("OK".equalsIgnoreCase(s) || s.startsWith("OK，") || s.startsWith("OK,")) {
            workingShown = false;
            return "✓ " + s;
        }

        if (s.startsWith("•") || s.startsWith("-")) {
            return s;
        }

        if (s.length() <= 2 && !s.equalsIgnoreCase("OK")) return null;
        if (s.matches("^[0-9;:.~ ·-]+$")) return null;
        return s;
    }

    private boolean isLowValueTerminalNoise(String s) {
        String lower = s.toLowerCase();
        return s.contains("Update available")
                || s.contains("Run npm install")
                || s.contains("release notes")
                || lower.contains("run /review on my current changes")
                || lower.contains("cmdlet")
                || s.contains("\u65e0\u6cd5\u5c06")
                || s.contains("\u6240\u5728\u4f4d\u7f6e \u884c")
                || s.contains("OpenAI Codex")
                || s.startsWith("PS ")
                || s.startsWith("> codex ")
                || lower.contains("playwright")
                || s.contains("model_reasoning_effort")
                || s.contains("github.com/openai/codex")
                || lower.contains("model:")
                || lower.contains("/model to change")
                || s.startsWith("directory:")
                || s.startsWith("permissions:")
                || s.startsWith("Tip:")
                || s.contains("hooks need review")
                || s.contains("Context 100% left")
                || s.contains("Context 93% left")
                || s.contains("gpt-5.5 high")
                || s.contains("gpt-5.5 -c")
                || lower.contains("esc to interrupt")
                || lower.contains("esc o interrupt")
                || lower.contains("tointerrupt")
                || lower.contains("interrupt)")
                || s.contains("Starting MCP servers")
                || s.contains("initialize response")
                || s.contains("playwright")
                || s.contains("deepseek,")
                || s.startsWith("http://")
                || s.startsWith("https://")
                || s.contains("没有找到进程")
                || s.contains("Summarize recent commits")
                || s.contains("Use /skills to list available skills");
    }

    private boolean isTuiFragmentLine(String s) {
        if (s.length() <= 6) return true;
        if (s.length() <= 18 && s.matches("^[A-Za-z0-9 .,/()\\-:;\u00B0\u2022]+$")) return true;
        return s.matches("^[A-Za-z]{1,12}( [A-Za-z0-9]{1,8})?$");
    }

    private boolean looksLikeEncodingNoise(String s) {
        return s.contains("鈹")
                || s.contains("鈺")
                || s.contains("鈼")
                || s.contains("鈿")
                || s.contains("閿")
                || s.contains("杈")
                || s.contains("绯荤粺");
    }

    private boolean isRecentDuplicate(String line) {
        if (recentOutputSet.contains(line)) return true;
        recentOutputLines.addLast(line);
        recentOutputSet.add(line);
        while (recentOutputLines.size() > 40) {
            String removed = recentOutputLines.removeFirst();
            recentOutputSet.remove(removed);
        }
        return false;
    }

    private String cleanTerminalText(String raw) {
        if (raw == null || raw.isEmpty()) return "";
        String esc = "\u001B";
        return raw
                .replaceAll(esc + "\\][^\u0007]*(\u0007|" + esc + "\\\\)", "")
                .replaceAll(esc + "\\][^\\n\\r]*", "")
                .replaceAll(esc + "\\[[0-9;?]*[ -/]*[@-~]", "")
                .replace("\u001B[?2026h", "")
                .replace("\u001B[?2026l", "")
                .replace(esc, "");
    }

    private void showKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(promptInput, InputMethodManager.SHOW_IMPLICIT);
        } catch (Exception ignored) {}
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            View view = getCurrentFocus();
            if (imm != null && view != null) imm.hideSoftInputFromWindow(view.getWindowToken(), 0);
        } catch (Exception ignored) {}
    }

    private void closeSocket() {
        if (socket != null) {
            socket.close(1000, "switch");
            socket = null;
        }
    }

    @Override
    protected void onDestroy() {
        closeSocket();
        client.dispatcher().executorService().shutdown();
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private int color(int rgb) {
        return Color.rgb((rgb >> 16) & 0xFF, (rgb >> 8) & 0xFF, rgb & 0xFF);
    }

    private abstract class JsonHandler {
        public abstract void ok(JSONObject obj);
        public abstract void fail(String message);
    }
}
