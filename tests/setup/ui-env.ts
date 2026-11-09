/**
 * 测试环境的终端能力固定为"有颜色"。
 *
 * `src/ui/core/utils.ts` 在模块加载时读 `NO_COLOR` / `TERM=dumb` 决定是否把所有
 * SGR 常量退化成空串。测试进程继承调用者的 shell，在 `TERM=dumb` 的终端里跑全量
 * 会让一整批"断言带样式渲染"的 UI 用例变成环境假红（同一份代码在 CI 上是绿的）。
 * 测试要可复现，就不能依赖调用者终端，这里在导入被测模块之前把开关定死。
 *
 * 降级路径没有被丢掉：`tests/ui-no-color.test.ts` 用子进程显式注入
 * `NO_COLOR=1` / `TERM=dumb` 覆盖，不靠继承环境。
 */
delete process.env.NO_COLOR;
process.env.TERM = "xterm-256color";
