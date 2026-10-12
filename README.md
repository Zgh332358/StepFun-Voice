# Step Voice

Step Voice 是可单独加载的 Step Code 终端语音插件。语音控件、实时字幕、麦克风状态和任务进度直接显示在现有 Step Code TUI 中。StepFun 原生 Realtime 负责连续交流、服务端 VAD 和语音打断；编码、文件和终端任务交给当前 Step Code Agent，完成后由 StepFun TTS 播报简要结果。后台工作期间可以继续聊天、补充要求或查询进度。

插件代码集中在本目录，使用宿主现有的 extension API 和工具权限流程。macOS 音频由随插件提供的 Swift / AVAudioEngine 助手处理。

## 安装与启动

当前原生音频支持 **macOS**，需要 Node.js **22.19 或更高版本**、已安装的 Step Code 和 **Xcode Command Line Tools**。从源码启动 Step Code 还需要 pnpm **9**。首次开始语音时会编译音频助手；缺少编译工具时，按系统提示运行 `xcode-select --install` 安装。

### 从 GitHub 安装

GitHub 托管插件源码和版本，不需要 npm 账号。插件仓库为 [Zgh332358/StepFun-Voice](https://github.com/Zgh332358/StepFun-Voice)，根目录直接包含 `package.json`、`index.ts`、`src/` 和 `native/`。详见 [GitHub 分发说明](GITHUB.md)。

在要使用语音的项目目录执行：

```bash
step install -l git:github.com/Zgh332358/StepFun-Voice
step
```

然后输入 `/voice`。**第一次打开时面板会引导你完成接入**：

1. 选择接入通道：**开放平台 API**（按调用量计费）或 **Step Plan**（使用订阅套餐额度）。
2. 粘贴 API Key（输入时只显示最后 4 位）。两个通道用同一把平台 Key，在 [platform.stepfun.com/interface-key](https://platform.stepfun.com/interface-key) 创建；Step Plan 通道需要账号已[订阅套餐](https://platform.stepfun.com/step-plan)。
3. 插件当场验证：先确认 Key 被该通道接受，再确认该通道的实时语音模型能建立会话。通过后保存，按 Enter 开始语音。

如果启动前已经 `export STEP_API_KEY`，第 2 步直接按 Enter 就会使用它，不会另存一份。之后可在面板按 Ctrl+O → K 更换通道或 Key，或运行 `/voice setup`。Step Code 会 clone 仓库、安装运行依赖并注册扩展。安装仅注册插件，麦克风在用户明确开始语音后启用。

### 两个接入通道

| | 开放平台 API | Step Plan |
| --- | --- | --- |
| API 地址 | `https://api.stepfun.com/v1` | `https://api.stepfun.com/step_plan/v1` |
| 实时语音模型 | `stepaudio-3-realtime-preview` | `stepaudio-2.5-realtime` |
| 任务播报模型 | `stepaudio-3-tts` | `stepaudio-2.5-tts` |
| 计费 | 按调用量 | 折算为 Step Plan 套餐额度 |

2026-10-12 用同一把 Key 实测：Step Plan 路径不提供 `stepaudio-3-*` 模型（返回 404），所以选择通道时插件会同时切换默认模型。

### 默认模型与修改配置

不设置模型和音色环境变量时，插件使用所选通道的默认值（下表为开放平台通道）：

| 配置项 | 默认值 | 环境变量 |
| --- | --- | --- |
| 实时语音交流：理解、回复、字幕及任务委派 | `stepaudio-3-realtime-preview` | `STEP_VOICE_REALTIME_MODEL` |
| 后台任务结果的语音播报 | `stepaudio-3-tts` | `STEP_VOICE_TTS_MODEL` |
| 语音音色 | `linjiajiejie` | `STEP_VOICE_VOICE` |

要覆盖默认模型或音色，用 `export STEP_VOICE_REALTIME_MODEL=...` 等变量设置你 StepFun 账号可用的模型或音色，再从**同一个终端**运行 `step`。如果 Step Code 已经运行，先退出，再设置变量并重新启动；在另一个终端执行 `export` 不会更新已有进程。启动后用 `/voice config`，或在语音面板按 Ctrl+O，查看当前配置。

编码与文件、终端任务沿用 **Step Code 当前选择的模型**，不由这些语音变量指定。代码还提供默认型号为 `stepaudio-3-asr-max` 的独立 ASR helper，可通过 `STEP_VOICE_ASR_MODEL` 修改；当前通话的理解和字幕由 Realtime 完成，不使用这个独立 ASR 路径。

### 管理安装

不带 `-l` 时安装到用户范围，可用于其他项目。当前项目引用保存在 `.stepcode/config.toml`；用户引用保存在 `~/.stepcode/config.toml`，由 Step Code 管理。安装后重新启动 Step Code，或通过 `/reload` 重载。查看、更新和卸载：

```bash
step list
step update --extension git:github.com/Zgh332358/StepFun-Voice
step remove -l git:github.com/Zgh332358/StepFun-Voice
# 用户范围卸载：step remove git:github.com/Zgh332358/StepFun-Voice
```

`update` 按仓库匹配用户和当前项目中的已配置来源，不使用 `-l`。不固定 ref 时跟随当前跟踪分支。要固定版本，在仓库确实创建了对应 tag 后，使用 `step install -l git:github.com/Zgh332358/StepFun-Voice@v0.1.0`；升级时重新安装新的 tag。

本插件没有 npm 发布配置、scope 设置或 npx 安装器；`package.json` 标记为 `private`。依赖安装仍由 Step Code 的 Node package 工具处理，这是插件运行需要的 `ws` 依赖。无需在 npm 注册或发布插件。

### 从源码启动

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
npm --prefix plugins/step-voice ci --ignore-scripts

# 在启动 Step Code 的同一个终端设置开放平台 Key。
export STEP_API_KEY='你的 StepFun API Key'

pnpm step -e ./plugins/step-voice/index.ts
```

进入 Step Code 后输入：

```text
/voice
```

终端会显示语音面板。输入框为空时按 **Enter** 开始语音，按 macOS 提示允许当前终端应用使用麦克风，即可直接说话。只打开面板不会开启麦克风。也可以输入 `/voice start` 直接开始通话。

仓库根目录还提供 `启动 Step Voice.command`。设置 Key 后，可在同一个终端运行：

```bash
"./启动 Step Voice.command"
```

脚本检查 Node 和已安装依赖，然后启动带插件的 Step Code；进入后仍通过 `/voice` 使用语音。Finder 双击启动不会继承另一个终端刚设置的 `export`，环境变量接入建议使用上面的同终端启动方式。

### 项目级安装

插件已在 `package.json` 的 `pi.extensions` 中声明入口。也可通过 Step package 机制安装到当前项目：

```bash
# 在仓库根目录使用源码 CLI 安装。
pnpm step install -l ./plugins/step-voice
pnpm step
```

使用已安装的 `step` 命令时，可在目标项目中执行 `step install -l /path/to/Step-Code-Voice/plugins/step-voice`，将示例路径替换为实际插件目录。`-l` 将 package 引用写入目标项目的 `.stepcode/config.toml`；重新启动 Step Code 后即可运行 `/voice`。

首次体验和开发可继续使用 `-e ./plugins/step-voice/index.ts`，无需保存 package 设置。`step.plugin.json` 提供插件身份信息；启用入口使用上述 extension / Step package 加载方式。

## 终端操作

| 命令 | 用途 |
| --- | --- |
| `/voice` | 打开语音面板；后台 Agent 工作时显示终端语音状态控件 |
| `/voice start` | 开始语音，申请本机麦克风访问 |
| `/voice mute` | 切换麦克风静音 |
| `/voice interrupt` | 清空播放并取消当前语音生成；后台任务继续运行 |
| `/voice end` | 结束通话并关闭麦克风，保留本地语音服务 |
| `/voice stop` | 释放语音控制器与本地服务 |
| `/voice status` | 查看语音和宿主任务状态 |
| `/voice setup` | 打开接入引导：选择通道、输入并验证 API Key |
| `/voice config` | 显示接入说明 |

在语音面板中：

| 按键 | 用途 |
| --- | --- |
| Enter（输入框为空） | 开始或结束当前语音 |
| 直接打字 + Enter | 发送文字；**通话中可以随时打字**，不需要先切换模式 |
| Tab | 切换文字的发送对象：语音对话 / 交给 Step Code / 排入后续任务 |
| Ctrl+T | 切换麦克风静音 |
| Ctrl+X | 打断当前回复 |
| Ctrl+G | 请求停止后台 Agent 任务 |
| Ctrl+O | 接入设置：查看通道、Key 来源和模型；K 更换通道或 Key，X 清除保存的 Key |
| Ctrl+Q | 结束通话并收起面板 |
| Esc | 输入框有内容时清空；为空时收起面板，保留当前通话 |
| Ctrl+C | 收起面板，保留当前通话；终端状态控件继续显示语音状态 |

面板下方的输入框始终可用，字母和中文输入法的文字都会进入输入框，所以快捷键都使用 Ctrl 组合。发给语音对话的文字需要通话已经开始；还没开始时文字会保留，可以先开始通话，或按 Tab 交给 Step Code。设置视图中的 R 重新读取**当前进程**已有的 Key、API 地址、实时 / TTS 模型和音色变量，需先结束通话。VAD、提示词和其他参数改动需重新启动 Step Code。

当后台编码任务开始时，完整语音面板会收起，麦克风与通话按当前状态继续运行，终端保留语音状态控件。这使宿主的权限确认和其他交互继续获得键盘焦点。可继续说话，或使用 `/voice mute`、`/voice interrupt`、`/voice end` 控制通话；任务结束后通过 `/voice` 重新打开完整面板。

## 环境变量与 StepFun 模型

Key 有两个来源：

- **面板引导里输入的 Key**：验证通过后保存在 `~/.stepcode/step-voice/credentials.json`。目录权限 700、文件权限 600，只有当前用户能读。文件里还记录所选通道。设置里按 X 可以删除。
- **环境变量** `STEP_API_KEY` / `STEPFUN_API_KEY`（同时存在时优先 `STEP_API_KEY`）。已经运行的进程不会收到另一个终端新设置的变量，设置后需要重新启动 Step Code。

两者都有时，使用面板里保存的 Key。Key 不传给原生音频助手，界面和报错里只显示最后 4 位。Step Code 的 Step Plan / OAuth 登录与 API Key 是两回事：已经登录编码工具，不代表语音 API Key 已配置。

```bash
export STEP_API_KEY='你的 Key'
export STEP_VOICE_REALTIME_MODEL='stepaudio-3-realtime-preview'
export STEP_VOICE_TTS_MODEL='stepaudio-3-tts'
export STEP_VOICE_VOICE='linjiajiejie'
step
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `STEP_API_KEY` / `STEPFUN_API_KEY` | 无 | StepFun API Key（面板里保存的 Key 优先） |
| `STEP_VOICE_CHANNEL` | `api` | 未在面板选择时的通道：`api` 或 `step_plan` |
| `STEP_VOICE_BASE_URL` | 随通道 | 官方 API 地址：`/v1`（开放平台）或 `/step_plan/v1`（Step Plan），域名可为 `api.stepfun.com` / `api.stepfun.ai` |
| `STEP_VOICE_REALTIME_MODEL` | `stepaudio-3-realtime-preview` | 连续语音理解、交流、字幕和工具调用 |
| `STEP_VOICE_TTS_MODEL` | `stepaudio-3-tts` | 后台任务结果播报 |
| `STEP_VOICE_VOICE` | `linjiajiejie` | 语音音色 |
| `STEP_VOICE_SILENCE_MS` | `450` | VAD 停顿判定，范围 100–2000 毫秒 |
| `STEP_VOICE_VAD_THRESHOLD` | `2500` | VAD 能量阈值，范围 0–5000 |
| `STEP_VOICE_INSTRUCTIONS` | 内置中文交流与任务委派提示 | 自定义语音伙伴提示 |
| `STEP_VOICE_ASR_MODEL` | `stepaudio-3-asr-max` | 独立 ASR helper 型号，当前通话不使用此路径 |

当前语音理解、语音回复和任务播报都使用 StepFun 模型。编码任务继续使用 Step Code 宿主当前选择的模型和配置。`src/stepfun.mjs` 还提供独立的 `transcribeAudio()` HTTP SSE helper；终端通话的理解和字幕由原生 Realtime 会话完成。

国内和海外 API 的账号、Key、模型可用性需要分别核实，插件不会自动跨地区发送 Key。`stepaudio-3-realtime-preview` 是当前预览型号，服务策略和型号可能调整；模型和音色可用环境变量配置。默认模型与 `linjiajiejie` 音色已通过真实 API 请求验证，可以返回音频。

## 交流与后台工作

可以直接说“帮我检查当前项目的启动问题”。语音模型通过 `stepcode_task` 把明确要求交给当前 Agent，工具返回“已提交 / 已排队”后继续交流。正在执行时补充要求使用宿主 steering 队列，后续任务使用 follow-up 队列。

- 说“现在做到哪了”，可通过 `stepcode_status` 查询宿主进度。
- 用户开口或使用打断控制会停止当前语音输出，已经开始的后台工作继续执行。
- 说“停止后台任务”或按 Ctrl+G，才请求宿主取消 Agent 工作。
- 结束通话或关闭语音服务会停止录音；后台任务的生命周期仍由 Step Code 管理。
- 需要权限确认时，按 Step Code 自己的提示在终端处理。语音插件不会代替用户批准工具，也不绕过项目可信与工具权限检查。

任务动态和公开回复在终端显示。一次宿主工作及已排队的补充 / 后续工作完成后，插件通知结果，并通过 StepFun TTS 播报清理代码块、Markdown 和链接后的简要文本，最多 850 个字符。完整结果保留在宿主终端；失败或取消使用对应状态呈现。

## 音频与数据路径

```text
macOS 麦克风 / Swift AVAudioEngine
  → 单声道 PCM16 / 24 kHz
  → 本地终端控制器与 127.0.0.1 relay
  → StepFun 原生 Realtime
  → 回复音频 / 原生播放，字幕 / Step Code TUI

语音任务工具
  → 当前 Step Code Agent / 宿主权限流程
  → 任务状态与公开回复 / 终端控件
  → 结果上下文 / StepFun TTS / 原生播放
```

本地 relay 仅监听 `127.0.0.1`，校验 Host、Origin 和随机访问令牌；StepFun 鉴权头由服务端添加，公开配置不包含 Key，出站事件进行 Key 脱敏。麦克风音频和对话发送到所选 StepFun 官方 API；后台任务的精简结果也会发送到 Realtime 上下文和 TTS。

只在显式开始语音后打开麦克风。静音时不上传麦克风帧；结束通话、关闭服务或释放会话会停止原生音频进程。切换 / 关闭 Step Code 会话、重新加载 extension 后，在当前新会话重新运行 `/voice`。

## 验证与当前边界

从仓库根目录运行离线测试：

```bash
npm --prefix plugins/step-voice test
```

在独立的 GitHub 插件 checkout 中运行完整测试时，使用 `STEP_CODE_SOURCE=/path/to/Step-Code npm test`，把路径替换为已安装依赖的 Step Code 源码 checkout。此变量只为测试提供真实 TUI 模块；正常插件运行时由宿主 loader 提供该模块。

测试使用模拟宿主、WebSocket、API 响应和音频适配器，检查任务桥接、终端控制、PCM、取消、迟到输出屏蔽、工具去重及错误处理。新增回归覆盖准备阶段取消后立即重试、旧会话结束事件、清理异常、启动超时，以及 TTS 完成后连接仍未关闭的情况。

2026-10-11 的真实验证包括：默认 Realtime 模型完成连接和一轮文字输入的语音回复，默认 TTS 返回完整 PCM；macOS 原生助手连续启停、实际麦克风 PCM 采集和播放完成，系统回声消除开启；已安装的 Step Code 0.1.3 二进制在隔离配置中连续三轮进入“正在聆听”并正常结束。原生采集测试仅在内存统计并丢弃音频。离线回归与这些短测试分别提供证据，尚未完成长时间真人语音交流、噪声环境或多种设备的体验验收。

Windows / Linux 的原生音频适配尚未实现。实际延迟、中文识别、音色效果、扬声器回声抑制与麦克风权限表现，需要在配置 Key 的 macOS 设备上验证。VAD 由 StepFun 服务端判定，网络延迟与录音环境会影响打断速度。

如果本地控制连接失败，执行 `/voice stop` 后再 `/voice`，重建控制器。麦克风被拒绝时，在 macOS 系统设置中允许当前终端应用使用麦克风，再重新开始。缺少 Key 时会显示环境变量说明；Key、模型权限和接口错误在终端呈现。

### 卡在准备或处理状态时

语音面板顶部显示实际语音阶段：“准备本地音频助手”“打开麦克风”“连接 StepFun 语音模型”，连接完成后显示“正在聆听”。下方“Step Code · 等待任务”只表示编码 Agent 当前闲置。首次使用需要编译助手；看到麦克风权限提示时，在系统提示中允许当前终端应用。

准备与打开音频有 75 秒的总超时，模型就绪等待最多 25 秒，TTS 等待网络数据的空闲超时为 30 秒。可以按 Enter 取消启动，再次 Enter 重试；旧操作、旧会话的音频与结束事件不会覆盖新的通话。启动失败时会显示原因并结束音频。

本次修复了启用回声消除时混音器与输出节点格式不一致造成的 CoreAudio `-10875` 初始化失败，保留系统回声消除。升级后执行 `/reload`，再输入 `/voice`；已运行的旧插件需要重载后才会使用修复。

同时修复了编译版 Step Code 的本地连接在重载时清理不完整、导致停留在 Reloading 的情况。若已经运行的旧版在重载过程中卡住，退出 Step Code 后从已配置 Key 的同一个终端重新启动。

宿主的 `sendUserMessage` 返回 `void`，因此“已提交 / 已排队”表示请求交给宿主，不等于工作已成功执行。模型未配置、鉴权预检或工具权限提示仍以 Step Code 的实际执行状态为准；长时间没有进度时查看宿主输出。

## 官方资料

- [StepFun Realtime 开发指南](https://platform.stepfun.com/docs/zh/guides/developer/realtime)
- [Realtime API 事件与工具协议](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat)
- [StepAudio 3 Realtime 模型介绍](https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime)
- [StepFun TTS HTTP / SSE 接口](https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio)
- [独立 ASR SSE 接口](https://platform.stepfun.com/docs/zh/api-reference/audio/asr-sse)
- [Step Code 官方仓库](https://github.com/stepfun-ai/Step-Code)
- [Step Code extension 说明](https://github.com/stepfun-ai/Step-Code/blob/main/packages/coding-agent/docs/extensions.md)
- [Step Code package 说明](https://github.com/stepfun-ai/Step-Code/blob/main/packages/coding-agent/docs/packages.md)

协议与默认型号按 2026-10-11 的官方资料实现。服务与型号变化时，以 StepFun 当前文档为准。

本插件遵循 [MIT License](LICENSE)。
