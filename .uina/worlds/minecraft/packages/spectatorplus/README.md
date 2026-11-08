# spectatorplus（Uina Addon）

把 Uina 自己的**个人背包窗口事务**起止，翻译成 SpectatorPlus 已经会处理的服务器入站
Payload。装了这个包，旁观 Uina 的真实 Fabric 客户端会在 Uina 穿脱装备、丢物品、
2×2 合成时看到它的个人背包界面，并在事务结束后自动关闭。

它**不是**服务端插件，也**不渲染任何东西**。渲染在观察者的 Fabric 客户端 Mod 里，
同步在服务器的 SpectatorPlus 里，本包只负责"告诉服务器 Uina 现在开了/关了个人背包"。

## 前置条件

服务端是 **Fabric + SpectatorPlus 服务端 Mod**（由服主自己安装）。客户端是
**Fabric + SpectatorPlus 客户端 Mod**。本包不安装、不分发、不探测这两者。

## 不支持 Paper

Paper 端只支持插件，SpectatorPlus 在那里是另一个实现：它的
`opened_inventory_sync` 处理器读 **0 字节**、只当作"打开"，没有关闭分支。也就是说
Uina 发 `00` 过去，Paper 会再当成一次打开——界面会重新弹出来，比不装更糟。

要支持 Paper 必须改服务端插件，那是上游的事。本包只做 Fabric 的 1 字节协议。

## 它不做什么

- 不新增 `spectatorplus.*` 工具或查询：界面是真实游戏操作的副作用，不需要 LLM 调用。
- 不重发箱子/工作台/熔炉的打开关闭：那些是服务端窗口，SpectatorPlus 自己会镜像；
  Uina 再发一遍只会和上游互相覆盖。
- 不猜界面：不根据物品数量变化推断"大概开了背包"。
- 不宣称画面成功：没有服务端 ACK，Uina 只知道"发出去了"。

## 安装与启用

```bash
pnpm mc:addon -- install .uina/worlds/minecraft/packages/spectatorplus
pnpm mc:addon -- enable spectatorplus --profile <64-hex profileId>
```

无配置项。启用写进该 Profile 的 `addons.json`，连接时冻结；改完要重连才生效。

## 协议

| phase | 通道 | 载荷 |
|---|---|---|
| `open` | `spectatorplus:opened_inventory_sync` | `01` |
| `close` | `spectatorplus:opened_inventory_sync` | `00` |

上游 Fabric 端 `ScreenSyncHandler` 收 `true` 走 `syncScreenOpened`，收 `false` 走
`syncScreenClosed`（广播带 `screen closed` 标志的界面包），所以这里不需要任何新通道。

## 已知限制

- 只声明 `1.21.11`；协议版本不匹配时 Driver 会拒绝装配。
- 个人背包界面需要观察者装 SpectatorPlus 客户端 Mod；没有 Mod 的观察者看不到。
- 上游未实现的 MERCHANT 界面不在本包范围。
- 极短的背包事务可能来不及渲染就被关闭；这是节奏问题，不是协议问题，未加人为延时。
- 没有任何服务端 ACK，`sent` 只代表字节已写入连接。

## 许可

本包是 Uina 自己的代码，不包含 [SpectatorPlus](https://github.com/yzxoi/SpectatorPlus)
（GPL-3.0）的任何源码，只按其公开协议收发字节。
