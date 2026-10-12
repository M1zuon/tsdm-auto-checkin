# tsdm-auto-checkin

天使动漫论坛（www.tsdm39.com）的每日签到与打工脚本，跑在青龙面板或白虎面板上。

- 签到：`plugin.php?id=dsu_paulsign:sign`，自动选心情、填签到语，领随机天使币
- 打工：`plugin.php?id=np_cliworkdz:work`，点满 6 个广告位后领奖（+7 天使币，6 小时冷却）
- 结果通过面板原生通知接口推送（Server酱 / 青龙 `notify.py` / 白虎 `notify/send`），开关由环境变量控制
- 只用 Node 内置模块，无第三方依赖，青龙不用装依赖、白虎不用装 mise 包

Node ≥ 18。

## 快速开始

```bash
# 1. 取 Cookie：浏览器登录论坛 → F12 → Network → 点任一请求 → 复制 Request Headers 的整行 Cookie
#    至少要含 Ystv_2132_saltkey 和 Ystv_2132_auth

# 2. 先看网络与登录态（不需要 Cookie）
node tsdm_checkin.js --probe

# 3. 只打印请求计划，确认无误
TSDM_COOKIE='<整行 Cookie>' TSDM_DRY_RUN=1 node tsdm_checkin.js

# 4. 真实执行
TSDM_COOKIE='<整行 Cookie>' node tsdm_checkin.js
TSDM_COOKIE='<整行 Cookie>' node tsdm_work.js
```

退出码：`0` 全部账号成功（含「今天已签到」「冷却中」这类幂等成功），`1` 有账号失败。

## 部署到青龙面板

1. 脚本放到 `/ql/data/scripts/tsdm/`，保持 `lib/` 目录结构：

   ```bash
   docker cp ./tsdm_checkin.js qinglong:/ql/data/scripts/tsdm/tsdm_checkin.js
   docker cp ./tsdm_work.js    qinglong:/ql/data/scripts/tsdm/tsdm_work.js
   docker cp ./lib             qinglong:/ql/data/scripts/tsdm/lib
   ```

2. 「环境变量」新建 `TSDM_COOKIE`（多账号换行分隔），被盾时再加 `TSDM_UA`。
3. 「系统设置 → 通知设置」配任一渠道（`PUSH_KEY`、`BARK_PUSH`、`TG_BOT_TOKEN`+`TG_USER_ID`、`QYWX_KEY`、`WEBHOOK_URL` 等），脚本会自动调用容器自带的 `notify.py` 群发。
4. 「定时任务」新建两条：

   | 任务名 | 命令 | 定时 |
   |---|---|---|
   | TSDM 签到 | `task tsdm/tsdm_checkin.js` | `10 1 * * *` |
   | TSDM 打工 | `task tsdm/tsdm_work.js` | `20 1,9 * * *` |

   论坛规定签到时间 01:00–23:59，所以签到放 01:10；打工 6 小时冷却，一天两次够用。

用仓库订阅时，白名单填 `tsdm_checkin|tsdm_work`，**依赖必须填 `lib`**，否则 `lib/` 会被过滤掉。

## 部署到白虎面板

1. 「脚本管理」建 `tsdm` 目录，把两个入口和 `lib/` 按同样结构放进去。
2. 「变量机密」新建 `TSDM_COOKIE`，建议选「机密」类型（加密存储 + 日志打码）。
3. 「消息推送」建渠道，在「脚本调用说明」复制 Token 和渠道 ID，然后建变量 `BHPKG_NOTIFY_TOKEN`、`BHPKG_NOTIFY_CHANNEL`。
4. 「定时任务」新建两条，脚本路径 `tsdm/tsdm_checkin.js`、`tsdm/tsdm_work.js`，Cron 同上。

面板侧「任务编辑 → 通知配置」也能按成功/失败推信，**和脚本内通知二选一**，否则会收到两条。

## 命令行

```
node tsdm_checkin.js [--help] [--probe] [--test-notify]
node tsdm_work.js    [--help] [--probe] [--test-notify]
```

