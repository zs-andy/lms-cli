# 接入新的平台 MCP

目标：新增 `src/platforms/<id>/`，在一个地方注册，再补测试、许可和兼容性说明；不在 CLI、MCP、登录页或 Backend 中不断增加 `if (platform === ...)`。

先读 [架构与边界](ARCHITECTURE.md)。现有真实平台是 Canvas 和 Blackboard；下面的 `example` 是刻意不可运行的模板，不代表 Moodle、Brightspace 等已经支持。

以下步骤在克隆后的源码仓库根目录执行，不是在全局 npm 安装目录中修改构建产物。

## 先判断是哪类贡献

| 需求 | 应修改的位置 |
| --- | --- |
| 同一个 LMS 的另一所学校/另一个账号 | 通过 `lms init` / `lms profiles add` 添加配置；无需源码改动 |
| 添加方便使用的学校网址预设 | `src/config.ts` 的预设与兼容说明 |
| 包装一个新的 LMS 上游 MCP | 本文的平台模块与注册表 |
| 为现有平台开放一个工具 | 先审查上游实现，再修改该平台的 `readTools` 并补测试 |
| OAuth、远程 MCP、任意命令加载、写操作 | 先设计讨论；不属于现有模板自动支持的范围 |

## 1. 审查并固定上游

在 Issue / PR 中列明上游仓库、固定版本或 commit、许可证、支持的部署版本、所需权限、认证方式和已知限制。

- 优先复用上游的 HTTP、分页、解析器和工具实现。
- 若 vendoring，将源码和许可证放进 `vendor/<id>/`，记录本地补丁；若使用依赖，固定版本并更新锁文件。
- 更新 `THIRD_PARTY_NOTICES.md`；确认 `npm pack --dry-run` 和 App 打包包含运行代码及许可证。
- 上游工具自称只读不构成审核证据；检查是否间接标记已读、创建测验尝试、提交作业、发消息、写文件或导入浏览器数据。
- 不接受运行时下载移动分支、任意 MCP 启动命令或未经审核的插件自动发现。

## 2. 复制模板并填写平台定义

```sh
cp -R src/platforms/_template src/platforms/example
```

把目录、导出名称和所有示例值替换成真实平台。平台 ID 必须为小写字母开头的小写字母/数字，不能与 CLI 命令或 profile 字段冲突。发布后不能随意改名。

`index.ts` 必须 `satisfies PlatformDefinition`，并保留 `id: '你的平台id' as const`。

| 字段 | 要求 |
| --- | --- |
| `id` / `label` | 稳定机器 ID / 面向用户的名称 |
| `environmentPrefixes` | 上游读取的全部环境命名空间；worker 清除所有已注册平台的残留环境 |
| `readTools` | 逐项审核的精确工具名；不允许通配、前缀放行 |
| `aliases` | CLI 资源别名到 `readTools` 的映射，例如 `courses` |
| `courseArgument` | `--course` 对应的上游参数名及数字/字符串类型 |
| `login` | 精确 Cookie 名称规则、会话 Cookie、验证 API 路径；不含 IdP Cookie |
| `probes` | 无需参数或带固定安全参数的身份、课程列表只读调用 |
| `overview` | 可选的有界概览计划；必须包含可靠覆盖范围，不支持就省略 |
| `limitations` | 接口版本、认证与功能限制；不能只写“兼容” |
| `loadRuntime` | `async () => (await import('./runtime.js')).runtime`，不得顶层导入 runtime |

新增定义会在启动时检查 ID、工具名是否重复、别名/探针是否引用了未审核工具、环境前缀和 Cookie 策略是否有效。它不会替代人工安全审核。

## 3. 实现运行时

`runtime.ts` 实现 `PlatformRuntime` 的四个方法。模板方法会显式失败，必须逐个替换，不能把空实现当成支持。

