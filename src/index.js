const { Schema, Bot, MessageEncoder } = require("koishi");
const mysql = require("mysql2/promise");

// Helper: get string value from Go's *string JSON (key may be "String" or "string")
function getString(obj) {
  if (!obj) return "";
  return obj.String || obj.string || "";
}

// ============ Schema ============

const modeDesc = `消息接收模式：
• **Webhook（推荐）**：wechat-robot-client 主动将消息 POST 到 Koishi，实时性最好（毫秒级延迟），配置简单，无需数据库连接。
• **数据库轮询**：Koishi 定时查询 MySQL 数据库获取新消息，适合 Webhook 不可达的场景（如 Koishi 在内网），需要配置 MySQL 连接信息。
• **混合模式**：同时启用 Webhook 和数据库轮询，Webhook 负责实时推送，轮询作为兜底确保不丢消息。`;

const endpointDesc = "wechat-robot-client 的 API 地址，例如 http://127.0.0.1:9000。该地址用于健康检查和发送消息，需要 Koishi 能直接访问。";
const selfIdDesc = "机器人的微信 wxid，例如 wxid_xxxxxxxxxxxx。首次连接时会自动获取，可留空。";
const timeoutDesc = "调用 client API 的超时时间（毫秒），网络较慢时可适当增大。";

const mysqlHostDesc = "MySQL 数据库地址，需与 wechat-robot-client 使用同一个数据库。同机部署通常为 wechat-admin-mysql（Docker 容器名）或 127.0.0.1。";
const mysqlPortDesc = "MySQL 端口，默认 3306。";
const mysqlUserDesc = "MySQL 用户名。如果是 Docker 部署，通常为 robot_xxxx（在管理后台创建机器人时自动生成）。";
const mysqlPasswordDesc = "MySQL 密码。如果使用数据库轮询或混合模式，此项必填。留空则跳过数据库连接。";
const mysqlDatabaseDesc = "数据库名称，通常与 robot_code 相同，例如 x8ov8zyVz79Kz5Dq。";
const pollIntervalDesc = "数据库轮询间隔（秒）。设为 0 则禁用轮询（仅在混合模式下有意义）。默认 2 秒。";

const webhookPathDesc = "Webhook 回调路径，wechat-robot-client 会向此路径 POST 消息。需要在 client 的数据库中配置 webhook_url 指向 Koishi 的此路径。";
const webhookSecretDesc = "Webhook 签名密钥（可选）。如果设置了，client 发送 webhook 时需携带对应的签名 header。";

// Common fields shared by all modes
const commonFields = {
  endpoint: Schema.string().description(endpointDesc).required(),
  selfId: Schema.string().description(selfIdDesc).default(""),
  timeout: Schema.number().description(timeoutDesc).default(30000),
};

// MySQL fields
const mysqlFields = {
  mysqlHost: Schema.string().description(mysqlHostDesc).default("127.0.0.1"),
  mysqlPort: Schema.number().description(mysqlPortDesc).default(3306),
  mysqlUser: Schema.string().description(mysqlUserDesc).default("root"),
  mysqlPassword: Schema.string().description(mysqlPasswordDesc),
  mysqlDatabase: Schema.string().description(mysqlDatabaseDesc).default("wechat_robot"),
};

// Polling fields
const pollingFields = {
  ...mysqlFields,
  pollInterval: Schema.number().description(pollIntervalDesc).default(2),
};

// Webhook fields
const webhookFields = {
  webhookPath: Schema.string().description(webhookPathDesc).default("/wechat-robot/callback"),
  webhookSecret: Schema.string().description(webhookSecretDesc),
};

