/**
 * TSDM 签到/打工 共用内核。
 *
 * 请求参数、文案判定、页面选择器全部来自工作区内的真实抓包记录，
 * 端口到端口的对照见 README「抓包依据」一节。
 * 除 Node 内置模块外无任何依赖。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const LOG_PREFIX = '[TSDM]';

// ── 默认值 ────────────────────────────────────────────────────────────

// 默认用手机端 UA。官方客户端在真机上就是以浏览器类指纹直接调网页接口的，
// 不带 cf_clearance 也能工作，所以优先按移动端指纹试。
const DEFAULT_MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/154.0.0.0 Mobile Safari/537.36';

const DEFAULT_DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/154.0.0.0 Safari/537.36';

const CHANNELS = ['desktop', 'mobile-ua', 'mobile-tpl'];

const QDXQ_VALUES = ['kx', 'ng', 'ym', 'wl', 'nu', 'ch', 'fd', 'yl', 'shuai'];
const FASTREPLY_VALUES = [1, 2, 3, 4, 5, 6, 7, 8];

// ── 小工具 ────────────────────────────────────────────────────────────

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m.slice(1).find((v) => v != null && v !== '');
  }
  return null;
}

function snippetOf(html, len = 200) {
  return stripTags(html).slice(0, len);
}

/**
 * 诊断用：优先取出 Discuz 的提示信息块（id="messagetext"）。
 * 直接 stripTags 整页会把导航栏排在前面，真正的原因被挤出 200 字之外。
 */
function messageTextOf(html, len = 300) {
  const body = String(html || '');
  const m = /<div[^>]*id="messagetext"[^>]*>([\s\S]*?)<\/div>/i.exec(body);
  if (m) {
    const text = stripTags(m[1]).slice(0, len);
    if (text) return text;
  }
  // 没有标准提示块时退回整页，但跳过导航区
  const idx = body.indexOf('id="ct"');
  const tail = idx >= 0 ? body.slice(idx) : body;
  const text = stripTags(tail).slice(0, len);
  return text || snippetOf(body, len);
}

// ── 日志 ──────────────────────────────────────────────────────────────

class Logger {
  constructor(scope, debug) {
    this.scope = scope || 'TSDM';
    this.debug = !!debug;
  }

  line(level, msg) {
    const tag = level ? `${level} ` : '';
    console.log(`${LOG_PREFIX}[${nowStamp()}][${this.scope}] ${tag}${msg}`);
  }

  info(msg) { this.line('', msg); }
  ok(msg) { this.line('✅', msg); }
  warn(msg) { this.line('⚠️', msg); }
  error(msg) { this.line('❌', msg); }
  dbg(msg) { if (this.debug) this.line('🔍', msg); }

  child(scope) {
    return new Logger(`${this.scope}|${scope}`, this.debug);
  }
}

// ── Cookie ────────────────────────────────────────────────────────────

const COOKIE_PART_RE = /^([^=]+)=([\s\S]*)$/;

function parseCookieString(raw) {
  // 按 ";" 切分，值里不会出现分号；同名只保留第一次出现的
  const out = [];
  const seen = new Set();
  for (const part of String(raw || '').split(';')) {
    const seg = part.trim();
    if (!seg) continue;
    const m = COOKIE_PART_RE.exec(seg);
    if (!m) continue;
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push([name, m[2].trim()]);
  }
  return out;
}

function parseSetCookie(header) {
  const seg = String(header || '').split(';')[0];
  const m = COOKIE_PART_RE.exec(seg.trim());
  if (!m) return null;
  return [m[1].trim(), m[2].trim()];
}

class CookieJar {
  constructor(rawCookie) {
    this.map = new Map();
    for (const [k, v] of parseCookieString(rawCookie)) this.map.set(k, v);
  }

  has(name) { return this.map.has(name); }

  // Discuz 的 cookie 带站点前缀（本站是 Ystv_2132_），所以按「精确名」或「后缀名」匹配
  hasName(name) {
    if (this.map.has(name)) return true;
    for (const key of this.map.keys()) {
      if (key.endsWith(`_${name}`)) return true;
    }
    return false;
  }

  del(name) { this.map.delete(name); }

  set(name, value) { this.map.set(name, value); }

  absorbSetCookies(headers) {
    let list = [];
    if (!headers) return list;
    if (typeof headers.getSetCookie === 'function') {
      list = headers.getSetCookie();
    } else if (typeof headers.get === 'function') {
      const single = headers.get('set-cookie');
      if (single) list = single.split(/,(?=[^;=]+=[^;]*)/);
    }
    for (const item of list) {
      const kv = parseSetCookie(item);
      if (!kv) continue;
      this.map.set(kv[0], kv[1]);
    }
    return list;
  }

  toString() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  names() {
    return [...this.map.keys()];
  }
}

// ── 配置 ──────────────────────────────────────────────────────────────

function envStr(env, name) {
  const v = env[name];
  if (v == null) return '';
  return String(v).trim();
}

function envInt(env, name, def) {
  const raw = envStr(env, name);
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : def;
}

