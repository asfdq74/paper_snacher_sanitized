# Paper Snacher

按 id 批量下载论文（MDPI + ScienceDirect + Wiley），文件保存为 `{id}.pdf`。

当前默认论文根目录为 `<PROJECT_ROOT>\downloads`。相对 `--outdir/--dir` 也会解析到该目录；
显式绝对路径仍可覆盖。顶层菜单由 `entry.ps1` 分发任务。

## 目录结构

```
paper_snacher/
├─ entry.ps1                       ← 顶层任务菜单和分发器
├─ 开始下载-MDPI.cmd              ← MDPI 入口（双击运行）
├─ 开始下载-SciDir.cmd            ← ScienceDirect 入口（双击运行）
├─ 开始下载-SciDir-CARSI.cmd      ← ScienceDirect 直连入口（CARSI 机构登录，不用 WebVPN）
├─ 开始下载-SciDir-官方API.cmd     ← Elsevier 官方 API 入口
├─ 开始下载-Wiley.cmd             ← Wiley 入口（双击运行）
├─ scripts/                       下载器与工具脚本
│   ├─ lib.mjs                    共用库（浏览器/CDP、cookie、指纹池、校验）
│   ├─ webvpn-auth.mjs            共用 WebVPN/CAS 登录、验证码与轨迹
│   ├─ mdpi.mjs                   MDPI 下载器
│   ├─ scidir.mjs                 ScienceDirect（login / download / api / close）
│   ├─ wiley.mjs                  Wiley（login / check / download / close）
│   ├─ filter_owner.py            owner/id → JSON 清单
│   ├─ build_list.py              id 清单 + Excel → 下载清单
│   ├─ resolve_pii.mjs            DOI → ScienceDirect 直链
│   └─ verify.py                  下载结果校验（比对 PDF 首页 DOI）
├─ data/
│   ├─ inputs/                    原始 Excel 源表
│   ├─ manifests/                 当前 id、DOI 和下载 JSON 清单
│   │   └─ archive/               历史派生清单
│   └─ reports/                   快照和分析报告
├─ state/                         运行时状态（不要提交/外传）
│   ├─ elsevier_key.txt           Elsevier API key
│   ├─ scidir_cookies.json        WebVPN 登录会话
│   ├─ wiley_cookies.json         Wiley 用的 WebVPN 登录会话
│   ├─ wiley_token.txt            Wiley TDM token（API 用，当前不可用）
│   ├─ xlsx_clean.xlsx            build_list 用的兼容副本
│   ├─ *_log.jsonl                下载日志
│   ├─ captcha_login.jsonl        验证码事件日志（不含凭据）
│   ├─ captcha/                   验证码截图与轨迹
│   └─ scidir_fail/               失败截图
├─ <PROJECT_ROOT>\downloads\            当前论文输出根目录
│   ├─ downloads_scidir/          SciDir 输出（{id}.pdf）
│   ├─ downloads_mdpi/            MDPI 输出
│   ├─ downloads_api/             官方 API 输出
│   └─ downloads_wiley*/          Wiley 输出
├─ .browser_profile_scidir/       SciDir 下载用浏览器 profile
├─ .browser_profile_scidir_login/ 登录用浏览器 profile
├─ node_modules/ + package.json   playwright-core 依赖
└─ requirements.txt               Python 依赖（openpyxl）
```

## 快速使用

### WebVPN 登录辅助与验证码

SciDir/Wiley 的 `login` 命令和独立登录入口现在共用 `scripts\webvpn-auth.mjs`，
SciDir 的 WebVPN 登录默认复用 `.browser_profile_scidir` 中已保存的账号密码，
验证码通过后主动触发浏览器自动填充；终端或环境变量提供的账号密码优先。

默认自动识别滑块、拖动验证，并在通过后填写账号密码、点击登录。

```powershell
node scripts\webvpn-login.mjs
node scripts\scidir.mjs login
node scripts\scidir.mjs login --direct
node scripts\wiley.mjs login
```

常用参数：

- `--captcha auto`：默认模式，自动识别并拖动；失败后保留可见窗口，转人工完成。
- `--captcha manual`：只自动填写账号密码，滑块由人工完成。
- `--captcha-profile human|human_slow|human_fast|linear|ease|jitter|stepped`：拖动轨迹，默认 `human`。
- `--captcha-max 1|2`：单次登录自动尝试上限，默认 2；超过上限不会继续循环。
- `--no-prompt`：不读取终端输入，仅使用环境变量。

