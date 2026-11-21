package app.hub.boost;

import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Ускоритель: VPN только для выбранной игры.
 *
 *  • UDP игры (матчи, от него зависит пинг) → узел Hub Boost (режим HELLO2) → игровой сервер.
 *  • TCP (лобби, загрузки) → напрямую, через локальный прокси, чтобы игра не ломалась.
 *  • DNS → напрямую.
 * Остальные приложения телефона VPN не затрагивает.
 */
public class BoostVpnService extends VpnService {
    public static final String ACTION_START = "app.hub.boost.START";
    public static final String ACTION_STOP = "app.hub.boost.STOP";
    private static final String TAG = "HubBoost";
    private static final String TUN_ADDR = "10.88.0.2";
    private static final int TUN_IP = Packets.ipFromString(TUN_ADDR);
    private static final int TCP_SYN = 0x02;
    private static final int TCP_ACK = 0x10;

    // Состояние для экрана приложения (читает HubBoostPlugin).
    static volatile String state = "stopped";
    static volatile String error = null;
    static volatile String game = null;
    static volatile double rttMs = -1;
    static volatile double jitterMs = 0;
    static volatile double loss = 0;
    static final AtomicLong upBytes = new AtomicLong();
    static final AtomicLong downBytes = new AtomicLong();
    static volatile List<String> boostedPackages = new ArrayList<>();

