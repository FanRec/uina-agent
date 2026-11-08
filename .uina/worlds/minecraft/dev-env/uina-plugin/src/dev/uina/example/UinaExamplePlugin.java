package dev.uina.example;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import io.papermc.paper.dialog.Dialog;
import io.papermc.paper.event.player.PlayerCustomClickEvent;
import io.papermc.paper.registry.data.dialog.ActionButton;
import io.papermc.paper.registry.data.dialog.DialogBase;
import io.papermc.paper.registry.data.dialog.action.DialogAction;
import io.papermc.paper.registry.data.dialog.body.DialogBody;
import io.papermc.paper.registry.data.dialog.input.DialogInput;
import io.papermc.paper.registry.data.dialog.type.DialogType;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.key.Key;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.title.Title;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.NamespacedKey;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.plugin.messaging.PluginMessageListener;
import org.bukkit.scoreboard.Criteria;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Scoreboard;

/**
 * Paper-side test fixture for Uina's universal server-interaction surface.
 *
 * <p>It is deliberately a fixture, not a menu framework: every shape here exists to make one
 * protocol behaviour observable from the client with real server-side evidence.
 *
 * <p>Commands (all require op or the console):
 * <pre>
 *   /uina_menu            open the 9x3 test menu (buttons + price that changes on refresh)
 *   /uina_menu_refresh    reopen the menu with new prices (advances the UI revision)
 *   /uina_hud             sidebar + boss bar + title + action bar + tab header
 *   /uina_chat_actions    chat line with run_command / custom / show_dialog click events
 *   /uina_say &lt;text&gt;      echo a system chat line (evidence that a click ran)
 *   /uina_dialog_submit   command used by the dialog command-template button
 * </pre>
 *
 * <p>Wire contract for the original custom channel ({@code uina:example}, UTF-8 JSON):
 * <pre>
 *   client -> server  {"op":"press","times":N}
 *   client -> server  {"op":"state"}
 *   server -> client  {"op":"state","counter":N,"item":"example:uina_token","serverTime":"..."}
 * </pre>
 */
public final class UinaExamplePlugin extends JavaPlugin implements PluginMessageListener, Listener {

    public static final String CHANNEL = "uina:example";
    private static final Pattern TIMES = Pattern.compile("\"times\"\\s*:\\s*(\\d+)");

    /** Menu slot map: fixed so the client-side test can assert exact digests per slot. */
    private static final int SLOT_BUY = 11;
    private static final int SLOT_REFRESH = 13;
    private static final int SLOT_SILENT = 15;
    private static final int SLOT_CLOSE = 22;

    private final Map<UUID, Integer> counters = new HashMap<>();
    /** Per-player menu variant: bumping it changes every price, hence every button digest. */
    private final Map<UUID, Integer> menuVariants = new HashMap<>();
    /** Per-player purchase counter, mirrored into the sidebar so the client can cross-check. */
    private final Map<UUID, Integer> purchases = new HashMap<>();
    private NamespacedKey tokenKey;

    @Override
    public void onEnable() {
        tokenKey = new NamespacedKey(this, "token_id");
        getServer().getMessenger().registerIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().registerOutgoingPluginChannel(this, CHANNEL);
        getServer().getPluginManager().registerEvents(this, this);
        getLogger().info("uina example channel ready: " + CHANNEL);
    }

    @Override
    public void onDisable() {
        getServer().getMessenger().unregisterIncomingPluginChannel(this, CHANNEL, this);
        getServer().getMessenger().unregisterOutgoingPluginChannel(this, CHANNEL);
    }

    // ---- custom channel (unchanged fixture) ----

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

