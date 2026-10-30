# 书童 AI 转发站

让书童的每次 AI 生成不直接调 API，而是排进队列，由你选定的桌面 AI 工具（Claude、Codex、Gemini 等）来完成，再把结果交回书童。

书童本身的代码不用改。转发站对书童来说就是一个 OpenAI 兼容接口。

```
书童 ──请求──▶ 转发站 /claude/v1 ──▶ claude 通道队列 ──▶ Claude 桌面端（MCP 取任务、交结果）
      ◀─结果──           /gemini/v1 ──▶ gemini 通道队列 ──▶ Gemini CLI
                         /codex/v1  ──▶ codex 通道队列  ──▶ Codex
                                       └─▶ 网页面板 / 收件目录（手动复制粘贴）
```

只需要 Node.js 22 或更新版本，没有第三方依赖。

## 1. 启动转发站

```sh
node tools/ai-relay/relay.mjs serve
```

- 端口默认 `8787`，可用环境变量 `AI_RELAY_PORT` 改。
- 收件目录默认 `~/ai-relay-inbox`，可用 `AI_RELAY_DIR` 改。
- 浏览器打开 <http://127.0.0.1:8787/> 是网页面板，能看到所有待处理任务。

转发站在书童使用期间要一直开着。

## 2. 在书童里加模型

在「设置 → AI 模型」里，每个平台加一个模型：

| 名称 | 接口类型 | 地址 | API Key | 模型名 |
|---|---|---|---|---|
| Claude（转发） | 自定义（OpenAI 兼容） | `http://127.0.0.1:8787/claude/v1` | 随便填，如 `relay` | 随便填，如 `claude-relay` |
| Gemini（转发） | 自定义（OpenAI 兼容） | `http://127.0.0.1:8787/gemini/v1` | 同上 | `gemini-relay` |
| Codex（转发） | 自定义（OpenAI 兼容） | `http://127.0.0.1:8787/codex/v1` | 同上 | `codex-relay` |

用途勾选「生成」。上下文长度和最大输出按你实际要用的平台填。

平台名就是地址里的那一段，只要是小写字母、数字或连字符都行，想加别的平台直接换个名字即可。

然后在「设置 → 分工模型」里给各环节指定模型，例如：

- 规划（设定、架构、蓝图）：Codex
- 起草（写正文、批量写、编辑器选段修改）：Claude
- 审稿：Gemini
- 修稿润色：Gemini
- 定稿整理：Claude

「写本章」弹窗里也可以临时换模型。正文里选中一段后，工具条最左边有个模型下拉框，润色、扩写、续写、改成对话、按意见改都按这里选的模型走；选「跟随起草」就用起草环节的模型。这个选择在软件关闭前一直记住。下拉框只在有两个以上生成模型时出现。

## 3. 让 AI 工具接上转发站（MCP）

每个工具各接自己的通道，加上 `--platform <平台名>`。下面的路径换成你电脑上这个文件的绝对路径。

### Claude 桌面端

打开「设置 → 开发者 → 编辑配置」，编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "shutong-relay": {
      "command": "node",
      "args": ["/Users/zhang/projects/AI-Novel-Writer/tools/ai-relay/relay.mjs", "mcp", "--platform", "claude"]
    }
  }
}
```

保存后重启 Claude 桌面端。

### Codex

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.shutong-relay]
command = "node"
args = ["/Users/zhang/projects/AI-Novel-Writer/tools/ai-relay/relay.mjs", "mcp", "--platform", "codex"]
```

### Gemini CLI

编辑 `~/.gemini/settings.json`：

```json
{
  "mcpServers": {
    "shutong-relay": {
      "command": "node",
      "args": ["/Users/zhang/projects/AI-Novel-Writer/tools/ai-relay/relay.mjs", "mcp", "--platform", "gemini"]
    }
  }
}
```

Gemini 的网页版和手机 App 不能接自定义 MCP，只能用下面的手动方式。

### MCP 工具

| 工具 | 作用 |
|---|---|
| `list_tasks` | 列出本通道待处理任务 |
| `get_next_task` | 取最早的一条，返回任务 id 和完整提示词 |
| `get_task` | 按 id 取某条任务 |
| `submit_result` | 交回结果，书童随即收到 |

## 4. 日常使用

1. 在书童里点生成按钮。按钮会显示生成中，此时请求已排进对应通道。
2. 到对应的 AI 工具里说「处理下一个书童任务」。它会取任务、写结果、交回。
3. 书童收到结果，继续往下走。

不用 MCP 时有两种手动方式：

- **网页面板**：在 <http://127.0.0.1:8787/> 点「复制提示词」，贴到任何 AI 里，把回答粘回文本框，点「交回书童」。
- **收件目录**：提示词在 `~/ai-relay-inbox/<平台>/<任务id>.prompt.md`。把回答存成同目录的 `<任务id>.answer.md`，一秒内就会交回。

处理完和被取消的任务都会移到 `~/ai-relay-inbox/_done/`，留作记录。

## 注意事项

- **要求 JSON 的任务**：提示词开头会写明。交回时如果被 ```json 代码块包着，转发站会自动去掉。
- **一个按钮可能产生多条任务**：批量写章、审稿后修稿、架构分步生成都会连续发出多次请求，每一条都要处理。
- **有时限的任务**：书童给部分后台任务设了截止时间，例如剧情线候选大约 2 分钟、剧情树 10 分钟，一次生成会话最长 1 小时。超时后书童会自己取消，任务移进 `_done/` 并标为 cancelled。
- **只监听本机**：转发站只绑定 `127.0.0.1`，局域网里的其他设备连不上。
- **不要让 AI 去改项目文件**：书童的作品数据在数据库里，结果只能通过交回任务写进去。提示词开头已经提醒了这一点。