    private volatile boolean active;
    private ParcelFileDescriptor tun;
    private FileOutputStream tunOut;
    private DatagramSocket relay;
    private ServerSocket tcpProxy;
    private int tcpProxyPort;
    private ExecutorService pool;
    private String helloMessage;
    /** Порт приложения → {IP сервера, порт сервера, время последнего пакета}. */
    private final Map<Integer, long[]> tcpNat = new ConcurrentHashMap<>();

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            shutdown();
            stopSelf();
            return START_NOT_STICKY;
        }
        final String host = intent.getStringExtra("host");
        final int port = intent.getIntExtra("port", 0);
        final String token = intent.getStringExtra("token");
        final String[] packages = intent.getStringArrayExtra("packages");
        game = intent.getStringExtra("game");
        shutdown();
        new Thread(() -> start(host, port, token, packages), "boost-start").start();
        return START_NOT_STICKY;
    }

    @Override
    public void onRevoke() {
        shutdown();
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        shutdown();
        super.onDestroy();
    }

    private void start(String host, int port, String token, String[] packages) {
        state = "connecting";
        error = null;
        rttMs = -1;
        jitterMs = 0;
        loss = 0;
        upBytes.set(0);
        downBytes.set(0);
        try {
            relay = new DatagramSocket();
            protect(relay);
            relay.connect(new InetSocketAddress(InetAddress.getByName(host), port));
            helloMessage = "HELLO2 " + token;
            handshake();

            tcpProxy = new ServerSocket();
            tcpProxy.bind(new InetSocketAddress(0));
            tcpProxyPort = tcpProxy.getLocalPort();

            Builder b = new Builder()
                .setSession("Hub Boost")
                .addAddress(TUN_ADDR, 32)
                .addRoute("0.0.0.0", 0)
                .addDnsServer("1.1.1.1")
                .setMtu(1400)
                .setBlocking(true);
            List<String> installed = new ArrayList<>();
            for (String pkg : packages == null ? new String[0] : packages) {
                try {
                    b.addAllowedApplication(pkg);
                    installed.add(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // игра не установлена
                }
            }
            if (installed.isEmpty()) throw new IOException("Игра не установлена на этом телефоне");
            // Своё приложение тоже в VPN: так ответы локального TCP-прокси возвращаются в игру.
            // Собственные соединения наружу защищены protect() и идут мимо VPN.
            b.addAllowedApplication(getPackageName());
            boostedPackages = installed;

            tun = b.establish();
            if (tun == null) throw new IOException("Нет разрешения на VPN");
            tunOut = new FileOutputStream(tun.getFileDescriptor());
            active = true;
            pool = Executors.newCachedThreadPool();
            pool.execute(this::tunLoop);
            pool.execute(this::relayLoop);
            pool.execute(this::pingLoop);
            pool.execute(this::tcpAcceptLoop);
            state = "running";
            Log.i(TAG, "boost started via " + host + ":" + port + " for " + installed);
        } catch (Exception e) {
            Log.w(TAG, "start failed", e);
            error = e.getMessage();
            shutdown();
            state = "error";
        }
    }

    /** Рукопожатие с узлом: HELLO2 <токен> → OK2. */
    private void handshake() throws IOException {
        byte[] hello = helloMessage.getBytes(StandardCharsets.UTF_8);
        byte[] buf = new byte[64];
        relay.setSoTimeout(2000);
        for (int attempt = 0; attempt < 3; attempt++) {
            relay.send(new DatagramPacket(hello, hello.length));
            try {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                relay.receive(p);
                String reply = new String(buf, 0, p.getLength(), StandardCharsets.UTF_8);
                if (reply.equals("OK2")) { relay.setSoTimeout(0); return; }
                if (reply.startsWith("ERR")) throw new IOException("Узел отказал: " + reply.substring(4));
            } catch (java.net.SocketTimeoutException ignored) {
                // повторяем
            }
        }
        throw new IOException("Узел не отвечает");
    }

    private void writeTun(byte[] packet, int len) {
        FileOutputStream out = tunOut;
        if (out == null) return;
        synchronized (this) {
            try { out.write(packet, 0, len); } catch (IOException e) { if (active) Log.w(TAG, "tun write", e); }
        }
    }

    // ---------- Пакеты из игры ----------

    private void tunLoop() {
        byte[] buf = new byte[32767];
        try (FileInputStream in = new FileInputStream(tun.getFileDescriptor())) {
            while (active) {
                int n = in.read(buf);
                if (n <= 0 || !Packets.isValidIpv4(buf, n)) continue;
                int proto = Packets.protocol(buf);
                if (proto == Packets.PROTO_UDP) onUdpFromApp(buf);
                else if (proto == Packets.PROTO_TCP) onTcpPacket(buf);
            }
        } catch (IOException e) {
            if (active) Log.w(TAG, "tun read", e);
        }
    }

    private void onUdpFromApp(byte[] p) {
        int dst = Packets.dstIp(p);
        int dport = Packets.dstPort(p);
        int sport = Packets.srcPort(p);
        int off = Packets.udpPayloadOffset(p);
        int len = Packets.udpPayloadLength(p);
        if (dport == 53) {
            final byte[] query = java.util.Arrays.copyOfRange(p, off, off + len);
            pool.execute(() -> resolveDirect(dst, sport, query));
            return;
        }
        if (Packets.isPrivate(dst)) return;
        byte[] frame = MuxCodec.encodeData(dst, dport, sport, p, off, len);
        try {
            relay.send(new DatagramPacket(frame, frame.length));
            upBytes.addAndGet(len);
        } catch (IOException e) {
            if (active) Log.w(TAG, "relay send", e);
        }
    }

    private void resolveDirect(int dnsIp, int appPort, byte[] query) {
        try (DatagramSocket s = new DatagramSocket()) {
            protect(s);
            s.setSoTimeout(3000);
            InetAddress server = InetAddress.getByAddress(ipBytes(dnsIp));
            s.send(new DatagramPacket(query, query.length, server, 53));
            byte[] buf = new byte[4096];
            DatagramPacket reply = new DatagramPacket(buf, buf.length);
            s.receive(reply);
            byte[] packet = Packets.buildUdp(dnsIp, 53, TUN_IP, appPort, buf, 0, reply.getLength());
            writeTun(packet, packet.length);
        } catch (IOException ignored) {
            // игра повторит запрос
        }
    }

    /**
     * TCP перенаправляем на локальный прокси, переписывая адреса прямо в пакетах:
     *   игра (10.88.0.2:sp → D:dp)  ⇒  (D:sp → 10.88.0.2:прокси)
     *   прокси (10.88.0.2:прокси → D:sp)  ⇒  (D:dp → 10.88.0.2:sp)
     * Прокси соединяется с D:dp напрямую (сокет защищён от VPN).
     */
    private void onTcpPacket(byte[] p) {
        int src = Packets.srcIp(p);
        int dst = Packets.dstIp(p);
        int sp = Packets.srcPort(p);
        int dp = Packets.dstPort(p);
        int len = Packets.totalLength(p);
        if (src != TUN_IP) return;
        if (sp == tcpProxyPort) {
            long[] orig = tcpNat.get(dp);
            if (orig == null) return;
            orig[2] = System.currentTimeMillis();
            Packets.rewriteTcp(p, (int) orig[0], (int) orig[1], TUN_IP, dp);
        } else {
            int flags = Packets.tcpFlags(p);
            long[] entry = tcpNat.get(sp);
            if ((flags & TCP_SYN) != 0 && (flags & TCP_ACK) == 0) {
                entry = new long[] {dst, dp, System.currentTimeMillis()};
                tcpNat.put(sp, entry);
            } else if (entry == null) {
                return;
            }
            entry[2] = System.currentTimeMillis();
            Packets.rewriteTcp(p, dst, sp, TUN_IP, tcpProxyPort);
        }
        writeTun(p, len);
    }

    private void tcpAcceptLoop() {
        while (active) {
            try {
                Socket client = tcpProxy.accept();
                pool.execute(() -> proxyTcp(client));
            } catch (IOException e) {
                if (active) Log.w(TAG, "accept", e);
            }
        }
    }

    private void proxyTcp(Socket client) {
        long[] orig = tcpNat.get(client.getPort());
        if (orig == null) { closeQuietly(client); return; }
        Socket remote = new Socket();
        try {
            protect(remote);
            remote.connect(new InetSocketAddress(InetAddress.getByAddress(ipBytes((int) orig[0])), (int) orig[1]), 10_000);
            remote.setTcpNoDelay(true);
            client.setTcpNoDelay(true);
            pool.execute(() -> pipe(remote, client));
            pipe(client, remote);
        } catch (IOException e) {
            closeQuietly(client);
            closeQuietly(remote);
        }
    }

    private static void pipe(Socket from, Socket to) {
        byte[] buf = new byte[16384];
        try {
            InputStream in = from.getInputStream();
            OutputStream out = to.getOutputStream();
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } catch (IOException ignored) {
            // соединение закрыто
        } finally {
            closeQuietly(from);
            closeQuietly(to);
        }
    }

    // ---------- Ответы от узла ----------

    private void relayLoop() {
        byte[] buf = new byte[65535];
        DatagramPacket p = new DatagramPacket(buf, buf.length);
        while (active) {
            try {
                p.setLength(buf.length);
                relay.receive(p);
                int n = p.getLength();
                if (MuxCodec.isData(buf, n)) {
                    int len = n - MuxCodec.HEADER;
                    byte[] packet = Packets.buildUdp(MuxCodec.serverIp(buf), MuxCodec.serverPort(buf), TUN_IP, MuxCodec.appPort(buf), buf, MuxCodec.HEADER, len);
                    writeTun(packet, packet.length);
                    downBytes.addAndGet(len);
                } else {
                    long sent = MuxCodec.decodePing(buf, n);
                    if (sent > 0) onPong(sent);
                }
            } catch (IOException e) {
                if (active) Log.w(TAG, "relay receive", e);
            }
        }
    }

    // ---------- Пинг до узла (каждую секунду) ----------

    private int pingsSent;
    private int pongsReceived;

    private synchronized void onPong(long sentNanos) {
        double rtt = (System.nanoTime() - sentNanos) / 1e6;
        if (rttMs >= 0) jitterMs = jitterMs * 0.8 + Math.abs(rtt - rttMs) * 0.2;
        rttMs = rtt;
        pongsReceived++;
    }

    private void pingLoop() {
        long lastHello = System.currentTimeMillis();
        while (active) {
            try {
                byte[] ping = MuxCodec.encodePing(System.nanoTime());
                relay.send(new DatagramPacket(ping, ping.length));
                synchronized (this) {
                    pingsSent++;
                    if (pingsSent >= 20) {
                        loss = Math.max(0, 1.0 - (double) pongsReceived / pingsSent);
                        pingsSent = 0;
                        pongsReceived = 0;
                    }
                }
                long now = System.currentTimeMillis();
                if (now - lastHello > 20_000) {
                    // Обновляем сессию на узле (на случай его перезапуска); потоки при этом сохраняются.
                    byte[] hello = helloMessage.getBytes(StandardCharsets.UTF_8);
                    relay.send(new DatagramPacket(hello, hello.length));
                    lastHello = now;
                    tcpNat.values().removeIf((e) -> now - e[2] > 300_000);
                }
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                return;
            } catch (IOException e) {
                if (active) Log.w(TAG, "ping", e);
            }
        }
    }

    // ---------- Остановка ----------

    private synchronized void shutdown() {
        active = false;
        if (pool != null) pool.shutdownNow();
        pool = null;
        closeQuietly(tcpProxy);
        tcpProxy = null;
        if (relay != null) relay.close();
        relay = null;
        try { if (tun != null) tun.close(); } catch (IOException ignored) { /* */ }
        tun = null;
        tunOut = null;
        tcpNat.clear();
        if (!"error".equals(state)) state = "stopped";
    }

    private static byte[] ipBytes(int ip) {
        return new byte[] {(byte) (ip >>> 24), (byte) (ip >>> 16), (byte) (ip >>> 8), (byte) ip};
    }

    private static void closeQuietly(java.io.Closeable c) {
        try { if (c != null) c.close(); } catch (IOException ignored) { /* */ }
    }
}
