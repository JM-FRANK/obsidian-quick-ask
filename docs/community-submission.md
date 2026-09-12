# Obsidian 社区插件登记准备

本文件提供可填写的登记材料，不表示已经提交、通过审核或上架。

## 登记信息

| 字段 | 内容 |
| --- | --- |
| GitHub repository URL | https://github.com/JM-FRANK/obsidian-quick-ask |
| Name | Quick Ask |
| ID | `quick-ask` |
| Author | FRANK-SMITH |
| Owner | 关联 `JM-FRANK` 的个人账户 |
| Version | `1.0.0` |
| Minimum app version | `1.13.7` |
| Platforms | Desktop only |
| License | Apache-2.0 |
| Payment | Plugin is free; a configured AI provider may require a paid API account/credits |
| Short description | Ask AI about selected Markdown text and files, with local conversation history and explicit context control. |

建议的英文详细介绍：

> Ask AI about Markdown text and files you explicitly choose, directly in an Obsidian sidebar. Stream answers, manage local conversations, track changes to referenced files, and export/import session history. Configure a Responses-compatible endpoint, model and named API secret. Provider accounts or usage fees may apply; selected text, file content and conversation context are sent to that provider. Quick Ask includes no plugin telemetry and does not edit your notes. Requires Obsidian 1.13.7 or later on desktop.

2026-09-13 查询官方 `obsidian-releases/community-plugins.json`，未发现 `quick-ask` ID 或 `Quick Ask` 同名条目。这是已发布列表检查，不是保留名称或官方审核通过证明；提交时仍需检查目录结果。

## 从 LaTeX 插件上次审核吸取的经验

参考同一维护者的 LaTeX Inline Block Toggle 0.2.0 本地审核记录（2026-09-07）：

- 不添加 `builtin-modules`：Quick Ask 无此依赖，构建脚本直接使用 Node 内置模块。
- 避免遗留未使用示例函数：独立插件入口仅保留实际使用的启动、设置及共享功能接入；发布范围不加入 Scholar 的 PDF、Zotero 或 Pandoc 模块。并未因此声称整个代码库经过全面死代码审计。
- 为安装附件添加 **GitHub artifact attestations**：发布 workflow 在 Actions 中重新构建、测试，给同一份 `main.js`、`manifest.json`、`styles.css` 生成来源证明后再上传草稿。不能给一份文件生成证明，却上传另一次构建的文件。
- 修复已发布版本的问题时递增版本，不覆盖已发布标签或附件。工具只允许刷新尚未发布的草稿。

## 发布前状态

- 发布材料、Apache-2.0 许可证、NOTICE、依赖许可证及版本元数据已准备。
- 本仓库当前为私有；准备阶段的草稿不等于可供社区安装的公开 Release。
- 普通 GitHub 计划的私有仓库不支持 artifact attestations。公开仓库后重新运行 **Prepare Quick Ask release**，确认 attestation 步骤成功，再发布草稿。不要把私有阶段的跳过状态当作已生成证明。
- 独立版原生设置、实际 API 请求、会话迁移和禁用／重载仍需维护者人工验证，见 [兼容性记录](compatibility.md)。主仓库 Citation 的 Windows 验收不能替代 Quick Ask 独立版验收。

## 正式提交流程

1. 完成人工验收，将 GitHub 仓库设为公开；检查公开范围只包含该独立发行版。
2. 运行 **Prepare Quick Ask release**，确认构建、测试、版本检查及来源证明成功。草稿附件包含必需的 `main.js`、`manifest.json`、`styles.css`，另外提供许可证、NOTICE、第三方声明及 SHA256SUMS。
3. 从草稿下载 `main.js`、`styles.css`，分别运行 `gh attestation verify 文件名 -R JM-FRANK/obsidian-quick-ask` 验证。发布标签必须是 `1.0.0`，不加 `v`，与默认分支根目录的 manifest 版本完全一致。
4. 检查并发布 GitHub 草稿 Release。首次发行版本在此之前不增加历史发布日期。
5. 登录 [Obsidian Community](https://community.obsidian.md)，关联维护者的 GitHub 账号 `JM-FRANK`。在 Plugins → New plugin 中填写仓库 URL、选择拥有者。
6. 由维护者阅读并同意开发者政策与持续维护承诺后提交。检查自动审核结果；根据反馈修复并发布更高版本，最后按目录流程发布。

这不是向 `obsidian-releases` 提交旧式登记 PR 的流程。网站登录、政策承诺与最终 Submit/Publish 由维护者完成。

参考：[提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[账号关联与登记](https://docs.obsidian.md/community-directory/set-up-and-claim)、[插件要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[GitHub 来源证明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。
