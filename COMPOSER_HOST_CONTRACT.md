# Step Voice 输入栏宿主契约（提案 v1）

**这是本插件定义的接入提案，不是 StepCode 0.2.1 已有的 API。** 当前实现了插件端和离线契约测试；真实页面组件、设备采播、鉴权通道仍需要宿主维护方接入。类型定义：`src/composer-contract.ts`。

插件独立安装/卸载，不修改 StepCode.app，不注入 DOM、不读取宿主 cookie，不再自动回落到浮窗。旧终端 Voice v1 路径保留；它与本契约不是同一个协议。

## 1. 最小宿主入口

宿主在每个桌面扩展上下文提供一个稳定、会话绑定的 `voiceComposer`：

```ts
ctx.voiceComposer = {
  protocol: 'stepvoice.composer/1',
  surface: 'composer',
  registerProvider(provider, configuration) {
    // 宿主负责把入口挂在输入框底部工具栏；这里不是插件注入网页。
    return {
      async command(action) { /* open/start/mute/interrupt/end/setup/status */ },
      async dispose() { /* 移除入口，释放音轨、播放器和所有会话资源 */ },
    };
  },
};
```

以上是宿主实现示意，不是已实现的运行代码。只增加这个属性但不实现方法不会获得语音 UI。插件校验协议/挂载区域/注册方法，不修改官方 SDK 声明来伪造能力。

- `session_start` 时注册 provider，只注册 UI，不调用语音模型、不请求麦克风。
- `/stepvoice`、`panel` 映射到 `command('open')`，仅展开控制条。
- `start` 必须由用户触发。宿主先申请页面音频、确认设备状态，再 `createSession` / `start` / 上传帧。
- `mute` 由宿主切换本地音轨上传及 `setMuted`；`interrupt` 清空播放器并调用会话 `interrupt`；`end` 关闭本次音轨、输出与会话，不取消已接纳的任务。
- `setup` 使用宿主安全输入组件调用 `configuration.save`，Key 不进入聊天；`configuration.snapshot()` 只有安全配置/Key 提示，不返回 Key 原文。
- `dispose` 必须取消 contexts，停止所有 tracks、播放器并关闭 provider 会话。插件随后也会 dispose provider，双重回收应幂等。
- `/stepvoice stop` 注销当前注册；下次打开重新注册。会话替换必须触发正常 `session_shutdown`，不得复用旧注册。

## 2. 对话 provider

运行时通过 `createHarnessVoiceRuntime().conversationProvider` 提供：

- `createSession(context)`：纯创建，不连接模型或打开设备；同一 provider 只允许一个对话或一个独立朗读。
- `session.start()`：只连接 StepFun Realtime，**不负责申请麦克风**；必须等 `voice.state=ready` 才传音频。
- `appendAudio({data, sampleRate:24000, numChannels:1})`：Base64 PCM16，最多 128000 个 Base64 字符/帧，样本必须完整。页面需将实际设备采样率转换为 24 kHz，而不是假定浏览器一定采用请求采样率。
- `setMuted(boolean)`：控制 provider 音频接收；物理设备与本地缓冲仍由宿主处理。
- `interrupt()`：发出 `output.clear`、取消模型旧输出；不调用编码任务 abort。
- `updateTask({taskId,sequence,kind,text})`：传回已接受任务的公开 started/progress/settled/failed 信息。忽略未知 taskId、旧 sequence 和终态后的更新；文本上限 12000 字符，发送给语音模型的摘要最多 4000 字符。
- `close()`：立即封存任务入口、清输出，取消启动/接收等待，并等待上游 socket 关闭。失败时不假装资源已释放，需宿主报告并重载。

`context` 包含 `sessionId`、`voiceSessionId`、正整数 `generation`、`signal`、`emit`、`requestTask`、`getTaskStatus`。上下文必须绑定当前宿主会话；不能由浏览器自由指定另一个会话。

## 3. 唯一任务入口与接收回执

```ts
requestTask({ sessionId, voiceSessionId, generation, callId, instruction, delivery })
  => Promise<HandoffReceipt>
```

