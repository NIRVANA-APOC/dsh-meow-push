# MeoW 消息推送 API 参考

本文档汇总截至 2026-08-28 的 `api_doc.html` 内嵌 OpenAPI 规范。

- 基础地址：`https://api.chuckfang.com`
- 公开文档：`https://www.chuckfang.com/MeoW/api_doc.html`
- 请求方法：GET、POST
- 响应媒体类型：`application/json`
- 当前传输层行为：HTTP 状态通常为 `200`，必须检查 JSON 中的业务 `status`。

## 网络来源要求

- 避免通过多人共享的公共出口 IP 调用推送 API，例如共享代理、NAT 网关或 Serverless 公共出口地址。
- 同一个共享 IP 向多个昵称发送推送时，MeoW 可能将其判定为攻击行为。
- 优先使用独立、稳定、可信的出口 IP。可信 IP 如需调用权限，可联系开发者申请加入白名单。
- 不要通过轮换代理或更换 IP 绕过该控制。

## 推荐请求：POST JSON

使用以下任一端点：

```text
POST /{nickname}
POST /{nickname}/{title}
```

查询参数：

| 名称 | 必填 | 说明 |
|---|---:|---|
| `url` | 否 | 点击通知后打开的链接；JSON Body 也支持此字段 |
| `imgUrl` | 否 | 通知图片 URL；JSON Body 中的值优先 |
| `msgType` | 否 | `text`（默认）或 `html` |
| `htmlHeight` | 否 | HTML 显示高度，单位为像素；仅用于 `msgType=html`，默认 `200` |

JSON Body：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `msg` | 是 | 消息内容 |
| `title` | 否 | 覆盖路径中的标题；默认为 `MeoW` |
| `url` | 否 | 点击通知后打开的链接 |
| `imgUrl` | 否 | 通知图片 URL，建议使用 216×216 PNG |

请求示例：

```http
POST /JohnDoe?msgType=text HTTP/1.1
Host: api.chuckfang.com
Content-Type: application/json

{
  "title": "系统通知",
  "msg": "部署完成",
  "url": "https://example.com",
  "imgUrl": "https://example.com/icon_216x216.png"
}
```

参数优先级：

```text
title: body > path > "MeoW"
imgUrl: body > query
```

`msgType` 和 `htmlHeight` 始终是查询参数，不是 JSON 字段。

## POST text/plain

需要原样发送纯文本或消息包含较多换行时使用：

```http
POST /{nickname}/{optional-title}?msgType=text HTTP/1.1
Host: api.chuckfang.com
Content-Type: text/plain

这里是原始消息内容
```

请求体就是消息内容。路径标题可省略，默认使用 `MeoW`。

## POST 表单

支持以下媒体类型：

- `multipart/form-data`
- `application/x-www-form-urlencoded`

表单字段为 `title`、`msg`、`url` 和 `imgUrl`。文档中的表单 Schema 要求 `title` 和 `msg`。`msgType` 和 `htmlHeight` 仍须放在查询字符串中。

## GET

仅对简短请求使用 GET，或在用户明确需要 URL 形式集成时使用：

```text
GET /{nickname}/{title}/{msg}
GET /{nickname}/{msg}                 # 标题默认为 MeoW
```

可选查询参数为 `url`、`imgUrl`、`msgType` 和 `htmlHeight`。

每个动态路径段必须分别进行百分号编码。查询参数应按查询值编码，不要一次性编码整个 URL。昵称不能包含 `/`。

## 显示类型

- `text`：默认值，按纯文本显示。
- `html`：在 App 中把消息内容渲染为 HTML；`htmlHeight` 控制显示高度，默认 `200`。
- 不支持 Markdown，绝不能发送 `msgType=markdown`。

## 响应

响应结构：

```json
{
  "status": 200,
  "data": true,
  "msg": "发送成功"
}
```

业务状态码：

| 状态码 | 含义 | 处理方式 |
|---:|---|---|
| `200` | 接口接受成功 | 仅在 `data=true` 时报告成功 |
| `400` | 标题或消息缺失、无效 | 修正请求，不要用原输入重试 |
| `403` | 内容被策略拒绝 | 报告拒绝原因，不要用相同内容重试 |
| `404` | 接收者昵称未注册 | 请用户核对昵称 |
| `429` | 发送或 IP 频率超限 | 不要自动重试 |
| `500` | 服务器错误 | 送达结果可能不确定，重试前询问用户 |

服务端仍通过 JSON 返回业务状态码，因此不能只依赖 HTTP 状态。

## 非会员发送限制

API 文档规定非会员用户的发送限制为：

- 每 3 秒最多 1 条
- 每分钟最多 15 条
- 每小时最多 60 条
- 保留每天最多 1,000 条的现有限制

超过任一发送或 IP 频率限制时，返回业务 `status=429`。响应没有提供可靠的剩余等待时间，不要自行编造等待时长或安排自动重试。