function envBool(env, name, def) {
  const raw = envStr(env, name).toLowerCase();
  if (!raw) return def;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

function splitAccounts(raw) {
  // 多账号按换行分隔；同时兼容 & 分隔（Cookie 值里不含 &）
  return String(raw || '')
    .split(/[\r\n&]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const requireCf = envBool(env, 'TSDM_REQUIRE_CF', false);

  const cookies = splitAccounts(envStr(env, 'TSDM_COOKIE'));
  if (!cookies.length) {
    errors.push('未设置 TSDM_COOKIE（浏览器里复制的完整 Cookie，通常需要包含 saltkey 与 auth）');
  }

  const accounts = cookies.map((raw, i) => {
    const jar = new CookieJar(raw);
    if (!jar.hasName('saltkey') || !jar.hasName('auth')) {
      const missing = ['saltkey', 'auth'].filter((n) => !jar.hasName(n));
      errors.push(
        `第 ${i + 1} 个账号的 Cookie 缺少关键字段：${missing.join('、')}` +
        '（应为 <前缀>_saltkey 与 <前缀>_auth，本站前缀是 Ystv_2132_）',
      );
    }
    // 默认剔除 cf_clearance：它与 IP/UA 绑定，带上不匹配的过期值反而容易触发校验。
    if (!requireCf && jar.has('cf_clearance')) {
      jar.del('cf_clearance');
      warnings.push(`第 ${i + 1} 个账号：已按默认策略剔除 cf_clearance（如需保留请设 TSDM_REQUIRE_CF=1）`);
    }
    return { index: i + 1, rawCookie: raw, jar };
  });

  const uaRaw = envStr(env, 'TSDM_UA');
  const mobileUa = uaRaw || DEFAULT_MOBILE_UA;
  const desktopUa = uaRaw || DEFAULT_DESKTOP_UA;

  const profile = {
    accounts,
    errors,
    warnings,
    base: envStr(env, 'TSDM_BASE') || 'https://www.tsdm39.com',
    requireCf,
    ua: mobileUa,
    mobileUa,
    desktopUa,
    proxy: envStr(env, 'TSDM_PROXY'),
    channel: envStr(env, 'TSDM_CHANNEL').toLowerCase(),
    qdxq: envStr(env, 'TSDM_QDXQ') || 'ym',
    todaysay: envStr(env, 'TSDM_TODAYSAY'),
    fastreply: envInt(env, 'TSDM_FASTREPLY', 0),
    clickMinMs: envInt(env, 'TSDM_WORK_CLICK_MIN_MS', 1200),
    clickMaxMs: envInt(env, 'TSDM_WORK_CLICK_MAX_MS', 2600),
    workRounds: envInt(env, 'TSDM_WORK_ROUNDS', 3),
    timeoutMs: envInt(env, 'TSDM_TIMEOUT_MS', 20000),
    retry: envInt(env, 'TSDM_RETRY', 2),
    delayBetweenMs: envInt(env, 'TSDM_DELAY_BETWEEN_MS', 1500),
    dryRun: envBool(env, 'TSDM_DRY_RUN', false),
    debug: envBool(env, 'TSDM_DEBUG', false),
    notify: {
      enabled: envBool(env, 'TSDM_NOTIFY', true),
      onSuccess: envBool(env, 'TSDM_NOTIFY_ON_SUCCESS', true),
      onFailure: envBool(env, 'TSDM_NOTIFY_ON_FAILURE', true),
      title: envStr(env, 'TSDM_NOTIFY_TITLE'),
      channelId: envStr(env, 'TSDM_NOTIFY_CHANNEL') || envStr(env, 'BHPKG_NOTIFY_CHANNEL'),
      baihuUrl: envStr(env, 'BHPKG_NOTIFY_URL'),
      baihuToken: envStr(env, 'BHPKG_NOTIFY_TOKEN'),
      qlNotifyPath: envStr(env, 'TSDM_QL_NOTIFY_PATH'),
      qlDir: envStr(env, 'QL_DIR'),
      pythonBin: envStr(env, 'TSDM_PYTHON') || envStr(env, 'PYTHON_BIN') || 'python3',
      webhookUrl: envStr(env, 'TSDM_WEBHOOK_URL'),
      // Server酱：优先用专用变量，其次复用青龙里常见的 PUSH_KEY
      serverchanKey: envStr(env, 'TSDM_SERVERCHAN_KEY') || envStr(env, 'PUSH_KEY'),
      // 自建/中转 Server酱 时覆盖端点（留空则按官方域名拼接）
      serverchanUrl: envStr(env, 'TSDM_SERVERCHAN_URL'),
    },
  };

  if (!QDXQ_VALUES.includes(profile.qdxq)) {
    warnings.push(`TSDM_QDXQ="${profile.qdxq}" 不是有效心情，已回退为 ym`);
    profile.qdxq = 'ym';
  }
  if (profile.todaysay) {
    const len = [...profile.todaysay].length;
    if (len < 3) {
      warnings.push('TSDM_TODAYSAY 少于 3 个字，已改为使用快速语句（qdmode=3）');
      profile.todaysay = '';
    } else if (len > 50) {
      warnings.push('TSDM_TODAYSAY 超过 50 个字，已截断到 50 个字');
      profile.todaysay = [...profile.todaysay].slice(0, 50).join('');
    }
  }
  if (profile.channel && !CHANNELS.includes(profile.channel)) {
    warnings.push(`TSDM_CHANNEL="${profile.channel}" 无效，改为自动探测所有通道`);
    profile.channel = '';
  }

  return profile;
}

// ── HTTP ──────────────────────────────────────────────────────────────

class TsdmHttpError extends Error {
  constructor(kind, message, extra) {
    super(message);
    this.name = 'TsdmHttpError';
    this.kind = kind; // challenge | http | network | timeout | config
    this.status = extra && extra.status;
    this.url = extra && extra.url;
    this.code = extra && extra.code;
    this.snippet = extra && extra.snippet;
  }
}

/**
 * 只有「挑战专用标记」才算 Cloudflare 盾页。
 *
 * 注意：本站每个正常页面里都有 Cloudflare 注入的
 * /cdn-cgi/challenge-platform/scripts/jsd/main.js 探测脚本，
 * 所以不能用 "challenge-platform" 这种宽泛关键字，否则会把正常页误判成盾页。
 */
const CHALLENGE_MARKERS = [
  'cf_chl_opt',
  '/cdn-cgi/challenge-platform/h/', // 真正的挑战编排路径
  'cf-chl-',
  '__cf_chl_tk',
];

function detectChallenge(html, status) {
  const body = String(html || '');
  if (/<title>\s*just a moment/i.test(body)) return true;
  if (/<title>\s*attention required/i.test(body)) return true;
  if (/<title>\s*one more step/i.test(body)) return true;
  // 盾页不会有 Discuz 自己的页面标记；有则说明拿到的是真实页面
  const looksLikeDiscuz = /discuz_uid\s*=|<form[^>]+id="qiandao"|id="messagetext"|class="pg_dsu_paulsign"/.test(body);
  if (looksLikeDiscuz) return false;
  if (status === 403 && /cloudflare/i.test(body)) return true;
  if (/cf-error-details/i.test(body) && status && status >= 400) return true;
  return CHALLENGE_MARKERS.some((m) => body.includes(m));
}

async function resolveProxyDispatcher(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    const undici = require('undici');
    if (undici && typeof undici.ProxyAgent === 'function') {
      return new undici.ProxyAgent(proxyUrl);
    }
  } catch (_) {
    /* 没有 undici 时回退到环境变量代理 */
  }
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy) process.env.HTTPS_PROXY = proxyUrl;
  if (!process.env.HTTP_PROXY && !process.env.http_proxy) process.env.HTTP_PROXY = proxyUrl;
  return undefined;
}