    // ---- commands ----

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        if (!(sender instanceof Player player)) {
            sender.sendMessage("this fixture only works for a player");
            return true;
        }
        switch (command.getName()) {
            case "uina_menu" -> {
                openMenu(player);
                return true;
            }
            case "uina_menu_refresh" -> {
                menuVariants.merge(player.getUniqueId(), 1, Integer::sum);
                openMenu(player);
                return true;
            }
            case "uina_hud" -> {
                applyHud(player);
                return true;
            }
            case "uina_chat_actions" -> {
                sendChatActions(player);
                return true;
            }
            case "uina_say" -> {
                String text = args.length == 0 ? "(empty)" : String.join(" ", args);
                player.sendMessage(Component.text("[uina] " + text, NamedTextColor.AQUA));
                return true;
            }
            case "uina_dialog_submit" -> {
                String note = args.length == 0 ? "(no note)" : String.join(" ", args);
                player.sendMessage(Component.text("[uina] dialog submit: " + note, NamedTextColor.GREEN));
                return true;
            }
            default -> {
                return false;
            }
        }
    }

    // ---- menu ----

    /** Marker holder: only inventories carrying it are handled, so ordinary chests stay vanilla. */
    static final class MenuHolder implements InventoryHolder {
        private final UUID owner;
        private Inventory inventory;

        MenuHolder(UUID owner) {
            this.owner = owner;
        }

        UUID owner() {
            return owner;
        }

        @Override
        public Inventory getInventory() {
            return inventory;
        }

        void bind(Inventory inventory) {
            this.inventory = inventory;
        }
    }

    private void openMenu(Player player) {
        int variant = menuVariants.getOrDefault(player.getUniqueId(), 0);
        MenuHolder holder = new MenuHolder(player.getUniqueId());
        Inventory inventory = Bukkit.createInventory(holder, 27, Component.text("Uina Test Menu"));
        holder.bind(inventory);
        int price = 3 + variant;
        inventory.setItem(SLOT_BUY, button(Material.DIAMOND, "Buy Diamond", "cost " + price + " emeralds", variant));
        inventory.setItem(SLOT_REFRESH, button(Material.ARROW, "Refresh Prices", "variant " + variant, variant));
        inventory.setItem(SLOT_SILENT, button(Material.BOOK, "Silent Notice", "chat only, no screen change", variant));
        inventory.setItem(SLOT_CLOSE, button(Material.BARRIER, "Close", "closes this menu", variant));
        player.openInventory(inventory);
    }

    private ItemStack button(Material material, String name, String lore, int variant) {
        ItemStack stack = new ItemStack(material, 1);
        ItemMeta meta = stack.getItemMeta();
        meta.displayName(Component.text(name, NamedTextColor.GOLD));
        List<Component> lines = new ArrayList<>();
        lines.add(Component.text(lore, NamedTextColor.GRAY));
        lines.add(Component.text("variant " + variant, NamedTextColor.DARK_GRAY));
        meta.lore(lines);
        stack.setItemMeta(meta);
        return stack;
    }

    @EventHandler
    public void onInventoryClick(InventoryClickEvent event) {
        if (!(event.getView().getTopInventory().getHolder() instanceof MenuHolder holder)) return;
        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player)) return;
        if (!holder.owner().equals(player.getUniqueId())) return;
        int slot = event.getSlot();
        if (event.getClickedInventory() != event.getView().getTopInventory()) return;
        // 服务端侧证据：每次按钮点击都在服务器日志留一行，客户端读数必须能对上。
        getLogger().info("menu click: " + player.getName() + " slot=" + slot
            + " variant=" + menuVariants.getOrDefault(player.getUniqueId(), 0));
        switch (slot) {
            case SLOT_BUY -> {
                int price = 3 + menuVariants.getOrDefault(player.getUniqueId(), 0);
                ItemStack cost = new ItemStack(Material.EMERALD, price);
                if (!player.getInventory().containsAtLeast(cost, price)) {
                    player.sendMessage(Component.text("[uina] not enough emeralds", NamedTextColor.RED));
                    return;
                }
                player.getInventory().removeItem(cost);
                player.getInventory().addItem(new ItemStack(Material.DIAMOND, 1));
                int bought = purchases.merge(player.getUniqueId(), 1, Integer::sum);
                player.sendMessage(Component.text("[uina] bought a diamond (" + bought + " total)", NamedTextColor.GREEN));
                applyHud(player);
                // 价格随购买次数上涨：内容真的变了，客户端应看到 uiRevision 推进。
                menuVariants.merge(player.getUniqueId(), 1, Integer::sum);
                openMenu(player);
            }
            case SLOT_REFRESH -> {
                menuVariants.merge(player.getUniqueId(), 1, Integer::sum);
                openMenu(player);
            }
            case SLOT_SILENT ->
                player.sendMessage(Component.text("[uina] silent notice: no screen change", NamedTextColor.YELLOW));
            case SLOT_CLOSE -> player.closeInventory();
            default -> {
                // 空白槽也取消点击，避免把菜单物品拖进背包。
            }
        }
    }

    // ---- HUD ----

    private void applyHud(Player player) {
        Scoreboard scoreboard = Bukkit.getScoreboardManager().getNewScoreboard();
        Objective objective = scoreboard.registerNewObjective("uina_hud", Criteria.DUMMY, Component.text("Uina HUD"));
        objective.setDisplaySlot(DisplaySlot.SIDEBAR);
        objective.getScore("diamonds").setScore(purchases.getOrDefault(player.getUniqueId(), 0));
        objective.getScore("variant").setScore(menuVariants.getOrDefault(player.getUniqueId(), 0));
        player.setScoreboard(scoreboard);
        player.showBossBar(
            BossBar.bossBar(Component.text("Uina Boss"), 0.5f, BossBar.Color.RED, BossBar.Overlay.PROGRESS));
        player.showTitle(Title.title(Component.text("Uina Title"), Component.text("subtitle line")));
        player.sendActionBar(Component.text("action bar line"));
        player.sendPlayerListHeaderAndFooter(
            Component.text("Uina Header", NamedTextColor.GOLD), Component.text("Uina Footer", NamedTextColor.GRAY));
    }

    // ---- chat text actions + dialog ----

    private void sendChatActions(Player player) {
        Dialog dialog = buildDialog();
        Component line = Component.text("[uina] actions: ", NamedTextColor.GRAY)
            .append(Component.text("[run]", NamedTextColor.AQUA)
                .clickEvent(ClickEvent.runCommand("/uina_say clicked-run")))
            .append(Component.text(" "))
            .append(Component.text("[custom]", NamedTextColor.LIGHT_PURPLE)
                .clickEvent(ClickEvent.custom(Key.key("uina", "probe"), "from-chat")))
            .append(Component.text(" "))
            .append(Component.text("[dialog]", NamedTextColor.GOLD)
                .clickEvent(ClickEvent.showDialog(dialog)));
        player.sendMessage(line);
    }

    /**
     * Multi-action dialog with the three real button encodings Uina must tell apart:
     * a command template, a custom click action, and a static run_command click event.
     */
    private Dialog buildDialog() {
        ActionButton submit = ActionButton.builder(Component.text("Submit"))
            .tooltip(Component.text("runs the command template with the note input"))
            .action(DialogAction.commandTemplate("uina_dialog_submit $(note)"))
            .build();
        ActionButton custom = ActionButton.builder(Component.text("Custom"))
            .tooltip(Component.text("sends a custom click action with the note"))
            .action(DialogAction.customClick(Key.key("uina", "dialog_submit"), null))
            .build();
        ActionButton close = ActionButton.builder(Component.text("Close"))
            .tooltip(Component.text("static click event: plain command"))
            .action(DialogAction.staticAction(ClickEvent.runCommand("/uina_say dialog-close")))
            .build();
        DialogBase base = DialogBase.builder(Component.text("Uina Dialog"))
            .canCloseWithEscape(true)
            .body(List.of(DialogBody.plainMessage(Component.text("Pick an action to send a note."), 300)))
            .inputs(List.of(DialogInput.text("note", Component.text("Note")).maxLength(64).build()))
            .build();
        // Dialog.create 拿到的是 RegistryBuilderFactory，必须先 empty() 才有 base()/type()。
        return Dialog.create(factory -> factory.empty()
            .base(base)
            .type(DialogType.multiAction(List.of(submit, custom, close)).build()));
    }

    @EventHandler
    public void onCustomClick(PlayerCustomClickEvent event) {
        // BinaryTagHolder 只暴露 SNBT 字符串（string()），没有 asString()。
        String tag = event.getTag() == null ? "null" : event.getTag().string();
        getLogger().info("custom click action: " + event.getIdentifier().asString() + " tag=" + tag);
        Bukkit.broadcast(Component.text(
            "[uina] custom click " + event.getIdentifier().asString() + " tag=" + tag, NamedTextColor.LIGHT_PURPLE));
    }
}
