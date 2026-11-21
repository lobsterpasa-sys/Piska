package app.hub.boost;

import static org.junit.Assert.*;

import org.junit.Test;

public class PacketsTest {
    private static final int GAME = Packets.ipFromString("10.88.0.2");
    private static final int SERVER = Packets.ipFromString("203.0.113.7");

    @Test
    public void ipConversions() {
        assertEquals("203.0.113.7", Packets.ipToString(SERVER));
        assertEquals(0xCB007107, SERVER);
        assertThrows(IllegalArgumentException.class, () -> Packets.ipFromString("1.2.3"));
        assertThrows(IllegalArgumentException.class, () -> Packets.ipFromString("1.2.3.300"));
    }

    @Test
    public void buildUdpProducesValidPacket() {
        byte[] data = "hello game".getBytes();
        byte[] p = Packets.buildUdp(SERVER, 27015, GAME, 50001, data, 0, data.length);
        assertTrue(Packets.isValidIpv4(p, p.length));
        assertEquals(4, Packets.version(p));
        assertEquals(Packets.PROTO_UDP, Packets.protocol(p));
        assertEquals(SERVER, Packets.srcIp(p));
        assertEquals(GAME, Packets.dstIp(p));
        assertEquals(27015, Packets.srcPort(p));
        assertEquals(50001, Packets.dstPort(p));
        assertEquals(data.length, Packets.udpPayloadLength(p));
        assertEquals("hello game", new String(p, Packets.udpPayloadOffset(p), Packets.udpPayloadLength(p)));
        assertTrue("контрольные суммы IP и UDP", Packets.checksumsValid(p));
    }

    @Test
    public void udpWithOddPayloadLength() {
        byte[] data = {1, 2, 3};
        byte[] p = Packets.buildUdp(SERVER, 1, GAME, 2, data, 0, 3);
        assertTrue(Packets.checksumsValid(p));
    }

    @Test
    public void rewriteTcpKeepsChecksumsValid() {
        byte[] p = sampleTcpSyn();
        assertTrue(Packets.checksumsValid(p));
        int proxy = GAME;
        Packets.rewriteTcp(p, SERVER, 40000, proxy, 8443);
        assertEquals(SERVER, Packets.srcIp(p));
        assertEquals(proxy, Packets.dstIp(p));
        assertEquals(40000, Packets.srcPort(p));
        assertEquals(8443, Packets.dstPort(p));
        assertEquals(0x02, Packets.tcpFlags(p) & 0x02);
        assertTrue(Packets.checksumsValid(p));
    }

    @Test
    public void rejectsGarbage() {
        assertFalse(Packets.isValidIpv4(new byte[10], 10));
        byte[] v6 = new byte[40];
        v6[0] = 0x60;
        assertFalse(Packets.isValidIpv4(v6, 40));
        byte[] p = Packets.buildUdp(SERVER, 1, GAME, 2, new byte[4], 0, 4);
        assertFalse("обрезанный пакет", Packets.isValidIpv4(p, p.length - 1));
    }

    @Test
    public void privateRanges() {
        assertTrue(Packets.isPrivate(Packets.ipFromString("192.168.1.1")));
        assertTrue(Packets.isPrivate(Packets.ipFromString("172.20.0.1")));
        assertTrue(Packets.isPrivate(Packets.ipFromString("10.88.0.2")));
        assertFalse(Packets.isPrivate(Packets.ipFromString("172.32.0.1")));
        assertFalse(Packets.isPrivate(SERVER));
    }

    @Test
    public void muxCodecRoundTrip() {
        byte[] data = "shot".getBytes();
        byte[] f = MuxCodec.encodeData(SERVER, 27015, 50001, data, 0, data.length);
        assertTrue(MuxCodec.isData(f, f.length));
        assertEquals(SERVER, MuxCodec.serverIp(f));
        assertEquals(27015, MuxCodec.serverPort(f));
        assertEquals(50001, MuxCodec.appPort(f));
        assertEquals("shot", new String(f, MuxCodec.HEADER, f.length - MuxCodec.HEADER));
        // Формат совпадает с узлом на Node.js: [0x01][IPv4][порт][порт приложения]
        assertArrayEquals(new byte[] {1, (byte) 203, 0, 113, 7, 0x69, (byte) 0x87, (byte) 0xC3, 0x51}, java.util.Arrays.copyOf(f, 9));

        long t = 0x0102030405060708L;
        byte[] ping = MuxCodec.encodePing(t);
        assertEquals(t, MuxCodec.decodePing(ping, ping.length));
        assertEquals(-1, MuxCodec.decodePing(f, f.length));
    }

    /** TCP SYN 10.88.0.2:50123 → 203.0.113.7:443 с правильными контрольными суммами. */
    private static byte[] sampleTcpSyn() {
        byte[] p = new byte[40];
        p[0] = 0x45;
        Packets.put16(p, 2, 40);
        p[8] = 64;
        p[9] = Packets.PROTO_TCP;
        Packets.put32(p, 12, GAME);
        Packets.put32(p, 16, SERVER);
        Packets.put16(p, 20, 50123);
        Packets.put16(p, 22, 443);
        Packets.put32(p, 24, 12345);       // seq
        p[32] = 0x50;                      // длина заголовка 20
        p[33] = 0x02;                      // SYN
        Packets.put16(p, 34, 65535);       // окно
        Packets.rewriteTcp(p, GAME, 50123, SERVER, 443); // проставит суммы
        return p;
    }
}
