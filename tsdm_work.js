'use strict';

const { runWork } = require('./lib/tsdm.js');
const { cli } = require('./lib/cli.js');

cli({
  script: 'tsdm_work.js',
  title: 'TSDM 天使动漫 · 打工领天使币',
  taskName: 'TSDM天使动漫打工',
  execute: runWork,
  usage: [
    'node tsdm_work.js                    执行打工（多账号按 TSDM_COOKIE 换行分隔）',
    'TSDM_DRY_RUN=1 node tsdm_work.js         只打印执行计划，不发请求',
    'node tsdm_work.js --probe                只读网络诊断（不需要 Cookie）',
    'node tsdm_work.js --test-notify          只测试通知接口是否可用',
  ],
  env: [
    'TSDM_COOKIE(必填) TSDM_UA TSDM_CHANNEL',
    'TSDM_WORK_ROUNDS / TSDM_WORK_CLICK_MIN_MS / TSDM_WORK_CLICK_MAX_MS',
    'TSDM_NOTIFY / TSDM_NOTIFY_ON_SUCCESS / TSDM_NOTIFY_ON_FAILURE',
    'BHPKG_NOTIFY_TOKEN + BHPKG_NOTIFY_CHANNEL（白虎），或青龙自带 notify.py',
  ],
});
