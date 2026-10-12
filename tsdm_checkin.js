'use strict';

const { runTask, runCheckin } = require('./lib/tsdm.js');
const { cli } = require('./lib/cli.js');

cli({
  script: 'tsdm_checkin.js',
  title: 'TSDM 天使动漫 · 每日签到',
  taskName: 'TSDM天使动漫签到',
  execute: runCheckin,
  usage: [
    'node tsdm_checkin.js                 执行签到（多账号按 TSDM_COOKIE 换行分隔）',
    'TSDM_DRY_RUN=1 node tsdm_checkin.js      只打印执行计划，不发请求',
    'node tsdm_checkin.js --probe             只读网络诊断（不需要 Cookie）',
    'node tsdm_checkin.js --test-notify       只测试通知接口是否可用',
  ],
  env: [
    'TSDM_COOKIE(必填) TSDM_UA TSDM_CHANNEL TSDM_QDXQ TSDM_TODAYSAY TSDM_FASTREPLY',
    'TSDM_NOTIFY / TSDM_NOTIFY_ON_SUCCESS / TSDM_NOTIFY_ON_FAILURE',
    'BHPKG_NOTIFY_TOKEN + BHPKG_NOTIFY_CHANNEL（白虎），或青龙自带 notify.py',
  ],
});
