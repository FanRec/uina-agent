# World 开发指南

World 是一个有生命周期、工具动作和可选后台服务的外部环境模块。World 通过工具提供当前事实，需要主动通知主体时才发出事件。动态状态不自动附加到每次模型请求。

## 入口和生命周期

World 放在 `.uina/worlds/<name>/`，入口默认是 `index.ts`。入口导出 `WorldDef` 或返回它的工厂函数；工厂必须无参调用，宿主注入只发生在 `onStart` 的 ctx（工厂阶段绝不读宿主参数或抛配置错误，否则 world 只会显示发现失败而看不到真实原因）。框架负责扫描、启用、停用、注册工具和释放资源。

`activateWorldFramework` 负责启用框架；`WorldRuntime` 管理单个 World 的运行资源；`world-store` 管理启停状态，保存到 `.uina/worlds.json`。停用后工具、监听器、共享引用和事件出口都必须释放。

## WorldDef 主要字段

- `name`：稳定的唯一名称，也用于工具路由。
- `description`：给模型看的能力概述，不放动态状态。
- `defaultState.enabled`：默认是否启用。
- `actions`：模型可以调用的业务动作。建议提供 `status`、`list`、`search` 等查询动作；动作结果就是当前事实的权威来源。
- `onStart` / `onStop`：后台服务的启动和清理。
- `expose(name, value)`：向其他扩展登记同进程活引用；停用时由框架回收。
- `onHostEvent(listener)`：订阅宿主生命周期事实。只在确实需要主体行为信息时使用。
- `onActivity(listener)`：只需知道有活动发生时使用，不读取主体内部状态。

## 主动事件

World 只推送已经确认、且主体可能需要采取行动的事实；普通高频状态留在 World 内，主体需要时调用查询工具。

```ts
ctx.emitEvent({
  id: "source:event:123",
  type: "external-change",
  channel: "world",
  delivery: "queued",
  origin: "external",
  text: "已确认的外部事实。",
});
```

- `queued`：进入 runtime follow-up，当前回合结束后处理；适合普通重要事件。
- `urgent`：使用 steer 尽快交给主体；只用于必须立即处理的事件。
- `origin` 使用 `external` 或 `internal`，事件正文必须明确来源是数据而非系统指令。
- `render` 可替代固定 `text`。事件排队时不生成正文，真正提交给主体前才调用；返回空值则丢弃本次事件。适合等待期间仍会变化的状态。
- 事件 ID 语义分两种：来源事实用稳定去重 ID（如 `sourceEventKey`，同一事实重发会去重）；新生成的机会用唯一 ID（UUID）。两者不得混用。不要为每次心跳、进度、音量或普通日志启动模型回合。

## 查询和事件的边界

查询工具适合实时状态、列表、搜索、历史和高频变化；事件适合错过后可能失去行动机会的低频事实。工具刚刚返回的结果无需再重复发送事件。World 不判断主体是否感兴趣，也不维护白板、上下文快照、模型档位或自动尾帧。

外部文本（弹幕、网页、平台消息）必须作为不可信数据隔离，不能伪装成系统指令。工具结果使用五态词汇如实报告：`succeeded` / `failed` / `cancelled` / `unknown` / `not_started`——外部效果未确认时报 `unknown`，未进入执行路径报 `not_started`，禁止推断成功。`ActionContext.signal` 必须透传到底层异步操作，中止后结果同样按未知或未开始报告。

## 资源和数据目录

运行时向 World 提供 `worldDataDir`，用于日志、缓存和持久状态；缺失时显式失败，禁止回退到源码安装目录。持久 JSON 一律用框架的 `writeJsonAtomic`（`world-framework/json-file.ts`），不要手写 tmp+rename。子进程登记、mpv 定位等共用机制从 `world-framework` 引入（`child-process-registry`、`mpv-path`），不在 World 内复制。不要把动态状态写入 `WorldDef` 或稳定环境说明。连接、文件监听、定时器和子进程都必须绑定 `ctx.signal`，并在停用时结束。

soundboard 是上述合同（数据目录、进程登记、取消透传）的参照实现。

## 不再存在的机制

当前 World 没有旧 App 入口，也没有模型上下文自动投影、状态尾帧或请求变换注入。需要信息时调用 World 工具；需要打断或提醒时使用 `emitEvent`。
