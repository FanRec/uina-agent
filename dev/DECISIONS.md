# Uina 开发约定与预先决策

更新时间：2026-09-11

这里记录需要提前决定、且不应由每次开发临时改变的项目约定。源码、package.json 和可执行验证优先于本文。

## 启动方式

### 开发运行

    pnpm start

实际入口：`tsx src/main.ts`。

### 持续开发

    pnpm dev

使用 `tsx watch src/main.ts`，不作为验收证据。

### 构建后运行

    pnpm build
    pnpm start:dist

构建输出在 `dist/`。构建后运行用于验证编译产物和资源复制。

### 一次性模式

    UINA_ONESHOT_MSG="你好" pnpm start

PowerShell：`$env:UINA_ONESHOT_MSG="你好"; pnpm start`。

## 配置与数据

- Provider 配置：默认 `~/.uina/auth.json`，配置根可由 `UINA_HOME` 指定。
- 当前会话：`data/session.jsonl`。
- 项目扩展：当前工作目录下 `.uina/extensions/`，支持脚本、目录入口与 manifest；`-e/--extension` 可重复指定额外文件/目录。配置和会话路径不随扩展路径改变。
- 构建产物：`dist/`。
- 不把真实密钥、真实会话或生产数据放入测试 fixture、提交或共享日志。

## 验证入口

- 快速基线：`pnpm dev:baseline -- --quick`
- 完整基线：`pnpm dev:baseline`
- 类型和边界：`pnpm typecheck`
- 测试：`pnpm test`
- 构建：`pnpm build`
- 编译 CLI：`pnpm verify:cli`
- 文件事件：`pnpm verify:file-events`

## 固定约定

- 默认开发目标是源码运行：`pnpm start`。
- 只有涉及构建产物或资源复制时才运行 `start:dist`。
- 只有任务需要时才连接真实 Provider。
- 测试使用 fake/localhost Provider，并报告证据边界。
- 测试使用临时目录或内存 store，不修改 `data/session.jsonl`。
- 不通过自动切换 Provider、thinking、context window 或工具能力来让测试通过。
- 不改变启动方式、配置路径或会话路径而不更新本文和相关测试。

## 修改启动链路前

必须说明现有入口为何不足、新入口如何覆盖 TTY/stdio/无 UI、配置与会话所有权、语义兼容性以及是否改变用户数据位置。