账号密码只存在于内存中，不写入文件。验证码事件写入
`state\captcha_login.jsonl`，验证码截图与轨迹写入 `state\captcha\`；日志不会记录密码、
Cookie 或带 token 的图片 URL。`webvpn-captcha-risk-test.mjs` 只保留为独立样本采集入口，
主下载器不会启动它。

也可以预先设置环境变量后运行，避免交互输入：

```powershell
$env:WEBVPN_USERNAME = '你的学号或人事编号'
$env:WEBVPN_PASSWORD = '你的密码'
node scripts\webvpn-login.mjs
```

可用 `--check` 只检查登录页能否打开，`--keep-open` 在登录成功后保留窗口。
如果只想练习滑块的图像识别和拖动流程，可以运行完全本地的合成测试：

```powershell
node test\slider-demo\solve.mjs --rounds 5
```

它不会连接 WebVPN，详见 `test\slider-demo\README.md`。

| 入口 | 用途 | 输出 |
|---|---|---|
| `开始下载-MDPI.cmd` | MDPI（开放获取） | `<PROJECT_ROOT>\downloads\downloads_mdpi\` |
| `开始下载-SciDir.cmd` | ScienceDirect（Example University WebVPN） | `<PROJECT_ROOT>\downloads\downloads_scidir\` |
| `开始下载-SciDir-CARSI.cmd` | ScienceDirect（CARSI 机构会话直连，不用 WebVPN） | `<PROJECT_ROOT>\downloads\downloads_scidir\` |
| `开始下载-SciDir-官方API.cmd` | Elsevier 官方 API（需 insttoken） | `<PROJECT_ROOT>\downloads\downloads_api\` |
| `开始下载-Wiley.cmd` | Wiley（Example University WebVPN + `/doi/pdfdirect`） | `<PROJECT_ROOT>\downloads\downloads_wiley\` |

`开始下载-SciDir.cmd` 是闭环的：会话失效（502 / 风控页）时自动弹出**可见**登录窗口，
自动完成滑块与账号登录；验证码失败时窗口保持可见，可人工完成后继续下载。
下载命令启动时会先完成 WebVPN/CAS 登录或会话检查，再在**同一个有头页面**中导航到论文；
登录阶段关闭窗口会立即终止等待。`--headless` 只影响后续会话轮换。
当本次队列完全没有成功条目时，SciDir 以退出码 `3` 结束；部分成功、部分失败仍按完成处理。


## 命令行

```bash
# 1) 准备清单（新批次）
python scripts\build_list.py --ids data\manifests\newlist.txt --start 600 --count 200 --out data\manifests\newlist3_papers.json
node   scripts\resolve_pii.mjs --src data\manifests\newlist3_papers.json --out data\manifests\newlist3_sd.json

# 2) 下载
node scripts\mdpi.mjs   --list data\manifests\<mdpi清单>.json --outdir <PROJECT_ROOT>\downloads\downloads_mdpi [--max N] [--only id1,id2]
node scripts\scidir.mjs login                        # 有头登录，默认自动处理滑块
node scripts\scidir.mjs download --list data\manifests\newlist3_sd.json --outdir <PROJECT_ROOT>\downloads\downloads_scidir [--rotate 9]

# CARSI 直连模式（不走 WebVPN，靠机构登录会话拿权限）
node scripts\scidir.mjs login    --direct            # 弹窗 → Example University，默认自动处理滑块
node scripts\scidir.mjs download --direct --list data\manifests\newlist3_sd.json --outdir <PROJECT_ROOT>\downloads\downloads_scidir --rotate 0 --delay 3000
node scripts\scidir.mjs api      --list data\manifests\newlist3_sd.json --outdir <PROJECT_ROOT>\downloads\downloads_api [--via direct|webvpn] [--dry-run]
node scripts\scidir.mjs close                        # 关闭本项目所有浏览器实例

# Wiley（1592 篇，限速 10s/篇 + 滚动 10 分钟 ≤ 60 次请求）
node scripts\wiley.mjs login                         # WebVPN 登录，默认自动处理滑块
node scripts\wiley.mjs check [id]                    # 只验证 1 篇，确认链路
node scripts\wiley.mjs download --list data\manifests\wiley_papers.json --outdir <PROJECT_ROOT>\downloads\downloads_wiley [--delay 10000] [--max N] [--only id1,id2]
node scripts\wiley.mjs close