const Config = Schema.intersect([
  Schema.object({
    mode: Schema.union([
      Schema.const("webhook").description("Webhook 推荐，client 主动推送消息，毫秒级延迟"),
      Schema.const("polling").description("数据库轮询，适合 Koishi 在内网无法接收 Webhook 的场景"),
      Schema.const("mixed").description("同时启用 Webhook 和轮询，双保险不丢消息"),
    ]).default("webhook").description("消息接收模式"),
  }),
  Schema.union([
    Schema.object({
      mode: Schema.const("webhook"),
      ...webhookFields,
    }),
    Schema.object({
      mode: Schema.const("polling"),
      ...mysqlFields,
      pollInterval: Schema.number().description(pollIntervalDesc).default(2),
    }),
    Schema.object({
      mode: Schema.const("mixed"),
      ...webhookFields,
      ...mysqlFields,
      pollInterval: Schema.number().description(pollIntervalDesc).default(2),
    }),
  ]),
  Schema.object(commonFields),
]).default({ mode: "webhook", endpoint: "" });

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
    this._healthFails = 0;
    this._contactCache = {};  // wxid -> { nickname, avatar }
    this._healthHttp = ctx.http.extend({
      endpoint: config.endpoint,
      timeout: 3000,
    });
  }

  get mode() {
    return this.config.mode || "webhook";
  }

  async start() {
    // 1. Register webhook if mode is webhook or mixed
    if (this.mode === "webhook" || this.mode === "mixed") {
      this._registerWebhook();
    }

    // 2. Connect to MySQL if mode is polling or mixed
    if (this.mode === "polling" || this.mode === "mixed") {
      await this._initMySQL();
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
      try {
        await this._updateBotInfo();
      } catch {}
      await this._loadContacts();
      this.status = 1;
      this.logger.info("robot %s connected (mode=%s)", this.selfId, this.mode);
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

  // ======== Webhook ========

  _registerWebhook() {
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
        if (!body) return;
        const syncData = body.Data || body;
        if (!syncData.AddMsgs) return;
        handleSyncMessage(bot, syncData).catch((e) =>
          bot.logger.error("webhook error: %s", e.message || e)
        );
      } catch (e) {
        bot.logger.warn("webhook parse error: %s", e.message || e);
      }
    });
    this.logger.info("webhook registered at %s", path);
  }

  // ======== MySQL ========

  async _initMySQL() {
    if (!this.config.mysqlPassword) {
      this.logger.warn("mysql password not configured, skipping database connection");
      return;
    }
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
      this.logger.warn("mysql connect failed: %s", e.message || e);
      this._mysqlPool = null;
    }
  }

  // ======== Health Check ========

  _startHealthCheck() {
    if (this._healthTimer) return;
    this._healthTimer = setInterval(() => this._healthCheck(), 30000);
  }

  async _healthCheck() {
    try {
      const r = await this._healthHttp.get("/api/v1/robot/is-loggedin");
      const loggedIn = r && (r.data === true || r === true);
      if (loggedIn) {
        this._healthFails = 0;
        if (this.status !== 1) {
          await this._updateBotInfo();
          await this._loadContacts();
          this.status = 1;
          this.logger.info("health: robot reconnected");
        }
      } else {
        this._healthFails++;
        if (this._healthFails >= 3 && this.status === 1) {
          this.status = 0;
          this.logger.warn("health: robot disconnected (3 failures)");
        }
      }
    } catch {
      this._healthFails++;
      if (this._healthFails >= 3 && this.status === 1) {
        this.status = 0;
        this.logger.warn("health: robot disconnected (3 timeouts)");
      }
    }
  }

  // ======== Polling ========

  _startPolling() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    const pollSec = this.config.pollInterval ?? 2;
    if (pollSec <= 0) { this.logger.info("polling disabled (pollInterval=%d)", pollSec); return; }
    this._pollTimer = setInterval(() => this._poll(), pollSec * 1000);
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

  async _updateBotInfo() {
    try {
      const info = await this.getCachedInfo();
      if (info?.Wxid) this.selfId = info.Wxid;
      if (info?.NickName || info?.HeadUrl) {
        this.user = {
          ...this.user,
          ...(info?.NickName ? { name: info.NickName } : {}),
          ...(info?.HeadUrl ? { avatar: info.HeadUrl } : {}),
        };
      }
    } catch {}
    if (!this.selfId) this.selfId = this.config.selfId;
  }

  async getCachedInfo() {
    const r = await this._http.get("/api/v1/robot/get-cached-info");
    return r && r.data ? r.data : r;
  }

  async _loadContacts() {
    try {
      const r = await this._http.get("/api/v1/robot/contacts");
      const items = (r && r.data ? r.data.items : r.items) || [];
      for (const item of items) {
        const wxid = item.wechat_id || item.WechatId || "";
        const nickname = item.nickname || item.NickName || "";
        const avatar = item.avatar || item.Avatar || "";
        if (wxid) this._contactCache[wxid] = { nickname, avatar };
      }
      this.logger.info("loaded %d contacts", items.length);
    } catch (e) {
      this.logger.debug("load contacts failed: %s", e.message || e);
    }
  }

  getContactName(wxid) {
    return this._contactCache[wxid]?.nickname || wxid;
  }

  async getGuildMember(guildId, userId) {
    if (!this._contactCache[userId]) await this._loadContacts();
    const contact = this._contactCache[userId];
    return {
      userId,
      name: contact?.nickname || userId,
      avatar: contact?.avatar || "",
      nickname: contact?.nickname || "",
    };
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

// ============ Session from Webhook Message ============
function toSession(bot, msg) {
  if (msg.MsgType === 10000 || msg.MsgType === 10002) return undefined;
  const session = bot.session();
  session.type = "message";
  const fromUser = getString(msg.FromUserName) || "";
  const isChatRoom = fromUser.endsWith("@chatroom");
  session.guildId = fromUser;
  session.channelId = fromUser;
  session.messageId = String(msg.MsgId || msg.NewMsgId || "");

  let senderId = fromUser;
  let content = getString(msg.Content) || "";
  if (isChatRoom) {
    const colon = content.indexOf(":");
    if (colon > 0) { senderId = content.substring(0, colon); content = content.substring(colon + 1).trim(); }
  }
  session.author = { userId: senderId, username: bot.getContactName(senderId), isBot: false };
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
  session.author = { userId: senderId, username: bot.getContactName(senderId), isBot: false };
  session.userId = senderId;

  switch (msgType) {
    case 1: session.content = content; break;
    case 3: session.content = "[图片]"; break;
    case 34: session.content = "[语音]"; break;
    case 43: session.content = "[视频]"; break;
    case 47: session.content = "[表情]"; break;
    case 48: session.content = "[位置]"; break;
    case 42: session.content = "[名片]"; break;
    case 49: { const t = content.match(/<title>(.*?)<\/title>/s); session.content = t?.[1]?.trim() || "[应用消息]"; break; }
    default: session.content = "[消息类型:" + msgType + "]"; break;
  }
  if (!session.content) return undefined;
  if (row.created_at) session.timestamp = row.created_at * 1000;
  return session;
}

module.exports = WeChatRobotBot;
