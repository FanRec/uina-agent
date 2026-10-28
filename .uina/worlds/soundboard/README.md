# soundboard World

播放短音效。三个动作：`play` 播一个、`list` 看有什么、`stop` 全停。

想加音效就往 `sounds/` 里丢文件，文件名写成 `<id>-<中文名>.<ext>`，例如 `glass_break-玻璃碎裂.wav`；删掉文件就是移除。没有索引文件要同步。

`list` 的结果是唯一会变的东西——目录里有什么，它就说有什么，不做缓存。`play` 未命中时会直接列出全部 ID，照着改一次就能播对。

音量是可选参数（默认 80，单文件偏移写在 `config.json` 的 `soundOverrides`）。World 停用时会结束仍在播放的 mpv 进程。