function makeHeaders(jar, opts) {
  const headers = {
    'User-Agent': opts.ua,
    'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7,ja;q=0.6',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
  };
  if (opts.referer) headers.Referer = opts.referer;
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.ajax) headers['X-Requested-With'] = 'XMLHttpRequest';
  if (jar) headers.Cookie = jar.toString();
  return headers;
}

async function rawRequest(profile, jar, url, opts = {}) {
  const target = buildUrl(profile, url, opts.channel);
  const headers = makeHeaders(jar, {
    ua: opts.ua || profile.ua,
    referer: opts.referer,
    origin: opts.origin,
    ajax: opts.ajax,
  });
  const init = {
    method: opts.method || 'GET',
    headers,
    redirect: 'manual',
  };
  if (opts.body != null) {
    if (opts.json) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(opts.body);
    } else {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = opts.body;
    }
  }
  const dispatcher = await resolveProxyDispatcher(profile.proxy);
  if (dispatcher) init.dispatcher = dispatcher;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || profile.timeoutMs);
  let res;
  try {
    res = await fetch(target, { ...init, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new TsdmHttpError('timeout', `请求超时（${opts.timeoutMs || profile.timeoutMs}ms）：${target}`, { url: target });
    }
    throw new TsdmHttpError('network', `网络请求失败：${err && err.message}`, { url: target, code: err && err.code });
  }
  clearTimeout(timer);

  const setCookies = jar ? jar.absorbSetCookies(res.headers) : [];
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, url: target, setCookies };
}

async function request(profile, jar, url, opts = {}) {
  const attempts = Math.max(1, (opts.retry == null ? profile.retry : opts.retry) + 1);
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await rawRequest(profile, jar, url, opts);
      if (res.status >= 500 || res.status === 429) {
        throw new TsdmHttpError('http', `服务端返回 ${res.status}`, { status: res.status, url: res.url });
      }
      if (detectChallenge(res.text, res.status)) {
        throw new TsdmHttpError('challenge', '触发 Cloudflare 人机验证', {
          status: res.status,
          url: res.url,
          snippet: snippetOf(res.text),
        });
      }
      if (res.status >= 400) {
        throw new TsdmHttpError('http', `请求失败 ${res.status}`, {
          status: res.status,
          url: res.url,
          snippet: snippetOf(res.text),
        });
      }
      return res;
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof TsdmHttpError && ['http', 'network', 'timeout'].includes(err.kind);
      if (!retryable || attempt === attempts) break;
      await sleep(attempt === 1 ? 1000 : 3000);
    }
  }
  throw lastErr;
}

function buildUrl(profile, url, channel) {
  const absolute = /^https?:\/\//i.test(url)
    ? url
    : `${profile.base.replace(/\/+$/, '')}/${String(url).replace(/^\/+/, '')}`;
  if (channel === 'mobile-tpl') {
    const sep = absolute.includes('?') ? '&' : '?';
    return `${absolute}${sep}mobile=2`;
  }
  return absolute;
}

// ── 页面解析（纯函数，便于离线单测）──────────────────────────────────
//
// 注意 bug 陷阱：广告位说明里先出现的是颜色值 #FF0000，
// 直接抓数字会误取 "0000"，所以要求数字被 <b> 包住（页面结构确实如此）。

const REGEX = {
  formhash: [
    /name="formhash"\s+value="([0-9a-zA-Z]+)"/,
    /value="([0-9a-zA-Z]+)"\s+name="formhash"/,
    /data-tsdm-formhash="([0-9a-zA-Z]+)"/,
    /formhash=([0-9a-zA-Z]+)/,
  ],
  uid: [
    /discuz_uid\s*=\s*'(\d+)'/,
    /discuz_uid\s*=\s*(\d+)/,
    /space&(?:amp;)?uid=(\d+)/,
  ],
  adId: /id="np_advid(\d+)"/g,
  count: /^(\d+)$/,
  adNeed: [
    /共需要点击\D*?<b>\s*(\d+)\s*<\/b>/,
    /共需要点击(?:[^<]*<(?:(?!<\/font>)[^>])*>)*?[^\d<]{0,8}(\d+)\s*(?:<\/b>|个)/,
  ],
  sigSuccess: /恭喜你签到成功[^0-9]{0,20}(\d+)/,
  workSuccess: /已经成功领取了奖励天使币\s*\+\s*(\d+)/,
  // 冷却/剩余时长：必须容忍省略形态（只有秒、只有分钟、只有小时）与不同措辞。
  // 抓包的「每间隔6小时0分钟0秒可进行一次」属于领奖成功页；
  // 「…后再来 / 才能再次领取」那种是冷却提示页，两种都要认。
  cooldown: [
    /每间隔\s*(?<h>\d+)\s*小时\s*(?<m>\d+)\s*分钟\s*(?<s>\d+)\s*秒/,
    /(?<h>\d+)\s*小时\s*(?<m>\d+)\s*分钟\s*(?<s>\d+)\s*秒[^。！!]{0,8}(?:再来|后)/,
    /(?<m>\d+)\s*分钟\s*(?<s>\d+)\s*秒[^。！!]{0,8}(?:再来|后)/,
    /(?<h>\d+)\s*小时\s*(?<m>\d+)\s*分钟[^。！!\d]{0,8}(?:再来|后)/,
    /(?<h>\d+)\s*小时[^。！!\d]{0,8}(?:再来|后)/,
    /(?<m>\d+)\s*分钟[^。！!\d]{0,8}(?:再来|后)/,
    /(?<s>\d+)\s*秒[^。！!\d]{0,8}(?:再来|后)/,
  ],
  rewardText: /msg = '([^']*)'/,
};

