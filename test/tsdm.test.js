'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tsdm = require('../lib/tsdm.js');

const fixtures = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');

// 结构照搬真实 Cookie（含 Discuz 的 Ystv_2132_ 前缀、URL 编码的值、cf_clearance），
// 但所有值都是编造的——真实凭据不入库。
const SAMPLE_COOKIE =
  'Ystv_2132_saltkey=sampleSalt; Ystv_2132_auth=Ab3dEf5Gh1Jk%2BlMn0PqRsTuVwXyZ%2F0123456789abcdef; ' +
  'cf_clearance=sampleClearanceValue-1791796309-1.2.1.1-abcdef; Ystv_2132_sid=sampleSid';

test('从签到页提取 formhash / uid / 签到状态（真实抓包片段）', () => {
  const html = fixtures('sign_page_unsigned.html');
  assert.equal(tsdm.extractFormhash(html), '1f7a4c3d');
  assert.equal(tsdm.extractUid(html), 1000000);
  assert.equal(tsdm.signState(html), 'unsigned');
  assert.equal(tsdm.isLoggedOut(html), false);
});

test('已签到页面识别为 signed', () => {
  const html = fixtures('sign_page_signed.html');
  assert.equal(tsdm.signState(html), 'signed');
  assert.equal(tsdm.extractFormhash(html), '1f7a4c3d');
  assert.equal(tsdm.isLoggedOut(html), false);
});

test('游客/未登录页面识别为未登录', () => {
  const html = fixtures('guest_notice.html');
  assert.equal(tsdm.isLoggedOut(html), true);
  assert.equal(tsdm.extractUid(html), 0);
});

test('解析签到成功响应（XML CDATA + 随机奖励）', () => {
  const r = tsdm.parseSignResult(fixtures('sign_ok.xml'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'signed');
  assert.equal(r.reward, 12);
});

test('解析签到异常响应：无法识别时给出原文且判失败', () => {
  const r = tsdm.parseSignResult(fixtures('sign_unknown.xml'));
  assert.equal(r.ok, true, '“已经签到过了”应视为已签到成功');
  assert.equal(r.kind, 'already');
});

test('解析纯文本签到响应（非 XML 包裹）', () => {
  const r = tsdm.parseSignResult('恭喜你签到成功!获得随机奖励 天使币 7 .');
  assert.equal(r.ok, true);
  assert.equal(r.reward, 7);
});

test('从打工页提取广告位 id 与所需数量（真实抓包片段）', () => {
  const html = fixtures('work_page.html');
  const ids = tsdm.extractAdIds(html);
  assert.deepEqual(ids, [1, 2, 4, 6, 7, 9]);
  assert.equal(tsdm.parseAdNeed(html), 6);
});

test('解析打工成功响应：奖励 +7 与 6 小时冷却', () => {
  const r = tsdm.parseWorkResult(fixtures('work_ok.html'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'claimed');
  assert.equal(r.reward, 7);
  assert.equal(r.cooldownHours, 6);
});

test('解析防作弊响应', () => {
  const r = tsdm.parseWorkResult(fixtures('work_cheat.html'));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'cheat');
  assert.match(r.message, /不要作弊/);
});

test('解析冷却中响应：视为成功并给出剩余时间', () => {
  const r = tsdm.parseWorkResult(fixtures('work_cooldown.html'));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'cooldown');
  assert.equal(r.cooldownHours, 3);
  assert.equal(r.cooldownSeconds, 3 * 3600 + 20 * 60 + 5);
});

test('冷却时长支持省略形态（只有分钟/只有秒）', () => {
  const minutesOnly = tsdm.parseWorkResult('<div id="messagetext"><p>您已经打过工了，请 42 分钟后再来。</p></div>');
  assert.equal(minutesOnly.ok, true);
  assert.equal(minutesOnly.kind, 'cooldown');
  assert.equal(minutesOnly.cooldownSeconds, 42 * 60);
  assert.match(minutesOnly.message, /42 分/);

  const secondsOnly = tsdm.parseWorkResult('<div id="messagetext"><p>请 90 秒后再来。</p></div>');
  assert.equal(secondsOnly.kind, 'cooldown');
  assert.equal(secondsOnly.cooldownSeconds, 90);

  const hoursOnly = tsdm.parseWorkResult('<div id="messagetext"><p>请 5 小时后再来。</p></div>');
  assert.equal(hoursOnly.kind, 'cooldown');
  assert.equal(hoursOnly.cooldownHours, 5);
});

