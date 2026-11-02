# 输入栏内 Codex 式语音交互：架构重启方案

日期：2026-11-02。状态：**架构提案；插件端已开始实现，宿主新界面尚未接入**。

> 实施更新（0.2.0-dev.1）：按用户确认，项目坚持普通插件交付。已新增对话 provider、独立 TTS 和 [composer 宿主契约](COMPOSER_HOST_CONTRACT.md)，并移除默认桌面的浮窗/Swift采集回落。正式宿主缺接口时仅通知，未修改 StepCode.app 或安装目录。下文为原架构研究与后续宿主需求，不代表全部已经实现。

## 0. 本次重新确定的目标

用户要求：复刻 Codex 的语音交互，把语音入口和通话控件放进 StepCode 聊天输入框底部工具栏，而不是桌面浮窗。

推荐决策：**StepCode 宿主提供输入栏组件、页面音频和会话编排；Step Voice 作为语音 provider 插件提供 StepFun 实时对话与语音输出。** 这是“宿主集成 + provider 插件”，不是“只修改普通插件就能任意插入宿主 UI”。

- 保留当前 StepCode 会话、编码模型、工作目录、任务队列、权限审批。
- 语音对话和编码任务可以同时推进；用户可以打断播报、询问进度、追加或调整任务。
- 原生听写仍是“录音结束后把文字放到草稿”，不被悄悄改成自动执行。
- 不再推进 AppKit 浮窗或独立麦克风 App 作为目标 UI；旧实现暂不删除、不覆盖安装，以便比较和回退。
- 不把“转写直送 + 完成后 TTS”称为完整 Codex 实时对话复刻。

### 证据与不确定性