function isAjaxXml(text) {
  const t = String(text || '').trim();
  return t.startsWith('<?xml') || /^<root>/.test(t);
}

function unwrapXml(text) {
  const t = String(text || '');
  if (!isAjaxXml(t)) return t;
  const m = /<!\[CDATA\[([\s\S]*?)\]\]>/.exec(t);
  return m ? m[1] : t;
}

function parseSignResult(text) {
  const body = unwrapXml(text);
  const success = REGEX.sigSuccess.exec(body);
  if (success) {
    return { ok: true, kind: 'signed', reward: Number(success[1]), message: '签到成功', raw: snippetOf(body) };
  }
  const plain = stripTags(body);
  if (/今天已签到|已经签到/.test(plain)) {
    return { ok: true, kind: 'already', message: '今天已签到', raw: plain.slice(0, 120) };
  }
  if (/签到时间|还没到签到时间|不在签到时间/.test(plain)) {
    return { ok: false, kind: 'window', message: plain.slice(0, 120), raw: plain.slice(0, 200) };
  }
  if (/drlhash|未登录|请先登录|游客/.test(plain)) {
    return { ok: false, kind: 'auth', message: plain.slice(0, 120), raw: plain.slice(0, 200) };
  }
  const reward = REGEX.rewardText.exec(body);
  return {
    ok: false,
    kind: 'unknown',
    message: reward ? reward[1] : (plain.slice(0, 120) || '无法识别的响应'),
    raw: snippetOf(body),
  };
}

/** 把「还有 X 小时 Y 分钟 Z 秒」这类提示解析成总秒数；认不出返回 null */
function matchCooldown(text) {
  for (const re of REGEX.cooldown) {
    const m = re.exec(text);
    if (!m || !m.groups) continue;
    const hours = Number(m.groups.h || 0);
    const minutes = Number(m.groups.m || 0);
    const seconds = Number(m.groups.s || 0);
    const totalSeconds = hours * 3600 + minutes * 60 + seconds;
    if (totalSeconds > 0) return { hours, minutes, seconds, totalSeconds };
  }
  return null;
}

function parseWorkResult(text) {
  const body = unwrapXml(text);
  const success = REGEX.workSuccess.exec(body);
  if (success) {
    const cd = matchCooldown(stripTags(body));
    return {
      ok: true,
      kind: 'claimed',
      reward: Number(success[1]),
      cooldownHours: cd ? cd.hours : null,
      cooldownSeconds: cd ? cd.totalSeconds : null,
      message: '打工成功',
      raw: messageTextOf(body),
    };
  }
  const plain = stripTags(body);
  if (/不要作弊/.test(plain)) {
    return { ok: false, kind: 'cheat', message: '服务端返回“不要作弊”（广告点击未记录完整）', raw: messageTextOf(body, 200) };
  }
  // 冷却提示页：措辞多变（打过工了 / 已经领取 / 完成任务 / 请 X 后再来）。
  // 能解析出「距离下次还有多久」这个时长，本身就是冷却的强证据，所以
  // matchCooldown 有结果即按冷却处理，关键词只用来兜住解析不出的情况。
  const cd = matchCooldown(plain);
  if (cd || /每间隔|可进行一次|已经领取|今日已领取|已领取|完成|打过工|间隔/.test(plain)) {
    return {
      ok: true,
      kind: 'cooldown',
      reward: null,
      cooldownHours: cd ? cd.hours : null,
      cooldownSeconds: cd ? cd.totalSeconds : null,
      message: cd ? `距下次打工还有 ${cd.hours} 小时 ${cd.minutes} 分 ${cd.seconds} 秒` : '本次不可领取（冷却中）',
      raw: messageTextOf(body, 200),
    };
  }
  if (/未登录|请先登录|游客/.test(plain)) {
    return { ok: false, kind: 'auth', message: plain.slice(0, 120), raw: messageTextOf(body, 200) };
  }
  return { ok: false, kind: 'unknown', message: messageTextOf(body, 200) || '无法识别的响应', raw: messageTextOf(body, 200) };
}

function extractFormhash(html) {
  return firstMatch(String(html || ''), REGEX.formhash);
}

function extractUid(html) {
  const m = firstMatch(String(html || ''), REGEX.uid);
  return m == null ? null : Number(m);
}

function extractAdIds(html) {
  const ids = [];
  const re = new RegExp(REGEX.adId.source, 'g');
  let m;
  while ((m = re.exec(String(html || '')))) ids.push(Number(m[1]));
  return ids;
}