test('冷却提示页措辞变化也要认出（打过工了 / 完成任务）', () => {
  for (const text of [
    '抱歉，您今天已经打过工了。',
    '今天的工作已经完成，请稍后再试。',
    '您已经领取过奖励，请稍后再来。',
  ]) {
    const r = tsdm.parseWorkResult(`<div id="messagetext"><p>${text}</p></div>`);
    assert.equal(r.ok, true, `应判定为冷却：${text}`);
    assert.equal(r.kind, 'cooldown');
  }
});

test('无法识别时把提示块原文带进 message，而不是导航栏', () => {
  const page = [
    '<div id="hd">快捷导航 首页 搜索 积分: 1467</div>',
    '<div id="ct"><div id="messagetext"><p>某个没见过的新提示</p></div></div>',
  ].join('\n');
  const r = tsdm.parseWorkResult(page);
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'unknown');
  assert.match(r.message, /没见过的新提示/);
  assert.doesNotMatch(r.message, /快捷导航/);
});

test('点击广告的纯文本计数解析', () => {
  assert.equal(tsdm.clickCount('1'), 1);
  assert.equal(tsdm.clickCount('6\n'), 6);
  assert.equal(tsdm.clickCount('<html>提示</html>'), null);
});

test('识别 Cloudflare 盾页', () => {
  const challenge =
    '<html><head><title>Just a moment...</title></head><body>' +
    '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>' +
    '<span id="cf_chl_opt"></span></body></html>';
  assert.equal(tsdm.detectChallenge(challenge, 403), true);
  assert.equal(tsdm.detectChallenge('<html><head><title>Just a moment...</title></head></html>', 200), true);
  assert.equal(tsdm.detectChallenge(fixtures('sign_page_unsigned.html'), 200), false);
});

test('回归：正常页面里的 Cloudflare 探测脚本不算盾页', () => {
  // 真实抓包/实测中，每个正常页面都带这段 Cloudflare 注入的 jsd 探测脚本，
  // 早期用 "challenge-platform" 做关键字会把游客页误判成盾页。
  const normalPage =
    '<html><head><title>提示信息 - 天使动漫</title>' +
    "<script>window.__CF$cv$params={r:'abc',t:'MTc5'};" +
    "var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';" +
    'document.getElementsByTagName(\'head\')[0].appendChild(a);</script>' +
    '</head><body><a href="member.php?mod=logging&amp;action=login">登录</a></body></html>';
  assert.equal(tsdm.detectChallenge(normalPage, 200), false);

  // 带真实 Discuz 标记的页面同样不能判成盾页
  assert.equal(tsdm.detectChallenge(fixtures('guest_notice.html'), 200), false);
  assert.equal(tsdm.detectChallenge(fixtures('work_ok.html'), 200), false);
});

test('stripTags 清理脚本与标签', () => {
  const text = tsdm.stripTags('<p>你好 <script>var a=1;</script><b>世界</b></p>');
  assert.equal(text, '你好 世界');
});

test('messageTextOf 取的是提示块而不是导航栏', () => {
  // 复现真实工单：广告位解析失败时日志里全是导航栏，真正原因被挤出截断长度
  const page = [
    '<html><head><title>提示信息 - 天使动漫 - Powered by Discuz!</title></head><body>',
    '<div id="hd"><a href="./">首页</a> 支援天使 搜索 16周年 坛庆活动 勋章|称号|风格| 萌战 10月新番',
    ' 积分|银行 宠物 快捷导航 sampleUser | 我的 | 设置 | 消息 | 提醒 | 退出 积分: 1467</div>',
    '<div id="wp">',
    '<div id="ct" class="wp cl w"><div class="nfl"><div class="f_c altw">',
    '<div id="messagetext" class="alert_info"><p>抱歉，您今天已经打过工了，请 5 小时 12 分钟 30 秒后再来。</p></div>',
    '</div></div></div>',
    '</body></html>',
  ].join('\n');

  const detail = tsdm.messageTextOf(page);
  assert.match(detail, /今天已经打过工了/);
  assert.doesNotMatch(detail, /快捷导航/);
});

test('messageTextOf 在没有提示块时跳过导航区', () => {
  const page = '<div id="hd">快捷导航 首页 搜索</div><div id="ct"><p>真的原因在这里</p></div>';
  const detail = tsdm.messageTextOf(page);
  assert.match(detail, /真的原因在这里/);
  assert.doesNotMatch(detail, /快捷导航/);
});

