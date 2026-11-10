package dev.uina.fixture;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.UUID;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerConfigurationConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerConfigurationNetworking;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.FriendlyByteBuf;
import net.minecraft.network.codec.ByteBufCodecs;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.storage.LevelResource;

public final class Fixture implements ModInitializer {
    private static final String NS = "uina_fixture";

    record Manifest(String json) implements CustomPacketPayload {
        static final Type<Manifest> TYPE = new Type<>(Identifier.fromNamespaceAndPath(NS, "manifest"));
        static final StreamCodec<FriendlyByteBuf, Manifest> CODEC =
                StreamCodec.composite(ByteBufCodecs.STRING_UTF8, Manifest::json, Manifest::new);
        public Type<Manifest> type() { return TYPE; }
    }

    private static String worldIdentity(Path world) {
        Path marker = world.resolve("uina-fixture-world-id");
        try {
            if (Files.notExists(marker)) {
                Files.writeString(marker, UUID.randomUUID().toString(), java.nio.file.StandardOpenOption.CREATE_NEW);
            }
            return UUID.fromString(Files.readString(marker).strip()).toString();
        } catch (IOException error) {
            throw new IllegalStateException("cannot read fixture world identity", error);
        }
    }

    @Override
    public void onInitialize() {
        Identifier tileId = Identifier.fromNamespaceAndPath(NS, "tile");
        ResourceKey<Block> blockKey = ResourceKey.create(Registries.BLOCK, tileId);
        Block tile = Registry.register(BuiltInRegistries.BLOCK, blockKey,
                new Block(BlockBehaviour.Properties.of().strength(1.5F).setId(blockKey)));
        ResourceKey<Item> tileItemKey = ResourceKey.create(Registries.ITEM, tileId);
        Item tileItem = Registry.register(BuiltInRegistries.ITEM, tileItemKey,
                new BlockItem(tile, new Item.Properties().setId(tileItemKey)));
        ResourceKey<Item> tokenKey = ResourceKey.create(Registries.ITEM, Identifier.fromNamespaceAndPath(NS, "token"));
        Item token = Registry.register(BuiltInRegistries.ITEM, tokenKey, new Item(new Item.Properties().setId(tokenKey)));
        PayloadTypeRegistry.configurationS2C().register(Manifest.TYPE, Manifest.CODEC);

        ServerLifecycleEvents.SERVER_STARTED.register(server -> worldIdentity(server.getWorldPath(LevelResource.ROOT)));
        ServerConfigurationConnectionEvents.BEFORE_CONFIGURE.register((handler, server) -> {
            String manifest = String.format(
                    "{\"world\":\"%s\",\"tileItem\":%d,\"tokenItem\":%d,\"tileBlock\":%d,\"tileState\":%d}",
                    worldIdentity(server.getWorldPath(LevelResource.ROOT)),
                    BuiltInRegistries.ITEM.getId(tileItem), BuiltInRegistries.ITEM.getId(token),
                    BuiltInRegistries.BLOCK.getId(tile), Block.getId(tile.defaultBlockState()));
            ServerConfigurationNetworking.send(handler, new Manifest(manifest));
        });
    }
}
