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

# 启动前在同一个终端设置 Key。
export STEP_API_KEY='你的 StepFun API Key'

# 可选：以下是默认模型和音色；按需替换右侧的值。
export STEP_VOICE_REALTIME_MODEL='stepaudio-3-realtime-preview'
export STEP_VOICE_TTS_MODEL='stepaudio-3-tts'
export STEP_VOICE_VOICE='linjiajiejie'

step
```

然后输入 `/voice`，按 Enter 开始语音。Step Code 会 clone 仓库、安装运行依赖并注册扩展。安装仅注册插件，麦克风在用户明确开始语音后启用。

### 默认模型与修改配置

不设置模型和音色环境变量时，插件自动使用以下默认值：

| 配置项 | 默认值 | 环境变量 |
| --- | --- | --- |
| 实时语音交流：理解、回复、字幕及任务委派 | `stepaudio-3-realtime-preview` | `STEP_VOICE_REALTIME_MODEL` |
| 后台任务结果的语音播报 | `stepaudio-3-tts` | `STEP_VOICE_TTS_MODEL` |
| 语音音色 | `linjiajiejie` | `STEP_VOICE_VOICE` |

要修改配置，将上面安装示例中对应 `export` 右侧的值替换为你 StepFun 账号可用的模型或音色，再从**同一个终端**运行 `step`。如果 Step Code 已经运行，先退出，再设置变量并重新启动；在另一个终端执行 `export` 不会更新已有进程。启动后用 `/voice config`，或在语音面板按 S，查看当前配置。

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

终端会显示语音面板。按 **Enter** 或 **空格**开始语音，按 macOS 提示允许当前终端应用使用麦克风，即可直接说话。只打开面板不会开启麦克风。也可以输入 `/voice start` 直接开始通话。

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
| `/voice config` | 显示环境变量接入说明 |

在语音面板中：

| 按键 | 用途 |
| --- | --- |
| Enter / 空格 | 开始或结束当前语音 |
| M | 切换麦克风静音 |
| I | 打断当前回复 |
| T | 输入语音对话文字 |
| G | 输入要交给 Step Code 的任务 |
| C | 请求停止后台 Agent 任务 |
| S | 查看当前模型、音色和 Key 是否已配置 |
| Q | 结束通话并收起面板 |
| Esc / Ctrl+C | 收起面板，保留当前通话；终端状态控件继续显示语音状态 |

文字输入时用 **Tab** 切换“语音对话 / 补充任务 / 后续任务”，Enter 发送，Esc 取消文字输入。设置视图中的 R 重新读取**当前进程**已有的 Key、API 地址、实时 / TTS 模型和音色变量，需先结束通话。VAD、提示词和其他参数改动需重新启动 Step Code。

当后台编码任务开始时，完整语音面板会收起，麦克风与通话按当前状态继续运行，终端保留语音状态控件。这使宿主的权限确认和其他交互继续获得键盘焦点。可继续说话，或使用 `/voice mute`、`/voice interrupt`、`/voice end` 控制通话；任务结束后通过 `/voice` 重新打开完整面板。

## 环境变量与 StepFun 模型

插件只读取启动进程的环境变量。支持 `STEP_API_KEY` 和 `STEPFUN_API_KEY`，同时存在时优先使用 `STEP_API_KEY`。Key 不写入文件，也不传给原生音频助手；终端设置只显示是否已配置。

**请在启动 Step Code 之前配置 Key。** 已经运行的进程不会收到另一个终端新设置的变量；设置完成后重新启动 Step Code。Step Plan / OAuth 登录与 StepFun 开放平台 Key 独立，已经登录编码工具不代表语音 API Key 已配置。

```bash
export STEP_API_KEY='你的 Key'
export STEP_VOICE_REALTIME_MODEL='stepaudio-3-realtime-preview'
export STEP_VOICE_TTS_MODEL='stepaudio-3-tts'
export STEP_VOICE_VOICE='linjiajiejie'
step
```

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `STEP_API_KEY` / `STEPFUN_API_KEY` | 无 | StepFun 开放平台鉴权 |
| `STEP_VOICE_BASE_URL` | `https://api.stepfun.com/v1` | 官方 API 地址；也支持 `https://api.stepfun.ai/v1` |
| `STEP_VOICE_REALTIME_MODEL` | `stepaudio-3-realtime-preview` | 连续语音理解、交流、字幕和工具调用 |
| `STEP_VOICE_TTS_MODEL` | `stepaudio-3-tts` | 后台任务结果播报 |
| `STEP_VOICE_VOICE` | `linjiajiejie` | 语音音色 |
| `STEP_VOICE_SILENCE_MS` | `450` | VAD 停顿判定，范围 100–2000 毫秒 |
| `STEP_VOICE_VAD_THRESHOLD` | `2500` | VAD 能量阈值，范围 0–5000 |
| `STEP_VOICE_INSTRUCTIONS` | 内置中文交流与任务委派提示 | 自定义语音伙伴提示 |
| `STEP_VOICE_ASR_MODEL` | `stepaudio-3-asr-max` | 独立 ASR helper 型号，当前通话不使用此路径 |

当前语音理解、语音回复和任务播报都使用 StepFun 模型。编码任务继续使用 Step Code 宿主当前选择的模型和配置。`src/stepfun.mjs` 还提供独立的 `transcribeAudio()` HTTP SSE helper；终端通话的理解和字幕由原生 Realtime 会话完成。

国内和海外 API 的账号、Key、模型可用性需要分别核实，插件不会自动跨地区发送 Key。`stepaudio-3-realtime-preview` 是当前预览型号，服务策略和型号可能调整；模型和音色可用环境变量配置。默认音色沿用当前官方协议示例，尚未使用真实账号确认 Audio3 音色效果。

## 交流与后台工作

可以直接说“帮我检查当前项目的启动问题”。语音模型通过 `stepcode_task` 把明确要求交给当前 Agent，工具返回“已提交 / 已排队”后继续交流。正在执行时补充要求使用宿主 steering 队列，后续任务使用 follow-up 队列。

- 说“现在做到哪了”，可通过 `stepcode_status` 查询宿主进度。
- 用户开口或使用打断控制会停止当前语音输出，已经开始的后台工作继续执行。
- 说“停止后台任务”或按 C，才请求宿主取消 Agent 工作。
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

测试使用模拟宿主、WebSocket、API 响应和音频适配器，检查任务桥接、终端控制、PCM、取消、迟到输出屏蔽、工具去重及错误处理。原生 Swift 源码可在本机编译检查。**离线验证不代表真实 StepFun 语音通话通过：当前交付未使用真实 Key 完成 Realtime、TTS 或物理麦克风的端到端验收。**

Windows / Linux 的原生音频适配尚未实现。实际延迟、中文识别、音色效果、扬声器回声抑制与麦克风权限表现，需要在配置 Key 的 macOS 设备上验证。VAD 由 StepFun 服务端判定，网络延迟与录音环境会影响打断速度。

如果本地控制连接失败，执行 `/voice stop` 后再 `/voice`，重建控制器。麦克风被拒绝时，在 macOS 系统设置中允许当前终端应用使用麦克风，再重新开始。缺少 Key 时会显示环境变量说明；Key、模型权限和接口错误在终端呈现。

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
