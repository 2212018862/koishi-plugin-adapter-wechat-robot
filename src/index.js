const { Schema, Bot, MessageEncoder } = require("koishi");
const mysql = require("mysql2/promise");

// ============ Bot Config ============
const Config = Schema.object({
  endpoint: Schema.string().description("wechat-robot-client API 地址").required(),
  selfId: Schema.string().description("机器人 wxid").required(),
  timeout: Schema.number().description("请求超时(ms)").default(30000),
  mysqlHost: Schema.string().description("MySQL 主机").default("127.0.0.1"),
  mysqlPort: Schema.number().description("MySQL 端口").default(3306),
  mysqlUser: Schema.string().description("MySQL 用户名").default("root"),
  mysqlPassword: Schema.string().description("MySQL 密码"),
  mysqlDatabase: Schema.string().description("MySQL 数据库").default("wechat_robot"),
  pollInterval: Schema.number().description("轮询间隔(秒)").default(2),
  webhookEnabled: Schema.boolean().description("启用 Webhook 接收消息(备选)").default(true),
  webhookPath: Schema.string().description("Webhook 回调路径").default("/wechat-robot/callback"),
  webhookSecret: Schema.string().description("Webhook 签名密钥 (可选)"),
});

// ============ Bot ============
class WeChatRobotBot extends Bot {
  static inject = ["http", "server"];
  static Config = Config;

  constructor(ctx, config) {
    super(ctx, config);
    this.platform = "wechat-robot";
    this.adapterName = "wechat-robot";
    this.logger = ctx.logger("wechat-robot");
    this._http = ctx.http.extend({
      endpoint: config.endpoint,
      timeout: config.timeout || 30000,
    });
    this._lastMsgId = 0;
    this._pollTimer = null;
    this._mysqlPool = null;
  }

  async start() {
    // 1. Register webhook (fallback method)
    if (this.config.webhookEnabled !== false) {
      const path = this.config.webhookPath || "/wechat-robot/callback";
      const secret = this.config.webhookSecret;
      const bot = this;

      this.ctx.server.post(path, (koaCtx) => {
        if (secret) {
          const sig = koaCtx.headers["x-signature"] || koaCtx.headers["authorization"];
          if (sig !== secret) { koaCtx.status = 403; koaCtx.body = { success: false }; return; }
        }
        koaCtx.status = 200;
        koaCtx.body = { success: true };
        try {
          const body = koaCtx.request.body;
          if (!body || !body.Data || !body.Data.AddMsgs) return;
          handleSyncMessage(bot, body.Data).catch((e) =>
            bot.logger.error("callback error: %s", e.message || e)
          );
        } catch (e) {
          bot.logger.warn("webhook body error: %s (raw=%s)", e.message || e,
            koaCtx.request.body ? typeof koaCtx.request.body : "no-body");
        }
      });
      this.logger.info("webhook registered at %s", path);
    }

    // 2. Connect to MySQL for polling
    if (this.config.mysqlPassword) {
      try {
        this._mysqlPool = mysql.createPool({
          host: this.config.mysqlHost,
          port: this.config.mysqlPort,
          user: this.config.mysqlUser,
          password: this.config.mysqlPassword,
          database: this.config.mysqlDatabase,
          waitForConnections: true,
          connectionLimit: 2,
          queueLimit: 0,
          connectTimeout: 5000,
        });
        const [rows] = await this._mysqlPool.query("SELECT MAX(id) as maxId FROM messages");
        this._lastMsgId = (rows[0] && rows[0].maxId) || 0;
        this.logger.info("mysql connected, last msg_id = %d", this._lastMsgId);
      } catch (e) {
        this.logger.warn("mysql connect failed, falling back to webhook only: %s", e.message || e);
        this._mysqlPool = null;
      }
    } else {
      this.logger.warn("mysql password not configured, falling back to webhook only");
    }

    // 3. Start polling if MySQL is available
    if (this._mysqlPool) {
      this._startPolling();
    }

    // 4. Start health check
    this._startHealthCheck();

    // 5. Check robot status
    try {
      const running = await this.isRunning();
      if (!running) { this.logger.warn("service not running"); this.status = 0; return; }
      const loggedIn = await this.isLoggedIn();
      if (!loggedIn) { this.logger.warn("not logged in"); this.status = 0; return; }
      try { const info = await this.getCachedInfo(); if (info?.Wxid) this.selfId = info.Wxid; } catch {}
      this.status = 1;
      this.logger.info("robot %s connected (polling every %ds)", this.selfId, this.config.pollInterval);
    } catch (e) {
      this.logger.error("connect failed: %s", e.message || e);
      this.status = 0;
    }
  }

