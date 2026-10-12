# tsdm-auto-checkin

天使动漫论坛（www.tsdm39.com）的每日签到与打工脚本，可跑在青龙面板或白虎面板上。

- 签到：`dsu_paulsign` 插件，自动选心情、填签到语，领取随机天使币
- 打工：`np_cliworkdz` 插件，点满 6 个广告位后领奖
- 通知：Server酱 / 青龙 `notify.py` / 白虎 `notify/send`，渠道与开关由环境变量控制
- 仅使用 Node 内置模块，无第三方依赖（青龙无需装依赖，白虎无需装 mise 包）

要求 Node ≥ 18。

## 快速开始

```bash
# 1. 取 Cookie：登录论坛 → F12 → Network → 点任一请求 → 复制 Request Headers 的整行 Cookie
#    至少包含 <前缀>_saltkey 与 <前缀>_auth（本站前缀为 Ystv_2132_）

# 2. 自检：站点是否可达、登录态是否有效（不需要 Cookie）
node tsdm_checkin.js --probe

# 3. 预览请求计划，不发网络请求
TSDM_COOKIE='<整行 Cookie>' TSDM_DRY_RUN=1 node tsdm_checkin.js

# 4. 执行
TSDM_COOKIE='<整行 Cookie>' node tsdm_checkin.js
TSDM_COOKIE='<整行 Cookie>' node tsdm_work.js
```

退出码：`0` 全部账号成功（「今天已签到」「冷却中」这类幂等结果也算成功），`1` 有账号失败。

## 部署到青龙面板

1. 脚本放到 `/ql/data/scripts/tsdm/`，保持 `lib/` 目录结构：

   ```bash
   docker cp ./tsdm_checkin.js qinglong:/ql/data/scripts/tsdm/tsdm_checkin.js
   docker cp ./tsdm_work.js    qinglong:/ql/data/scripts/tsdm/tsdm_work.js
   docker cp ./lib             qinglong:/ql/data/scripts/tsdm/lib
   ```

2. 「环境变量」新建 `TSDM_COOKIE`（多账号换行分隔）。被 Cloudflare 拦时再加 `TSDM_UA`。
3. 通知：填 `PUSH_KEY` 即可（脚本直接发 HTTP，不走青龙的 `notify.py`）。
4. 「定时任务」新建两条：

   | 任务名 | 命令 | 定时 |
   |---|---|---|
   | TSDM 签到 | `task tsdm/tsdm_checkin.js` | `10 1 * * *` |
   | TSDM 打工 | `task tsdm/tsdm_work.js` | `6 0,7,14,21 * * *` |

   签到时段为 01:00–23:59，故放在 01:10。打工的冷却按「上次领取成功」起算，**cron 间隔必须大于冷却时长**，否则每次触发都会差几十秒而白跑；7 小时间隔（00:06 / 07:06 / 14:06 / 21:06）可保证每次触发都在冷却之后。

   用仓库订阅时，白名单填 `tsdm_checkin|tsdm_work`，**依赖必须填 `lib`**，否则 `lib/` 会被过滤掉。

## 部署到白虎面板

1. 「脚本管理」建 `tsdm` 目录，按同样结构放入两个入口与 `lib/`。
2. 「变量机密」新建 `TSDM_COOKIE`，建议选「机密」类型（加密存储、日志打码）。
3. 「消息推送」建渠道，从「脚本调用说明」复制 Token 与渠道 ID，建变量 `BHPKG_NOTIFY_TOKEN`、`BHPKG_NOTIFY_CHANNEL`。
4. 「定时任务」新建两条，脚本路径 `tsdm/tsdm_checkin.js`、`tsdm/tsdm_work.js`，Cron 同上。

面板侧「任务编辑 → 通知配置」也能按成功/失败推信，**与脚本内通知二选一**，否则会收到两条。

## 命令行

```
node tsdm_checkin.js [--help] [--probe] [--test-notify]
node tsdm_work.js    [--help] [--probe] [--test-notify]
```

- `--probe` 只读诊断，不提交表单、不需要 Cookie
- `--test-notify` 发送一条测试消息，验证通知渠道
- `TSDM_DRY_RUN=1` 只打印请求计划，不发网络请求

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `TSDM_COOKIE` | — | 必填。整行 Cookie，多账号换行分隔 |
| `TSDM_SERVERCHAN_KEY` / `PUSH_KEY` | — | Server酱 SendKey，脚本直接发 HTTP |
| `TSDM_NOTIFY` | `1` | 通知总开关 |
| `TSDM_NOTIFY_ON_SUCCESS` / `TSDM_NOTIFY_ON_FAILURE` | `1` | 成功 / 失败时是否推送 |
| `TSDM_NOTIFY_TITLE` | 脚本名 | 通知标题前缀 |
| `TSDM_UA` | 手机端 Chrome | User-Agent；被拦时改为取 Cookie 浏览器的 UA |
| `TSDM_REQUIRE_CF` | `0` | `0` 剔除 `cf_clearance`，`1` 保留 |
| `TSDM_CHANNEL` | 自动 | `desktop` / `mobile-ua` / `mobile-tpl`，固定单通道跳过探测 |
| `TSDM_PROXY` | — | HTTP(S) 代理 |
| `TSDM_BASE` | `https://www.tsdm39.com` | 站点地址 |
| `TSDM_QDXQ` | `ym` | 心情 `kx/ng/ym/wl/nu/ch/fd/yl/shuai`，或 `random` |
| `TSDM_TODAYSAY` | — | 签到语（3–50 字），不填则用快速语句 |
| `TSDM_FASTREPLY` | 随机 | 快速语句编号 1–8 |
| `TSDM_WORK_CLICK_MIN_MS` / `MAX_MS` | `1200` / `2600` | 点击广告的随机间隔 |
| `TSDM_WORK_ROUNDS` | `3` | 点击计数异常时的整轮重试上限 |
| `TSDM_TIMEOUT_MS` / `TSDM_RETRY` | `20000` / `2` | 单请求超时 / 重试次数（1s、3s 退避） |
| `TSDM_DELAY_BETWEEN_MS` | `1500` | 多账号之间的间隔 |
| `TSDM_DRY_RUN` / `TSDM_DEBUG` | `0` | 只打印计划 / 打印调试日志 |
| `BHPKG_NOTIFY_TOKEN` / `BHPKG_NOTIFY_CHANNEL` / `BHPKG_NOTIFY_URL` | — | 白虎原生通知接口 |
| `TSDM_SERVERCHAN_URL` | 官方域名 | 自建或中转 Server酱 时覆盖端点 |
| `TSDM_QL_NOTIFY_PATH` / `TSDM_PYTHON` | 自动 | 青龙 `notify.py` 路径与 python 可执行文件 |
| `TSDM_WEBHOOK_URL` | — | 通用兜底，POST JSON `{title, content}` |

