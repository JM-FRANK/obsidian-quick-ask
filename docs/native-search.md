# 厂商联网搜索配置

搜索方式仍选择 **“模型提供商的服务端搜索”**，开启输入区的联网开关。无需新增选项；自动根据现有协议和模型名称选择接口，复用模型密钥及 Base URL，兼容转发相同接口的中转。

## DeepSeek Search

| 设置 | 值 |
| --- | --- |
| 协议 | Responses 或 Chat Completions，按对话服务配置 |
| Base URL | `https://api.deepseek.com`，或你的中转 Base URL |
| 模型 | 你的 DeepSeek 模型，包括 `deepseek-flash`、`deepseek-v4-pro` 等 |
| 命名密钥 | 同一服务的 DeepSeek API Key |

模型通过工具调用给出搜索词后，Quick Ask 调用 `POST /v1/tools/search`，返回网页摘要与来源。Base URL 已以 `/v1` 结尾时只追加 `/tools/search`。查询上限是 **128 个 Unicode 字符**；超限会反馈给模型修正，不截断，不切换搜索服务。搜索结果优先采用 `summary`。

**这个独立 Search 接口不限定 Pro，也不需要传入模型字段。** 此前“仅 Pro”的限制属于 Responses 请求中内置的 `web_search`，不是这里接入的独立 Search API。

没有增加网页 Fetch 工具：本次只补齐用户要求的搜索接口，不改变本地只读文件权限。

官方说明：[网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search/)、[Search API](https://api-docs.deepseek.com/api/search/)、[另一个 Responses 内置搜索接口](https://api-docs.deepseek.com/zh-cn/guides/responses_api/#tools)。

## CPA + Antigravity（Google 搜索）

| 设置 | 值 |
| --- | --- |
| 协议 | **Responses 或 Chat Completions** |
| Base URL | `http://127.0.0.1:8317/v1`，或你实际的 CPA 地址 |
| 模型 | 已在该 CPA 链路实测的 `gemini-3-flash` |
| 命名密钥 | CPA 客户端 API Key |
| 搜索方式 | 模型提供商的服务端搜索 |

新建会话后开启联网。**Chat Completions** 请求保持 `/v1/chat/completions`，发送 `tools: [{"google_search":{}}]`，不发送 `web_search_options`、`tool_choice` 或普通函数工具。当前CPA返回回答及正文链接，但不返回结构化搜索记录；Quick Ask 不把普通文本链接伪造成已执行搜索的证据。

选择 **Responses** 时，此路径保持 Responses 协议，发送到 `/v1/responses`，使用 `tools: [{"type":"web_search"}]` 和 `tool_choice: "required"`；搜索轮不混入 `get-full-file` 等函数工具。显式添加的上下文仍随请求发送。关闭联网后不再声明搜索工具，恢复普通会话工具。

**已有会话保存创建时的协议、地址和模型。修改设置后请新建会话测试。** 不会在请求失败后自动换协议。

此前 CPA 日志中的 `/v1/models/...:generateContent` 返回404，说明那个原生接口路径在该地址没有开放；不应把这条路径当作 CPA Responses 搜索接口。CPA/AGY 的这条 Responses 搜索链路已使用 Quick Ask 实际 conversation + transport 实测，单次流式请求成功，返回 completed 搜索记录、来源和 url_citation。其他 CPA 模型是否支持由其渠道决定，不把一个模型的实测扩大为所有模型保证。

以下 Gemini API Key 说明适用于直接调用或确实转发 Gemini 原生 API 的服务，与本节 CPA Responses 配置不同。

## Google Gemini API Key

| 设置 | 值 |
| --- | --- |
| 协议 | Chat Completions |
| Base URL | `https://generativelanguage.googleapis.com/v1beta/openai`，或兼容中转 |
| 模型 | 你实际使用的 Gemini 模型，如 `gemini-2.5-flash`、`gemini-2.5-pro`、`gemini-3.8-flash` |
| 命名密钥 | 普通 Gemini API Key |

联网轮自动调用 Gemini 原生 `generateContent` 与 `google_search`，密钥放在 `x-goog-api-key` 请求头。已有文件、选区、图片及历史仍发送给同一厂商；原生回答、思考签名、grounding metadata、来源、引用与 Search Suggestions 都保留。Google 引用按原生 UTF-8 字节位置计算，避免中文／emoji 引用错位。搜索建议在回答旁以隔离、安全的 HTML 展示，重载后仍可回看。

**不再人为只允许两款模型，也不要求官方域名。** `google/` 模型名前缀也可识别。开启联网时使用原生搜索请求；关闭联网与生成本地摘要时继续使用原 Chat 接口，不继承搜索权限。Google 搜索轮不调用本地函数工具，但显式上下文照常发送。

目前 Google 原生搜索返回完整回答后展示，不逐字流式输出；停止按钮会停止等待并忽略迟到结果。原生响应保存在 Chat 会话的 `extra_content.google` 中；下一次原生请求恢复其完整内容，普通 Chat 请求只发送原有对话字段，不向兼容接口发送应用保存的 native wrapper。

显式 Gemini 原生路径（`/v1beta/openai`、`/v1beta`、`/v1alpha`）或官方 Gemini API 地址使用原生适配；末尾 `/openai` 移除后追加 `/models/MODEL:generateContent`。普通兼容路径（如 CPA 的 `/v1`）保持 CC，使用 `tools: [{"google_search":{}}]`，不猜测中转支持原生 URL。

### 已有 Vertex 配置

已有 `/projects/PROJECT/locations/LOCATION/endpoints/openapi` 配置继续走 Vertex Chat 的 `web_search_options: {}`，仍使用 Cloud access token，无需改成 API Key。该路径也不再限定两个模型。

### 思考档位

Gemini 原生协议使用 `thinkingBudget`／`thinkingLevel`。Off 显式请求零预算，不会自动改成有思考；服务端若不支持该档位会直接报错。XHigh／Max 在原生 Gemini 请求中使用其 High 档位，不保证等同其他厂商的计算量。

官方说明：[Google Search 原生接口与模型支持](https://ai.google.dev/gemini-api/docs/generate-content/google-search)、[生成接口与 grounding 字节偏移](https://ai.google.dev/api/generate-content)、[Vertex 兼容参数](https://cloud.google.com/vertex-ai/generative-ai/docs/multimodal/call-vertex-using-openai-library)。

## 中转与错误

中转使用你已配置的 Base URL 与密钥，不会私自改回官方地址。模型名称应保留可识别的 DeepSeek／Gemini 等家族名称。中转未转发对应接口、密钥错误或限流时直接反馈错误，不切换服务，不额外发送付费探测请求。

模型是否实际搜索，依据真实搜索结果／Google grounding 数据；成功生成一段回答本身不作为已搜索的证明。服务端搜索与模型用量可能分开计费，具体以厂商当前计费文档为准。

CPA 参数依据：[官方 AGY Chat 请求转译](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/antigravity/openai/chat-completions/antigravity_openai_request.go)。CPA 返回字段依据：[官方 Chat 响应转译](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/antigravity/openai/chat-completions/antigravity_openai_response.go)。
