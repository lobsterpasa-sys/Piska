package app.hub.boost;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;

import java.util.List;

/** Мост между веб-интерфейсом Boost и VPN-сервисом: window.Capacitor.Plugins.HubBoost. */
@CapacitorPlugin(name = "HubBoost")
public class HubBoostPlugin extends Plugin {

    /** start({ host, port, token, packages: [...], game }) — запрашивает разрешение на VPN и запускает ускорение. */
    @PluginMethod
    public void start(PluginCall call) {
        if (call.getString("host") == null || call.getInt("port") == null || call.getString("token") == null) {
            call.reject("Нужны host, port и token");
            return;
        }
        Intent consent = VpnService.prepare(getContext());
        if (consent != null) startActivityForResult(call, consent, "onVpnConsent");
        else launch(call);
    }

    @ActivityCallback
    private void onVpnConsent(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() == Activity.RESULT_OK) launch(call);
        else call.reject("Без разрешения на VPN ускорение не работает");
    }

    private void launch(PluginCall call) {
        String[] packages;
        try {
            List<String> list = call.getArray("packages", new JSArray()).toList();
            packages = list.toArray(new String[0]);
        } catch (JSONException e) {
            call.reject("packages должен быть списком");
            return;
        }
        Intent intent = new Intent(getContext(), BoostVpnService.class)
            .setAction(BoostVpnService.ACTION_START)
            .putExtra("host", call.getString("host"))
            .putExtra("port", call.getInt("port"))
            .putExtra("token", call.getString("token"))
            .putExtra("game", call.getString("game"))
            .putExtra("packages", packages);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getContext().startService(new Intent(getContext(), BoostVpnService.class).setAction(BoostVpnService.ACTION_STOP));
        call.resolve();
    }

    /** Текущее состояние: running/connecting/stopped/error, пинг до узла, джиттер, потери, трафик. */
    @PluginMethod
    public void status(PluginCall call) {
        JSObject r = new JSObject();
        r.put("state", BoostVpnService.state);
        r.put("error", BoostVpnService.error);
        r.put("game", BoostVpnService.game);
        r.put("rttMs", BoostVpnService.rttMs);
        r.put("jitterMs", BoostVpnService.jitterMs);
        r.put("loss", BoostVpnService.loss);
        r.put("upBytes", BoostVpnService.upBytes.get());
        r.put("downBytes", BoostVpnService.downBytes.get());
        r.put("packages", new JSArray(BoostVpnService.boostedPackages));
        call.resolve(r);
    }

    /** Какие из перечисленных игр установлены на телефоне. */
    @PluginMethod
    public void installed(PluginCall call) {
        JSArray result = new JSArray();
        try {
            for (String pkg : call.getArray("packages", new JSArray()).<String>toList()) {
                try {
                    getContext().getPackageManager().getPackageInfo(pkg, 0);
                    result.put(pkg);
                } catch (PackageManager.NameNotFoundException ignored) {
                    // не установлена
                }
            }
        } catch (JSONException e) {
            call.reject("packages должен быть списком");
            return;
        }
        JSObject r = new JSObject();
        r.put("packages", result);
        call.resolve(r);
    }
}