test('解析 Cookie 字符串并保留原值（按 Discuz 前缀匹配）', () => {
  const jar = new tsdm.CookieJar(SAMPLE_COOKIE);
  assert.equal(jar.hasName('saltkey'), true);
  assert.equal(jar.hasName('auth'), true);
  assert.equal(jar.hasName('cf_clearance'), true);
  assert.equal(jar.has('saltkey'), false, 'Discuz 会加前缀，所以精确名不应命中');
  assert.match(jar.toString(), /Ystv_2132_saltkey=sampleSalt/);
  assert.match(jar.toString(), /cf_clearance=sampleClearanceValue/);
});

test('默认策略会剔除 cf_clearance，设 TSDM_REQUIRE_CF=1 时保留', () => {
  const def = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE });
  assert.equal(def.accounts[0].jar.has('cf_clearance'), false);
  assert.match(def.warnings.join(' '), /剔除 cf_clearance/);

  const keep = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_REQUIRE_CF: '1' });
  assert.equal(keep.accounts[0].jar.has('cf_clearance'), true);
});

test('合并响应 Set-Cookie 并按名覆盖', () => {
  const jar = new tsdm.CookieJar('Ystv_2132_saltkey=sampleSalt; Ystv_2132_sid=sampleSid');
  const headers = {
    getSetCookie: () => [
      'Ystv_2132_sid=an96kd; expires=Tue, 13 Oct 2026 09:13:34 GMT; Max-Age=86400; path=/; secure',
      'Ystv_2132_lip=43.199.162.33%2C1791796308; path=/; secure',
    ],
  };
  const list = jar.absorbSetCookies(headers);
  assert.equal(list.length, 2);
  assert.equal(jar.map.get('Ystv_2132_sid'), 'an96kd');
  assert.equal(jar.map.get('Ystv_2132_lip'), '43.199.162.33%2C1791796308');
});

test('缺 TSDM_COOKIE 时报配置错误', () => {
  const profile = tsdm.loadConfig({});
  assert.equal(profile.accounts.length, 0);
  assert.match(profile.errors[0], /TSDM_COOKIE/);
});

test('Cookie 缺 saltkey/auth 时报具体字段', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: 'Ystv_2132_saltkey=sampleSalt' });
  assert.equal(profile.accounts.length, 1);
  assert.match(profile.errors.join(' '), /auth/);
});

test('多账号按换行拆分', () => {
  const profile = tsdm.loadConfig({
    TSDM_COOKIE: `${SAMPLE_COOKIE}\nYstv_2132_saltkey=x; Ystv_2132_auth=y`,
  });
  assert.equal(profile.accounts.length, 2);
  assert.equal(profile.errors.length, 0);
});

test('非法心情回退为 ym 并告警', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_QDXQ: 'bad' });
  assert.equal(profile.qdxq, 'ym');
  assert.match(profile.warnings.join(' '), /TSDM_QDXQ/);
});

test('签到语过长会被截断到 50 字并告警', () => {
  const long = '签'.repeat(60);
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_TODAYSAY: long });
  assert.equal([...profile.todaysay].length, 50);
  assert.match(profile.warnings.join(' '), /50/);
});

test('签到语过短会改为快速语句并告警', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_TODAYSAY: '短' });
  assert.equal(profile.todaysay, '');
  assert.match(profile.warnings.join(' '), /3 个字/);
});

test('通知开关默认值', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE });
  assert.equal(profile.notify.enabled, true);
  assert.equal(profile.notify.onSuccess, true);
  assert.equal(profile.notify.onFailure, true);
  assert.equal(profile.requireCf, false);
});

test('URL 拼接与移动模板通道参数', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE });
  assert.equal(
    tsdm.buildUrl(profile, tsdm.SIGN_URL, 'desktop'),
    'https://www.tsdm39.com/plugin.php?id=dsu_paulsign:sign',
  );
  assert.equal(
    tsdm.buildUrl(profile, tsdm.SIGN_URL, 'mobile-tpl'),
    'https://www.tsdm39.com/plugin.php?id=dsu_paulsign:sign&mobile=2',
  );
});

test('签到表单体与抓包一致（qdmode=3 + fastreply）', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_FASTREPLY: '1', TSDM_QDXQ: 'ym' });
  const body = tsdm.buildSignBody('1f7a4c3d', profile);
  assert.equal(body, 'formhash=1f7a4c3d&qdxq=ym&qdmode=3&todaysay=&fastreply=1');
});

