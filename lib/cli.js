'use strict';

/**
 * 两个入口脚本共用的命令行外壳：--help / --probe / --test-notify / 正常执行。
 * 只负责参数分派与退出码，具体流程由传入的 execute 完成。
 */

const { runTask, loadConfig, notify, probeNetwork, Logger } = require('./tsdm.js');

/** 诊断与自检不需要 Cookie，随便塞一个占位值即可绕过必填校验 */
function withPlaceholderCookie() {
  return { ...process.env, TSDM_COOKIE: process.env.TSDM_COOKIE || 'placeholder=1' };
}

async function runProbe(script) {
  const profile = loadConfig(withPlaceholderCookie());
  const logger = new Logger('网络诊断', profile.debug);
  logger.info(`目标站点：${profile.base}`);
  await probeNetwork(profile, logger);
}

async function runNotifySelfTest(profile, script) {
  const logger = new Logger('通知自检', profile.debug);
  const r = await notify(profile, {
    title: `${profile.notify.title || 'TSDM'} · 通知自检`,
    content: `- 来自 ${script} --test-notify 的测试消息\n- 时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    success: true,
  }, logger);
  if (!r.sent) {
    logger.warn(`通知未发送：${r.skipped || r.error || '未知原因'}`);
    process.exitCode = 1;
  }
}

function printHelp(opts) {
  console.log([
    opts.title,
    '',
    '用法：',
    ...opts.usage.map((l) => `  ${l}`),
    '',
    '环境变量：',
    ...opts.env.map((l) => `  ${l}`),
    '',
    '完整说明见 README.md',
  ].join('\n'));
}

function cli(opts) {
  const argv = process.argv.slice(2);
  const has = (...flags) => flags.some((f) => argv.includes(f));

  if (has('--help', '-h')) {
    printHelp(opts);
    process.exit(0);
  }

  if (has('--probe')) {
    runProbe(opts.script).catch((err) => {
      console.error(`[TSDM] 诊断异常：${(err && err.message) || err}`);
      process.exit(1);
    });
    return;
  }

  if (has('--test-notify')) {
    runNotifySelfTest(loadConfig(process.env), opts.script).catch((err) => {
      console.error(`[TSDM] 通知自检异常：${(err && err.message) || err}`);
      process.exit(1);
    });
    return;
  }

  runTask({ taskName: opts.taskName, execute: opts.execute }).catch((err) => {
    console.error(`[TSDM] 任务异常终止：${(err && err.stack) || err}`);
    process.exit(1);
  });
}

module.exports = { cli };