  async stop() {
    this._stopPolling();
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._mysqlPool) {
      await this._mysqlPool.end().catch(() => {});
      this._mysqlPool = null;
    }
    this.status = 0;
    this.logger.info("robot stopped");
  }

  // ======== Health Check ========

  _startHealthCheck() {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => this._healthCheck(), 30000);
  }

  async _healthCheck() {
    try {
      const loggedIn = await this.isLoggedIn();
      if (loggedIn && this.status !== 1) {
        try {
          const info = await this.getCachedInfo();
          if (info?.Wxid) this.selfId = info.Wxid;
        } catch {}
        this.status = 1;
        this.logger.info("health: robot reconnected");
      } else if (!loggedIn && this.status === 1) {
        this.status = 0;
        this.logger.warn("health: robot disconnected");
      }
    } catch {}
  }

  // ======== Polling ========

  _startPolling() {
    const interval = (this.config.pollInterval || 2) * 1000;
    this._pollTimer = setInterval(() => this._poll(), interval);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    if (!this._mysqlPool) return;
    try {
      const [rows] = await this._mysqlPool.query(
        "SELECT id, msg_id, type, content, from_wxid, sender_wxid, " +
        "to_wxid, is_chat_room, created_at " +
        "FROM messages WHERE id > ? ORDER BY id ASC LIMIT 50",
        [this._lastMsgId]
      );
      for (const row of rows) {
        try {
          const session = toSessionFromRow(this, row);
          if (session) this.dispatch(session);
          this._lastMsgId = row.id;
        } catch (e) {
          this.logger.error("poll msg %d error: %s", row.id, e.message || e);
        }
      }
    } catch (e) {
      this.logger.debug("poll error: %s", e.message || e);
    }
  }

  // ======== API Methods ========

  async isRunning() {
    try { const r = await this._http.get("/api/v1/robot/is-running"); return r && (r.data === true || r === true); }
    catch { return false; }
  }

  async isLoggedIn() {
    try { const r = await this._http.get("/api/v1/robot/is-loggedin"); return r && (r.data === true || r === true); }
    catch { return false; }
  }

  async getCachedInfo() {
    const r = await this._http.get("/api/v1/robot/get-cached-info");
    return r && r.data ? r.data : r;
  }

  async sendTextMessage(toWxid, content, atList) {
    const body = { to_wxid: toWxid, content };
    if (atList?.length) body.at = atList;
    return this._http.post("/api/v1/robot/message/send/text", body);
  }

  async sendImageByUrl(toWxid, urls) {
    return this._http.post("/api/v1/robot/message/send/image/url", { to_wxid: toWxid, image_urls: urls });
  }

  async sendVideoByUrl(toWxid, urls) {
    return this._http.post("/api/v1/robot/message/send/video/url", { to_wxid: toWxid, video_urls: urls });
  }

  async sendVoice(toWxid, url) {
    return this._http.post("/api/v1/robot/message/send/voice/url", { to_wxid: toWxid, voice_url: url });
  }
}

// ============ Message Encoder ============
WeChatRobotBot.MessageEncoder = class extends MessageEncoder {
  // Override render to skip visit() — our flush handles everything directly
  async render() {}

  async flush() {
    const { channelId, elements } = this.session;
    if (!channelId) return;
    const textParts = [], atList = [], imageUrls = [];
    for (const el of elements || []) {
      if (el.type === "text") textParts.push(el.attrs?.content || "");
      else if (el.type === "at" && el.attrs?.id) atList.push(el.attrs.id);
      else if (el.type === "image" && el.attrs?.src) imageUrls.push(el.attrs.src);
      else if (el.attrs?.content) textParts.push(el.attrs.content);
    }
    const text = textParts.join("").trim();
    if (text) await this.bot.sendTextMessage(channelId, text, atList.length ? atList : undefined);
    for (const url of imageUrls) await this.bot.sendImageByUrl(channelId, [url]);
  }
};