- `--probe` 只读诊断，不提交任何表单、不需要 Cookie，直接告诉你站点是否可达、有没有被 Cloudflare 拦、当前登录态如何
- `--test-notify` 发一条测试消息，验证通知渠道
- `TSDM_DRY_RUN=1` 只打印请求计划，不发网络请求

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TSDM_COOKIE` | — | 必填。整行 Cookie，多账号换行分隔 |
| `TSDM_UA` | 手机端 Chrome | User-Agent；被盾时改成取 Cookie 的浏览器 UA |
| `TSDM_REQUIRE_CF` | `0` | `0` 剔除 `cf_clearance`，`1` 保留 |
| `TSDM_CHANNEL` | 自动 | `desktop` / `mobile-ua` / `mobile-tpl`，固定单通道跳过探测 |
| `TSDM_PROXY` | — | HTTP(S) 代理，如 `http://127.0.0.1:7890` |
| `TSDM_BASE` | `https://www.tsdm39.com` | 站点地址 |
| `TSDM_QDXQ` | `ym` | 心情 `kx/ng/ym/wl/nu/ch/fd/yl/shuai`，`random` 随机 |
| `TSDM_TODAYSAY` | — | 签到语（3–50 字），不填则用快速语句 |
| `TSDM_FASTREPLY` | 随机 | 快速语句编号 1–8 |
| `TSDM_WORK_CLICK_MIN_MS` / `MAX_MS` | `1200` / `2600` | 点击广告的随机间隔 |
| `TSDM_WORK_ROUNDS` | `3` | 遇「不要作弊」时整轮重开的上限 |
| `TSDM_TIMEOUT_MS` / `TSDM_RETRY` | `20000` / `2` | 单请求超时 / 重试次数（1s、3s 退避） |
| `TSDM_DELAY_BETWEEN_MS` | `1500` | 多账号之间的间隔 |
| `TSDM_DRY_RUN` / `TSDM_DEBUG` | `0` | 只打印计划 / 打印调试日志 |
| `TSDM_NOTIFY` | `1` | 通知总开关 |
| `TSDM_NOTIFY_ON_SUCCESS` | `1` | 成功时是否推送 |
| `TSDM_NOTIFY_ON_FAILURE` | `1` | 失败时是否推送 |
| `TSDM_NOTIFY_TITLE` | 脚本名 | 通知标题前缀 |
| `TSDM_SERVERCHAN_KEY` | — | Server酱 SendKey，脚本直接发 HTTP，不依赖 Python |
| `TSDM_SERVERCHAN_URL` | 官方域名 | 自建/中转 Server酱 时覆盖端点 |
| `PUSH_KEY` | — | 同上，`TSDM_SERVERCHAN_KEY` 未设时取它（复用青龙里的既有变量） |
| `BHPKG_NOTIFY_TOKEN` / `BHPKG_NOTIFY_CHANNEL` / `BHPKG_NOTIFY_URL` | — | 白虎原生通知接口 |
| `TSDM_QL_NOTIFY_PATH` / `TSDM_PYTHON` | 自动 | 青龙 `notify.py` 路径与 python 可执行文件 |
| `TSDM_WEBHOOK_URL` | — | 通用兜底，POST JSON `{title, content}` |

### 通知渠道怎么选

脚本按 **白虎 → Server酱 → 青龙 notify.py → Webhook** 的顺序取第一个可用的，失败会自动往下一个回落。推荐用 **Server酱**（`PUSH_KEY`）：

- 纯 HTTP 直发，**不需要青龙预装 Python 的 `requests`**，也不会因为 `notify.py` 的问题连累通知
- 自动识别两种 key：`sctp{uid}t...`（Server酱³，走 `{uid}.push.ft07.com`）与 `SCT...`（Turbo，走 `sctapi.ftqq.com`）
- 返回码 `code != 0` 直接判失败并把原始信息带进日志

Server酱³ 的 key 形如 `sctp4247txxxx`，**只填 key 本身**，不要带域名或 `/send/`。青龙里就填在 `PUSH_KEY`（脚本会自动读），或者用专用变量 `TSDM_SERVERCHAN_KEY` 更明确。

> 注：青龙自带的 `notify.py` 对单个渠道失败只打印不报错，脚本会解析它的输出识别失败；但如果你已经用 Server酱，这条路径根本不会走到。

## 抓包依据

脚本里所有请求参数、页面选择器和文案判定都来自一次完整的浏览器抓包，没有猜测成分：

**签到**

