package cn.wata4me.weq.remote;

import android.app.Instrumentation;
import android.content.ComponentName;
import android.content.Intent;
import android.graphics.Bitmap;
import android.os.Bundle;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;

public final class RemoteInstrumentation extends Instrumentation {
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        MainActivity activity = null;
        try {
            String pkg = getTargetContext().getPackageName();
            Intent first = new Intent().setComponent(new ComponentName(pkg, MainActivity.class.getName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = (MainActivity)startActivitySync(first);
            final MainActivity initial = activity;
            require(read(initial.networkState).contains("未启动"), "default network must stay off");
            runOnMainSync(() -> require(!initial.pairButton.isEnabled(), "unconnected pairing enabled"));
            runOnMainSync(initial::finish); waitForIdleSync();

            JSONObject network = http("/test/network", "GET");
            JSONObject invitation = http("/test/invitation", "GET");
            Intent launch = new Intent().setComponent(new ComponentName(pkg, MainActivity.class.getName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("isolated_ts_test", true).putExtra("test_control", network.getString("control")).putExtra("test_invitation", invitation.getString("url"));
            activity = (MainActivity)startActivitySync(launch);
            final MainActivity connected = activity;
            waitText(connected.networkState, "已连接", 40000);
            runOnMainSync(() -> connected.pairButton.performClick());
            waitText(connected.computerState, "电脑在线", 30000);
            require(read(connected.detail).contains("ms"), "real latency missing");
            runOnMainSync(() -> connected.verifyButton.performClick());
            waitForIdleSync();
            long requestDeadline = android.os.SystemClock.elapsedRealtime() + 16000;
            while (true) {
                AtomicReference<Boolean> ready = new AtomicReference<>(false);
                runOnMainSync(() -> ready.set(connected.verifyButton.isEnabled()));
                if (ready.get()) break;
                require(android.os.SystemClock.elapsedRealtime() < requestDeadline, "repeat request timed out");
                Thread.sleep(100);
            }
            android.view.accessibility.AccessibilityNodeInfo activeWindow = null;
            long windowDeadline = android.os.SystemClock.elapsedRealtime() + 5000;
            while (android.os.SystemClock.elapsedRealtime() < windowDeadline) {
                activeWindow = getUiAutomation().getRootInActiveWindow();
                if (activeWindow != null && pkg.contentEquals(activeWindow.getPackageName())) break;
                Thread.sleep(100);
            }
            if (activeWindow == null || !pkg.contentEquals(activeWindow.getPackageName())) {
                Bitmap failureImage = getUiAutomation().takeScreenshot();
                if (failureImage != null) { try (FileOutputStream output = new FileOutputStream(new File(getTargetContext().getFilesDir(), "failure.png"))) { failureImage.compress(Bitmap.CompressFormat.PNG, 100, output); } failureImage.recycle(); }
                throw new AssertionError("active window mismatch: expected=" + pkg + ", observed=" + (activeWindow == null ? "none" : activeWindow.getPackageName()));
            }
            Bitmap image = getUiAutomation().takeScreenshot();
            require(image != null, "screenshot unavailable");
            try (FileOutputStream output = new FileOutputStream(new File(getTargetContext().getFilesDir(), "connection.png"))) { image.compress(Bitmap.CompressFormat.PNG, 100, output); }
            image.recycle();
            http("/test/revoke", "POST");
            runOnMainSync(() -> connected.verifyButton.performClick());
            waitText(connected.error, "授权已被撤销", 20000);
            runOnMainSync(() -> require(connected.verifyButton.getVisibility() != android.view.View.VISIBLE, "revoked device remains connected"));
            result.putString("stream", "PASS: default network off; embedded TS; pairing; status; repeated request; revoke=401\n");
            runOnMainSync(connected::finish);
            finish(android.app.Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            if (activity != null) { MainActivity previous = activity; runOnMainSync(previous::finish); }
            result.putString("stream", "FAIL: " + failure.getClass().getSimpleName() + ": " + failure.getMessage() + "\n");
            finish(android.app.Activity.RESULT_CANCELED, result);
        }
    }
    private String read(android.widget.TextView view) { AtomicReference<String> value = new AtomicReference<>(); runOnMainSync(() -> value.set(view.getText().toString())); return value.get(); }
    private void waitText(android.widget.TextView view, String expected, long timeout) throws Exception {
        long until = android.os.SystemClock.elapsedRealtime() + timeout;
        while (android.os.SystemClock.elapsedRealtime() < until) { if (read(view).contains(expected)) return; Thread.sleep(200); }
        throw new AssertionError("UI state not reached: " + expected + "; current=" + read(view));
    }
    private JSONObject http(String path, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)new URL("http://127.0.0.1:45198" + path).openConnection();
        connection.setRequestMethod(method); connection.setConnectTimeout(5000); connection.setReadTimeout(5000);
        try {
            int status = connection.getResponseCode();
            require(status >= 200 && status < 300, "fixture HTTP " + status);
            if (status == 204) return new JSONObject();
            try (java.io.InputStream input = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[1024]; int count;
                while ((count = input.read(chunk)) != -1) { bytes.write(chunk, 0, count); require(bytes.size() <= 65536, "fixture response too large"); }
                return new JSONObject(bytes.toString("UTF-8"));
            }
        } finally { connection.disconnect(); }
    }
    private static void require(boolean value, String message) { if (!value) throw new AssertionError(message); }
}
