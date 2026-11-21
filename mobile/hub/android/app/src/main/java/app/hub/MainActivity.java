package app.hub;

import android.os.Bundle;

import app.hub.boost.HubBoostPlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HubBoostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
