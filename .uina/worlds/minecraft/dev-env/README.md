# Minecraft 开发环境（dev-env）

更新时间：2026-10-19。本目录承担总规划 §4-A 的"固定可复位真实服务端"职责；
`server/` 整体被 .gitignore 忽略，可随时删除重建。

## 固定组合

| 项 | 值 |
|---|---|
| 服务端 | Paper 1.21.11 build 132（`server/paper-1.21.11-132.jar`） |
| Java | Java 21（本机 `java` 命令，21.0.9 已核实） |
| 模式 | offline（`online-mode=false`）；Microsoft 正版验收另走独立配置，不在本环境 |
| 端口 | 25565（默认；被占用时在 start 脚本改 server.properties） |
| 世界名 | `world`（默认 level-name，Uina 侧显式绑定此值） |
| 客户端 | npm mineflayer 4.39.0（minecraft-protocol 1.68.0，协议上限 1.21.11） |
| 参考源码 | `E:/Uina/ThirdParty/mineflayer`（PrismarineJS 克隆，适配层核对用；运行时依赖仍是 npm 锁定版本） |

## 数据归属

| 路径 | 归属 | 说明 |
|---|---|---|
| `dev-env/server/` | MC 世界本体 | 服务端 jar、world 存档、server.properties、EULA；git 忽略，可整体删除复位 |
| `.uina/world-data/minecraft/` | Uina 世界数据 | runtime.db、world-history.db、programs/ 等由各所有者模块写入；只清这个目录 ≠ 复位 MC 存档，两者互不代管 |

## 启动与复位

```powershell
# 首次启动（会生成 eula.txt，需先改 eula=true）
pwsh -File dev-env/start-server.ps1

# 复位：删除 server/world* 目录后重新启动（只复位 MC 存档，不动 Uina 数据）
pwsh -File dev-env/reset-server.ps1
```

start-server.ps1 为 UTF-8 带 BOM：Windows PowerShell 5.1 按无 BOM 的 ANSI 解析中文注释会报
语法错误（批20 实测），编辑此文件后必须保留 BOM。

首次启动流程：`start-server.ps1` 首跑生成 `eula.txt` 与 `server.properties` →
自动写入 `eula=true`、`online-mode=false` → 需要重启一次服务端生效。
场景准备与结果断言属于验证代码，放在 `tests/` 或验证脚本，不进入本目录。