- `delivery` 为 `steer | followUp`，默认 followUp；instruction 非空且最多 4000 字符；只接受既定参数。
- 回执为 `submitted/queued + taskId`、`handled` 或 `rejected`；表示接收结果，不等于任务开始或成功。
- 宿主必须在 **admission** 时返回，而不是等待整个任务完成。后续事件通过 `updateTask` 返回。
- 目前接收等待默认 5 秒。超时、断线、无效回执都封存为 unknown，不自动重试；晚到结果不绑定到新任务。宿主仍应利用 callId 实现自身幂等性。
- 每个会话最多 256 个工具请求；不通过丢弃旧 ID 来腾出空间，避免重放执行。
- 普通 `input.transcript.*` **只显示/记入上下文，不得再自动提交**。当前 provider 仅通过 `stepcode_task` 的 handoff 派发任务。
- `stepcode_status` 只读取受限状态投影。语音工具没有“代批权限”或直接停止编码任务能力；停止任务使用原宿主 UI。
- 实际任务继续用当前 AgentSession 的模型、权限和队列；不是新启动另一个编码 Agent。

进度默认为静默上下文。终态到达且当前用户和模型均未说话时，可以触发语音回应；若用户/模型正在说话，只补充上下文，不抢话，留待后续对话使用。这部分使用 StepFun 现有协议适配，真实账号上的对话节奏仍需验收。

## 4. 独立 TTS 与输出生命周期

`provider.speak(text, mediaContext)` 直接使用独立朗读服务：

- 不需要创建对话 session，不建立 Realtime 连接，也不请求麦克风。
- 复用已有摘要和 `/audio/speech` SSE，发出字幕、PCM16 音频片段、字幕结束。
- 文本上限 12000 字符；摘要失败回退结果末尾；合成失败明确报错并清队列。
- `interruptReadout()` 取消合成并发 `output.clear`，晚到音频被 fence 丢弃；替换朗读会先取消旧朗读。
- 正在进行实时对话时拒绝另起独立朗读，避免同时生成两份语音。宿主可以先结束对话再朗读；切换到对话前，还必须清除已经生成但尚未播放完的 TTS 队列。
- `active` 表示当前连接/合成操作占用，不是扬声器已经播放完毕的证明；`output.subtitle.end` 表示合成事件流结束。最终播放互斥和停止确认由宿主播放器负责。
- outputEpoch/responseId 用于播放器清理与丢弃过期音频。音频片段到达不等于已经播放，宿主必须以播放时钟更新字幕位置。

TTS 与麦克风解耦是新 composer provider 的行为；旧终端 provider 保留原通话流程，未在本轮更改。

## 5. UI、权限与宿主实现义务

- 挂载在原输入框工具栏，与附件/权限/模型/发送并存；字幕在同一输入框容器内，不打开系统浮窗或模态控制面板。
- 原生“听写入草稿”和“实时对话”必须明确区分，两者共享且互斥占有麦克风。
- 保留键盘草稿、光标、中文 IME 状态，不让流式字幕替换编辑器内容。
- 用户拒绝权限时不循环弹窗。麦克风权限、设备故障、网络、模型权限分开报错；不能靠提示文本猜测 entitlement。
- 若走 WebSocket/HTTP，宿主负责同源鉴权、连接所有权、消息大小/速率限制、背压、会话 generation、真实 admission 及事件持久化。不得把音频或 Key 写入普通对话日志。
- `requestTask` 必须经原有项目授权/工具审批；`getTaskStatus` / `updateTask` 只传公开内容，不传内部思考、任意工具参数或凭证。
- 设备、AEC、外放防回声、浏览器播放权限、字体布局及真实焦点/IME 验收属于宿主侧，插件契约测试不能替代。
- 声明 capabilities 只代表适配器提供相应路径，不证明某账号/模型套餐在线上全部可用。Key 验证成功也不等于 handoff/双向语音已验收。

## 6. 本轮完成与未完成

已实现：插件契约及能力探测、缺能力时通知、不再启动 HUD/Swift 采集、独立对话 provider、handoff 去重/超时/进度、独立 TTS、离线回归。

未实现：真正的 StepCode 输入栏挂载、页面录音/播放器、宿主同源媒体通道和真实 admission adapter；没有实现 `ctx.voiceComposer` 的正式宿主仍不能使用新的桌面实时语音。

未验证：真实中文语音/音色/延迟、StepFun 各通道的异步工具行为、真实外放打断、防回声和首次系统授权。新协议不会解除系统麦克风限制。

更新插件前请备份旧安装。要看到输入栏语音控件，必须由宿主维护方实现本契约；不是再安装一次插件就会出现。
