package app.hub.boost;

/**
 * Разбор и сборка IPv4-пакетов (UDP/TCP) для VPN-интерфейса.
 * Без зависимостей от Android — покрыто JVM-тестами.
 */
public final class Packets {
    public static final int PROTO_TCP = 6;
    public static final int PROTO_UDP = 17;

    private Packets() {}

    public static int version(byte[] p) { return (p[0] >> 4) & 0x0F; }
    public static int ihl(byte[] p) { return (p[0] & 0x0F) * 4; }
    public static int totalLength(byte[] p) { return u16(p, 2); }
    public static int protocol(byte[] p) { return p[9] & 0xFF; }
    public static int srcIp(byte[] p) { return i32(p, 12); }
    public static int dstIp(byte[] p) { return i32(p, 16); }
    public static int srcPort(byte[] p) { return u16(p, ihl(p)); }
    public static int dstPort(byte[] p) { return u16(p, ihl(p) + 2); }

    /** Смещение и длина полезных данных UDP. */
    public static int udpPayloadOffset(byte[] p) { return ihl(p) + 8; }
    public static int udpPayloadLength(byte[] p) { return u16(p, ihl(p) + 4) - 8; }

    /** Флаги TCP (SYN = 0x02, FIN = 0x01, RST = 0x04, ACK = 0x10). */
    public static int tcpFlags(byte[] p) { return p[ihl(p) + 13] & 0xFF; }

    /** Минимальная проверка: IPv4, длина заголовков помещается в прочитанное. */
    public static boolean isValidIpv4(byte[] p, int len) {
        if (len < 20 || version(p) != 4) return false;
        int ihl = ihl(p);
        int total = totalLength(p);
        if (ihl < 20 || total > len || total < ihl) return false;
        int proto = protocol(p);
        if (proto == PROTO_UDP) return total >= ihl + 8 && u16(p, ihl + 4) >= 8 && ihl + u16(p, ihl + 4) <= total;
        if (proto == PROTO_TCP) return total >= ihl + 20;
        return true;
    }

    /** Собрать IPv4/UDP-пакет. */
    public static byte[] buildUdp(int srcIp, int srcPort, int dstIp, int dstPort, byte[] data, int off, int len) {
        int total = 20 + 8 + len;
        byte[] p = new byte[total];
        p[0] = 0x45;
        put16(p, 2, total);
        put16(p, 4, 0);          // id
        put16(p, 6, 0x4000);     // не фрагментировать
        p[8] = 64;               // TTL
        p[9] = PROTO_UDP;
        put32(p, 12, srcIp);
        put32(p, 16, dstIp);
        put16(p, 10, checksum(p, 0, 20, 0));
        put16(p, 20, srcPort);
        put16(p, 22, dstPort);
        put16(p, 24, 8 + len);
        System.arraycopy(data, off, p, 28, len);
        int sum = checksum(p, 20, 8 + len, pseudoHeaderSum(srcIp, dstIp, PROTO_UDP, 8 + len));
        put16(p, 26, sum == 0 ? 0xFFFF : sum);
        return p;
    }

    /** Переписать адреса и порты TCP-пакета и пересчитать контрольные суммы. */
    public static void rewriteTcp(byte[] p, int srcIp, int srcPort, int dstIp, int dstPort) {
        int ihl = ihl(p);
        int total = totalLength(p);
        put32(p, 12, srcIp);
        put32(p, 16, dstIp);
        put16(p, ihl, srcPort);
        put16(p, ihl + 2, dstPort);
        put16(p, 10, 0);
        put16(p, 10, checksum(p, 0, ihl, 0));
        int tcpLen = total - ihl;
        put16(p, ihl + 16, 0);
        put16(p, ihl + 16, checksum(p, ihl, tcpLen, pseudoHeaderSum(srcIp, dstIp, PROTO_TCP, tcpLen)));
    }

    /** Проверка контрольных сумм (для тестов и отладки). */
    public static boolean checksumsValid(byte[] p) {
        int ihl = ihl(p);
        int total = totalLength(p);
        if (checksum(p, 0, ihl, 0) != 0) return false;
        int proto = protocol(p);
        int l4 = total - ihl;
        if (proto == PROTO_TCP || proto == PROTO_UDP) {
            return checksum(p, ihl, l4, pseudoHeaderSum(srcIp(p), dstIp(p), proto, l4)) == 0;
        }
        return true;
    }

    static long pseudoHeaderSum(int src, int dst, int proto, int len) {
        return ((src >>> 16) & 0xFFFF) + (src & 0xFFFF) + ((dst >>> 16) & 0xFFFF) + (dst & 0xFFFF) + proto + len;
    }

    /** Интернет-контрольная сумма (RFC 1071). */
    static int checksum(byte[] b, int off, int len, long initial) {
        long sum = initial;
        int i = off;
        int end = off + len;
        while (i + 1 < end) { sum += ((b[i] & 0xFF) << 8) | (b[i + 1] & 0xFF); i += 2; }
        if (i < end) sum += (b[i] & 0xFF) << 8;
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (int) (~sum & 0xFFFF);
    }

    public static int u16(byte[] b, int off) { return ((b[off] & 0xFF) << 8) | (b[off + 1] & 0xFF); }
    public static int i32(byte[] b, int off) {
        return ((b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16) | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF);
    }
    public static void put16(byte[] b, int off, int v) { b[off] = (byte) (v >> 8); b[off + 1] = (byte) v; }
    public static void put32(byte[] b, int off, int v) {
        b[off] = (byte) (v >> 24); b[off + 1] = (byte) (v >> 16); b[off + 2] = (byte) (v >> 8); b[off + 3] = (byte) v;
    }

    public static int ipFromString(String s) {
        String[] parts = s.split("\\.");
        if (parts.length != 4) throw new IllegalArgumentException("IPv4 expected: " + s);
        int v = 0;
        for (String part : parts) {
            int o = Integer.parseInt(part);
            if (o < 0 || o > 255) throw new IllegalArgumentException("IPv4 expected: " + s);
            v = (v << 8) | o;
        }
        return v;
    }

    public static String ipToString(int ip) {
        return ((ip >>> 24) & 0xFF) + "." + ((ip >>> 16) & 0xFF) + "." + ((ip >>> 8) & 0xFF) + "." + (ip & 0xFF);
    }

    /** Внутренние адреса не отправляем через узел (узел их всё равно отклонит). */
    public static boolean isPrivate(int ip) {
        int a = (ip >>> 24) & 0xFF;
        int b = (ip >>> 16) & 0xFF;
        return a == 10 || a == 127 || a == 0 || (a == 169 && b == 254) || (a == 172 && b >= 16 && b <= 31)
            || (a == 192 && b == 168) || (a == 100 && b >= 64 && b <= 127) || a >= 224;
    }
}
