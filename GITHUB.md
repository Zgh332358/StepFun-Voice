# GitHub 分发与安装

插件源码仓库：[Zgh332358/StepFun-Voice](https://github.com/Zgh332358/StepFun-Voice)。`main` 是 macOS 分支；普通插件不修改正式 `StepCode.app`，桌面入口为 `/stepvoice`，不是常驻侧栏。

## 从 GitHub 安装

需要 Node.js ≥ 22.19、Git、StepCode，以及用于编译原生音频助手的 Xcode Command Line Tools。

```bash
# 用户范围：适合正式桌面应用和多个项目
step install git:github.com/Zgh332358/StepFun-Voice

# 或：只在当前项目启用
step install -l git:github.com/Zgh332358/StepFun-Voice
```

二选一即可。安装后保存工作并重启 StepCode，然后发送 `/stepvoice`。**当前源码 0.2.0-dev.1 尚未发布，桌面需要宿主实现 `stepvoice.composer/1`；正式 0.2.1 上只通知能力缺失，不再打开浮窗。** GitHub 安装取决于远端版本，不包含未推送的本地修改。接入设置与真实语音调用均需用户主动触发，不要把 Key 发到聊天里。

宿主负责下载仓库、安装 `ws` 运行依赖和保存扩展引用。`pi.extensions` 中的 `./index.ts` 是真实加载入口。无需 npm 账号；仓库的 `private: true` 防止误发 npm。

## 更新与卸载

```bash
step list
# 更新：再次安装同一来源，宿主会 fetch 并快进该 Git clone
step install git:github.com/Zgh332358/StepFun-Voice
step remove git:github.com/Zgh332358/StepFun-Voice
```

如果原来使用 `-l` 安装，卸载时也添加 `-l`。更新前结束通话，更新后**退出并重新启动 StepCode**。

`step update <扩展来源>` 在 StepCode 0.2.1 中是 Step 自身更新（`step update [version]`），不会更新插件；请使用重复安装，或该版本确实支持的 `step update --extensions`。

**本地目录与 GitHub 地址是不同来源。** 如果 `step list` 显示本地安装，先备份并移除该来源，再决定是否改为 GitHub 安装；不要把两份同 ID 插件叠加加载。不要直接修改宿主管理的 Git clone 缓存，后续更新可能覆盖它。

要固定版本，可在 Git 来源后添加 `@<tag-or-commit>`，但必须先确认远端 ref 存在。修改 `package.json` 的版本、推送 `main`、创建 tag、创建 GitHub Release 和上传 ZIP 是不同操作，不能相互替代。

## 本地开发

```bash
git clone https://github.com/Zgh332358/StepFun-Voice.git
cd StepFun-Voice
npm ci --ignore-scripts
step --no-extensions -e ./index.ts
```

本仓库是独立插件，不包含宿主的 `plugins/step-voice` 子目录或 pnpm workspace。`--no-extensions` 只关闭该开发进程的自动发现，仍加载显式 `-e` 参数，避免与已安装副本重复注册。

## 构建运行 ZIP

```bash
node scripts/package-plugin.mjs
```

产物位于 `.cache/releases/step-voice-<版本>-macos.zip`，解压后得到 `step-voice/`。包内含锁定的 `ws` 运行依赖，安装方式为：

```bash
step install /absolute/path/to/step-voice
```

运行 ZIP 不是源码仓库的完整替代：测试和开发脚本留在 GitHub 源码中。构建脚本拒绝覆盖已有同名 ZIP，应先核对并保留旧产物，再重新构建。

## 验证与提交

正式桌面与可选开发宿主的检查命令、前置条件和已验证范围见 [README](README.md#测试与验证范围)；桌面日常操作见 [FORMAL_DESKTOP.md](FORMAL_DESKTOP.md)。

提交前确认 Git 作者身份及 diff，只上传代码、测试和公开文档。不要上传 `node_modules/`、`.cache/`、原生编译缓存、录音、会话记录、安装备份或任何凭证。语音 Key 在运行时由环境变量或独立凭证文件提供，不属于插件包。

## 参考

- [StepCode 官方仓库](https://github.com/stepfun-ai/Step-Code)
- [StepCode package 文档](https://github.com/stepfun-ai/Step-Code/blob/main/packages/coding-agent/docs/packages.md)
- [GitHub Release 文档](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)
