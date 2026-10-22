package cn.wata4me.weq.remote;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.View;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.net.URI;
import java.text.DateFormat;
import java.util.Date;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import org.json.JSONObject;
import androidnet.Androidnet;
import androidnet.Client;

public final class MainActivity extends Activity {
    final Handler main = new Handler(Looper.getMainLooper());
    final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService closer = Executors.newSingleThreadExecutor();
    private Client node;
    private volatile int generation;
    private volatile Future<?> closing;
    private boolean enabled, online, busy, paired, visible;
    private String loginURL, endpoint, token, claimID;
    private long expiresAt;
    private String testControl;
    TextView networkState, computerState, detail, error;
    EditText invitation;
    Button networkButton, pairButton, verifyButton, loginButton, disconnectButton;
    private LinearLayout pairSection;
    private final Runnable networkPoll = new Runnable() { public void run() { refreshNetwork(); } };
    private final Runnable approvalPoll = new Runnable() { public void run() { pollApproval(); } };

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (BuildConfig.TESTING && getIntent().getBooleanExtra("isolated_ts_test", false)) {
            String control = getIntent().getStringExtra("test_control");
            try {
                URI uri = new URI(control);
                if ("http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost()) && uri.getPort() > 0 && uri.getUserInfo() == null && "".equals(uri.getPath()) && uri.getQuery() == null && uri.getFragment() == null) testControl = control;
            } catch (Exception ignored) { }
        }
        buildUI();
        if (getIntent().getData() != null) invitation.setText(getIntent().getData().toString());
        if (testControl != null) { invitation.setText(getIntent().getStringExtra("test_invitation")); enabled = true; }
    }

