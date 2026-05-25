# koishi-plugin-wechat-robot-adapter

[![npm](https://img.shields.io/npm/v/koishi-plugin-wechat-robot-adapter)](https://www.npmjs.com/package/koishi-plugin-wechat-robot-adapter)

WeChat robot adapter for [wechat-robot-client](https://github.com/houhou-sa/wechat-robot-client). Polls messages from MySQL and dispatches to Koishi.

## Features

- ✅ MySQL polling — receives WeChat messages via database
- ✅ Webhook fallback — register as Koishi webhook endpoint
- ✅ Auto-reconnect — heartbeat check every 30s detects client logout/login
- ✅ Group & private chat support
- ✅ Image, video, voice message forwarding
- ✅ At-mention parsing in group chats

## Usage

1. Install the plugin:

```bash
yarn add koishi-plugin-wechat-robot-adapter
```

2. Add to `koishi.yml`:

```yaml
plugins:
  wechat-robot-adapter:
    selfId: wxid_xxx              # Your robot's wxid
    endpoint: http://client:9000   # wechat-robot-client API address
    mysqlHost: wechat-admin-mysql  # MySQL host
    mysqlPort: 3306
    mysqlUser: your_user
    mysqlPassword: your_password
    mysqlDatabase: your_database
    pollInterval: 2                # Polling interval in seconds
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | (required) | wechat-robot-client API 地址 |
| `selfId` | `string` | (required) | 机器人 wxid |
| `mysqlHost` | `string` | `wechat-admin-mysql` | MySQL 主机 |
| `mysqlPort` | `number` | `3306` | MySQL 端口 |
| `mysqlUser` | `string` | `robot_x8ov8zyVz79Kz5Dq` | MySQL 用户名 |
| `mysqlPassword` | `string` | (default from setup) | MySQL 密码 |
| `mysqlDatabase` | `string` | (default from setup) | MySQL 数据库 |
| `pollInterval` | `number` | `2` | 轮询间隔(秒) |
| `webhookEnabled` | `boolean` | `true` | 启用 Webhook 备选 |
| `webhookPath` | `string` | `/wechat-robot/callback` | Webhook 路径 |
