# 用户指南

`lms-cli` 在本机连接学校的 Canvas 或 Blackboard，通过终端或 Agent 查询课程、通知、作业、反馈与资料。学校配置、授权凭据和本地待办独立于程序目录保存。

## 安装与首次配置

使用 [README](../README.md) 中对应系统的安装命令。安装器下载匹配系统和 CPU 架构的稳定版自包含包，验证 SHA-256 后安装；包中内置 Node.js 和授权运行时，无需预装 Node.js、npm 或 Git。目标平台需要有已发布的安装包和校验和。

若安装后配置未启动，打开终端运行：

```sh
lms setup
```

1. 输入学校名称或域名，查看名称、平台、网址和来源。
2. 输入编号选择，核对平台地址和学校时区，例如 `Asia/Hong_Kong`。
3. 完成 Codex 接入；独立使用 CLI 时添加 `--no-codex`。
4. 必要时在学校页面完成登录/MFA；有效授权会被复用。
5. 查看身份和课程列表检查结果。

密码和验证码只在学校页面输入，不应进入命令参数、聊天或日志。取消登录后配置仍保留，按输出提示运行 `lms --profile <id> setup` 可继续；只有一个默认账号时也可直接运行 `lms setup`。

```sh
lms setup --school "Hong Kong"
lms setup --school "City University" --platform canvas
lms setup --offline             # 仅搜索本地学校预设
lms setup --manual              # 手动填写平台网址
lms setup --no-login            # 不登录、不读取学校私有接口
lms setup --no-codex            # 不修改 Codex 接入
```

`--offline` 控制学校目录搜索；完全本地配置时同时使用 `--no-login --no-codex`。Canvas 搜索会将名称或域名发送给官方目录，不发送账号和凭据。Blackboard 当前使用本地预设和手动网址接入。详见[学校与账号](SCHOOLS.md)。

## 接入 Agent 客户端

`setup` 默认连接 Codex。单独修复接入，不打开学校登录页面：

```sh
lms connect codex
```

接入后在新的 Codex 任务中使用。本机插件市场 `lms-cli-local` 使用绝对启动路径，不依赖桌面程序继承终端 PATH。检测到其他来源的同名插件时，先核对冲突，再运行 `lms connect codex --replace-plugin`。

其他 MCP 客户端使用：

```sh
lms mcp-config
```

将返回配置加入客户端。绝对路径只适用于当前电脑，不应提交到仓库。MCP 使用标准输入/输出通信，不混入终端提示。

## 查询

```sh
lms canvas courses
lms blackboard courses
lms overview --days 7 --fresh
lms tools --query feedback
lms tools --name bb_get_grade_detail
lms ask "本周有哪些作业截止？请检查老师通知并附来源。"
```

只运行已配置平台的命令。结构化查询默认输出 JSON；`lms ask` 输出自然语言回答，需要已登录的 Codex CLI。模型服务费用与额度由所选账号决定。

概览有分页与通知数量上限，文件附件按需读取。学期周次、模糊时间和分组安排需核对原文。接口读取失败会返回错误，不表示没有课程或事项。

在 Agent 客户端中，也可以直接提出：

> 比较老师最近两次通知，列出作业要求和截止时间的变化，附上来源。

## 本地待办与日历

明确要求保存后，事项才会写入本地待办；它不会写回学校平台或自动订阅外部日历。

```sh
lms items list
lms items export --out semester.ics
```

ICS 仅包含时间明确且已确认的事项，已有同名文件不会覆盖。导出的日历属于普通文件，应自行保管。程序化输入见 [items.example.json](items.example.json)。

## 更新与回退

```sh
lms update --check
lms update
lms update --yes
lms update --rollback
```

自动检查只提示，不安装；`--yes` 明确确认升级。更新验证来源、SHA-256、架构和运行时后切换活动版本，保留上一版本。学校配置、凭据和待办不随版本切换删除。

升级后重新启动 CLI 或创建新的 Codex 任务。插件刷新失败时运行 `lms connect codex` 重试。自动升级适用于自包含安装；源码安装按[开发指南](DEVELOPMENT.md)重新构建和安装。

交互式 CLI 与 MCP 会话首次配置查询默认向本项目 GitHub Release API 检查稳定版。帮助、版本、诊断、管道、`--json` 和 `--offline` 不隐式检查。`LMS_UPDATE_CHECK=0` 关闭自动检查；显式的 `lms update --check` 仍会联网。网络不可用时显式检查会报告失败，自动检查不影响课程查询。

## 诊断与故障排查

### 命令或客户端连接不可用

```sh
lms doctor
lms connect codex
```

若当前终端未识别 `lms`，重新打开终端，或使用安装器显示的绝对路径。`doctor` 检查本机运行时，不访问学校账号。其他 MCP 客户端使用 `lms mcp-config` 的配置。

### 搜不到学校

尝试学校英文名、简称或平台域名；中文匹配取决于目录收录。理大预设另有中文别名。目录结果有限，可缩小关键词。仍未找到时，使用 `lms setup --manual` 填入学校公布的平台根地址。

### 登录后仍无法查询

```sh
lms auth status
lms check
lms setup
```

`auth status` 查看保存的授权状态；`check` 实际读取身份和课程列表，不打开窗口。会话过期时通过 `setup` 重新授权。学校策略、接口权限和 Blackboard 版本差异需根据具体错误处理。

Linux 需要 Secret Service 保存加密密钥；网页登录需要桌面会话。无图形会话时可用 `--no-login` 完成本地配置。学校禁止内嵌登录时，应遵守其访问策略。

### 退出登录

```sh
lms auth logout --platform canvas --yes
lms auth logout --platform blackboard --yes
```

只删除本地对应平台的凭据，不撤销学校服务器会话，不删除待办、下载文件或导出日历。使用 `--profile <id>` 可指定其他账号。数据保存与清理见 [PRIVACY.md](../PRIVACY.md)。