# 3) 校验
python scripts\verify.py --list data\manifests\newlist3_sd.json --dir <PROJECT_ROOT>\downloads\downloads_scidir
python scripts\verify.py --list data\manifests\wiley_papers.json --dir <PROJECT_ROOT>\downloads\downloads_wiley
```

清单路径不存在时，脚本会列出 `data\manifests`、`data\` 和根目录下所有可用清单。

## 防风控设计（SciDir）

| 机制 | 说明 |
|---|---|
| 无头 UA 修正 | 无头模式会被识别成 `HeadlessChrome`，用 CDP 覆盖成真实 Edge UA + Client Hints |
| 指纹池 | 4 组真实 Edge/Win 配置（版本 + 分辨率 + 语言），每次启动/轮换随机取一组 |
| CF 凭证保留 | 轮换时保留 `cf_clearance`/`__cf_bm`/`ak_bmsc`，只清会话类 cookie |
| 人味节奏 | 落地后随机停留、点 PDF 前犹豫、篇间隔 ±40% 抖动、每 30 篇休息 30–90s |
| 自适应降速 | 出现风控页则间隔倍率上调（最高 8×），连续 15 篇正常后逐步恢复 |
| 指数退避 | 风控页 60s → 120s → 240s 后重试，避免连续撞击 |

## 运行说明

- **断点续传**：已存在且是有效 PDF 的 id 自动跳过，随时可关掉重跑。
- **失败重试**：单篇失败重试 3 次；WebVPN 502 累计 3 次 → 退出码 10 → 入口脚本自动带你重新登录。
- **浏览器隔离**：MDPI 与 SciDir 用各自独立的 profile 和调试端口，可同时运行互不干扰。
- **不要外传 `state/`**：里面有 API key 和登录会话。

### 铁律：`.cmd` 文件必须是纯 ASCII

cmd.exe 按 **GBK** 解析批处理文件。UTF-8 的中文字节被拆错后会掉出 `&`、`|`、`<`、`>`，
被当成命令分隔符，把一行切成碎片去执行。症状长这样：

```

### 看门狗的两个坑（2026-10-08 实测踩过，各废掉几小时）

**坑 1：拿"读浏览器当前页面"当风控触发器 → 死循环。**
实时读页面文本匹配 `there was a problem providing...` 看似灵敏，但付费墙页、
跳转中间态也会命中关键词。后果是：

```
读到疑似风控页 → 杀进程清理重启 → 脚本从头跑 → 又碰到没订阅的文章
→ 又读到疑似风控页 → 再清理重启 ...（实测刷了 34 轮）
```

没订阅的文章永远下不到 PDF，**会永远排在待办列表最前面**，所以每轮重启都从它开始。
现在实时读页面**只作提示，不作触发**；触发条件只认脚本自己写进日志的 `blocked` 状态。

**坑 2：`closeOurBrowsers()` 会杀掉项目里所有批次。**
它按 `paper_snacher` 匹配 Edge 进程。SciDir 每次会话轮换/重启都会调用它，
顺手就把 Wiley 那批的浏览器一起带走。现在两个脚本和看门狗都改成
**按 profile 限定**（`closeProfiles([...])`），只在 `close` 子命令里保留全杀语义。
'tle' is not recognized as an internal or external command
'watches' is not recognized as an internal or external command
Access is denied.
```

所以入口脚本里**不能出现任何非 ASCII 字符**（注释、echo、标题都不行），
中文只出现在 `.cmd` 的**文件名**上（文件名由文件系统处理，不走批处理解析器）。

改完 `.cmd` 后自检一遍：

```powershell
Get-ChildItem <PROJECT_ROOT>\*.cmd | ForEach-Object {
  $n = ([System.IO.File]::ReadAllBytes($_.FullName) | Where-Object { $_ -gt 127 }).Count
  "{0,-32} {1}" -f $_.Name, $(if ($n) { "X 含 $n 个非 ASCII 字节" } else { "OK" })
}
```

## Wiley 说明

`scripts\wiley.mjs` 对非 paywall 的 HTTP 403 风控页会自动执行：

1. 关闭当前 Wiley 浏览器；
2. 删除下载和登录 profile；
3. 清空 `state\wiley_cookies.json`；
4. 启动 WebVPN 登录，捕获新 cookie；
5. 重启浏览器并重试当前论文。

自动重登默认最多 2 次，可用 `--auto-relogin-max N` 调整。普通 `paywall` 的 403
不会触发重登。当前已知 `10.1002/admt` 基本没有机构全文权限。

## ScienceDirect 直连模式（CARSI）

为什么需要它：机构权限有两种来源——**校园网 IP** 或**机构登录会话（CARSI/Shibboleth）**。
如果设备不在校园网（例如手机只有香港出口 IP）却仍能看全文，说明走的是后者。
这条路对 PC 同样成立，且不需要 WebVPN、不需要 Tailscale，稳定性高得多。

- 首次使用：`node scripts\scidir.mjs login --direct`，在弹窗里点
  "Access through your organization" → 搜 "Example University" → 用Example University账号登录。
  登录期间脚本**不刷新页面**，可以慢慢填。
- 会话以 cookie 形式存到 `state\scidir_cookies.json`（48 个），下载时注入离屏浏览器。
- 实测：`download --direct --max 2` → 2/2 成功，未走 WebVPN。
- 直连模式下 `--rotate` 建议设 0（会话轮换是为了绕 WebVPN 的风控，真实机构会话不需要）。

### CARSI 直连的三个坑（2026-10-08 实测踩过）

1. **机构会话与出口 IP 绑定**。会话用家庭宽带建立、下载却走 Tailscale 手机出口时，
   Elsevier 判定会话换 IP，**整段撤销机构权限**。表现是前几篇正常、随后连续
   `no_pdf_params / no_access`。**登录和下载必须同一个出口，中途不要切网络。**
2. **登录成功判定曾经是假阳性**。旧实现用 `/"md5":"/` 判断，只要页面上出现这个前缀
   就认为登录成功——无权限时页面里同样有空字段，导致脚本"秒过"并保存了已失效的 cookie。
   现改为：文章 URL 没被重定向到 `/article/abs/pii/`，且 md5 有真实的 16 位十六进制值。
