# Step Voice 0.1.6：正式 macOS 桌面版兼容插件

## 与常驻面板测试副本的区别

这是普通 StepCode 扩展包，不包含 Electron、宿主补丁或测试模型。已验证的正式桌面宿主为 StepCode **0.2.1（0.2.1.639）**。

- 使用 `/stepvoice` 和宿主原生选择弹窗控制语音，不提供常驻侧栏。
- 语音最终转写提交当前 StepCode 会话，忙时 followUp 排队；编码模型、任务和工具权限仍由宿主管理。
- 结果摘要与 TTS 使用 StepFun；不另起编码 Agent，不自动打开外部浏览器。
- 正式宿主没有 Voice v1 时使用插件原有 localhost relay。不是让正式版获得测试副本的宿主级 API。

## 安装后使用

1. 保存当前工作，在新会话中尝试 `/stepvoice`。如仍加载旧版本或提示未知参数，退出并重新打开正式 StepCode；不要同时安装多个相同 ID 的插件。
2. `/stepvoice` 只打开控制弹窗，不录音、不访问真实模型。
3. 需要配置时，主动运行 `/stepvoice setup`，选择通道，再通过 macOS 隐藏输入框填写 Key。**不要把 Key 发到聊天里。** 验证接入会请求真实语音服务，可能消耗额度。
4. 在弹窗中选择“开始语音”后才申请麦克风权限。也可以使用 `/stepvoice start`。
5. 停顿会触发提交，请先用不会修改文件的简单指令验收；需要暂停输入时先静音。

| 命令 | 行为 |
| --- | --- |
| `/stepvoice` | 打开壳内控制弹窗，不开始录音 |
| `/stepvoice setup` | 主动配置并在线验证语音接入 |
| `/stepvoice mute` | 切换麦克风静音 |
| `/stepvoice interrupt` | 打断播报，不取消已提交的编码任务 |
| `/stepvoice end` | 结束采集和通话，保留插件服务 |
| `/stepvoice stop` | 释放控制器和本地服务 |
| `/stepvoice status` | 查看状态 |

任务开始或宿主需要权限确认时，弹窗会让出焦点。通话可以继续；重新发送 `/stepvoice` 查看状态。字幕和电平需要在弹窗中刷新，不是实时常驻显示。

## 安装方式

推荐使用 GitHub 来源安装到用户范围：

```bash
step install git:github.com/Zgh332358/StepFun-Voice
```

如果已经以本地目录方式安装到 `~/.stepcode/local-packages/step-voice`，不要重复添加 GitHub 来源。维护脚本可以备份旧目录并替换运行包，保留现有引用；切换来源前需确认 `step list` 并备份。

也可以自行构建运行 ZIP（见 [GitHub 分发说明](GITHUB.md)），解压得到 `step-voice` 目录后运行：

```bash
step install /absolute/path/to/step-voice
```

这是用户范围安装。运行包已包含锁定版本的 `ws` 依赖，不需要插件安装脚本或真实账号。首次启动音频仍需 Xcode Command Line Tools 编译 Swift 助手。

凭证独立保存在 `~/.stepcode/step-voice/credentials.json`；安装包不包含此文件，更新不清除或迁移已有凭证。回滚时先退出 StepCode，再恢复安装报告记录的旧插件目录。

## 验证边界

正式宿主检查覆盖：实际扩展发现和加载、`AgentSession.prompt` 分发、真实选择弹窗 broker，以及正式前端的命令补全行为。宿主模块使用临时 HOME / agentDir 和离线网络保护，不使用真实账号。打包后的目录和最终安装目录也应按同样方式复验。

本次安装不等于真人语音验收：真实中文识别、线上模型和 TTS、麦克风权限、回声和长时间通话仍需你主动开始后确认。模拟测试通过不能替代这些结果。