function parseAdNeed(html) {
  const raw = firstMatch(String(html || ''), REGEX.adNeed);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function signState(html) {
  const text = String(html || '');
  if (/今天已签到/.test(text)) return 'signed';
  if (/今天未签到/.test(text)) return 'unsigned';
  return 'unknown';
}

function isLoggedOut(html) {
  const text = String(html || '');
  if (extractUid(text) === 0) return true;
  if (/name="loginfield"|id="loginform"|mod=logging&amp;action=login|mod=logging&action=login/.test(text)) return true;
  if (/您需要登录后才可以|请先登录后/.test(text)) return true;
  return false;
}

function isCheatNotice(text) {
  return /不要作弊/.test(String(text || ''));
}

function clickCount(text) {
  const m = REGEX.count.exec(String(text || '').trim());
  return m ? Number(m[1]) : null;
}

// ── 请求构造 ──────────────────────────────────────────────────────────

const SIGN_URL = 'plugin.php?id=dsu_paulsign:sign';
const SIGN_POST_URL = 'plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1&inajax=1';
const WORK_URL = 'plugin.php?id=np_cliworkdz:work';

function buildSignBody(formhash, profile) {
  const params = new URLSearchParams();
  params.set('formhash', formhash);
  params.set('qdxq', profile.qdxq === 'random' ? pick(QDXQ_VALUES) : profile.qdxq);
  if (profile.todaysay) {
    params.set('qdmode', '1');
    params.set('todaysay', profile.todaysay);
    params.set('fastreply', '');
  } else {
    params.set('qdmode', '3');
    params.set('todaysay', '');
    params.set('fastreply', String(profile.fastreply && FASTREPLY_VALUES.includes(profile.fastreply)
      ? profile.fastreply
      : pick(FASTREPLY_VALUES)));
  }
  return params.toString();
}

// ── 通道探测 ──────────────────────────────────────────────────────────

function channelUa(profile, channel) {
  return channel === 'desktop' ? profile.desktopUa : profile.mobileUa;
}

/**
 * 按通道依次 GET 签到页，第一个「已登录 + 非盾页 + 有 formhash」的通道被选中。
 * 返回 { channel, ua, html, formhash, uid, state, tried }
 */
async function pickChannel(profile, account, logger) {
  const order = profile.channel ? [profile.channel] : CHANNELS;
  const tried = [];
  for (const channel of order) {
    const ua = channelUa(profile, channel);
    try {
      const res = await request(profile, account.jar, SIGN_URL, {
        ua,
        channel,
        referer: `${profile.base}/`,
      });
      const html = res.text;
      if (detectChallenge(html, res.status)) {
        tried.push(`${channel}:盾页`);
        logger.warn(`通道 ${channel} 被 Cloudflare 拦截，换下一个通道`);
        continue;
      }
      if (isLoggedOut(html)) {
        tried.push(`${channel}:未登录`);
        throw new TsdmHttpError('config', 'Cookie 无效或已过期（页面显示未登录）', {
          url: res.url,
          snippet: snippetOf(html),
        });
      }
      const formhash = extractFormhash(html);
      if (!formhash) {
        tried.push(`${channel}:无 formhash`);
        throw new TsdmHttpError('config', '页面结构变化：未能从签到页提取 formhash', {
          url: res.url,
          snippet: snippetOf(html),
        });
      }
      tried.push(`${channel}:ok`);
      logger.info(`通道 ${channel} 可用（UA 用${channel === 'desktop' ? '桌面' : '手机'}端）`);
      return {
        channel,
        ua,
        html,
        formhash,
        uid: extractUid(html),
        state: signState(html),
        tried,
      };
    } catch (err) {
      if (err instanceof TsdmHttpError && err.kind === 'challenge') {
        tried.push(`${channel}:盾页`);
        logger.warn(`通道 ${channel} 被 Cloudflare 拦截，换下一个通道`);
        continue;
      }
      throw err;
    }
  }
  throw new TsdmHttpError(
    'challenge',
    `所有通道都被 Cloudflare 拦截（尝试：${tried.join(' / ')}）。` +
    '处置建议：①把浏览器 Cookie 里的 cf_clearance 一起填进 TSDM_COOKIE 并设 TSDM_REQUIRE_CF=1；' +
    '②把 TSDM_UA 改成取 Cookie 时那个浏览器的 UA；③设 TSDM_PROXY 让出口 IP 与浏览器一致。',
  );
}

// ── 账号执行上下文 ────────────────────────────────────────────────────

class AccountContext {
  constructor(profile, account, logger) {
    this.profile = profile;
    this.account = account;
    this.logger = logger;
    this.channel = null;
    this.ua = null;
    this.uid = null;
  }

  async get(url, opts = {}) {
    return request(this.profile, this.account.jar, url, {
      ua: this.ua || this.profile.ua,
      channel: this.channel,
      referer: `${this.profile.base}/`,
      ...opts,
    });
  }

  async post(url, body, opts = {}) {
    return request(this.profile, this.account.jar, url, {
      method: 'POST',
      body,
      ua: this.ua || this.profile.ua,
      channel: this.channel,
      referer: opts.referer || `${this.profile.base}/${SIGN_URL}`,
      origin: this.profile.base,
      ...opts,
    });
  }
}

// ── 通知 ──────────────────────────────────────────────────────────────

function resolveQlNotifyPath(notify) {
  if (notify.qlNotifyPath) return notify.qlNotifyPath;
  const candidates = [
    path.join(notify.qlDir || '/ql', 'data', 'scripts', 'notify.py'),
    path.join(notify.qlDir || '/ql', 'scripts', 'notify.py'),
    '/ql/data/scripts/notify.py',
    '/ql/scripts/notify.py',
  ];
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch (_) { /* 忽略不可读路径 */ }
  }
  return null;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 20000, ...options }, (err, stdout, stderr) => {
        resolve({ ok: !err, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    } catch (err) {
      resolve({ ok: false, err, stdout: '', stderr: String(err && err.message) });
    }
  });
}

async function sendBaihu(notify, payload) {
  const url = notify.baihuUrl || 'http://localhost:8052/api/v1/notify/send';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'notify-token': notify.baihuToken,
    },
    body: JSON.stringify({
      channel_id: notify.channelId || undefined,
      title: payload.title,
      content: payload.content,
      format: 'markdown',
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);
  return `白虎通知接口 ${res.status}`;
}

async function sendQl(notify, payload) {
  const script = resolveQlNotifyPath(notify);
  if (!script) throw new Error('未找到青龙 notify.py');
  const r = await execFileAsync(notify.pythonBin, [script, payload.title, payload.content]);
  if (!r.ok) throw new Error(`notify.py 执行失败：${(r.stderr || (r.err && r.err.message) || '').slice(0, 200)}`);

  // notify.py 对单个渠道失败只 print 不抛异常，进程退出码仍是 0，
  // 所以要看输出才能知道到底有没有送出去，否则会误报"已发送"。
  const out = r.stdout || '';
  const failed = out.split('\n').filter((l) => /推送失败|发送失败|错误码/.test(l));
  if (failed.length) {
    throw new Error(`notify.py 内部渠道失败：${failed.join(' / ').slice(0, 200)}`);
  }
  const tail = out.trim().split('\n').slice(-3).join(' / ');
  return `青龙 notify.py${tail ? `（${tail.slice(0, 160)}）` : ''}`;
}

