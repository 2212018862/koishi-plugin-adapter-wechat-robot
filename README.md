# koishi-plugin-adapter-wechat-robot

[![npm](https://img.shields.io/npm/v/koishi-plugin-adapter-wechat-robot)](https://www.npmjs.com/package/koishi-plugin-adapter-wechat-robot)

WeChat robot adapter for [wechat-robot-client](https://github.com/hp0912/wechat-robot-client). 支持 Webhook 实时推送和 MySQL 数据库轮询两种消息接收模式。

## 功能特性

- ✅ **Webhook 模式** — wechat-robot-client 主动推送消息到 Koishi，毫秒级实时延迟
- ✅ **数据库轮询模式** — 定时查询 MySQL 获取新消息，适合 Webhook 不可达的场景
- ✅ **混合模式** — 同时启用 Webhook 和轮询，双保险不丢消息
- ✅ 自动重连 — 每 30 秒健康检查，断线自动恢复
- ✅ 群聊和私聊消息支持
- ✅ 图片、视频、语音消息转发
- ✅ 群聊 @提及解析
- ✅ 配置界面模式选择器，字段自动显示/隐藏

## 消息接收模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| **Webhook（推荐）** | client 主动 POST 消息到 Koishi | 实时性要求高、Koishi 可被 client 访问 |
| **数据库轮询** | Koishi 定时查询 MySQL | Koishi 在内网、Webhook 不可达 |
| **混合模式** | Webhook + 轮询同时工作 | 需要最高可靠性 |

### Webhook 模式原理

```
微信消息 → iPad 协议服务 → wechat-robot-client → HTTP POST → Koishi webhook 端点
```

Webhook 模式下，wechat-robot-client 在收到每条消息时会立即 POST 到 Koishi 的 webhook 地址，无需数据库连接，延迟最低。

### 数据库轮询模式原理

```
微信消息 → iPad 协议服务 → wechat-robot-client → 写入 MySQL → Koishi 定时查询
```

轮询模式下，Koishi 通过定时查询 MySQL 数据库的 `messages` 表获取新消息。需要 Koishi 能连接到 MySQL。

## 安装

```bash
# 在 Koishi 控制台的插件市场搜索 adapter-wechat-robot 安装
# 或手动安装
yarn add koishi-plugin-adapter-wechat-robot
```

## 配置

### Webhook 模式（推荐）

最简单的配置，只需 client 的 API 地址：

```yaml
plugins:
  wechat-robot-adapter:
    mode: webhook
    endpoint: http://127.0.0.1:9000  # wechat-robot-client API 地址
    webhookPath: /wechat-robot/callback  # webhook 回调路径
```

还需要在 wechat-robot-client 的数据库中配置 webhook_url：

```sql
UPDATE system_settings SET webhook_url = 'http://<koishi地址>:5140/wechat-robot/callback' WHERE id = 1;
```

### 数据库轮询模式

如果 Webhook 不可达（如 Koishi 在内网），可以使用数据库轮询：

```yaml
plugins:
  wechat-robot-adapter:
    mode: polling
    endpoint: http://127.0.0.1:9000
    mysqlHost: wechat-admin-mysql  # MySQL 地址
    mysqlPort: 3306
    mysqlUser: robot_xxxx          # 数据库用户名
    mysqlPassword: your_password   # 数据库密码
    mysqlDatabase: your_database   # 数据库名
    pollInterval: 2                # 轮询间隔（秒）
```

### 混合模式

同时启用 Webhook 和数据库轮询：

```yaml
plugins:
  wechat-robot-adapter:
    mode: mixed
    endpoint: http://127.0.0.1:9000
    webhookPath: /wechat-robot/callback
    mysqlHost: wechat-admin-mysql
    mysqlUser: robot_xxxx
    mysqlPassword: your_password
    mysqlDatabase: your_database
    pollInterval: 2
```

## 配置项说明

### 通用配置（所有模式共享）

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mode` | `string` | `webhook` | 消息接收模式：`webhook` / `polling` / `mixed` |
| `endpoint` | `string` | (必填) | wechat-robot-client 的 API 地址 |
| `selfId` | `string` | 自动获取 | 机器人的微信 wxid，留空会自动获取 |
| `timeout` | `number` | `30000` | API 调用超时时间（毫秒） |

### Webhook 配置

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `webhookPath` | `string` | `/wechat-robot/callback` | Webhook 回调路径 |
| `webhookSecret` | `string` | (空) | Webhook 签名密钥（可选） |

### 数据库轮询配置

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `mysqlHost` | `string` | `127.0.0.1` | MySQL 主机地址 |
| `mysqlPort` | `number` | `3306` | MySQL 端口 |
| `mysqlUser` | `string` | `root` | MySQL 用户名 |
| `mysqlPassword` | `string` | (空) | MySQL 密码（轮询模式必填） |
| `mysqlDatabase` | `string` | `wechat_robot` | 数据库名 |
| `pollInterval` | `number` | `2` | 轮询间隔（秒），设为 0 禁用轮询 |

## 常见问题

### Webhook 模式下消息收不到？

1. 确认 Koishi 的 webhook 端口（默认 5140）已对外暴露
2. 确认 client 的数据库中 `webhook_url` 配置正确
3. 确认 client 能访问到 Koishi 的地址

### 数据库轮询模式连接失败？

1. 确认 MySQL 地址和端口正确
2. 确认用户名和密码正确
3. 如果 Koishi 运行在 Docker 中，注意使用 Docker 网络内的容器名（如 `wechat-admin-mysql`）

### 如何查看机器人状态？

在 Koishi 控制台的插件配置页面可以看到连接状态。日志中会显示：
- `webhook registered at /wechat-robot/callback` — Webhook 已注册
- `robot wxid_xxx connected (mode=webhook)` — 机器人已连接
- `health: robot reconnected` — 自动重连成功

## Changelog

### 2.0.0

- 🎉 **新增模式选择器** — 支持 Webhook、数据库轮询、混合三种模式
- 🔧 **配置界面优化** — 使用 `Schema.union` 实现模式切换，选择模式后自动显示/隐藏相关配置项
- 📝 **详细字段描述** — 每个配置项都有中文说明，新手友好
- 🐛 **修复 pollInterval=0 的 falsy 问题** — 使用 `??` 运算符替代 `||`
- 🐛 **修复 webhook body 格式兼容** — 支持 client 发送的顶层和嵌套格式
- 🐛 **修复 Go *string JSON 序列化大小写问题** — 同时兼容 `String` 和 `string` 键名
- 🐛 **修复 MessageEncoder 中的 logger 引用** — `this.logger` → `this.bot.logger`
- 🧹 **清理调试日志** — 移除所有临时调试输出

### 1.0.2

- 初始 Webhook 支持
- MySQL 轮询功能

## License

MIT
