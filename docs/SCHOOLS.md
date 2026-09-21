# 学校搜索与账号配置

`lms-cli` 按平台适配，一个 profile 对应一个学校/账号，包含名称、独立 ID、学校时区和至少一个平台的 HTTPS 根地址。学校可同时使用 Canvas 与 Blackboard，无需为每所学校安装一套程序。

## 搜索学校

```sh
lms setup
lms setup --school "Hong Kong"
```

在终端输入学校名称或域名，结果会列出名称、平台地址与来源。输入编号选择，`r` 更换关键词，`m` 改为手动输入，`q` 取消。配置保存前还需确认学校网址和时区。

只查看搜索结果，不修改配置或登录：

```sh
lms schools search "Hong Kong"
lms schools search "canvas.cityu.edu.hk" --platform canvas
lms schools search "理大" --offline
```

- Canvas 在线结果来自[官方学校目录](https://developerdocs.instructure.com/services/canvas/resources/account_domain_lookups)，支持名称与域名匹配；覆盖范围和结果数量由目录决定。
- 本地预设随 CLI 分发，可离线搜索。PolyU 预设包含两个平台地址和 `Asia/Hong_Kong` 时区，支持 `polyu`、`理大`、简体及繁体中文名称。
- Blackboard 当前未接入公开在线目录。可搜索本地预设，或直接输入学校公布的 Blackboard 地址。
- 同一域名的多个登录入口合并为一个站点，具体身份服务由学校登录页面选择。

在线搜索只向 Canvas 发送搜索词，不发送账号或凭据。`--offline` 跳过在线目录；网络故障会显示来源不可用，可重试或手动接入。中文与简称能否匹配取决于目录内容，可尝试英文全称或平台域名。目录匹配不检查个人权限，也不会自动打开结果中的网址。

Agent 可以通过 `lms_school_search` 使用相同能力；选择学校、保存 profile 与授权是独立步骤，网址和时区需要用户确认。

## 手动接入

```sh
lms setup --manual
```

使用学校网站公布的 HTTPS 平台根地址，例如 `https://school.instructure.com`。不要填课程链接、学校门户、SSO 路径、查询参数或凭据。当前不支持部署在 URL 子路径下的平台。

已明确地址和时区时，可使用非交互配置：

```sh
lms setup --label "My University" --timezone Europe/London \
  --canvas https://canvas.example.edu --yes --no-login --no-codex
```

只填写需要的平台；双平台可同时提供 `--canvas` 与 `--blackboard`。`--yes` 确认明确给出的参数，不自动选择搜索结果，也不跳过学校 MFA。之后运行 `lms setup` 继续授权。

PolyU 也可以直接使用预设：

```sh
lms setup --preset polyu --yes
```

## 多学校与多账号

```sh
lms setup --school "Another University"
lms profiles list
lms profiles use <id>
lms --profile <id> canvas courses
```

添加账号保留原来的默认账号。`profiles use` 持久切换默认；`--profile` 仅指定本次操作。`lms setup` 没有新增学校参数时复用当前默认配置。

同校另一个账号需要不同 ID：

```sh
lms setup --school "My University" --id second-account
```

账号凭据、缓存、本地待办和下载目录按 profile 区分，不复制旧账号凭据到新地址。学校时区用于处理通知时间与日历；应选择学校所在地的 IANA 时区，而非自动采用电脑所在地。

地址填错时，新建正确配置，再用 `profiles use` 切换。程序不会覆盖、自动合并或删除已有账号。

## 授权与兼容范围

```sh
lms --profile <id> auth login
lms --profile <id> check
```

授权在学校页面完成；`check` 读取身份和课程列表，不打开窗口，也不输出个人资料正文。通知、成绩、文件等能力应分别验证。

Canvas 使用 REST 连接器和经过验证的学校会话；学校允许时，也可通过 `lms auth token --stdin` 私下导入个人令牌。Blackboard 使用 Learn Ultra 内部接口，其他版本和定制部署可能需要适配。能登录网页不代表所有 API 均可访问。

学校禁止内嵌登录或要求设备合规时，应遵守学校策略。会话到期后重新授权。当前实现仅适用于 Canvas 与 Blackboard；其他平台需通过[平台扩展接口](ADDING_A_PLATFORM.md)接入。