async function sendWebhook(notify, payload) {
  const res = await fetch(notify.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: payload.title, content: payload.content }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return `自定义 Webhook ${res.status}`;
}

/**
 * Server酱（方糖）原生推送，不经过青龙的 notify.py，也就没有 Python requests 依赖。
 *
 * 两种 key 对应不同端点，规则来自官方文档：
 *   Server酱³  sctp{uid}t...  → https://{uid}.push.ft07.com/send/{key}.send
 *   Turbo      SCT...         → https://sctapi.ftqq.com/{key}.send
 */
async function sendServerChan(key, payload, endpoints) {
  const ep = endpoints || {};
  const baseTurbo = ep.turbo || 'https://sctapi.ftqq.com';
  const m = /^sctp(\d+)t/.exec(key);
  const url = m
    ? `${ep.v3 || `https://${m[1]}.push.ft07.com`}/send/${key}.send`
    : `${baseTurbo}/${key}.send`;
  const params = new URLSearchParams({ title: payload.title, desp: payload.content });
  const res = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch (_) {
    throw new Error(`返回非 JSON（HTTP ${res.status}）：${body.slice(0, 120)}`);
  }
  const code = data.code == null ? data.errno : data.code;
  // 官方成功返回 code:0；有的接口用 errno
  if (code !== 0) {
    throw new Error(`Server酱返回 code=${code} ${data.message || ''}`.trim());
  }
  return `Server酱(${m ? `Server酱³ uid=${m[1]}` : 'Turbo'})`;
}

/**
 * 按 白虎 → Server酱 → 青龙 → Webhook 顺序尝试原生通知接口，任一成功即返回。
 * 通知失败只记录，不影响任务退出码。
 * 返回 { sent, via?, skipped?, error? }
 */
async function notify(profile, payload, logger) {
  const n = profile.notify;
  if (!n.enabled) return { sent: false, skipped: 'TSDM_NOTIFY 关闭' };
  if (payload.success && !n.onSuccess) return { sent: false, skipped: 'TSDM_NOTIFY_ON_SUCCESS 关闭' };
  if (!payload.success && !n.onFailure) return { sent: false, skipped: 'TSDM_NOTIFY_ON_FAILURE 关闭' };
  if (profile.dryRun) return { sent: false, skipped: 'DRY_RUN' };

  const attempts = [
    ['白虎', n.baihuToken, () => sendBaihu(n, payload)],
    ['Server酱', n.serverchanKey, () => sendServerChan(
      n.serverchanKey,
      payload,
      n.serverchanUrl ? { v3: n.serverchanUrl, turbo: n.serverchanUrl } : undefined,
    )],
    ['青龙', resolveQlNotifyPath(n), () => sendQl(n, payload)],
    ['Webhook', n.webhookUrl, () => sendWebhook(n, payload)],
  ];

  const errors = [];
  for (const [name, configured, send] of attempts) {
    if (!configured) continue;
    try {
      const via = await send();
      logger.info(`[通知] 已发送（${via}）`);
      return { sent: true, via };
    } catch (err) {
      errors.push(`${name}：${err.message}`);
      logger.warn(`[通知] ${name} 发送失败，尝试下一个渠道`);
    }
  }

  if (!errors.length) {
    logger.info('[通知] 跳过（未配置任何通知渠道：需 BHPKG_NOTIFY_TOKEN / PUSH_KEY / 青龙 notify.py / TSDM_WEBHOOK_URL）');
    return { sent: false, skipped: '未配置任何通知渠道' };
  }
  const error = errors.join('；');
  logger.warn(`[通知] 全部渠道失败：${error}`);
  return { sent: false, error };
}

// ── 任务骨架 ──────────────────────────────────────────────────────────

async function runTask(options) {
  const { taskName, env = process.env, execute } = options;

  const profile = loadConfig(env);
  const logger = new Logger(taskName, profile.debug);

  logger.info(`任务开始：${taskName}（${profile.dryRun ? 'DRY_RUN 模式，不会发请求' : '正常执行'}）`);

  if (profile.warnings) for (const w of profile.warnings) logger.warn(w);
  if (profile.errors.length) {
    for (const e of profile.errors) logger.error(e);
    logger.error('配置有误，终止执行');
    process.exitCode = 1;
    return { results: [], summary: { total: 0, ok: 0, fail: 0 }, profile };
  }
  if (profile.accounts.length > 1) logger.info(`共 ${profile.accounts.length} 个账号，串行执行`);

  const results = [];
  for (const account of profile.accounts) {
    const alog = logger.child(`账号${account.index}`);
    const ctx = new AccountContext(profile, account, alog);
    try {
      const r = await execute(ctx, profile, alog);
      results.push({ index: account.index, ...r });
      if (r.success) alog.ok(`${r.status}${r.detail ? ` · ${r.detail}` : ''}`);
      else alog.error(`${r.status}${r.detail ? ` · ${r.detail}` : ''}`);
    } catch (err) {
      const message = err instanceof TsdmHttpError
        ? `${err.message}${err.snippet ? `（页面片段：${err.snippet}）` : ''}`
        : (err && err.message) || String(err);
      results.push({ index: account.index, success: false, status: '异常', detail: message });
      alog.error(message);
      if (err instanceof TsdmHttpError && err.kind === 'challenge') {
        alog.warn('提示：这是 Cloudflare 拦截，不是账号问题');
      }
    }
    if (account.index < profile.accounts.length) await sleep(profile.delayBetweenMs);
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.success).length,
    fail: results.filter((r) => !r.success).length,
  };

  const title = `${profile.notify.title || taskName} · ${summary.fail === 0 ? '成功' : '失败'} · ${nowStamp()}`;
  const lines = [`- 共 ${summary.total} 个账号：成功 ${summary.ok}，失败 ${summary.fail}`];
  const channels = [...new Set(results.map((r) => r.channel).filter(Boolean))];
  if (channels.length) lines.push(`- 使用通道：${channels.join('、')}`);
  for (const r of results) {
    lines.push(`- 账号 ${r.index}：${r.success ? '✅' : '❌'} ${r.status}${r.detail ? ` · ${r.detail}` : ''}`);
  }
  console.log(`${LOG_PREFIX} 汇总：成功 ${summary.ok} / 失败 ${summary.fail} / 共 ${summary.total}`);
  for (const line of lines) console.log(`${LOG_PREFIX} ${line}`);

  await notify(profile, { title, content: lines.join('\n'), success: summary.fail === 0 }, logger);

  if (summary.fail > 0) process.exitCode = 1;
  logger.info(`任务结束（退出码 ${process.exitCode || 0}）`);
  return { results, summary, profile };
}

