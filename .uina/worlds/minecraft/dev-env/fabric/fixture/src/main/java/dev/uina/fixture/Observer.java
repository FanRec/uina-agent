package dev.uina.fixture;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.gui.screens.ConnectScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.client.multiplayer.ServerData;
import net.minecraft.client.multiplayer.resolver.ServerAddress;

/** Observe the actual Minecraft screen and camera of the real spectator client. */
public final class Observer implements ClientModInitializer {
    private String previous = "";
    private boolean connecting;

    @Override
    public void onInitializeClient() {
        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            String server = System.getProperty("uina.fixture.observer");
            if (!connecting && server != null && client.screen instanceof TitleScreen title) {
                connecting = true;
                ConnectScreen.startConnecting(title, client, ServerAddress.parseString(server),
                        new ServerData("Uina fixture", server, ServerData.Type.OTHER), false, null);
            }
            if (client.level == null || client.getCameraEntity() == null) return;
            String camera = client.getCameraEntity().getName().getString();
            String screen = client.screen == null ? "none" : client.screen.getClass().getName();
            String observed = camera + " " + screen;
            if (!observed.equals(previous)) {
                System.out.println("UINA_OBSERVER " + observed);
                previous = observed;
            }
        });
    }
}
