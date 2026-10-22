package cn.wata4me.weq.remote;

public final class InvitationTest {
    public static void main(String[] args) throws Exception {
        String secret = new String(new char[64]).replace('\0', 'a');
        String prefix = "weq-remote://pair?v=1&endpoint=";
        String suffix = "&invitation=" + secret;
        Invitation valid = Invitation.parse(prefix + "http%3A%2F%2F100.64.0.1%3A7691" + suffix);
        require(valid.endpoint.equals("http://100.64.0.1:7691"), "valid invitation");
        for (String endpoint : new String[]{"http://127.0.0.1:7691", "http://100.128.0.1:80", "http://example.com:80", "http://user@100.64.0.1:80", "http://100.64.0.1:0", "http://100.64.0.1:80/path"}) {
            reject(prefix + java.net.URLEncoder.encode(endpoint, "UTF-8") + suffix);
        }
        reject(prefix + "http%3A%2F%2F100.64.0.1%3A7691" + suffix + "&v=1");
        reject("https://example.com");
        String a = Invitation.credential(), b = Invitation.credential();
        require(a.matches("[a-f0-9]{64}") && !a.equals(b), "random credential");
        require(Invitation.hash(a).length() == 64, "credential hash");
        require(Invitation.hash("test").equals("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "desktop hash convention");
        String payload = prefix + "http%3A%2F%2F100.64.0.1%3A7691" + suffix;
        com.google.zxing.common.BitMatrix qr = new com.google.zxing.qrcode.QRCodeWriter().encode(payload, com.google.zxing.BarcodeFormat.QR_CODE, 300, 300);
        int[] pixels = new int[90000];
        for (int y = 0; y < 300; y++) for (int x = 0; x < 300; x++) pixels[y * 300 + x] = qr.get(x, y) ? 0xff000000 : 0xffffffff;
        com.google.zxing.BinaryBitmap bitmap = new com.google.zxing.BinaryBitmap(new com.google.zxing.common.HybridBinarizer(new com.google.zxing.RGBLuminanceSource(300, 300, pixels)));
        String decoded = new com.google.zxing.MultiFormatReader().decode(bitmap).getText();
        require(Invitation.parse(decoded).endpoint.equals(valid.endpoint), "real QR decode");
        System.out.println("Invitation tests passed: parsing, destination, duplicates, random credential, SHA-256, real QR decode");
    }
    private static void reject(String link) throws Exception { try { Invitation.parse(link); } catch (Exception expected) { return; } throw new AssertionError("unsafe invitation accepted"); }
    private static void require(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
