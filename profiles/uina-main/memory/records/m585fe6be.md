<!-- uina-memory {"schema":1,"id":"m585fe6be","revision":1,"type":"note","basis":"observed","subjectId":"uina-main","scope":{},"sources":[{"sessionId":"default","note":"本轮真机试用：voice status / interrupt 与桥侧 HTTP 实测"}],"status":"active","pinned":false,"title":"voice/tts 交付感知已在真机闭环（2026-09-23）","createdAt":"2026-09-23T16:06:44.168Z","updatedAt":"2026-09-23T16:06:44.168Z"} -->
# voice/tts 交付感知已在真机闭环（2026-09-23）

首次真机闭环验证通过（不再是只靠单测的"机制正确"）：

- 实物证据：视口实时行长出 `[voice] 开麦 | 播放 第 3/10 句（未播完 8 句）`；桥在线并真实播放；用 `voice interrupt` 自打断成功。
- 打断回报（工具侧）："物理播放头第 7 句「…」停在第 25 字"；随后上下文中确实出现了注入的 `[语音交付提示: 上一条回复在第 7 句「…」念到第 25 字处被打断，其后内容用户未听见。]`——交付事实的"提交→播放→打断→断点回灌"整条环路跑通了。
- 桥配置：serviceUrl http://127.0.0.1:8102，端点 /health、/v1/tts/speak、/v1/tts/cancel-trace、/v1/tts/turn-end、/v1/tts/subtitle-state?trace_id=、/v1/tts/events?trace_id=；maxSentenceChars 20。
- 观察细节：提交后先出现短暂的"待播 n/m 句"（尚未起播），起播后转为"播放 第 k/n 句（未播完 m 句）"——两种状态都是真话，别把前者当故障。
- 仍未证：输入侧（麦克风/ASR）未探；Mo 立绘（VTS）离线，所以看不到口型同步。