1. `configure(context)`：绑定 `context.origin`，禁用上游写权限、调试输出、自动登录和明文凭据存储；下载/运行目录必须按 `context.profileId` 隔离。
2. `validate(context, candidate)`：用上游 HTTP 客户端读取身份，只有确认成功才返回带 `validatedAt` 的 `StoredCredential`。失败不能写入最后可用会话。
3. `install(context, credential, persist)`：安装仅属于当前 worker 的凭据。`credential === null` 时仍应能离线列出工具，真正读取由 Backend 拒绝。刷新会话使用 `persist(updatedCredential)`，不能直接写 vault 或其他明文文件。
4. `serve()`：启动固定版本上游 MCP 的 stdio 服务。`stdout` 只输出协议消息，不自动导入系统浏览器 Cookie，不启动上游登录命令、SSO keeper 或重复 transport。

`StoredCredential.kind` / `value` 对核心是不透明数据；runtime 自行验证类型、版本及 origin。不要改变已发布凭据格式而不提供迁移方案。

学校密码/MFA 不进入这些方法。当前 UI 只传入审核后的 LMS Cookie；历史 Canvas token 导入保持原行为。需要新授权方式时先讨论如何扩展公共授权流程。

参考 [Canvas runtime](../src/platforms/canvas/runtime.ts) 的环境式适配，或 [Blackboard runtime](../src/platforms/blackboard/runtime.ts) 的 session/persistence 适配。不要复制 Blackboard 的 session 格式到其他平台。

## 4. 在唯一入口注册

在 `src/platforms/registry.ts` 中添加导入，并加入元组：

```ts
import { example } from './example/index.js';

export const platformDefinitions = [canvas, blackboard, example] as const;
```

不要注册 `_template`。注册后，下列能力自动派生：

- profile 的平台 HTTPS 字段与 MCP `platform` 枚举；未知字段仍拒绝。
- `lms init --example`、`profiles add --example`、`lms example <resource>`。
- 登录平台选项、名称、Cookie 筛选策略。
- `lms_tools` / `lms_call` 的平台归属和只读白名单。
- `auth status --live`、`check` 和平台概览。
- 按平台/学校账号/来源隔离凭据及缓存。

示例命令只有在完成真实实现并注册后才可运行：

```sh
lms init --id test-school --label "Test School" --timezone Europe/London --example https://lms.example.edu
lms --profile test-school tools --platform example
lms --profile test-school example courses
```

## 5. 测试先于兼容性承诺

所有自动测试使用合成数据，默认离线，不读取个人配置或 OS 凭据。新平台至少覆盖：

- [ ] 真实上游 MCP 可以无凭据离线握手；别名、探针和概览参数通过真实工具 schema。
- [ ] 未审核工具、远程写操作、原始 HTTP、浏览器导入不可达；不泄露其他平台的同名工具。
- [ ] 身份探针失败、登录重定向、HTML、401/403、超时不会成为空成功；不覆盖旧凭据。
- [ ] Cookie 限定学校域、路径、有效期、Secure 和审核名称，排除 IdP 与无关 Cookie。
- [ ] 分页、重定向、下载不会向其他 origin 泄露凭据；有限请求/字节/页数。
- [ ] 同校不同账号、不同学校、重新登录和注销后的旧 worker 均保持隔离。
- [ ] 仅配置该平台和同时配置多个平台可用；不支持的 overview 显式报告。
- [ ] 注册不产生副作用，平台名不出现在公共调度的特殊分支中。
- [ ] 上游许可证、构建产物、用户说明和实测范围完整。

```sh
npm run typecheck
npm test
npm audit --omit=dev
npm run pack:cli
```

`test/platforms.test.ts` 是通用契约测试；真实上游握手在 `test/integration.test.ts`。新增平台通常还应增加 `test/<id>.test.ts` 来验证认证/HTTP 适配。涉及登录 UI 可运行贡献指南中的离线界面检查。

最后由获授权的使用者自行按 [ACCEPTANCE.md](ACCEPTANCE.md) 验证学校 SSO/MFA 和功能，不把“能配置”“离线测试通过”写成“所有学校已支持”。

## PR 最小交付

平台目录 + 注册项 + 离线测试 + 上游版本/许可证记录 + README / SCHOOLS / VALIDATION 中如实的能力说明。若需要修改 `backend.ts`、`mcp.ts`、`auth/` 的通用安全流程，请解释为什么现有契约不够，先评审边界再扩展。
