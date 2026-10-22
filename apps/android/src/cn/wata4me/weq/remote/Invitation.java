package cn.wata4me.weq.remote;

import java.net.URI;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Map;

final class Invitation {
    final String endpoint;
    final String secret;
    private Invitation(String endpoint, String secret) { this.endpoint = endpoint; this.secret = secret; }

    static Invitation parse(String text) throws Exception {
        if (text == null || text.length() > 2048) throw new IllegalArgumentException("配对链接无效");
        URI uri = new URI(text.trim());
        if (!"weq-remote".equals(uri.getScheme()) || !"pair".equals(uri.getHost()) || uri.getUserInfo() != null || uri.getPort() != -1 || !"".equals(uri.getPath()) || uri.getFragment() != null || uri.getRawQuery() == null) throw new IllegalArgumentException("配对链接无效");
        Map<String, String> fields = new HashMap<>();
        for (String field : uri.getRawQuery().split("&", -1)) {
            String[] pair = field.split("=", 2);
            if (pair.length != 2) throw new IllegalArgumentException("配对字段无效");
            String key = URLDecoder.decode(pair[0], "UTF-8");
            if (fields.put(key, URLDecoder.decode(pair[1], "UTF-8")) != null) throw new IllegalArgumentException("配对字段重复");
        }
        if (fields.size() != 3 || !"1".equals(fields.get("v")) || !fields.containsKey("endpoint") || !fields.containsKey("invitation")) throw new IllegalArgumentException("配对版本不兼容");
        URI endpoint = new URI(fields.get("endpoint"));
        String host = endpoint.getHost();
        if (!"http".equals(endpoint.getScheme()) || endpoint.getUserInfo() != null || endpoint.getPort() < 1 || endpoint.getPort() > 65535 || !"".equals(endpoint.getPath()) || endpoint.getRawQuery() != null || endpoint.getFragment() != null || host == null) throw new IllegalArgumentException("电脑地址无效");
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) throw new IllegalArgumentException("只允许 TS 网络地址");
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            octets[i] = Integer.parseInt(parts[i]);
            if (!Integer.toString(octets[i]).equals(parts[i]) || octets[i] < 0 || octets[i] > 255) throw new IllegalArgumentException("电脑地址无效");
        }
        if (octets[0] != 100 || octets[1] < 64 || octets[1] > 127) throw new IllegalArgumentException("只允许 TS 网络地址");
        String secret = fields.get("invitation");
        if (!secret.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("邀请无效");
        return new Invitation(endpoint.toString(), secret);
    }

    static String credential() { byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes); return hex(bytes); }
    static String hash(String token) throws Exception { return hex(MessageDigest.getInstance("SHA-256").digest(token.getBytes("UTF-8"))); }
    private static String hex(byte[] bytes) { StringBuilder text = new StringBuilder(); for (byte b : bytes) text.append(String.format(java.util.Locale.ROOT, "%02x", b & 255)); return text.toString(); }
}