完整示例见 [config.env.example](config.env.example)。

### 通知渠道

按 **白虎 → Server酱 → 青龙 notify.py → Webhook** 依次尝试，失败自动回落到下一个。推荐 Server酱：

- 纯 HTTP 直发，不依赖青龙预装 Python 的 `requests`
- 自动识别两种 SendKey：`sctp{uid}t...`（Server酱³ → `{uid}.push.ft07.com`）与 `SCT...`（Turbo → `sctapi.ftqq.com`）
- 只填 SendKey 本身，不要带域名或 `/send/`

## 内部实现说明

请求参数、页面选择器与文案判定都来自一次完整的浏览器抓包：

```
签到
GET  plugin.php?id=dsu_paulsign:sign
     → 提取 formhash、discuz_uid，判断「今天未签到 / 今天已签到」
POST plugin.php?id=dsu_paulsign:sign&operation=qiandao&infloat=1&inajax=1
     formhash=<页面提取>&qdxq=ym&qdmode=3&todaysay=&fastreply=1
     → 恭喜你签到成功!获得随机奖励 天使币 N .

打工（顺序不可调换）
1. GET  plugin.php?id=np_cliworkdz:work              → 取 np_advidN 广告位与所需点击数
2. POST 同上，act=getcre                             → 未点满时返回「不要作弊」
3. GET  同上                                         → 重新渲染本轮广告位
4. POST 同上，act=clickad&advid=N  ×N（间隔 1–2s）    → 纯文本计数 1,2,3…
5. POST 同上，act=getcre                             → 已经成功领取了奖励天使币 +N
```

实现中有三处需要留意，改动解析逻辑时不要退化：

- **盾页判定不能过宽。** 站点每个正常页面都带 Cloudflare 注入的 `/cdn-cgi/challenge-platform/scripts/jsd/main.js`，用它判断盾页会把正常页误判。`detectChallenge()` 只认挑战专用标记（`cf_chl_opt`、`/cdn-cgi/challenge-platform/h/`、`cf-chl-`）与 `Just a moment...` 等标题。
- **广告位数量不能直接抓数字。** 说明文字里先出现的是颜色值 `#FF0000`，`共需点击[^\d]*(\d+)` 会误取 `0000`；代码要求数字被 `<b>` 包住。
- **冷却时长的判定要容忍省略形态。** 服务端可能只给「X 小时」「X 分钟」或「X 秒」，措辞也会变（`再来` / `才能再次领取`）。

奖励数值与冷却时长均从响应文案解析，不做硬编码。

## 常见问题

| 现象 | 处理 |
|---|---|
| `--probe` 显示 `正常页面（未登录）`、`discuz_uid=0` | Cookie 失效，重新复制整行 Cookie |
| `--probe` 显示 `Cloudflare 人机验证` | 依次尝试：填 `cf_clearance` 且设 `TSDM_REQUIRE_CF=1` → 对齐 `TSDM_UA` → 配 `TSDM_PROXY` |
| `未能从签到页提取 formhash` | 论坛改版，对照 `test/fixtures/` 的报文更新 `lib/tsdm.js` 的解析规则 |
| 反复出现 `不要作弊` | 点击间隔过短，调大 `TSDM_WORK_CLICK_MIN_MS` / `MAX_MS` |
| `Cannot find module './lib/tsdm.js'` | `lib/` 目录未随脚本上传，注意 `lib/cli.js` 也要 |
| 通知未收到 | 用 `--test-notify` 单独验证渠道配置 |

## 测试

```bash
node --test "test/**/*.test.js"     # 47 个用例，纯离线，不联网
```

夹具取自抓包的真实报文片段，修改解析规则前先跑测试。

## 项目结构

```
tsdm_checkin.js       签到入口
tsdm_work.js          打工入口
lib/tsdm.js           内核：HTTP、Cookie、通道探测、页面解析、通知
lib/cli.js            两个入口共用的命令行外壳
test/tsdm.test.js     离线单元测试
test/fixtures/        真实报文片段（凭据与用户信息均为编造值）
config.env.example    环境变量模板
docker-compose.yml    本机青龙 + 白虎，便于端到端验证
```

## 安全

`TSDM_COOKIE`、Server酱 SendKey 等同账号与推送凭据，不要提交到公开仓库或发到公开场合。`.gitignore` 已忽略 `config.env` 与抓包文件。

## 许可

MIT，见 [LICENSE](LICENSE)。自用脚本，不提供任何担保；使用前请确认符合论坛规则。
