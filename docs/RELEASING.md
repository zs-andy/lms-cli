# 发布流程

## 发布目标

- GitHub 仓库：源码、说明、许可证和插件市场目录。
- GitHub Release：CLI 安装包、经验证的授权 App 和校验和。
- Codex GitHub 插件市场：通过本仓库的 `.agents/plugins/marketplace.json` 安装插件。

这三个目标不等同于 npm 发布，也不等同于 Codex 官方精选市场收录。尚未核实的官方上架流程不要写成已完成；如需申请，应由仓库维护者通过当时的正式提交渠道完成相关资料、条款和审核。

## 发布前检查

1. 核对 `package.json`、CLI/MCP 版本和插件 manifest 版本一致。不要把个人安装的 `+codex.*` 缓存后缀提交到发布版。
2. 更新 README、隐私说明、验证记录及第三方许可证。校徽和第三方标识不属于本项目 MIT 授权。
3. 在干净目录运行安装、类型检查、测试和依赖审计。
4. 扫描 Git 暂存文件及 `npm pack` 清单，确认没有密钥、账号、下载文件、私人路径或旧备份。
5. 在目标系统验证安装、启动、取消及重试。实际 SSO/MFA 和课程查询按 [ACCEPTANCE.md](ACCEPTANCE.md) 验收。
6. 正式安装包需要维护者自己的签名和公证。未完成时只能标为未签名预览版，不得暗示经过学校或系统平台认证。

## 构建

```sh
npm ci
npm run typecheck
npm test
npm audit --omit=dev
npm run pack:cli
npm run pack:app
```

自动测试和构建矩阵位于 `.github/workflows/ci.yml`。CI 成功不等于真实校园账号验收成功。

只上传与发布提交相对应的构建产物，使用 SHA-256 校验和，并在 Release 中注明架构、签名状态和已知限制。未验证系统的产物不要当作稳定版推荐。

## 插件安装验证

先为发布提交创建版本标签，再从 GitHub 标签安装：

```sh
codex plugin marketplace add zs-andy/polyu-lms-cli --ref v0.2.0
codex plugin add lms-cli@polyu-lms
codex plugin list
```

随后在新任务里核对插件说明和 MCP 工具。插件依赖另外安装的 `lms` 命令；市场安装不会自动安装 Node.js 或 CLI。

未来版本需要同时更新 README 中的下载文件名和 `--ref` 标签。不要覆盖已有 Release 附件或重写已公开标签，修复应发布新版本。
