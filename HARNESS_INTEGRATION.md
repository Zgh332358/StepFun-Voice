# Harness 级语音接入（开发版）

## 当前交付边界

这次把语音的会话生命周期、转写顺序与去重、任务接收确认、结果回流移到了
StepCode 的 `AgentSession`。Step Voice 保留 StepFun 协议、接入设置、音频和界面适配。

- 宿主支持 `ctx.voice?.protocolVersion === 1`：注册 StepFun provider，使用进程内连接，不再启动插件本地 relay。
- 旧宿主没有该能力：保留现有插件路径；这不等于旧宿主已获得新接口。
- 宿主修改需要包含配套补丁的独立 Step-Code 源码。仅更新这个插件不会升级已安装的 StepCode。
- 当前公开 Step-Code 仓库不含桌面 Web/Electron 客户端。这里没有修改签名应用包，也没有把浏览器演示页当作桌面原生面板。

首版仍是“最终转写直送 → 忙时 followUp → 真实结果摘要/TTS”。没有自动 steering、
语音模型工具委派或双模型实时闲聊；模型生成的文本不能变成第二条任务。

## 模块分工

| 模块 | 职责 |
| --- | --- |
| 宿主 `features/voice/session.ts` | 会话归属、启停、输入接收、取消与结果朗读调度 |
| 宿主 `features/voice/input-queue.ts` | 输入项顺序、终态封存、去重及超时 |
| 宿主 `core/agent-session.ts` | 原有任务入口、preflight 接收确认、消息身份关联、权限与队列 |
| 宿主 `modes/rpc/rpc-voice.ts` | 将 `voice_*` 命令接入同一会话能力 |
| `src/harness-provider.mjs` | StepFun 连接、配置/凭证验证、总结及 TTS；没有任务执行入口 |
| `src/harness-transport.mjs` | 把现有面板控制适配到宿主 API；不重复提交转写 |
| `src/terminal-controller.ts` | 本地音频设备、字幕和播放控制；可使用进程内 transport 或旧 relay |
| `index.ts` | 能力探测、provider 注册和资源回收；未开始前不打开麦克风 |

宿主的完整契约说明位于配套源码的 `packages/coding-agent/docs/voice.md`。

## 从独立源码试用

先准备包含语音补丁的 Step-Code 工作副本，不覆盖当前安装目录：

```bash
cd /path/to/patched-Step-Code
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build:offline
pnpm step --no-extensions -e /path/to/StepFun-Voice/index.ts
```

`--no-extensions` 在这个开发进程中关闭自动扩展发现，仍加载显式 `-e` 指定的插件，
避免与已安装旧副本重复注册；它不修改安装配置。

在这个开发 CLI 中使用 `/stepvoice setup` 配置语音接入，之后再明确开始录音。
编码模型沿用该 CLI 会话的模型与认证；语音 Key 仍由插件的后端配置保管。
不要把 Key 写进命令消息、模型上下文、RPC 示例或调试日志。

这条命令启动的是开发副本，不会让已经打开的 StepCode.app 自动使用新代码。
没有授权的麦克风、模型账号与额度时，只运行下面的离线验证。

## 接收确认与取消

- `task.accepted` 表示真实宿主 preflight 已接受。`submitted` 不表示任务已经执行；
  `queued` 表示排入后续队列；`handled` 表示由输入扩展处理。
- `task.started` 来自实际用户消息开始事件，按消息对象关联，不按相同文本猜测。
- `task.discarded` 来自核心队列实际移除的消息；`task.settled` 是一次完整宿主运行的批次结果。
- 语音停止、播放打断、Agent 取消是不同动作。结束通话不取消已经接受的编码任务。
- 未接受的转写在结束通话后丢弃，失败或接受结果不确定时不自动补发。
- 项目信任与工具权限继续走原来的宿主机制，不由语音 provider 批准。

客户端必须在关闭、错误和断线时释放自己的麦克风。宿主可以拒收后续音频，但不能
替远端界面关闭物理设备。当前原生控制器负责这一步。

## 离线验证

```bash
# 提供真实 TUI 模块，并开启针对配套宿主构建产物的集成测试。
STEP_CODE_SOURCE=/path/to/patched-Step-Code \
STEP_CODE_VOICE_SOURCE=/path/to/patched-Step-Code npm test

# 用配套宿主的公开类型检查插件 TypeScript 与 provider/transport 声明。
STEP_CODE_VOICE_SOURCE=/path/to/patched-Step-Code npm run check:types
```

`npm test` 预加载 `test/offline-network.mjs`：只允许 loopback 网络，缺失模拟实现时
直接失败，不能带着测试 Key 意外请求外部语音服务。测试凭证使用临时目录。

验证包含：

1. 实际 extension loader 注册 provider，`/stepvoice` 不创建旧 relay、不自动录音。
2. 原生控制器适配 → StepFun 事件解析 → 真实 AgentSession → faux 编码模型 → 摘要/TTS 模拟输出。
3. 构建后 CLI 子进程的真实 JSONL RPC：启停、音频输入、一次任务接收、输出音频和正常退出。
4. 宿主侧的去重、取消、队列移除、失败回收、权限拒绝、旧会话与事件顺序回归。

未设置 `STEP_CODE_VOICE_SOURCE` 时，构建产物集成测试明确跳过。
`STEP_CODE_HOST` 是旧的已安装桌面包测试选项，与这个源码参数不同；不要把旧版
压缩 bundle 测试的结果当作新宿主/桌面 UI 验收。

## 仍需完成的桌面接入

需要桌面客户端源码，才能把常驻控件、AudioWorklet/播放器、会话切换与上述 API 接起来。
旧宿主的选择弹窗仅保留为兼容入口，不是新的原生桌面 UI。

自动化使用假音频和模型，不代表真人中文识别、声学回声、长时间录音、设备切换、
实际延迟或线上模型可用性已经验收。现有字幕高亮仍按接收音频长度估算，不能视为
播放器逐字对齐的证明。

旧浏览器伴随方案和独立修改过的桌面测试副本都不是普通插件的交付物。它们的安装版本、宿主能力和测试结果不能直接当作正式版插件的状态；正式桌面兼容用法见 [FORMAL_DESKTOP.md](FORMAL_DESKTOP.md)。