// ── 只读网络诊断（不需要 Cookie）──────────────────────────────────────

async function probeNetwork(profile, logger) {
  const order = profile.channel ? [profile.channel] : CHANNELS;
  const rows = [];
  for (const channel of order) {
    const ua = channelUa(profile, channel);
    const row = { channel };
    try {
      const res = await request(profile, new CookieJar(''), SIGN_URL, {
        ua,
        channel,
        referer: `${profile.base}/`,
        retry: 0,
      });
      row.status = res.status;
      row.bytes = res.text.length;
      row.server = res.headers.get('server');
      row.cfRay = res.headers.get('cf-ray');
      row.challenge = detectChallenge(res.text, res.status);
      row.uid = extractUid(res.text);
      row.loggedOut = isLoggedOut(res.text);
      row.formhash = extractFormhash(res.text);
      row.verdict = row.challenge
        ? 'Cloudflare 人机验证'
        : (row.loggedOut ? '正常页面（未登录）' : '正常页面（已登录）');
    } catch (err) {
      row.error = err instanceof TsdmHttpError ? `${err.kind}: ${err.message}` : String(err && err.message);
      row.verdict = err instanceof TsdmHttpError && err.kind === 'challenge' ? 'Cloudflare 人机验证' : '请求失败';
    }
    rows.push(row);
    logger.info(
      `通道 ${channel}：${row.verdict}` +
      (row.status
        ? `（HTTP ${row.status}，${row.bytes} 字节，server=${row.server || '-'}，cf-ray=${row.cfRay || '-'}` +
          `，discuz_uid=${row.uid == null ? '?' : row.uid}，formhash=${row.formhash || '无'}）`
        : '') +
      (row.error ? `｜${row.error}` : ''),
    );
  }

  logger.info('');
  if (rows.some((r) => r.challenge)) {
    logger.warn('结论：至少一个通道被 Cloudflare 人机验证拦截。');
    logger.info('处理：① 填 cf_clearance 并设 TSDM_REQUIRE_CF=1；② TSDM_UA 对齐取 Cookie 时的浏览器；③ 设 TSDM_PROXY 让出口 IP 与浏览器一致。');
  } else {
    logger.ok('结论：站点可达且没有人机验证。剩下的问题只可能是 Cookie 失效（未登录）或页面结构变化。');
    if (rows.some((r) => r.loggedOut)) {
      logger.info('补充：返回的是「未登录游客页」（discuz_uid=0）。说明当前 Cookie 已失效，重新复制整行 Cookie 即可，不需要绕过 Cloudflare。');
    }
  }
  return rows;
}

// ── 两个任务的具体流程 ────────────────────────────────────────────────

function dryRunPlan(profile, kind) {
  const channels = profile.channel ? [profile.channel] : CHANNELS;
  const lines = [
    `通道探测顺序：${channels.join(' → ')}（TSDM_CHANNEL 可固定其中一个）`,
    `探测请求：GET ${SIGN_URL}（先用桌面 UA，再用手机 UA，最后加 mobile=2）`,
  ];
  if (kind === 'checkin') {
    const qdxq = profile.qdxq === 'random' ? '<随机心情>' : profile.qdxq;
    const body = profile.todaysay
      ? `formhash=<页面提取>&qdxq=${qdxq}&qdmode=1&todaysay=${profile.todaysay}&fastreply=`
      : `formhash=<页面提取>&qdxq=${qdxq}&qdmode=3&todaysay=&fastreply=<1-8 随机>`;
    lines.push('判定已签到：页面含「今天已签到」则直接成功退出');
    lines.push(`签到请求：POST ${SIGN_POST_URL}`);
    lines.push(`请求体：${body}`);
    lines.push('结果判定：成功文案「恭喜你签到成功!获得随机奖励 天使币 N」');
  } else {
    lines.push(`打工页：GET ${WORK_URL}`);
    lines.push('广告位：从页面正则提取 id="np_advidN"（抓包实测 1,2,4,6,7,9，共 6 个）');
    lines.push(`① POST ${WORK_URL}  体 act=getcre（探测，未点满会返回「不要作弊」）`);
    lines.push(`② 重新 GET ${WORK_URL} 取本轮广告位`);
    lines.push(`③ 逐个 POST ${WORK_URL}  体 act=clickad&advid=<id>，间隔 ${profile.clickMinMs}-${profile.clickMaxMs}ms`);
    lines.push(`④ POST ${WORK_URL}  体 act=getcre 领奖，判定「已经成功领取了奖励天使币 +N」`);
    lines.push(`容错：命中「不要作弊」或点击计数异常时整轮重开，最多 ${profile.workRounds} 轮`);
  }
  lines.push(`通知：${profile.notify.enabled ? '开启' : '关闭'}（成功推送=${profile.notify.onSuccess ? '是' : '否'}，失败推送=${profile.notify.onFailure ? '是' : '否'}）`);
  return lines;
}