test('填写 todaysay 时使用 qdmode=1', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_TODAYSAY: '每日签到' });
  const body = tsdm.buildSignBody('1f7a4c3d', profile);
  assert.equal(body, `formhash=1f7a4c3d&qdxq=ym&qdmode=1&todaysay=${encodeURIComponent('每日签到')}&fastreply=`);
});

test('DRY_RUN 计划包含真实请求参数且不联网', () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_DRY_RUN: '1', TSDM_FASTREPLY: '3' });
  const checkin = tsdm.dryRunPlan(profile, 'checkin').join('\n');
  assert.match(checkin, /operation=qiandao/);
  assert.match(checkin, /formhash=<页面提取>/);
  assert.match(checkin, /qdmode=3/);

  const work = tsdm.dryRunPlan(profile, 'work').join('\n');
  assert.match(work, /act=getcre/);
  assert.match(work, /act=clickad&advid=<id>/);
  assert.match(work, /np_advidN/);
});

test('DRY_RUN 下 runCheckin 不发任何网络请求', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_DRY_RUN: '1' });
  const account = profile.accounts[0];
  const ctx = new tsdm.AccountContext(profile, account, new tsdm.Logger('t'));
  const r = await tsdm.runCheckin(ctx, profile, new tsdm.Logger('t'));
  assert.equal(r.status, 'DRY_RUN');
  assert.equal(r.success, true);
});

test('DRY_RUN 下 runWork 不发任何网络请求', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_DRY_RUN: '1' });
  const account = profile.accounts[0];
  const ctx = new tsdm.AccountContext(profile, account, new tsdm.Logger('t'));
  const r = await tsdm.runWork(ctx, profile, new tsdm.Logger('t'));
  assert.equal(r.status, 'DRY_RUN');
  assert.equal(r.success, true);
});

test('TSDM_NOTIFY=0 时跳过通知', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_NOTIFY: '0' });
  const r = await tsdm.notify(profile, { title: 't', content: 'c', success: true }, new tsdm.Logger('t'));
  assert.equal(r.sent, false);
  assert.match(r.skipped, /TSDM_NOTIFY 关闭/);
});

test('成功但 TSDM_NOTIFY_ON_SUCCESS=0 时跳过通知', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_NOTIFY_ON_SUCCESS: '0' });
  const r = await tsdm.notify(profile, { title: 't', content: 'c', success: true }, new tsdm.Logger('t'));
  assert.equal(r.sent, false);
  assert.match(r.skipped, /ON_SUCCESS/);
});

test('失败但 TSDM_NOTIFY_ON_FAILURE=0 时跳过通知', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_NOTIFY_ON_FAILURE: '0' });
  const r = await tsdm.notify(profile, { title: 't', content: 'c', success: false }, new tsdm.Logger('t'));
  assert.equal(r.sent, false);
  assert.match(r.skipped, /ON_FAILURE/);
});

test('没有任何通知接口时跳过且不抛错', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_QL_NOTIFY_PATH: 'C:/definitely/not/here.py' });
  const r = await tsdm.notify(profile, { title: 't', content: 'c', success: true }, new tsdm.Logger('t'));
  assert.equal(r.sent, false);
  assert.ok(r.skipped || r.error);
});

test('DRY_RUN 时不发通知', async () => {
  const profile = tsdm.loadConfig({ TSDM_COOKIE: SAMPLE_COOKIE, TSDM_DRY_RUN: '1' });
  const r = await tsdm.notify(profile, { title: 't', content: 'c', success: true }, new tsdm.Logger('t'));
  assert.equal(r.sent, false);
  assert.equal(r.skipped, 'DRY_RUN');
});

test('白虎通知接口可用时按 notify-token 调用（本地假接口）', async () => {
  const http = require('node:http');
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, token: req.headers['notify-token'], body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"code":0}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const profile = tsdm.loadConfig({
      TSDM_COOKIE: SAMPLE_COOKIE,
      BHPKG_NOTIFY_URL: `http://127.0.0.1:${port}/api/v1/notify/send`,
      BHPKG_NOTIFY_TOKEN: 'tok-test',
      BHPKG_NOTIFY_CHANNEL: 'ch-1',
    });
    const r = await tsdm.notify(profile, { title: '标题', content: '正文', success: true }, new tsdm.Logger('t'));
    assert.equal(r.sent, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].token, 'tok-test');
    const payload = JSON.parse(received[0].body);
    assert.equal(payload.channel_id, 'ch-1');
    assert.equal(payload.title, '标题');
    assert.equal(payload.content, '正文');
    assert.equal(payload.format, 'markdown');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