    @Override protected void onResume() {
        super.onResume(); visible = true;
        if (enabled && node == null) startNetwork();
    }
    @Override protected void onStop() {
        visible = false;
        stopNetwork(false);
        super.onStop();
    }
    @Override protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        worker.shutdownNow(); closer.shutdown();
        super.onDestroy();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent.getData() != null) invitation.setText(intent.getData().toString());
    }

    private void buildUI() {
        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this); content.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(22); content.setPadding(pad, pad, pad, pad);
        scroll.setBackgroundColor(dark ? Color.rgb(18, 20, 22) : Color.rgb(249, 250, 251));
        scroll.addView(content); setContentView(scroll);
        if (android.os.Build.VERSION.SDK_INT >= 30) scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            content.setPadding(pad + bars.left, pad + bars.top, pad + bars.right, pad + bars.bottom); return insets;
        });
        TextView title = text("WeQ Remote", 28); title.setTypeface(null, android.graphics.Typeface.BOLD); content.addView(title);
        section(content, "网络");
        if (testControl != null) content.addView(text("本机 TS 集成测试", 12));
        networkState = text("App 内网络：未启动", 16); content.addView(networkState);
        networkButton = button("连接网络", () -> { if (enabled) stopNetwork(true); else { enabled = true; startNetwork(); } }); content.addView(networkButton);
        loginButton = button("登录 Tailscale", () -> { if (loginURL != null) startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(loginURL))); }); loginButton.setVisibility(View.GONE); content.addView(loginButton);
        pairSection = new LinearLayout(this); pairSection.setOrientation(LinearLayout.VERTICAL); content.addView(pairSection);
        section(pairSection, "配对电脑");
        invitation = new EditText(this); invitation.setHint("配对链接"); invitation.setTextSize(14); invitation.setMaxLines(3); invitation.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE | android.text.InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS); invitation.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO); pairSection.addView(invitation);
        LinearLayout actions = new LinearLayout(this); pairSection.addView(actions);
        actions.addView(button("扫码", () -> startActivityForResult(new Intent(this, ScannerActivity.class), 7)), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        actions.addView(button("粘贴链接", () -> {
            ClipboardManager clipboard = (ClipboardManager)getSystemService(CLIPBOARD_SERVICE);
            ClipData clip = clipboard.getPrimaryClip();
            if (clip != null && clip.getItemCount() > 0) { CharSequence value = clip.getItemAt(0).getText(); if (value != null && value.length() <= 2048) invitation.setText(value); }
        }), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
        pairButton = button("配对电脑", this::pair); pairSection.addView(pairButton);
        section(content, "电脑");
        computerState = text("未配对", 20); content.addView(computerState);
        detail = text("", 14); detail.setPadding(0, dp(10), 0, dp(10)); content.addView(detail);
        verifyButton = button("验证连通", this::verify); verifyButton.setVisibility(View.GONE); content.addView(verifyButton);
        disconnectButton = button("断开电脑", () -> { clearComputer(); render(); }); disconnectButton.setVisibility(View.GONE); content.addView(disconnectButton);
        error = text("", 14); error.setTextColor(dark ? Color.rgb(255, 160, 150) : Color.rgb(170, 35, 30)); error.setPadding(0, dp(12), 0, 0); content.addView(error);
        invitation.addTextChangedListener(new android.text.TextWatcher() {
            public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            public void onTextChanged(CharSequence s, int start, int before, int count) { render(); }
            public void afterTextChanged(android.text.Editable value) { }
        });
        render();
    }
    private TextView text(String value, int size) { TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setLineSpacing(dp(3), 1); return view; }
    private void section(LinearLayout parent, String name) { TextView heading = text(name, 14); heading.setTypeface(null, 1); heading.setPadding(0, dp(30), 0, dp(12)); parent.addView(heading); }
    private Button button(String label, Runnable action) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false); button.setMinHeight(dp(50)); button.setMaxLines(2);
        int resource = label.equals("扫码") ? android.R.drawable.ic_menu_camera : label.equals("粘贴链接") ? android.R.drawable.ic_menu_edit : label.equals("验证连通") ? android.R.drawable.ic_popup_sync : 0;
        if (resource != 0) { android.graphics.drawable.Drawable icon = getDrawable(resource).mutate(); icon.setTint(button.getCurrentTextColor()); button.setCompoundDrawablesWithIntrinsicBounds(icon, null, null, null); button.setCompoundDrawablePadding(dp(8)); }
        button.setOnClickListener(v -> action.run()); return button;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private void render() {
        networkButton.setText(enabled ? "断开网络" : "连接网络");
        pairButton.setEnabled(online && !busy && claimID == null && invitation.length() > 0);
        verifyButton.setVisibility(paired ? View.VISIBLE : View.GONE); verifyButton.setEnabled(!busy);
        disconnectButton.setVisibility(paired || claimID != null ? View.VISIBLE : View.GONE);
        pairSection.setVisibility(paired || claimID != null ? View.GONE : View.VISIBLE);
        loginButton.setVisibility(loginURL != null && enabled ? View.VISIBLE : View.GONE);
    }

    private void startNetwork() {
        if (busy || node != null || !visible) return;
        busy = true; error.setText(""); networkState.setText("App 内网络：正在连接"); render();
        final int revision = generation;
        worker.execute(() -> {
            try {
                Future<?> pendingClose = closing;
                if (pendingClose != null) pendingClose.get();
                go.Seq.setContext(getApplicationContext());
                Androidnet.setInterfaces(interfaceSnapshot());
                if (revision != generation || !visible) return;
                String directory = new java.io.File(getNoBackupFilesDir(), testControl == null ? "tailnet" : "tailnet-integration").getAbsolutePath();
                Client client = testControl == null ? Androidnet.newClient(directory) : Androidnet.newTestClient(directory, testControl);
                main.post(() -> {
                    if (revision != generation || !visible) { closeClient(client); return; }
                    node = client; busy = false; refreshNetwork();
                });
            } catch (Exception e) { main.post(() -> { if (revision == generation) { busy = false; enabled = false; error.setText("网络启动失败，请重试"); networkState.setText("App 内网络：未启动"); render(); } }); }
        });
    }
    private void refreshNetwork() {
        final Client client = node; final int revision = generation;
        if (client == null || !visible) return;
        worker.execute(() -> {
            try {
                JSONObject status = new JSONObject(client.status());
                String state = status.getString("state"); String auth = status.optString("loginURL");
                main.post(() -> {
                    if (revision != generation) return;
                    online = "Running".equals(state); loginURL = safeLogin(auth);
                    networkState.setText("App 内网络：" + (online ? "已连接" : "NeedsMachineAuth".equals(state) ? "等待网络管理员批准" : loginURL != null ? "等待网络登录" : "正在连接"));
                    render();
                    if (!online && loginURL == null) main.postDelayed(networkPoll, 1500);
                });
            } catch (Exception e) { main.post(() -> { if (revision == generation) { online = false; error.setText("网络状态读取失败，请重新连接"); render(); } }); }
        });
    }
    private String safeLogin(String value) {
        try { URI url = new URI(value); return "https".equals(url.getScheme()) && "login.tailscale.com".equals(url.getHost()) && url.getUserInfo() == null && (url.getPort() == -1 || url.getPort() == 443) ? value : null; }
        catch (Exception e) { return null; }
    }
    private String interfaceSnapshot() throws Exception {
        org.json.JSONArray result = new org.json.JSONArray();
        java.util.Enumeration<java.net.NetworkInterface> values = java.net.NetworkInterface.getNetworkInterfaces();
        while (values != null && values.hasMoreElements()) {
            java.net.NetworkInterface value = values.nextElement();
            int flags = (value.isUp() ? 1 : 0) | (value.isLoopback() ? 4 : 2) | (value.isPointToPoint() ? 8 : 0) | (value.supportsMulticast() ? 16 : 0);
            org.json.JSONArray addresses = new org.json.JSONArray();
            for (java.net.InterfaceAddress address : value.getInterfaceAddresses()) {
                addresses.put(address.getAddress().getHostAddress().split("%")[0] + "/" + address.getNetworkPrefixLength());
            }
            result.put(new JSONObject().put("name", value.getName()).put("index", value.getIndex()).put("mtu", value.getMTU()).put("flags", flags).put("addresses", addresses));
        }
        return result.toString();
    }
    private void stopNetwork(boolean disable) {
        generation++; if (disable) enabled = false;
        main.removeCallbacks(networkPoll); main.removeCallbacks(approvalPoll);
        Client previous = node; node = null; online = false; loginURL = null; busy = false;
        clearComputer(); networkState.setText(enabled ? "App 内网络：已暂停" : "App 内网络：未启动"); render();
        if (previous != null) closeClient(previous);
    }
    private void closeClient(Client client) {
        try { closing = closer.submit(client::close); }
        catch (java.util.concurrent.RejectedExecutionException stopped) { Thread cleanup = new Thread(client::close, "weq-network-close"); cleanup.setDaemon(true); cleanup.start(); }
    }
    private void clearComputer() {
        generation++;
        main.removeCallbacks(approvalPoll); endpoint = null; token = null; claimID = null; paired = false;
        computerState.setText("未配对"); detail.setText(""); error.setText(""); busy = false;
    }
    private void pair() {
        if (!online || busy || node == null) return;
        try {
            Invitation link = Invitation.parse(invitation.getText().toString());
            endpoint = link.endpoint; token = Invitation.credential();
            JSONObject body = new JSONObject().put("invitation", link.secret).put("name", "WeQ Remote Android").put("tokenHash", Invitation.hash(token));
            busy = true; error.setText(""); render();
            final Client client = node; final int revision = generation; final String address = endpoint;
            worker.execute(() -> {
                try {
                    JSONObject response = response(client.request(address, "/v1/pair", "POST", "", body.toString()));
                    String id = response.getString("id"), code = response.getString("code"); long expiry = response.getLong("expiresAt");
                    if (!id.matches("[a-f0-9-]{36}") || !code.matches("[0-9]{6}") || expiry <= System.currentTimeMillis() || expiry > System.currentTimeMillis() + 180000) throw new Exception("电脑返回了不兼容的数据");
                    main.post(() -> {
                        if (revision != generation) return;
                        claimID = id; expiresAt = expiry; busy = false; invitation.setText(""); invitation.clearFocus();
                        ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(invitation.getWindowToken(), 0);
                        computerState.setText("等待电脑批准"); detail.setText("校验码  " + code); render(); pollApproval();
                    });
                } catch (Exception e) { fail(revision, e.getMessage()); }
            });
        } catch (Exception e) { error.setText(e.getMessage()); }
    }
    private void pollApproval() {
        if (claimID == null || node == null || paired) return;
        if (System.currentTimeMillis() >= expiresAt) { clearComputer(); error.setText("配对确认已超时，请重新生成邀请"); render(); return; }
        final Client client = node; final int revision = generation; final String id = claimID, address = endpoint, credential = token;
        worker.execute(() -> {
            try {
                JSONObject approval = response(client.request(address, "/v1/pair/" + id, "GET", credential, ""));
                if (!id.equals(approval.getString("id")) || !"status:read".equals(approval.getString("scope"))) throw new Exception("电脑返回了不兼容的数据");
                main.post(() -> { if (revision != generation || !id.equals(claimID)) return; if (approval.optBoolean("approved")) { paired = true; verify(); } else main.postDelayed(approvalPoll, 1500); });
            } catch (Exception e) { fail(revision, e.getMessage()); }
        });
    }
    private void verify() {
        if (node == null || !paired || busy) return;
        final Client client = node; final int revision = generation; final String address = endpoint, credential = token;
        busy = true; error.setText(""); render();
        worker.execute(() -> {
            try {
                long started = SystemClock.elapsedRealtime();
                JSONObject status = response(client.request(address, "/v1/status", "GET", credential, ""));
                if (!"WeQ Remote".equals(status.getString("product")) || status.getInt("protocol") != 1 || !"status:read".equals(status.getString("scope")) || !status.getBoolean("online")) throw new Exception("电脑返回了不兼容的数据");
                long elapsed = SystemClock.elapsedRealtime() - started;
                main.post(() -> { if (revision != generation || !credential.equals(token)) return; busy = false; computerState.setText("电脑在线"); detail.setText("地址  " + address + "\n请求耗时  " + elapsed + " ms\n最近验证  " + DateFormat.getTimeInstance().format(new Date())); render(); });
            } catch (Exception e) { fail(revision, e.getMessage()); }
        });
    }
    private JSONObject response(String raw) throws Exception {
        JSONObject envelope = new JSONObject(raw); int status = envelope.getInt("status");
        if (status == 401) throw new Exception("设备未授权或授权已被撤销，请重新配对");
        if (status < 200 || status >= 300) throw new Exception("电脑返回 HTTP " + status + "，请检查邀请是否有效");
        return new JSONObject(envelope.getString("body"));
    }
    private void fail(int revision, String message) { main.post(() -> { if (revision != generation) return; clearComputer(); error.setText(message == null ? "连接失败，请重试" : message); render(); }); }
    @Override protected void onActivityResult(int request, int result, Intent data) { super.onActivityResult(request, result, data); if (request == 7 && result == RESULT_OK && data != null) invitation.setText(data.getStringExtra("invitation")); }
}
