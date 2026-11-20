package app.hub.boost;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(HubBoostPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
