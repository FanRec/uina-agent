# MO 原版与安装副本比较

日期：2026-10-10。本文记录重构前的只读检查；当时没有修改模型、VTS 配置、认证或运行代码，没有注入参数。比较脚本通过标准输入执行，未创建临时脚本文件。后续代码已用模型适配编译器替代固定名单与 retargeter，本文保留原始根因证据；真实模型文件仍未改动，实施状态见 [MODEL-ADAPTATION.md](./MODEL-ADAPTATION.md)。

## 比较对象与证据边界

- 原版：`C:/Users/34150/Downloads/Compressed/MO.v1.3.3`
- 安装副本：`G:/Program Files/Steam/steamapps/common/VTube Studio/VTube Studio_Data/StreamingAssets/Live2DModels/MO.v1.3.3`
- 两份配置的模型 ID 均为 `da0021cd32ee464ca41f980e8c32515b`。
- VTS 的 `Config/model_history.json` 将该安装副本记录为最近加载的主模型。
- 检查时未检测到运行中的 VTS 进程或本地 8001 端口连接，因此未核验内存中的活动模型、真实参数范围和视觉效果。结论适用于上述磁盘文件，不能重建全部历史修改过程。

## 模型资产没有被替换

原版共 19 个文件。18 个与安装副本 SHA-256 相同，唯一不同的原有文件是 `MO.vtube.json`。

完全相同的文件包括 `MO.moc3`、`MO.model3.json`、`MO.cdi3.json`、`MO.physics3.json`、10 张纹理、图标和 3 个 motion 文件。因此两份文件之间没有模型本体、参数 ID、显示名称或物理文件的替换证据。

两份 `MO.moc3` 的 SHA-256 均为：

```text
4dffd1f4fe58528dfbc3ff2fa5fca1aa3dd90bd26d22015699c3e8010fb30a24
```

安装副本额外包含 `1.exp3.json`、`items_pinned_to_model.json` 与 `MO.vtube.json.bak`。

## VTS 绑定的实际变化

按 Input + OutputLive2D 比较，原有 27 条绑定没有删除或改名。安装副本增加一条绑定，合计 28 条。

| 项目 | 原版 | 安装副本 |
| --- | --- | --- |
| `VoiceVolume -> ParamMouthOpenY` | 无 | 新增，输入 0..1，输出 0..2.1 |
| `MouthSmile -> ParamMouthForm` 的输出下限 | -1 | 0 |
| `JawOpen -> Param125` 的 `UseBreathing` | false | true |

其余原有绑定项的字段相同。备份文件保持 27 条绑定和嘴形下限 -1，但同样将 Param125 的 UseBreathing 设置为 true。

安装副本另有模型位置、音量、追踪丢失待机、热键和 VTS 元数据差异。新增表情文件包含 60 个参数值，配置为热键切换；这是外观/表达设置，不是模型参数 ID 重命名。

## 创建了自定义输入，但没有绑定到 MO

VTS 的 `Config/custom_parameters.json` 保存 7 个由 `Uina Live2D VTS` 创建的输入：

```text
ParamEyeRSmile, ParamEyeLSmile, ParamBreath,
ParamBodyAngleX, ParamBodyAngleY, ParamBodyAngleZ, ParamCheek
```

MO 安装副本的 28 条 ParameterSettings 中，没有一条将 Input 指向这些名称。创建输入与建立模型绑定是两个步骤，同名输入和输出不能被当作已接线。

当前保存关系仍为：眼笑与嘴形共用 MouthSmile；躯干与头角共用 FaceAngleX/Y/Z；呼吸 Input 为空，UseBreathing 为 true。这些自定义输入未提供独立眼笑、躯干或呼吸的接线证据。

## 现有适配器确实跳过自定义模型参数

MO 的参数显示信息列出 309 个参数项。原版与安装副本都保留这些自定义参数和绑定，例如：