1. StepCode 基线是本机正式安装 **0.2.1 / 0.2.1.639**，只读检查发布产物。它与另一个本地开发副本分开记录。
2. Codex 源码固定到官方仓库 commit [`a09812981de703f18f38015cd5d500ab373f616c`](https://github.com/openai/codex/commit/a09812981de703f18f38015cd5d500ab373f616c)，提交时间 2026-11-01T23:27:06Z。这证明公开代码的机制，不保证某个桌面发行版/账号已启用每个实验功能。
3. Codex 官方产品帮助与开发文档的搜索结果用于确认产品能力。直接获取官方网页全文分别遇到超时和 DNS 失败；不将搜索摘要冒充完整网页实测。
4. 当前 StepCode 页面麦克风的真人录音成功与否未验收。先前系统日志证明的是 Swift 插件录音请求被归属到缺少 audio-input entitlement 的 StepCode，不能从此推断所有页面录音都必然成功或失败。
5. 这次不请求麦克风、不重置 TCC、不读取登录密钥、不修改签名安装包。下载的公开参考源码仅放在 `.cache/codex-voice-research/`。

## 1. StepCode 现在到底有什么可以复用

路径简写：`WEB` = `/Applications/StepCode.app/Contents/Resources/server/node_modules/@step-harness/web/dist`；`CORE` = 同级 `coding-agent/dist`。

### 1.1 已有语音 HTTP 接口：内部页面可用，不是公开的插件录音 SDK

所有下列接口都受宿主 cookie / Origin 等鉴权约束，不能在插件里窃取 cookie 或读取宿主 secret 来模拟页面。

| 接口 | 实际作用 | 适合复用的范围 |
| --- | --- | --- |
| `GET /api/v1/voice` | 返回 available、channel、keySource；available 主要检查凭证 | 原生听写可用性；不能作为麦克风权限成功证明 |
| `POST /api/v1/voice/start` | 建立录音数据缓冲，接收 sampleRate | **不会打开麦克风** |
| `POST /api/v1/voice/audio` | 追加 base64 PCM16 音频片段 | 整段听写上传，非实时双向语音通道 |
| `POST /api/v1/voice/stop` | 合并音频，生成 WAV，调用 StepFun ASR，返回 `{ text }` | 结束后转写，适合“听写入草稿” |
| `POST /api/v1/voice/cancel` | 丢弃缓冲 | 原生听写取消 |

实现：`WEB/voice-routes.js:29–74`、`WEB/voice.js:162–263`。

该实现使用 `/v1/audio/transcriptions` 和 `stepaudio-2.5-asr`；10 分钟/64 MiB 会话上限。宿主只有一个活动听写缓冲，同时再次 start 返回 409；它不是按聊天 sessionId 隔离的实时通话服务。状态请求有凭证不等于远端模型访问一定成功。

### 1.2 已有页面录音与输入栏组件

- `navigator.mediaDevices.getUserMedia`：单声道、请求回声消除/自动增益/降噪。
- `AudioContext` + `AudioWorklet`：提取 PCM16、电平，每约 100 ms 一包，按真实 context 采样率上传。
- `voiceButton`、`voice-anchor`、`voice-pill`：入口、录音波形、时长、取消和“完成，插入文字”。
- 结束后的文字通过页面回调进入现有输入框；不是 HTTP stop 自动提交编码任务。

证据：`WEB/public/assets/index-C-ojyuCq.js` 中 `openMicrophone()`、`id:\`voiceButton\``、`onFinal`；`WEB/public/voice-capture-worklet.js:53–88`。编译产物可定位行为，**不能当成可维护的桌面源码工程**。

建议抽出可共享的 `BrowserAudioSession`，由原生听写和实时语音模式互斥使用；不要让两个按钮各自获取一份 MediaStream。

### 1.3 已有任务、事件与权限能力

| 能力 | 当前已有入口 | 用法与边界 |
| --- | --- | --- |
| 向当前会话发送输入 | 插件 `sendUserMessage`；页面 `POST /api/v1/sessions/:id/messages` | 复用正常任务路径，不另建编码 Agent |
| 调整/追加任务 | 插件 `deliverAs: steer / followUp`；页面 `/sessions/:id/steer` 与现有队列 | 是否立即调整必须明确；语音不能绕过审批 |
| 任务与输出事件 | 插件 `message_update`、`tool_execution_*`、`agent_settled` 等；页面 `/sessions/:id/events` SSE | 给语音层传有限公开文本和进度，不转发原始内部思考或任意工具参数 |
| 停止编码任务 | 宿主 abort/interrupt；页面 `/sessions/:id/interrupt` | 与“打断语音”和“结束通话”分开 |
| 选择/确认/澄清/通知 | 真实宿主 broker 与 `notify` | 设置和权限可以复用；常驻语音条不能用模态框代替 |

页面 messages 接口是异步触发并返回 202；**202 不证明任务已实际开始或成功**。需要关联 admission、started、settled 等真实宿主事件。

证据：`CORE/core/extensions/types.d.ts:128–279, 309–413, 646–741`；`WEB/server.js:164–172, 741–750, 1097–1154, 1199–1202`。

### 1.4 当前不能直接拿来用的部分

- 正式版桌面 `webUiContext` 的 `custom / setWidget / setStatus / setEditorText / setEditorComponent` 是空实现，相关类型主要服务 TUI。不能通过调用它们把组件塞进用户标出的工具栏。
- 当前检查到的正式版扩展 `ExtensionContext` 没有 `ctx.voice`，没有公开的音频帧订阅、页面录音控制、通话音频输出组件接口。
- 另一个本地 `Step-Code-voice-dev` 的 `Voice v1` 已有 `start / appendAudio / interrupt / stop / subscribe`、去重、任务回执；但这是本地补丁，不在上述正式安装中，其 `packages/` 也没有 Web/Electron 客户端源码。
- Voice v1 仍是最终转写直送 + 结果朗读，不支持 Codex 式 handoff 对话模式。不能原样接上就声称完成复刻。

证据：`WEB/runtime.js:74–109`；开发副本 `packages/coding-agent/docs/voice.md:8–11, 28–80, 106–124, 176–180`。

**结论：页面听写组件、任务框架可以复用；输入栏挂载、双向实时音频桥、语音会话编排需要宿主配套改造。现有 ASR HTTP 接口不是整套实时交互方案。**

## 2. Codex 对照：听写和实时交互是两种不同目标

### 2.1 产品能力证据

- [Codex app features](https://developers.openai.com/codex/app/features/) 描述 Voice dictation：在输入区域使用语音转写作为提示词输入。
- [ChatGPT Work and Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex) 描述桌面 live voice interface：自然打断、跟随聊天中的实时文字、发起或协调任务，同一时刻一个语音对话。
- [ChatGPT Voice](https://help.openai.com/zh-hans-cn/articles/20001274-chatgpt-voice) 的官方搜索摘要描述后台任务继续、语音/屏幕进度反馈与麦克风控制。

这些是产品功能说明；以下技术结论来自固定 commit 的公开代码，不把闭源桌面布局或具体灰度模型当成已核实事实。

### 2.2 公开代码证实的核心技术路径

```text
客户端音频采集、播放、波形与字幕
          ⇅ 实时音频 / 控制事件
       Realtime 语音会话
          ⇅ handoff（任务交接）与真实进度/结果
       当前 Codex 编码会话
          → 文件、命令、工具、既有权限机制
```

1. **线程绑定的语音会话，而不是一次音频上传。** App-server 协议有 `thread/realtime/start`、`appendAudio`、`appendText`、`appendSpeech`、`stop`，以及音频/字幕/生命周期通知。相关定义标记为 EXPERIMENTAL。
2. **媒体与后台控制分开。** 协议支持 WebSocket、WebRTC SDP 和已有 callId 三种启动形式。WebRTC 路径通过 calls 交换 SDP，并允许服务端 sideband WebSocket 加入同一 call；这不表示所有桌面版本都固定使用同一种 transport。
3. **实时语音模型和编码任务是两条逻辑循环。** V2 会话配置提供 `background_agent` 工具：任务交给后台；忙时的新指令可作为调整。`HandoffRequested` 被转为当前 session 的任务输入，普通转写不应另行重复提交。
4. **不是只等最后结果再读摘要。** 核心有 `handoff_out`、进度流缓冲与完成确认；真实公开进度/结果回流语音会话，使它能继续对话和汇报。
5. **原生实时语音输出与打断。** V2 同时配置 audio 输出、服务端 VAD 和 `interrupt_response`；事件解析接收 audio delta、输入/输出字幕、speech started、response cancelled。客户端还要抑制/清空旧输出，不能只在界面显示“已打断”。
6. **界面呈现状态，不承担执行权限。** 公开 TUI 的 `VoiceStrip` 把麦克风/扬声器电平和静音/停止控制嵌在输入区域附近；这是 UI 状态设计参考，不是桌面 React 组件的直接源码。

### 2.3 固定源码引用

以下均为 `a09812981de703f18f38015cd5d500ab373f616c`：

| 证据 | 文件与范围 |
| --- | --- |
| realtime RPC 名称与实验标记 | [common.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/app-server-protocol/src/protocol/common.rs#L1109-L1149) |
| transport、输出模态、会话和文本接口 | [v2/realtime.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/app-server-protocol/src/protocol/v2/realtime.rs#L193-L366) |
| V2 background_agent、语音输出、VAD | [methods_v2.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_v2.rs#L30-L167) |
| 音频/字幕/打断事件与工具交接解析 | [protocol_v2.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_v2.rs#L24-L165) |
| 交接进度/结果返回，交接路由到当前会话 | [realtime_conversation.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/core/src/realtime_conversation.rs#L959-L1056) 及 1807–1908 行 |
| WebRTC calls 与 sideband 标识 | [realtime_call.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/codex-api/src/endpoint/realtime_call.rs#L33-L40) |
| 输入区内嵌语音条 | [voice_strip.rs](https://github.com/openai/codex/blob/a09812981de703f18f38015cd5d500ab373f616c/codex-rs/tui/src/bottom_pane/voice_strip.rs#L1-L38) |

补充边界：同 commit 中 `codex-rs/voice-host/README.md` 明确把新的 native helper 标为 private foundation，指出部分音频接入/TUI/真机证明仍是后续阶段。**不把“仓库里存在 helper 代码”说成 Codex 桌面当前必然依赖该进程。** V1/V2/V3/Frameless 存在不同协议分支；本方案学习共同的会话/交接结构，不照搬实验字段、模型名或部署假设。参考 prompt 仅作分工证据，不复制其安全相关措辞。

### 2.4 与当前 Step Voice 的实际差距

| 环节 | Codex 公开实时路径 | 当前 Step Voice 0.1.7 | 新方案 |
| --- | --- | --- | --- |
| 界面 | 语音与当前会话/输入区域结合 | AppKit 浮窗；终端另有 TUI | 输入栏内 `ComposerVoiceStrip` |
| 输入 | 持续语音会话，有 turn/VAD/字幕 | Realtime 主要当转写器 | 保留持续会话，不改成结束才识别 |
| 任务入口 | handoff 路由、普通字幕独立 | final transcript 自动 followUp | 实时对话模式只走 handoff 一条提交路径 |
| 干活时继续说话 | 两条循环并行、可回流进度 | 编码任务后台执行，但语音模型自发回复被丢弃 | 语音模型保持可交互，任务进度回流 |
| 语音输出 | Realtime 原生音频、字幕与取消机制 | agent.complete/settled 后摘要，再独立 SSE TTS | 统一 SpeechOutput；会话原生音频与独立 TTS 互斥 |
| 打断 | 语音响应取消 + 客户端输出抑制 | 有手动打断，默认播报时麦克风 duck | 页面 AEC + 清队列 + generation fence；保留任务运行 |
| TTS 与采集 | 协议区分音频、文本、speech 控制 | TTS 依赖通话 ready，采集失败连带阻断 | 支持不打开麦克风的显式结果朗读 |

当前差距的直接代码证据：`src/server.mjs:133–174, 189–235`、`src/harness-provider.mjs:92–98`、`src/stepfun.mjs:468–515`。虽然已有 `VOICE_TOOLS` 和 `submitToolResult`，当前入口显式 `delegate:false`、丢弃语音模型回复、工具执行禁用。**不是简单打开一个布尔开关就完成 handoff 改造**，还需要队列语义、回执、去重和安全边界。

## 3. 推荐架构：宿主原生组件 + 会话服务 + Step Voice provider

```text
StepCode 桌面 renderer
  Composer（保留草稿、附件、权限、模型、发送按钮）
    ├─ 现有听写按钮 ── 现有整段 ASR 接口 ── 插入草稿
    └─ 新增实时语音入口 / ComposerVoiceStrip
           ⇅ BrowserAudioSession：采集、AEC、电平、播放、停止
           ⇅ 宿主同源的会话级 VoiceBridge（控制/音频/事件）
StepCode 后端
  SessionVoiceService（当前 sessionId / voiceSessionId / generation）
    ├─ Provider：Step Voice → StepFun Realtime（服务端持有 Key）
    ├─ HandoffRouter → 当前 AgentSession → 原有工具、队列与审批
    ├─ ProgressProjector ← 当前 AgentSession 的公开进度与真实结果
    └─ SpeechOutput：Realtime 音频 或 独立 TTS，单一播放仲裁
```

这是一个语音模型和一个已有编码会话的配合，**不是再启动一个独立编码 Agent**。语音模型没有文件读写、shell、自动批准权限；执行请求必须交给宿主原有任务路径。

### 3.1 各模块的职责与改动归属

下列名字是建议新增/抽取的模块，**不是宣称已经有这些 API 或文件**。

| 模块 | 放在哪里 | 复用/新增 |
| --- | --- | --- |
| `ComposerVoiceStrip` | StepCode 桌面前端 | 复用按钮/波形/主题/i18n，新增实时通话条和字幕区域 |
| `BrowserAudioSession` | StepCode 桌面前端 | 抽取现有 getUserMedia、worklet、设备释放；补播放器、播放时钟和互斥采集 |
| `VoiceBridge` | StepCode Web/桌面通信层 | 新增同源受鉴权的 session-scoped 通道，不由插件读取宿主 cookie |
| `SessionVoiceService` | StepCode harness | 复用本地 Voice v1 生命周期、去重与回执设计；新增对话模式和独立语音输出生命周期 |
| `HandoffRouter` | StepCode harness | 新增 tool/handoff→任务映射，复用真实 AgentSession admission、steer、followUp、审批 |
| `ProgressProjector` | StepCode harness | 新增公开结果摘要/进度投影与节流，复用现有事件 |
| `StepVoiceProvider` | 本插件 | 复用 StepFun 协议适配、Key配置、TTS和取消 fencing；补对话模式能力协商和结果回传 |
| 桌面签名与权限说明 | StepCode 桌面构建配置 | 根据真机结果检查并修复用途说明、音频 entitlement 与 Electron 权限处理 |

先做宿主专用语音挂载点，不为这一个功能建设“加载任意插件 HTML/JS”的通用注入框架。后续可以公开稳定 provider 契约。

### 3.2 传输选择

**首选：页面 AudioWorklet → 宿主会话级 WebSocket → StepFun Realtime WebSocket。**

- 复用 StepCode 页面组件，不需要浮窗进程。
- StepFun Key 只留在服务端；浏览器不直连带长期 Key 的上游。
- WebSocket 承载双向音频和有序事件；已有 SSE 保留给普通任务输出，不把音频写进普通会话日志/SSE 历史。
- 处理真实设备采样率：不能假定 `new AudioContext({sampleRate:24000})` 一定得到 24 kHz。转换到 provider 所需的单声道 PCM16，或协商真实格式。
- 不照搬 Codex 的 WebRTC endpoint：当前本插件/已核实 StepFun 路径是 WebSocket；有没有可用 WebRTC 能力要单独验证，不预设兼容。

参考：[StepFun 实时对话开发指南](https://platform.stepfun.com/docs/zh/guides/developer/realtime)、[StepAudio 3 Realtime](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)。模型、通道、函数调用与并发响应语义仍须用用户有权使用的账号验证。

### 3.3 语音输出（保留 TTS 能力，不重复播报）

统一定义 `SpeechOutput`，由会话服务选择输出源：

- **实时对话模式推荐**：StepFun Realtime 原生语音输出，接收后台结果作为上下文/工具结果后自然回答。这更接近 Codex 双循环交互。
- **显式朗读结果 / 降级路径**：保留现有独立 TTS。用户不打开麦克风也可以点“朗读”；麦克风错误不应禁止纯播放。
- 若产品决定固定使用独立 TTS 作为对话输出，则需验证“Realtime 文本流 → 分句 → 流式 TTS”的延迟、取消和上下文一致性；它是可替代实现，不冒充 Codex 的实际传输。
- StepFun 已有文档化的 [WebSocket 流式 TTS](https://platform.stepfun.com/docs/zh/api-reference/audio/ws-audio)，但本插件目前用的是固定输入文本的 `/audio/speech` SSE，**尚未接入该新路径**。
- 任一时刻只允许一个 source/output epoch 播放。不能同时播 Realtime 回答和同一任务的摘要 TTS。
- 字幕按实际播放帧/播放时钟推进，不按网络收到音频的时间伪装精确逐字同步。

### 3.4 最小新增契约（提案，不是现有接口）

可在同源 `/api/v1/sessions/:sessionId/voice` 下提供能力查询和 WebSocket 连接；具体路由在拿到宿主源码后与其 conventions 对齐。

控制类型建议：`voice.start`、`audio.append`、`voice.mute`、`output.interrupt`、`voice.stop`、`readout.start`。

事件类型建议：`voice.state`、`input.transcript.delta/final`、`output.audio.delta`、`output.subtitle`、`handoff.requested/accepted/rejected`、`task.started/progress/settled`、`voice.error`。

每个事件关联 `sessionId + voiceSessionId + generation + sequence`；任务交接另带 `handoffId/callId`，输出带 `responseId/outputEpoch`。前端不能选择任意旧会话发送，后端验证当前授权会话与连接所有权。

拟议的 provider 能力声明至少区分：流式输入转写、双向语音输出、工具交接、响应取消、独立 TTS。原有 Voice v1 采用兼容扩展或升新版本，不能让旧客户端误认具有对话能力。

### 3.5 必须保持的不变量

1. **一次请求只走一次任务派发。** 听写模式只改草稿；实时模式普通 transcript 用于显示/上下文，只有有效 handoff 派发，不能再让同一句 final transcript 自动 followUp。
2. **任务状态有真实回执。** accepted、queued、started、settled 分开；网络超时不自动重发可能已接受的任务。
3. **说话打断 ≠ 停止编码任务。** 先在客户端停止旧播放，取消 provider 输出并封存旧 epoch；只有明确“停止任务”才走宿主 abort/interrupt。
4. **语音结束 ≠ 取消已接受任务。** 停止音轨和输出，拒收晚到转写，保留后台任务；返回后不自动重放积压语音。若要复刻 Codex 的 transcript-tail flushing，另设设计和验证，不默认照搬。
5. **安全不靠 prompt。** 工具参数严格校验、会话绑定、callId 去重、速率/长度限制；审批仍走原 broker，语音模型不得批准自己发起的操作。
6. **隐私与认证边界。** 不传播 Key/cookie、内部思考、任意工具参数或完整日志；只投影经筛选的公开任务文本。默认不持久化 PCM，字幕历史策略与主会话明确一致。
7. **输入不被语音破坏。** 独立维护语音字幕与键盘草稿；IME composition 时不替换 draft，不自动聚焦，不全局截获普通按键。
8. **单设备所有权。** 原生听写与实时通话互斥；切换会话默认结束旧通话并释放设备，不把旧音频自动送到新会话。
9. **明确背压和恢复。** 音频队列/连接/会话均有上限；断线清理麦克风，过期 generation 音频丢弃，不以“重连”重放指令。
10. **能力独立但结束语义清楚。** 输入许可、连接状态、播放状态分开；“结束通话”停止本次会话的收听和播报，“静音”仅停输入，“打断朗读”仅停输出。

## 4. 用户红框处的界面方案：输入栏内语音条，不是浮窗

### 4.1 位置与形态

保留现有工具栏的附件、权限模式、上下文/查看、模型和发送按钮；在原麦克风附近增加清晰标注的“实时语音”入口。原麦克风仍叫“听写”，两者避免含义混淆。

```text
未开启：
┌──────────────────── 原输入框，草稿保持不变 ────────────────────┐
│                                                              │
│ ＋  完全访问 ▾  …       [听写 🎤] [实时语音]   模型 ▾     发送 ↑ │
└──────────────────────────────────────────────────────────────┘

开启实时语音后（仍在同一个输入框容器内）：
┌──────────────────── 原输入框，仍然可以打字 ────────────────────┐
│ 原有键盘草稿                                                  │
│ 你：帮我检查测试。       助手：正在检查，你可以继续补充。          │
│ ＋  完全访问 ▾  …  [● 聆听 ▂▅▃ 静音 | 打断 | 结束]  模型 ▾  ↑ │
└──────────────────────────────────────────────────────────────┘
```

这是基于用户截图的**新布局建议**，不是声称已逐像素还原 Codex 桌面版。需要最终视觉对齐时，用目标 Codex 版本的一次实际交互录屏校准细节；不以这件事阻塞技术架构确定。

- 通话条目标高度约 32–36 px，使用宿主字号/颜色/间距 token，不另建一套 AppKit 风格。
- 字幕最多两行，位于工具栏上方、同一 composer 容器内；不遮挡主对话，不新增桌面窗口、不用 select 弹窗。
- 宽度不足时语音条在 composer 内换到单独一行，不能挤掉发送按钮、模型选择或工具权限标识。
- 不把 Key、sessionId、调试日志塞进主控件；详细设置通过现有设置入口按需打开。
- 出错时在语音条邻近位置给出完整可恢复提示，不能像旧浮窗一样把关键权限原因截断后只留省略号。

### 4.2 状态与动作

| 状态 | 显示 | 允许的主要操作 |
| --- | --- | --- |
| 关闭 | 实时语音入口 | 开启；仅点击后申请设备 |
| 等待系统授权 | 等待麦克风授权 | 取消，不无限加载 |
| 连接中 | 连接语音服务 | 取消，超时后可重试 |
| 聆听 | 输入电平、实时字幕 | 静音、打断、结束，继续打字 |
| Agent 执行中 | 执行状态 + 通话仍在线 | 询问进度、补充/调整、另行停止任务 |
| 播报中 | 输出电平、回复字幕 | 说话或点按钮打断；不停止编码任务 |
| 静音 | 明确显示麦克风已静音 | 继续听回复、恢复麦克风、结束 |
| 等待审批 | 去主界面处理审批 | 不由语音代批，语音条不盖住审批 |
| 权限/设备/网络/模型错误 | 按错误类型显示原因与对应恢复动作 | 重试、设置、关闭，保留草稿 |

状态最好分轴保存：`captureState`、`connectionState`、`playbackState`、`agentState`，而不是一个枚举同时代表录音和执行；例如“静音 + 正在执行 + 正在朗读”是合法组合。

### 4.3 交互和文案检查

- 状态更新不自动 focus，不给文字编辑器注入快捷键。只有用户 Tab 导航才正常移动焦点；不能用全局禁止焦点的方式牺牲键盘可访问性。
- 对按钮使用独立名称：“静音麦克风”“打断朗读”“结束通话”；“停止任务”继续使用宿主原操作，不统称“停止”。
- 波形颜色只是补充，状态必须有文字/图标；减少动态效果时保留文字和控制。
- 屏幕阅读器只温和播报关键状态，不逐音频包或逐 token 重复打断。
- 首次开启前用简短说明告知：“音频将发送到所选语音服务；实时语音可能单独计费，口头任务可提交给当前会话，执行权限仍按原设置。”不自动开启、不默认连续录音，不因用户拒绝而反复弹权限框。
- 工具栏原模型选择仍表示编码模型；语音模型/音色在语音设置里标明，避免误认为更换编码模型就会更换声音。
- 误识别后允许检查/移除尚未执行的排队任务；已经执行的操作不能标成“撤销语音即撤销代码”，必须走宿主已有的停止/恢复机制。
- 权限失败、连接失败、模型不可用各自对应恢复措施。不得用“未开启麦克风”字符串猜测所有机器都缺 entitlement。

## 5. 实施路线：先验证关键阻塞，再迁移主体

### Gate 0：确认可改的宿主源码与真实录音条件

**需要用户提供/确认 StepCode 桌面 Web/Electron 源码位置及在开发构建里改动的权限。** 当前找到的是已签名发布产物和不含桌面端的本地 harness 开发副本，不能把改压缩 bundle/app.asar 当成正式开发路线。

同时做最小真实页面音频验证：

1. 在真正的 StepCode 页面由用户点击申请麦克风，观察 getUserMedia 是否返回 live audio track、电平是否真实变化；测试期间不必向外发送音频。
2. 停止后确认所有 track ended、系统录音指示结束；再独立测试播放。
3. 若失败，区分 Electron 媒体许可、macOS TCC、签名 entitlement、设备选择，而不是反复 reset TCC。
4. 若需签名修复，在有授权的宿主源码构建中增加正确 entitlement/usage description/权限策略并重签测试版；不修改用户正在使用的已签名 App，不关闭系统保护。

**退出标准**：真实页面完成“采集→停止”和“单独播放”，且有可构建的桌面源码。失败就停在这里，不再继续造另一种面板掩盖采集问题。

### Gate 1：输入栏内组件与同源桥接

- 做最小专用挂载点和 `ComposerVoiceStrip`，先用模拟状态验证布局。
- 抽出页面采集/播放器，打通会话级 WebSocket、设备互斥与身份绑定。
- 验证原输入框打字、中文 IME、附件、模型选择、发送/停止、宿主审批均不被破坏。
- 加入独立朗读能力：麦克风关闭时仍能通过明确的播放动作播报。

**退出标准**：真实主窗口内能展示并控制语音条，没有浮窗；真实音频采集与播放走新桥接。模拟波形不算通过。

### Gate 2：StepFun 实时对话与输出能力验证

- 新建受控 conversational provider 模式，验证模型/通道的输入转写、双向语音或文本输出、工具调用、取消与结果注入能力。
- 先验证单次交接和一次工具结果返回，再验证任务长时间运行时语音仍可继续，不能直接假设 StepFun 与 OpenAI 的异步工具语义一致。
- 实现 AEC、播放队列清理、响应 generation fencing；对比原生 Realtime 输出与独立流式 TTS 的音色、延迟和打断效果。
- 如模型不能在后台任务未完成时保持交互，明确报告能力缺口，再选择“立即回任务接收回执 + 后续进度事件注入”或级联方案；不能暗中退回整段听写却仍叫实时复刻。

**退出标准**：在获授权的真实账号下，能边对话边挂起一个模拟后台任务，并成功打断输出。只验证 HTTP/WS 握手或 Key 不算通过。

### Gate 3：当前 AgentSession 的 handoff 和进度回流

- 复用真实队列与权限；增加每个 callId 的去重、admission 与任务结果关联。
- 关闭实时模式的 transcript 自动直送，以免与工具交接重复执行。
- 任务进度和最终结果通过有限公开文本返回语音模型；审批卡片仍由宿主呈现。
- 逐条核对文字和语音输入的行为差异：显式调整、后续排队、查询进度、普通闲聊。

**退出标准**：一次“检查测试”的语音请求只运行一次任务；执行中能问进度；打断播报不取消任务；结束通话后后台任务继续且结果仍可在主界面看到。

### Gate 4：迁移、回归与发布

- `index.ts` 通过能力探测注册 provider；有宿主能力时打开内嵌语音条，不再默认拉起 HUD。
- 保留 StepFun 适配、凭证验证、转写顺序/去重、取消 fence、TTS代码中可复用的部分。
- `native/VoiceHUD.swift`、`src/native-hud.mjs` 退出目标桌面路径；Swift 音频可暂留终端用途，不继续假装它是页面录音修复。
- 本地 Voice v1 扩展为对话模式，并重新验证旧直送模式；不破坏终端或现有听写。
- 宿主和插件版本配套发布，明确最低宿主能力。旧宿主提示不支持内嵌实时语音，不静默回落为浮窗。
- 安装包回归必须覆盖真实签名、首次授权、已拒绝恢复与热重载清理；不得仅凭 Node 测试通过发布。

### 最小验收矩阵

| 场景 | 必须看到的结果 |
| --- | --- |
| 开启实时语音 | 控件出现在截图所示输入栏，无新窗口、无遮罩 |
| 中文输入法打字中收到字幕 | 草稿、光标、组合输入不被替换或中断 |
| 一次语音任务 | 同一会话只接纳并执行一次，不出现 ASR+handoff 双提交 |
| 工作中问“做到哪了” | 基于真实状态答复，不新建同一任务、不捏造进度 |
| 明确说“改成另一种方式”/“做完再做下一项” | 分别走明确的 steer / followUp，不混淆 |
| 说话打断或点击打断 | 本地立即清旧播放，晚到音频不复活，编码任务继续 |
| 只朗读已有答案 | 麦克风不被请求，独立 TTS 可用 |
| 切会话、断线、关闭、重载 | 旧音轨释放、旧 generation 拒收、无跨会话提交 |
| 模型/凭证/麦克风失败 | 各自显示准确错误、保留草稿，不自动反复申请权限 |
| 外放 vs 耳机 | 不把 TTS 回声当成新指令；如仅耳机验证通过，明确限制，不宣称全双工验收 |

建议测量（不是已达成指标，也不是 Codex 官方指标）：按钮到设备就绪、说完到首次有效回应、打断到本地停播、任务接受到状态显示的 P50/P95；另统计重复执行、误唤醒、丢字、回声触发与跨会话残留。使用同一批中文脚本/设备/网络与目标 Codex 版本对照，先测基线再定 SLO。

## 6. 当前能承诺什么、还需要什么

**现在能确定**：架构应转向宿主内嵌组件 + 页面音频 + 会话级语音 provider；当前 StepCode 的整段 ASR 接口只适合听写，不足以实现 Codex 式实时对话。现有插件能复用一部分业务代码，但不能无宿主配合直接插入工具栏。

**现在不能承诺**：某个未实测 StepFun 通道具备与 Codex 完全相同的异步工具和打断行为；当前已签名 StepCode 的页面采集一定可用；仅更新插件即可获得内嵌组件。

接下来唯一需要先定位的工程资源是：**StepCode 桌面前端及 Electron 的可修改源码仓库/分支**。有源码才进入 Gate 0/1；没有源码，就把第 3 节作为提交给宿主维护方的接口需求，而不是再次写浮窗/注入补丁冒充完成。

原架构研究阶段只新增了这份文档，没有修改安装或权限。后续插件端实施进展以顶部更新与 `COMPOSER_HOST_CONTRACT.md` 为准；输入栏挂载、真实页面音频和宿主接入仍未完成。
