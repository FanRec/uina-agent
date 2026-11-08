package dev.uina.example;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import net.kyori.adventure.text.Component;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;

/**
 * Minimal Paper-side counterpart of the {@code example-mod} Uina addon.
 *
 * <p>It is a test fixture, not a general mod loader: it proves that a real server can
 * answer a custom channel, keep authoritative state and hand out an item whose identity
 * lives in item components. The payload is a tiny fixed-shape JSON object, parsed with
 * string matching on purpose so the fixture has no third-party dependency.
 *
 * <p>Wire contract ({@code uina:example}, UTF-8 JSON):
 * <pre>
 *   client -> server  {"op":"press","times":N}
 *   client -> server  {"op":"state"}
 *   server -> client  {"op":"state","counter":N,"item":"example:uina_token","serverTime":"..."}
 * </pre>
 */
public final class UinaExamplePlugin extends JavaPlugin implements PluginMessageListener {

    public static final String CHANNEL = "uina:example";
    private static final Pattern TIMES = Pattern.compile("\"times\"\\s*:\\s*(\\d+)");

    private final Map<UUID, Integer> counters = new HashMap<>();
    private NamespacedKey tokenKey;

    @Override
    public void onEnable() {
        tokenKey = new NamespacedKey(this, "token_id");
        getServer().getMessenger().registerIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
        getLogger().info("uina example channel ready: " + CHANNEL);
    }

    @Override
    public void onDisable() {
        getServer().getMessenger().unregisterIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().unregisterOutgoingPluginChannel(this, CHANNEL);
    }

    @Override
    public void onPluginMessageReceived(String channel, Player player, byte[] message) {
        getLogger().info("payload on " + channel + " from " + player.getName() + " (" + message.length + " bytes)");
        if (!CHANNEL.equals(channel)) return;
        String text = new String(message, StandardCharsets.UTF_8);
        if (text.contains("\"op\":\"press\"")) {
            int times = 1;
            Matcher matcher = TIMES.matcher(text);
            if (matcher.find()) {
                times = Math.max(1, Math.min(10, Integer.parseInt(matcher.group(1))));
            }
            int counter = counters.merge(player.getUniqueId(), times, Integer::sum);
            if (counter == times) {
                grantToken(player);
            }
            sendState(player, counter);
        } else if (text.contains("\"op\":\"state\"")) {
            sendState(player, counters.getOrDefault(player.getUniqueId(), 0));
        }
    }

    private void grantToken(Player player) {
        ItemStack stack = new ItemStack(Material.PAPER, 1);
        ItemMeta meta = stack.getItemMeta();
        meta.displayName(Component.text("Uina Token"));
        meta.getPersistentDataContainer().set(tokenKey, PersistentDataType.STRING, "example:uina_token");
        meta.setEnchantmentGlintOverride(Boolean.TRUE);
        stack.setItemMeta(meta);
        player.getInventory().addItem(stack);
    }

    private void sendState(Player player, int counter) {
        String payload = String.format(
            "{\"op\":\"state\",\"counter\":%d,\"item\":\"%s\",\"serverTime\":\"%s\"}",
            counter,
            counter > 0 ? "example:uina_token" : "",
            Instant.now().toString());
        player.sendPluginMessage(this, CHANNEL, payload.getBytes(StandardCharsets.UTF_8));
    }
}
