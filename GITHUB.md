# Step Voice GitHub 分发与安装

GitHub 可以直接托管这个终端语音插件。Step Code 支持从 Git 仓库 clone、安装运行依赖并注册 extension，因此不需要 npm 账号或 npm 包发布。本插件没有 npx 安装器和 npm 发布脚本，`package.json` 的 `private: true` 阻止意外 npm 发布。

插件面向 Windows 分发。原 macOS 版本使用独立的 [Zgh332358/StepFun-Voice 仓库](https://github.com/Zgh332358/StepFun-Voice)；本 Windows 版推送到你自己的 GitHub 仓库后，把下文命令里的仓库地址替换为该地址即可。

## 仓库结构

把当前插件目录中的内容放到 GitHub 仓库根目录：

```text
StepFun-Voice/
  package.json
  package-lock.json
  index.ts
  step.plugin.json
  src/
  native/
  test/
  README.md
  GITHUB.md
  LICENSE
  .gitignore
```

可将交付的 `Step-Voice-plugin.zip` 解压后，使用内部 `step-voice` 目录作为仓库根目录。不要将它再次套在远端仓库的 `plugins/step-voice` 下：当前 Step Code Git package 从仓库根目录读取 manifest，没有独立的 Git 子目录安装参数。

`pi.extensions` 中的 `./index.ts` 是宿主实际使用的入口。C# 音频助手使用相对模块路径定位 `native/VoiceAudio.cs`，因此 clone 位置变化不影响定位；助手在首次使用时用系统自带 .NET Framework 编译并缓存到 `%LOCALAPPDATA%\StepVoice\native`。

## 开发与发布

开发时 clone 源码仓库，在自己的 checkout 中修改和测试：

```powershell
git clone <你的仓库地址>
cd StepFun-Voice-Windows
npm install --no-audit --no-fund
# TUI 测试使用已安装依赖的 Step Code 源码 checkout。
$env:STEP_CODE_SOURCE = "C:\path\to\Step-Code"
npm test
```

提交前确认 Git 作者信息是你的身份；向这个仓库推送需要已有写入权限。不要上传 `node_modules`、本机音频编译产物或凭证文件，`.gitignore` 已忽略相关文件。插件仅读取进程环境变量。

## 一条命令安装

用户需要先安装 Step Code、Node.js 22.19 或更高版本、Git，以及 Windows 10/11 系统自带的 .NET Framework 4.x（无需单独安装）。在目标项目中执行：

```powershell
step install -l git:github.com/<你的账号>/StepFun-Voice-Windows
```

Step Code 会 clone 到当前项目 `.stepcode\git\` 中，自动处理 `ws` 运行依赖，并把插件来源注册到项目 `.stepcode\config.toml`。不带 `-l` 时使用用户范围，clone 放到 `%USERPROFILE%\.stepcode\agent\git\`，来源保存在 `%USERPROFILE%\.stepcode\config.toml`。

安装后重新启动 Step Code，或在现有会话运行 `/reload`。开始语音前，在启动 Step Code 的同一个终端设置 StepFun 开放平台 Key：

```powershell
$env:STEP_API_KEY = '你的 StepFun API Key'
step
```

进入后输入 `/voice`，在输入框为空时按 Enter 开始语音。打开插件面板不自动开启麦克风。Step Plan / OAuth 登录不能替代语音模型需要的开放平台 Key。

从已安装依赖的 Step Code 源码仓库启动时，可把安装命令中的 `step` 换成 `pnpm step`，然后运行 `pnpm step`。

## 更新、固定版本和卸载

```powershell
step list
step update --extension git:github.com/<你的账号>/StepFun-Voice-Windows
step remove -l git:github.com/<你的账号>/StepFun-Voice-Windows
```

更新命令不带 `-l`，按仓库身份匹配用户与当前项目已配置的来源。不固定 ref 时更新当前跟踪分支。用户范围卸载使用不带 `-l` 的 remove。

要发布明确版本，先在插件仓库创建并推送对应 tag，例如 `v0.2.0`；随后可在 GitHub 创建 Release。GitHub Release 会提供该 tag 的源码 ZIP / tarball，也可以附加手动制作的 ZIP。

```powershell
# 在仓库确实存在 v0.2.0 tag 后使用。
step install -l git:github.com/<你的账号>/StepFun-Voice-Windows@v0.2.0
```

固定 tag / commit 的配置不会随普通更新切换到新版本；升级时用新 ref 重新执行 install。Step Code 管理的 clone 是安装缓存，更新会重置并清理其中的改动，开发修改应在自己的源码目录中进行。

## 本地使用和验证

也可以从本地目录加载。将路径替换成解压后的插件目录：

```powershell
step install -l C:\path\to\StepFun-Voice-Windows
step
```

本地目录需要已有运行依赖；在插件目录执行 `npm install --no-audit --no-fund`，再加载即可。这里的 npm 仅安装 Node 运行依赖，不注册账号、不发布插件。GitHub 安装路径由宿主自动完成依赖安装。

从插件源码目录运行 `npm test` 做完整离线验证；UI 套件需要 `$env:STEP_CODE_SOURCE = "C:\path\to\Step-Code"`（已安装依赖的 Step Code 源码 checkout）。该变量仅用于测试，从 GitHub 安装插件时不需要；正常运行的宿主 loader 提供 TUI 模块。默认 Realtime 和 TTS 模型与 macOS 版共用同一 HTTP/WS 路径，已通过真实请求；Windows 原生采集、播放与队列打断需要在 Windows 设备上做真机验收，长时间真人交流、多设备和噪声环境的体验仍需验证，具体范围见 [README](README.md#边界与限制)。

## 官方参考

- [Step Code 官方仓库](https://github.com/stepfun-ai/Step-Code)
- [Step Code package 文档](https://github.com/stepfun-ai/Step-Code/blob/main/packages/coding-agent/docs/packages.md)
- [GitHub Release 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

安装语法、实际配置路径和入口声明已按交付时的本地 Step Code 源码核对；旧文档中 `settings.json` 的配置路径文字不适用于当前原生 Step 实现。
