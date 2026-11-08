# Body API — 特殊动作与控制资格

只有高层 Capability 无法表达目标时才用 `mc.withBody(async body => {...})`。这是强大但更危险的原语：
导航、采集、合成、建造优先用对应 Capability，它们内部已处理观察、验收和局部纠错。

```js
async function main(mc) {
  return mc.withBody(async body => {
    await body.lookAt({ x: 10, y: 64, z: 10 });
    return { looked: true };
  });
}
```

## 合同要点

- `body` 可能提供 `drive/dig/attack/useItem/endUse/interact/equip/lookAt/openContainer/writeSign/feedback/loop` 等能力；精确入参与限制以当前版本 `describe` 的能力描述符为准，本文件不复制 schema。
- `body.loop(step, sensors)` 的 `step(frame)` **必须同步**返回 `ControlInput` 或 `{done:true}`。不能 `await`、不能返回 Promise、不能做长时间同步运算；帧窗约为实时控制反馈期限。
- `mc.withBody` 用 `Promise.race` 等 work 或"资格被撤销"。被 Safety、用户 Stop、断线或其他 Run 抢占后，旧 body handle 立即作废；**不要跨旧 handle 继续写**，不要沿用旧观察。
- 持有 Body 时**不要**等待另一个独立 Run 为你准备材料：独占资格会挡住别的动作。正确组合是分段、释放、观察、再申请。
- `mc.waitUntil` 不释放 `withBody` 持有的身体；需要其他任务供料时把等待写在 `withBody` 外。
- 默认自保（岩浆、缺氧、低血新伤害）可以打断身体。外层捕获 `INTERRUPTED` 后重读现场；`dispatch` 与 `effects` 说明已派发了什么，不凭错误文字猜"没发生"。

## Window

`openContainer` 产生 Window handle，提供 `snapshot() / click(args) / close()`，只支持 mode-0 左右点击。
`click` 的回执有 `dispatch` 与 `completion`：`completion:'unknown'` 表示**点击已派发但服务器权威同步没完成**。
此时：

1. 不重复提交原点击——它可能已经生效，重复会再次消耗或移动物品。
2. 按当前强制退出语义关闭这个不确定窗口（关闭动作自身也有 effect 记录），再用新会话与服务器同步重新观察。
3. 依据新的库存/槽位事实判断业务后置条件是否已达成，只从差额规划剩余动作。
4. Cursor 未清空前不做其他破坏性 inventory 操作；若新状态仍无法判定，保留 `UNKNOWN` 并交主脑，绝不假成功。

## 不要长期用底层代码绕过协议问题

用 Body 原语探索成功后，可以把稳定行为封装成 Program。若为规避上层窗口/控制协议 Bug 而长期编写危险的重复底层代码，应把问题反馈到 Driver 修复，而不是把补丁写进每个 Program。
