# Changelog

## 2.0.1 (2026-05-28)

### 🐛 Bug Fix

- 修复配置界面「消息接收模式」下拉框为空的问题（`Schema.const` 缺少 `.required()` 标记）

## 2.0.0 (2026-05-28)

### ⚠️ 包名变更

- 包名从 `koishi-plugin-wechat-robot-adapter` 更改为 `koishi-plugin-adapter-wechat-robot`
- 符合 Koishi 适配器命名规范，自动归入插件市场的「适配器」分类
- 旧包已标记 deprecated

### ✨ 新功能

- **模式选择器** — 新增三种消息接收模式：Webhook（推荐）、数据库轮询、混合模式
- **配置界面优化** — 使用 `Schema.union` 实现动态配置项显示/隐藏
- **详细字段描述** — 每个配置项都有详细的中文说明，方便新手理解

### 🐛 Bug 修复

- 修复 `pollInterval=0` 被 JS falsy 值覆盖的问题（`||` → `??`）
- 修复 webhook body 格式不兼容的问题（支持顶层和嵌套 `Data` 两种格式）
- 修复 Go `*string` JSON 序列化键名大小写不匹配的问题（`getString()` helper）
- 修复 `MessageEncoder.flush()` 中 `this.logger` 未定义的错误（→ `this.bot.logger`）

### 🧹 清理

- 移除所有调试日志输出（`[HANDLE]`、`[FLUSH]`、`[POLL]`、`console.log`）
- 代码结构优化：webhook / MySQL / health check 逻辑分离

### ⚠️ Breaking Changes

配置格式已变更。旧的平铺配置：

```yaml
wechat-robot-adapter:
  endpoint: http://127.0.0.1:9000
  selfId: wxid_xxx
  mysqlHost: wechat-admin-mysql
  mysqlUser: robot_xxxx
  mysqlPassword: xxx
  mysqlDatabase: xxx
  pollInterval: 2
  webhookEnabled: true
  webhookPath: /wechat-robot/callback
```

需要改为新的模式选择格式：

```yaml
wechat-robot-adapter:
  mode: webhook  # 或 polling / mixed
  endpoint: http://127.0.0.1:9000
  selfId: wxid_xxx
  webhookPath: /wechat-robot/callback
```

## 1.0.2 (2026-05-27)

- 初始发布
- MySQL 轮询消息接收
- 基础 Webhook 支持
