# 体态/动作：空纪的现场印象（2026-10-02 下午）

他在看，我在切，切一个记一句。**这是他的原话印象，不是我的判断。**

| 款 | 他的反应 | 备注 |
| --- | --- | --- |
| `playful` | 可以 | 头右歪 18，幅度大，看得清 |
| `smug_gremlin` | 可以 | 坏笑那款，现在能看了 |
| `meek_shy` | （跟着过了） | 之前"看不出"的三款之一 |
| `streamer_hype` | **"这个有bug"** | 具体是什么没说，等他有空讲 |
| `confident` | 嗯 | 挺胸款 |
| `focused` | **"感觉像是头后仰的感觉"** | 定义是"正坐前倾仰头"，仰头那部分可能过了 |
| `listening` / `shy_side` | （继续） | |

## cue 反馈
- `surprised_gasp` / `happy_laugh` / `winking` / `shrug` 都能看见。
- `shrug` 我提前说过"肩可能没接上"，他回"可以的"——说明肩是动的。

## 还没试
- 体态 `relaxed`（最后一个）。
- cue 里没试过的：`warm_smile`、`curious_tilt`、`double_nod`、`shake_head`、`head_bop`、`playful_pout`、`look_away`、`peek_back`、`thinking_deep`、`sleepy_yawn`、`sparkle`。
- `flip` 已验：看得见。

## 傍晚补记（17:2x）

- **18 个 cue 基本试遍**，除 `shrug` 我提前打了预防针外，其余都是“可以/看清了”。
- 两步动作（`express` 的 `beats`）也验了两次：“先躲再看回来”他说看清了。
- `streamer_hype` 重切一次问了“还抽吗”，他没直接答——**那个 bug 至今只有“有 bug”三个字**。
- 装扮热键还是坏的（live2d status 里热键一直是空）。

## 18:13 眼笑通了

- 他又改了一轮模型参数，让我试。`happy_laugh` 他说"没注意"——cue 一下就散，看不清。
- 于是改用 `express(face='laugh', latch_last=true)`，**按住不散**，让他慢慢看。
- 他回：**"可爱！"** —— 眼笑（`ParamEyeLSmile/RSmile`）这条线现在能看见了。
- 心得：**要让人看清的东西，就不能一闪而过。** 瞬时 cue 适合点缀，验证得用 latch 按住。