| 模型参数 | 显示名称 | 保存输入 |
| --- | --- | --- |
| Param122 | 歪嘴 | MouthX |
| Param123 | widen 嘴寬 | MouthPucker |
| Param124 | srugh 收下巴 | MouthShrug |
| Param125 | jaw 突下巴 | JawOpen |
| Param126 | 鼓嘴 | CheekPuff |

当前 `vts-axis-adapter.ts` 的 CUBISM_AXES/CUBISM_CHANNELS 固定表没有这些参数；`VTSParameterRetargeter.configure` 因此跳过这些绑定。VTSClient 的初始化可控检查也使用同一固定表。因此即使输入存在并可注入，现有 Uina 通用动作链仍不会驱动它们。检查时 VTS 没有运行，未实际确认上述输入在当前 API 中的可注入性。

此外 Param74 的显示名称是“腮红样式”，Param187 是“腮红上下”；不能仅凭名称将它们自动等同于当前 face.blush 的连续强度。模型适配需要语义确认。

## 对适配设计的影响

模型适配配置应分别描述逻辑轴、模型输出参数、VTS 注入入口、保存绑定、校准和耦合关系。可控性校验必须覆盖整条链路，状态应区分参数未识别、输入未创建、输入不可注入、未绑定、共享绑定和物理覆盖。

参数名称支持应从固定表迁入模型适配配置；非标准面部自由度需要明确的逻辑轴语义。服装、发型等外观参数则沿用独立的表情/热键能力，不自动塞入连续运动轴。

此次磁盘证据不支持“必须替换模型本体参数才能控制”的结论；也不能证明此前某个阶段的接线是否曾存在又被覆盖。接下来应以当前保存绑定与 API 输入清单核对完整控制链，避免把创建成功或同名误认为可呈现。

## 物理、内置来源与重复输出的补充核查

安装配置启用物理，强度 50，使用非 Legacy 模式；模型物理文件共 49 组，Meta.Fps 为 60。保存的 Live2DPhysicsFPS=3 是设置编码，不能据此解释为 3 FPS，活动 FPS 需要 VTS API 核验。

| 物理组 | 输入 | 输出 |
| --- | --- | --- |
| PhysicsSetting5 | ParamAngleX | ParamBodyAngleX |
| PhysicsSetting6 | ParamAngleY | ParamBodyAngleY |
| PhysicsSetting8 | ParamAngleZ | ParamBodyAngleZ |
| PhysicsSetting13 | ParamMouthForm | ParamEyeLSmile、ParamEyeRSmile、Param190、Param191 |

上述输出权重均为 100。因此解除共享输入后仍存在物理写入来源；仅创建专用输入不能证明躯干/眼笑独立。官方控制来源规则与准备方案见 [MODEL-ADAPTATION.md](./MODEL-ADAPTATION.md)。

VTS 官方手册说明 Auto-breath 忽略输入。MO ParamBreath 的空输入应归类为内置来源；Param125 的 UseBreathing=true 也不能被当作有效 JawOpen 连续控制链。

安装配置中 MouthOpen 和 VoiceVolume 两条记录都指向 ParamMouthOpenY。官方手册描述每个输出只能被选择一次，保存文件存在需核验的歧义；未运行 VTS，不能推断内存取哪一条或是否叠加。新增 1.exp3.json 不包含本次核查的躯干、眼笑、呼吸、Param125、嘴形和嘴开合目标；这不替代所有表情/动画资源审计。

## 当前代码的离线实调证据

通过标准输入调用生产 `loadModelProfile` 与 `VTSParameterRetargeter`，没有创建脚本文件或注入真实 VTS：

- 28 条保存设置仅得到 27 条映射，空输入自动呼吸行未保留。
- Param122..126 五条绑定读入成功，但注入结果不包含 MouthX、MouthPucker、MouthShrug、JawOpen 或 CheekPuff。
- 仅设置 torso.yaw=10 时，输出与中性逻辑帧完全一致；设置 head.yaw=15 时，输出包含 FaceAngleX=15。

这确认了当前适配链的丢弃/耦合行为，不证明任何真实画面效果。
