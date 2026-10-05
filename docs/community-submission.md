# Obsidian 社区插件登记准备

本文件提供登记材料与发布流程记录。Quick Ask 已上架 Obsidian 社区插件目录。

## 登记信息

| 字段 | 内容 |
| --- | --- |
| GitHub repository URL | https://github.com/JM-FRANK/obsidian-quick-ask |
| Name | Quick Ask |
| ID | `quick-ask` |
| Author | FRANK-SMITH |
| Owner | 关联 `JM-FRANK` 的个人账户 |
| Version | `1.0.4` |
| Minimum app version | `1.13.7` |
| Platforms | Desktop only |
| License | Apache-2.0 |
| Payment | Plugin is free; a configured AI provider may require a paid API account/credits |
| Short description | Ask AI about selected Markdown text and files, with local conversation history and explicit context control. |

建议的英文详细介绍：

> Ask AI about Markdown text and files you explicitly choose, directly in an Obsidian sidebar. Stream answers, manage local conversations, track changes to referenced files, and export/import session history. Configure a Responses-compatible endpoint, model and named API secret. Provider accounts or usage fees may apply; selected text, file content and conversation context are sent to that provider. Quick Ask includes no plugin telemetry and does not edit your notes. Requires Obsidian 1.13.7 or later on desktop.

2026-09-13：Quick Ask 已上架 Obsidian 社区插件目录。此前对官方 `obsidian-releases/community-plugins.json` 的列表查询（未发现同名条目）已被上架结果取代；下方提交流程保留为流程记录。

## 从 LaTeX 插件上次审核吸取的经验

参考同一维护者的 LaTeX Inline Block Toggle 0.2.0 本地审核记录（2026-09-07）：

- 不添加 `builtin-modules`：Quick Ask 无此依赖，构建脚本直接使用 Node 内置模块。
- 避免遗留未使用示例函数：独立插件入口仅保留实际使用的启动、设置及共享功能接入；发布范围不加入 Scholar 的 PDF、Zotero 或 Pandoc 模块。并未因此声称整个代码库经过全面死代码审计。
- 为安装附件添加 **GitHub artifact attestations**：发布 workflow 在 Actions 中重新构建、测试，给同一份 `main.js`、`manifest.json`、`styles.css` 生成来源证明后再上传草稿。不能给一份文件生成证明，却上传另一次构建的文件。
- 修复已发布版本的问题时递增版本，不覆盖已发布标签或附件。工具只允许刷新尚未发布的草稿。

## 发布状态

- 发布材料、Apache-2.0 许可证、NOTICE、依赖许可证及版本元数据已准备。
- 本仓库已公开，[1.0.0](https://github.com/JM-FRANK/obsidian-quick-ask/releases/tag/1.0.0) 与 [1.0.1](https://github.com/JM-FRANK/obsidian-quick-ask/releases/tag/1.0.1) 已正式发布，安装附件来源证明已验证；Quick Ask 已上架社区插件目录。
- 普通 GitHub 计划的私有仓库不支持 artifact attestations。本仓库公开后的 **Prepare Quick Ask release** 已成功生成来源证明；每次刷新安装附件都应通过该流程生成并验证对应证明。不要把早先私有阶段的跳过状态当作已生成证明。
- 独立版原生设置、实际 API 请求、会话迁移和禁用／重载仍需维护者人工验证，见 [兼容性记录](compatibility.md)。主仓库 Citation 的 Windows 验收不能替代 Quick Ask 独立版验收。

## 正式提交流程

1. 完成人工验收；GitHub 仓库已经公开，检查公开范围只包含该独立发行版。
2. 运行 **Prepare Quick Ask release**，确认构建、测试、版本检查及来源证明成功。草稿附件包含必需的 `main.js`、`manifest.json`、`styles.css`，另外提供许可证、NOTICE、第三方声明及 SHA256SUMS。
3. 从草稿下载 `main.js`、`styles.css`，分别运行 `gh attestation verify 文件名 -R JM-FRANK/obsidian-quick-ask` 验证。发布标签必须是 `1.0.3`，不加 `v`，与默认分支根目录的 manifest 版本完全一致。
4. 检查并发布 GitHub 草稿 Release。首次发行版本在此之前不增加历史发布日期。
5. 登录 [Obsidian Community](https://community.obsidian.md)，关联维护者的 GitHub 账号 `JM-FRANK`。在 Plugins → New plugin 中填写仓库 URL、选择拥有者。
6. 由维护者阅读并同意开发者政策与持续维护承诺后提交。检查自动审核结果；根据反馈修复并发布更高版本，最后按目录流程发布。

这不是向 `obsidian-releases` 提交旧式登记 PR 的流程。网站登录、政策承诺与最终 Submit/Publish 由维护者完成。

参考：[提交指南](https://docs.obsidian.md/plugins/releasing/submit-plugin)、[账号关联与登记](https://docs.obsidian.md/community-directory/set-up-and-claim)、[插件要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、[开发者政策](https://docs.obsidian.md/community-directory/developer-policies)、[GitHub 来源证明](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations)。


## 1.0.4 自动审查建议处理（2026-10-05）

- Release 额外附件：仅上传 `main.js`、`manifest.json`、`styles.css`。
  许可证／NOTICE 留在仓库并内嵌主文件，SHA-256 放发布说明，不作额外下载附件。
  对现有发布，只在维护者检查后删除多余附件；不创建新 Release、不替换安装附件。
- Vault Enumeration：文件选择器的路径枚举是既有功能所需，不等于批量读取／外发正文。
  保留公开 Vault API，并在中英文 README 披露范围及明确添加上下文才读取的边界。
- Clipboard Access：粘贴、会话导入、复制／导出均由用户触发，不监听／轮询剪贴板。
  保留功能及浏览器剪贴板 API，并披露外部剪贴板内容的输入边界。
- 修正原 README 的“不读取 Vault 外文件”描述：用户主动拖入的外部图片会被读取并缓存。
  不通过规避 API 名称或换私有文件扫描方式隐藏审查提示。

依据：[官方发布附件说明](https://docs.obsidian.md/Plugins/Releasing/Submit%20your%20plugin)、
[公开 Vault API](https://docs.obsidian.md/Plugins/Vault)、
[插件提交要求](https://docs.obsidian.md/community-directory/submission-requirements-for-plugins)、
[开发者披露与许可证政策](https://docs.obsidian.md/community-directory/developer-policies)。