// ============ Message Handler (Webhook) ============
async function handleSyncMessage(bot, syncMessage) {
  for (const msg of syncMessage.AddMsgs || []) {
    try {
      const session = toSession(bot, msg);
      if (session) bot.dispatch(session);
    } catch (e) { bot.logger.error("msg error: %s", e.message || e); }
  }
}

function toSession(bot, msg) {
  if (msg.MsgType === 10000 || msg.MsgType === 10002) return undefined;
  const session = bot.session();
  session.type = "message";
  const fromUser = msg.FromUserName?.String || "";
  const isChatRoom = fromUser.endsWith("@chatroom");
  session.guildId = fromUser;
  session.channelId = fromUser;
  session.messageId = String(msg.MsgId || msg.NewMsgId || "");

  let senderId = fromUser;
  let content = msg.Content?.String || "";
  if (isChatRoom) {
    const colon = content.indexOf(":");
    if (colon > 0) { senderId = content.substring(0, colon); content = content.substring(colon + 1).trim(); }
  }
  session.author = { userId: senderId, username: senderId, isBot: false };
  session.userId = senderId;

  switch (msg.MsgType) {
    case 1:
      if (msg.MsgSource) {
        const m = msg.MsgSource.match(/<atuserlist>(.*?)<\/atuserlist>/);
        if (m?.[1]) for (const wxid of m[1].split(",").filter(Boolean)) {
          content = content.replace(new RegExp("@" + wxid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `<at id="${wxid}"/>`);
        }
      }
      session.content = content; break;
    case 3: session.content = "[图片]"; break;
    case 34: session.content = "[语音]"; break;
    case 43: session.content = "[视频]"; break;
    case 47: session.content = "[表情]"; break;
    case 48: session.content = "[位置]"; break;
    case 42: session.content = "[名片]"; break;
    case 49: { const t = content.match(/<title>(.*?)<\/title>/s); session.content = t?.[1]?.trim() || "[应用消息]"; break; }
    default: session.content = "[消息类型:" + msg.MsgType + "]"; break;
  }
  if (!session.content) return undefined;
  if (msg.CreateTime) session.timestamp = msg.CreateTime * 1000;
  return session;
}

// ============ Session from MySQL Row ============
function toSessionFromRow(bot, row) {
  const msgType = row.type;
  if (msgType === 10000 || msgType === 10002) return undefined;

  const session = bot.session();
  session.type = "message";

  const fromUser = row.from_wxid || "";
  const isChatRoom = row.is_chat_room == 1 || fromUser.endsWith("@chatroom");
  session.guildId = fromUser;
  session.channelId = fromUser;
  session.messageId = String(row.msg_id || row.id);

  let senderId = fromUser;
  let content = row.content || "";
  if (isChatRoom && row.sender_wxid) {
    senderId = row.sender_wxid;
  }
  session.author = { userId: senderId, username: senderId, isBot: false };
  session.userId = senderId;

  switch (msgType) {
    case 1: session.content = content; break;
    case 3: session.content = "[图片]"; break;
    case 34: session.content = "[语音]"; break;
    case 43: session.content = "[视频]"; break;
    case 47: session.content = "[表情]"; break;
    case 48: session.content = "[位置]"; break;
    case 42: session.content = "[名片]"; break;
    case 49: {
      const t = content.match(/<title>(.*?)<\/title>/s);
      session.content = t?.[1]?.trim() || "[应用消息]";
      break;
    }
    default: session.content = "[消息类型:" + msgType + "]"; break;
  }
  if (!session.content) return undefined;
  if (row.created_at) session.timestamp = row.created_at * 1000;
  return session;
}

module.exports = WeChatRobotBot;