```
GET  plugin.php?id=dsu_paulsign:sign                     → 提取 formhash、discuz_uid、今天未签到/今天已签到
POST plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1&inajax=1
     formhash=<页面提取>&qdxq=ym&qdmode=3&todaysay=&fastreply=1
     → 恭喜你签到成功!获得随机奖励 天使币 12 .
```

**打工**（顺序不能改）

```
1. GET  plugin.php?id=np_cliworkdz:work         → 页面含 np_advid1/2/4/6/7/9 与「共需要点击 6 个广告」
2. POST 同上，act=getcre                        → 未点满时返回「不要作弊哦，重新进行游戏吧！」
3. GET  同上                                    → 重新渲染本轮广告位
4. POST 同上，act=clickad&advid=N  ×6（间隔 1–2s）→ 纯文本 1,2,3,4,5,6（点击数递增）
5. POST 同上，act=getcre                        → 恭喜，您已经成功领取了奖励天使币 +7。
                                                   每间隔6小时0分钟0秒可进行一次。
```

同一次抓包里签到后积分 1466、打工后 1467，可交叉验证奖励到账。脚本按文案判定结果，不硬编码奖励数值和冷却时长。

## 两个容易踩的坑

**Cloudflare 不需要绕过。** 该站正常页面里都带一段 Cloudflare 注入的
`/cdn-cgi/challenge-platform/scripts/jsd/main.js` 探测脚本，所以不能用 `challenge-platform`
这种宽泛关键字判断盾页，否则会把正常页误判成盾页（开发过程中就被这个坑带偏过一次）。
`lib/tsdm.js` 的 `detectChallenge` 只认标题为 `Just a moment...` / `Attention Required` /
`One more step`，或 `cf_chl_opt`、`/cdn-cgi/challenge-platform/h/`、`cf-chl-` 这类挑战专用标记，
且有回归用例。实测直连（不带 `cf_clearance`）能正常拿到页面，所以默认策略是剔除 `cf_clearance`。

**广告位数量不能直接抓数字。** 说明文字里先出现的是颜色值 `#FF0000`，`共需要点击[^\d]*(\d+)` 会误取 `0000`。
代码里要求数字被 `<b>` 包住。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `--probe` 显示 `正常页面（未登录）`、`discuz_uid=0` | Cookie 失效。重新复制整行 Cookie，不需要绕 Cloudflare |
| `--probe` 显示 `Cloudflare 人机验证` | 出口 IP 需验证。依次试：填 `cf_clearance` 且 `TSDM_REQUIRE_CF=1` → 对齐 `TSDM_UA` → 配 `TSDM_PROXY` |
| `页面结构变化：未能从签到页提取 formhash` | 论坛改版。对照 `test/fixtures/` 的报文更新 `lib/tsdm.js` 里的解析规则 |
| 反复出现 `不要作弊` | 点击间隔太短或同一账号被并发跑。调大 `TSDM_WORK_CLICK_MIN_MS`/`MAX_MS` |
| `Cannot find module './lib/tsdm.js'` | 只上传了两个入口脚本。补 `lib/` 目录，注意 `lib/cli.js` 也要 |

## 测试

```bash
node --test "test/**/*.test.js"     # 36 个用例，纯离线，不联网
```

夹具是抓包里的真实报文片段，改解析规则时先跑测试。

## 项目结构

```
tsdm_checkin.js       签到入口（参数分派见 lib/cli.js）
tsdm_work.js          打工入口
lib/tsdm.js           内核：HTTP、Cookie、通道探测、页面解析、通知
lib/cli.js            两个入口共用的命令行外壳
test/tsdm.test.js     离线单元测试
test/fixtures/        真实报文片段
config.env.example    环境变量模板
docker-compose.yml    本机青龙 + 白虎，便于端到端验证
```

## 安全

`TSDM_COOKIE` 等同于账号登录凭据，不要提交到公开仓库或发到群里，`.gitignore` 已忽略 `config.env`。

开发时用的原始抓包文件（含真实 `auth`、`cf_clearance`）**没有放在仓库里**，只在本地留存。
测试夹具里出现的用户名、UID 和 Cookie 值都是编造的。如果你也抓了包，建议单独保存在仓库外。

## 许可

MIT，见 [LICENSE](LICENSE)。自用脚本，不提供任何担保；使用前请确认符合论坛规则，请求频率与手工操作保持一致。
