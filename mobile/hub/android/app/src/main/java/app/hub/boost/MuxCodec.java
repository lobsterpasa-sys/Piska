package app.hub.boost;

/**
 * Формат обмена с узлом ускорителя (см. server/src/boost/relay.js, режим HELLO2):
 *   данные: [0x01][IPv4: 4][порт сервера: 2][порт приложения: 2][полезные данные]
 *   пинг:   [0x02][8 байт метки времени]
 */
public final class MuxCodec {
    public static final byte TYPE_DATA = 0x01;
    public static final byte TYPE_PING = 0x02;
    public static final int HEADER = 9;

    private MuxCodec() {}

    public static byte[] encodeData(int serverIp, int serverPort, int appPort, byte[] data, int off, int len) {
        byte[] out = new byte[HEADER + len];
        out[0] = TYPE_DATA;
        Packets.put32(out, 1, serverIp);
        Packets.put16(out, 5, serverPort);
        Packets.put16(out, 7, appPort);
        System.arraycopy(data, off, out, HEADER, len);
        return out;
    }

    public static byte[] encodePing(long nanos) {
        byte[] out = new byte[9];
        out[0] = TYPE_PING;
        for (int i = 0; i < 8; i++) out[1 + i] = (byte) (nanos >>> (56 - 8 * i));
        return out;
    }

    public static long decodePing(byte[] b, int len) {
        if (len != 9 || b[0] != TYPE_PING) return -1;
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (b[1 + i] & 0xFF);
        return v;
    }

    public static boolean isData(byte[] b, int len) { return len >= HEADER && b[0] == TYPE_DATA; }
    public static int serverIp(byte[] b) { return Packets.i32(b, 1); }
    public static int serverPort(byte[] b) { return Packets.u16(b, 5); }
    public static int appPort(byte[] b) { return Packets.u16(b, 7); }
}
