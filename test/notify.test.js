'use strict';
/*
 * 通知渠道的离线测试。
 *
 * 重要：本文件内所有 SendKey / Cookie 均为编造值，仅保持真实格式用于验证解析逻辑，
 * 严禁把任何真实凭据写进测试或夹具（否则会随仓库公开）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const tsdm = require('../lib/tsdm.js');

// 编造的 Server酱³ key：sctp{uid}t... 形态，uid 用 4247 仅为便于断言
const FAKE_SC3_KEY = 'sctp4247tFAKEKEY0000000000000000';
// 编造的 Turbo key：非 sctp 前缀即可走 sctapi 域名
const FAKE_TURBO_KEY = 'SCT00000FAKEKEYforROUTINGtest00000';

/** 起一个本地假 Server酱，记录收到的请求 */
async function withFakeServer(handler, run) {
  const received = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    received.push({ path: url.pathname, title: url.searchParams.get('title'), desp: url.searchParams.get('desp') });
    handler(req, res, url);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function okJson(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 0, message: 'SUCCESS' }));
}

test('Server酱³ 的 key 走 ft07 域名，并带上 title/desp', async () => {
  await withFakeServer(okJson, async (base, received) => {
    const via = await tsdm.sendServerChan(FAKE_SC3_KEY, { title: '标题A', content: '正文B' }, { v3: base });
    assert.equal(received.length, 1);
    assert.equal(received[0].path, `/send/${FAKE_SC3_KEY}.send`);
    assert.equal(received[0].title, '标题A');
    assert.equal(received[0].desp, '正文B');
    assert.match(via, /Server酱³ uid=4247/);
  });
});

test('Turbo 的 key（非 sctp 前缀）走 sctapi 域名', async () => {
  await withFakeServer(okJson, async (base, received) => {
    const via = await tsdm.sendServerChan(FAKE_TURBO_KEY, { title: 'T', content: 'C' }, { turbo: base });
    assert.equal(received.length, 1);
    assert.equal(received[0].path, `/${FAKE_TURBO_KEY}.send`);
    assert.match(via, /Turbo/);
  });
});

test('Server酱返回非 0 时抛错并带上原始信息', async () => {
  await withFakeServer((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 30001, message: 'database error- wxstatus' }));
  }, async (base) => {
    await assert.rejects(
      () => tsdm.sendServerChan(FAKE_SC3_KEY, { title: 't', content: 'c' }, { v3: base }),
      /code=30001/,
    );
  });
});

test('Server酱返回非 JSON 时抛错而不是静默成功', async () => {
  await withFakeServer((req, res) => {
    res.writeHead(502, { 'Content-Type': 'text/html' });
    res.end('<html>bad gateway</html>');
  }, async (base) => {
    await assert.rejects(
      () => tsdm.sendServerChan(FAKE_SC3_KEY, { title: 't', content: 'c' }, { v3: base }),
      /返回非 JSON/,
    );
  });
});

test('配了 PUSH_KEY 时 notify 直接走 Server酱，不碰 notify.py', async () => {
  await withFakeServer(okJson, async (base, received) => {
    const profile = tsdm.loadConfig({
      TSDM_COOKIE: 'Ystv_2132_saltkey=x; Ystv_2132_auth=y',
      PUSH_KEY: FAKE_TURBO_KEY,
      TSDM_SERVERCHAN_URL: base,
      // 故意指向一个不存在的 notify.py，确保不会被走到
      TSDM_QL_NOTIFY_PATH: '/definitely/not/a/real/notify.py',
    });
    assert.equal(profile.notify.serverchanKey, FAKE_TURBO_KEY);

    const r = await tsdm.notify(
      profile,
      { title: '任务标题', content: '任务正文', success: true },
      new tsdm.Logger('test'),
    );
    assert.equal(r.sent, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].title, '任务标题');
    assert.equal(received[0].desp, '任务正文');
  });
});

test('Server酱失败时回落到下一个已配置渠道', async () => {
  await withFakeServer((req, res, url) => {
    if (url.pathname.startsWith('/send/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 30001, message: 'database error- wxstatus' }));
    } else {
      res.writeHead(200);
      res.end('ok');
    }
  }, async (base) => {
    // webhook 指向同一个假服务器（非 /send/ 路径），验证回落成功
    const profile = tsdm.loadConfig({
      TSDM_COOKIE: 'Ystv_2132_saltkey=x; Ystv_2132_auth=y',
      PUSH_KEY: FAKE_SC3_KEY,
      TSDM_SERVERCHAN_URL: base,
      TSDM_WEBHOOK_URL: `${base}/fallback`,
    });
    const r = await tsdm.notify(profile, { title: 't', content: 'c', success: true }, new tsdm.Logger('test'));
    assert.equal(r.sent, true);
    assert.match(r.via, /Webhook/);
  });
});
