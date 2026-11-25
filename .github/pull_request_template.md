## 改动与动机 / Changes and motivation

<!-- 说明用户可见的结果；关联 Issue（例如 Closes #123）。Describe user-visible impact and link related issues. -->

## 范围 / Scope

- [ ] 现有平台功能或修复 / Existing platform feature or fix (`canvas` / `blackboard`)
- [ ] 新增平台 MCP（已阅读 `docs/ADDING_A_PLATFORM.md`） / New LMS platform adapter
- [ ] 学校预设或兼容性文档 / School preset or compatibility docs
- [ ] CLI / MCP / 授权 / CI / 文档 / CLI, MCP, auth, CI, or documentation

## 验证 / Validation

- [ ] `npm run check:repo`（版本同步、插件清单与相对链接检查）
- [ ] `npm run typecheck`
- [ ] `npm test`（离线、合成数据）
- [ ] `npm audit --omit=dev`（如改动依赖）
- [ ] 涉及认证/凭据时验证失败、重登录、注销及多账号隔离
- [ ] 涉及打包/安装器或工具数变化时验证 `npm run pack:cli` / `scripts/verify-standalone.mjs`

<!-- 列出实测环境、通过/跳过情况及未验证部分。请勿包含真实 Cookie、密码、令牌、成绩或私人课程资料。 -->

## 新平台或上游变更（不适用可删除）/ New platform or vendor changes

- 上游仓库、固定版本/commit、许可证 / Upstream repo, pinned commit, license:
- 部署版本、认证方式、所需权限 / Deployment version, auth, permissions:
- 逐项审核的只读/本地工具及排除的副作用 / Reviewed tool allowlist & excluded side effects:
- [ ] 单一注册入口（`src/platforms/registry.ts`），公共核心未增加平台名称分支
- [ ] 已更新 `THIRD_PARTY_NOTICES.md`、用户说明与验证记录
