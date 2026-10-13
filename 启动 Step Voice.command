#!/bin/zsh
# Step Voice 启动脚本：检查环境后启动带语音插件的 Step Code。
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null; then echo "未找到 Node.js，请先安装 Node 22+。"; exit 1; fi
if [ ! -d node_modules ]; then echo "首次运行：安装依赖..."; npm install --no-audit --no-fund || exit 1; fi
if [ -z "$STEP_API_KEY" ] && [ -z "$STEPFUN_API_KEY" ]; then
  echo "提示：未检测到 STEP_API_KEY，可在语音面板引导中输入 Key。"
fi
exec step -e ./index.ts
