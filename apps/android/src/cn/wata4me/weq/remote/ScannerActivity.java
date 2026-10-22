package cn.wata4me.weq.remote;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.hardware.Camera;
import android.os.Bundle;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.widget.Toast;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.HybridBinarizer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@SuppressWarnings("deprecation")
public final class ScannerActivity extends Activity implements SurfaceHolder.Callback {
    private Camera camera;
    private SurfaceView preview;
    private final ExecutorService decoder = Executors.newSingleThreadExecutor();
    private volatile boolean decoding, stopped;
    private long lastFrame;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); preview = new SurfaceView(this); setContentView(preview);
        preview.getHolder().addCallback(this);
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
    }
    @Override public void surfaceCreated(SurfaceHolder holder) { open(); }
    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }
    @Override public void surfaceDestroyed(SurfaceHolder holder) { close(); }
    @Override protected void onPause() { stopped = true; close(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); stopped = false; if (preview.getHolder().getSurface().isValid()) open(); }
    @Override protected void onDestroy() { decoder.shutdownNow(); super.onDestroy(); }
    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] result) {
        super.onRequestPermissionsResult(request, permissions, result);
        if (result.length > 0 && result[0] == PackageManager.PERMISSION_GRANTED) open();
        else { Toast.makeText(this, "可返回粘贴配对链接", Toast.LENGTH_LONG).show(); finish(); }
    }
    private void open() {
        if (camera != null || stopped || checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED || !preview.getHolder().getSurface().isValid()) return;
        try {
            camera = Camera.open();
            Camera.Parameters parameters = camera.getParameters();
            for (Camera.Size size : parameters.getSupportedPreviewSizes()) if (size.width == 1280 && size.height == 720) { parameters.setPreviewSize(size.width, size.height); break; }
            if (parameters.getSupportedFocusModes().contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) parameters.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            camera.setParameters(parameters); camera.setDisplayOrientation(90); camera.setPreviewDisplay(preview.getHolder());
            camera.setPreviewCallback((bytes, source) -> {
                long now = android.os.SystemClock.elapsedRealtime();
                if (decoding || stopped || now - lastFrame < 400) return;
                decoding = true; lastFrame = now;
                Camera.Size size = source.getParameters().getPreviewSize(); byte[] copy = bytes.clone();
                decoder.execute(() -> {
                    MultiFormatReader reader = new MultiFormatReader();
                    try {
                        PlanarYUVLuminanceSource image = new PlanarYUVLuminanceSource(copy, size.width, size.height, 0, 0, size.width, size.height, false);
                        String text = reader.decode(new BinaryBitmap(new HybridBinarizer(image))).getText();
                        Invitation.parse(text);
                        runOnUiThread(() -> { if (!stopped) { stopped = true; setResult(RESULT_OK, new Intent().putExtra("invitation", text)); finish(); } });
                    } catch (Exception ignored) { }
                    finally { reader.reset(); decoding = false; }
                });
            });
            camera.startPreview();
        } catch (Exception e) { close(); Toast.makeText(this, "相机不可用，可返回粘贴链接", Toast.LENGTH_LONG).show(); finish(); }
    }
    private void close() { if (camera != null) { camera.setPreviewCallback(null); camera.stopPreview(); camera.release(); camera = null; } }
}