3. **下载窗口必须复用登录 profile**。Elsevier 的机构凭证不全在 cookie 里，
   换个 profile 只注入 cookie 会被当作"换了设备"。现直连模式下
   `PROFILE` 自动指向 `.browser_profile_scidir_login`。

另外：`--direct` 时会自动关闭指纹伪造（`stealthUa`），登录窗口是真实 Edge UA，
下载窗口也用真实 UA 才不会露馅。

- **链路**：Example University WebVPN 代理 `onlinelibrary.wiley.com/doi/pdfdirect/{doi}?download=true`，
  用 Playwright 的 `ctx.request` 直接在浏览器上下文里取二进制（不经 base64），再落到 `{id}.pdf`。
- **限速**：默认每篇间隔 10s，并强制"任意滚动 10 分钟内不超过 60 次请求"，对齐 Wiley TDM
  官方公布的 3 篇/秒 + 60 请求/10 分钟。改间隔用 `--delay`，改窗口上限用 `--per-10min`。
- **Wiley TDM API 为什么没用**：token 已从页面确认无误（`state\wiley_token.txt`），但
  `api.wiley.com` 对订阅内容一律返回裸 403（无限速头、无消息体），官方客户端把 403 解释为
  "TDM access denied from IP"。即机构侧没有为 TDM API 开放当前出口 IP。走 API 需要联系
  `TDM@wiley.com` 或图书馆开通，或用真正的校园网 IP 重试。

### Elsevier API 结论（2026-10-08 定案）

官方 `api.elsevier.com` 全文接口拿不到内容，**不是网络问题，是缺机构令牌**。四方对照：

| 出口 | 凭证 | `content/article` 返回 |
|---|---|---|
| 香港出口 | 带 key | 403 `AUTHENTICATION_ERROR` |
| 香港出口 | 不带 key | 403，同一错误 |
| 校园网 IP | 不带 key | 200，但只有 `coredata`（元数据） |
| 校园网 IP | 带 key | 无权限 |

- `content/abstract` 和 `content/search/sciencedirect` 两个接口正常（200），说明 key 本身有效；
- 全文接口无论换 IP、换设备、带不带 key 都拿不到 `<originalText>` 或 PDF；
- 结论：个人自助注册的 key 永远拿不到全文，必须由图书馆向 Elsevier 申请 **insttoken**
  （机构令牌）配到 `state\elsevier_insttoken.txt` 才可能通。换出口节点、做安卓 APK 都无效。
- 判断脚本：`node scripts\elscheck.mjs`（或双击 `检查-ElsevierAPI.cmd`），换网络后先跑它。
- **当前已知权限缺口**：`10.1002/admt`（Advanced Materials Technologies）大多没有机构全文权限。
  `list2` 中 182 篇 admt 最终只有 15 篇存在 PDF，167 篇仍为 `no_access`。
  其他 Advanced 子刊的批量 403 多数是临时出口限流，经过冷却或重新登录后可以恢复。


## 脱敏副本说明

此副本不包含 Git 历史、state、浏览器 profile、cookie、密钥或输出文件。
机构与账号配置使用通用占位符；运行前先配置 WebVPN。
安装依赖：`npm install`、`python -m pip install -r requirements.txt`。
