# Roadmap / 开发路线图

本路线图透明展示 `lms-cli` 的近期重点与社区共建方向。欢迎在 [Discussions](https://github.com/zs-andy/lms-cli/discussions) 投票讨论，或认领带有 `good first issue` / `help wanted` 标签的 [Issues](https://github.com/zs-andy/lms-cli/issues)。

## 近期目标 / Near-Term (v0.5.x)

- **Canvas 原始文件安全下载**：支持 `lms download` 与 `lms_download_file`，流式校验、不覆盖已有文件、CDN 凭据隔离及 403 模块/页面回退（PR #1）。
- **无人值守后台自动重新授权**：在已有用户明确同意的前提下支持 `LMS_AUTH_BACKGROUND=1` 静默续期，不抢焦点（PR #2 评审中）。
- **自动化工程与社区基建**：跨平台 CI + Electron 离线认证回归 + CodeQL + Dependabot + 标签驱动的自动化草稿发布流程。
- **社区学校兼容性矩阵与预设扩展**：收集更多高校的 Canvas / Blackboard 实测反馈，沉淀可复用配置与常见问题指南。

## 中期方向 / Mid-Term (v0.6.x+)

- **Blackboard 原始文件本地安全下载**：与 Canvas 下载边界保持一致，提供流式校验与不覆盖发布能力。
- **新教学平台适配器（欢迎社区共建）**：基于 `src/platforms/_template/` 与 [ADDING_A_PLATFORM.md](ADDING_A_PLATFORM.md) 探索接入：
  - **Moodle**（REST / Web Service 只读适配）
  - **Brightspace (D2L)**
  - **Gradescope / Sakai**（视上游 API 与社区实测需求决定）
- **包管理器分发通道**：提供 Homebrew Tap（macOS / Linux）、Scoop / Winget（Windows），与现有自包含安装器并行维护。
- **更完善的跨平台本地体验**：持续优化 Windows / Linux 密钥库诊断提示与慢网更新体验。

## 坚守的长期边界 / Non-Goals & Guardrails

无论功能如何演进，`lms-cli` 始终坚持：

1. **学校平台默认只读**：不自动提交作业、不启动/保存测验、不代发消息、不修改远程课程内容。
2. **绝不绕过学校安全策略**：尊重学校 SSO、MFA、CAPTCHA 与设备合规要求；不收集、不中转、不向模型提示暴露学校密码或 Cookie。
3. **诚实标注能力边界**：离线测试通过不等于真实校园兼容；局部读取失败或分页截断必须显式告知，绝不伪装成“没有待办”。