async function runCheckin(ctx, profile, logger) {
  if (profile.dryRun) {
    return {
      success: true,
      status: 'DRY_RUN',
      channel: profile.channel || 'auto',
      detail: dryRunPlan(profile, 'checkin').join(' | '),
    };
  }

  const picked = await pickChannel(profile, ctx.account, logger);
  ctx.channel = picked.channel;
  ctx.ua = picked.ua;
  ctx.uid = picked.uid;

  if (picked.state === 'signed') {
    return { success: true, status: '今天已签到', channel: picked.channel, detail: `uid=${picked.uid}` };
  }

  const res = await ctx.post(SIGN_POST_URL, buildSignBody(picked.formhash, profile), {
    ajax: true,
    referer: `${profile.base}/${SIGN_URL}`,
  });
  const result = parseSignResult(res.text);
  if (!result.ok) {
    return {
      success: false,
      status: result.kind === 'auth' ? 'Cookie 失效' : '签到失败',
      channel: picked.channel,
      detail: `${result.message}${result.raw ? `（${result.raw}）` : ''}`,
    };
  }
  return {
    success: true,
    status: result.kind === 'already' ? '今天已签到' : '签到成功',
    channel: picked.channel,
    detail: result.reward != null ? `随机奖励 天使币 ${result.reward}` : `uid=${picked.uid}`,
  };
}

async function runWork(ctx, profile, logger) {
  if (profile.dryRun) {
    return {
      success: true,
      status: 'DRY_RUN',
      channel: profile.channel || 'auto',
      detail: dryRunPlan(profile, 'work').join(' | '),
    };
  }

  // 打工同样先探测通道（需要登录态），但不需要 formhash
  const picked = await pickChannel(profile, ctx.account, logger);
  ctx.channel = picked.channel;
  ctx.ua = picked.ua;

  const rounds = Math.max(1, profile.workRounds);
  let lastFail = null;

  for (let round = 1; round <= rounds; round += 1) {
    const page = await ctx.get(WORK_URL, { referer: `${profile.base}/${SIGN_URL}` });
    let ads = extractAdIds(page.text);

    if (!ads.length) {
      const pre = parseWorkResult(page.text);
      if (pre.ok) {
        return {
          success: true,
          status: pre.kind === 'cooldown' ? '冷却中' : '已领取',
          channel: ctx.channel,
          detail: pre.message,
        };
      }
      lastFail = { status: '广告位解析为空', detail: messageTextOf(page.text) };
      if (round < rounds) { await sleep(1500 * round); continue; }
      break;
    }
    const need = parseAdNeed(page.text) || ads.length;
    if (ads.length < need) {
      lastFail = { status: '广告位不足', detail: `页面只有 ${ads.length} 个广告位，需要 ${need} 个` };
      if (round < rounds) { await sleep(1500 * round); continue; }
      break;
    }

    // 对齐抓包：先探测一次领奖（未点满会返回「不要作弊」）
    await ctx.post(WORK_URL, 'act=getcre', { ajax: false, referer: `${profile.base}/${WORK_URL}` });

    // 重新取页面，保证用的是服务端本轮渲染的广告位
    const fresh = await ctx.get(WORK_URL, { referer: `${profile.base}/${WORK_URL}` });
    const freshAds = extractAdIds(fresh.text);
    if (freshAds.length) ads = freshAds;

    let clicked = 0;
    let broken = null;
    for (const id of ads) {
      const res = await ctx.post(WORK_URL, `act=clickad&advid=${id}`, {
        ajax: true,
        referer: `${profile.base}/${WORK_URL}`,
      });
      const text = res.text.trim();
      if (isCheatNotice(text)) {
        broken = { status: '防作弊', detail: '点击广告时服务端返回“不要作弊”' };
        break;
      }
      const count = clickCount(text);
      if (count == null) {
        broken = { status: '点击无计数', detail: messageTextOf(text, 160) };
        break;
      }
      clicked = count;
      logger.dbg(`广告 ${id} 点击成功（计数 ${count}）`);
      if (id !== ads[ads.length - 1]) await sleep(randInt(profile.clickMinMs, profile.clickMaxMs));
    }

    if (broken) {
      lastFail = broken;
      if (round < rounds) {
        logger.warn(`第 ${round} 轮 ${broken.status}，重开一轮`);
        await sleep(2000 * round);
        continue;
      }
      break;
    }
    if (clicked < ads.length) {
      lastFail = { status: '点击未完成', detail: `只记录到 ${clicked}/${ads.length} 次点击` };
      if (round < rounds) { await sleep(2000 * round); continue; }
      break;
    }

    const claim = await ctx.post(WORK_URL, 'act=getcre', { ajax: false, referer: `${profile.base}/${WORK_URL}` });
    const result = parseWorkResult(claim.text);
    if (result.ok) {
      return {
        success: true,
        status: result.kind === 'cooldown' ? '冷却中' : '打工成功',
        channel: ctx.channel,
        detail: result.reward != null
          ? `奖励 天使币 +${result.reward}${result.cooldownHours ? `，${result.cooldownHours} 小时后再来` : ''}`
          : result.message,
      };
    }
    lastFail = { status: result.kind === 'cheat' ? '防作弊' : '领奖失败', detail: result.message };
    if (round < rounds) {
      logger.warn(`第 ${round} 轮领奖失败（${result.message}），重开一轮`);
      await sleep(2000 * round);
    }
  }

  return {
    success: false,
    status: (lastFail && lastFail.status) || '打工失败',
    channel: ctx.channel,
    detail: (lastFail && lastFail.detail) || '未知原因',
  };
}

module.exports = {
  // 常量
  SIGN_URL,
  SIGN_POST_URL,
  WORK_URL,
  CHANNELS,
  QDXQ_VALUES,
  DEFAULT_MOBILE_UA,
  DEFAULT_DESKTOP_UA,
  // 基础设施
  Logger,
  CookieJar,
  TsdmHttpError,
  request,
  loadConfig,
  buildUrl,
  buildSignBody,
  // 解析
  stripTags,
  messageTextOf,
  extractFormhash,
  extractUid,
  extractAdIds,
  parseAdNeed,
  signState,
  isLoggedOut,
  clickCount,
  parseSignResult,
  parseWorkResult,
  detectChallenge,
  // 流程
  pickChannel,
  AccountContext,
  runCheckin,
  runWork,
  runTask,
  dryRunPlan,
  probeNetwork,
  notify,
  sendServerChan,
};
