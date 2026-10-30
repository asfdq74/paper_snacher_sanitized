# 交接文档（2026-10-30）

> 新会话先读这份。项目路径 `<PROJECT_ROOT>`，Windows，PowerShell，用户中文交流。

---

## 0. 当前运行状态

- `exec_command` 已恢复正常。
- 项目代码在 `<PROJECT_ROOT>`。
- 默认论文下载根目录为 `<PROJECT_ROOT>\downloads`；相对 `--outdir/--dir` 也解析到这里。
- `entry.ps1` 已恢复，顶层菜单和进度入口重新可用。
- 所有 `.cmd` 启动器保持纯 ASCII。
- 当前没有运行中的下载器或 watchdog。
- 当前 PDF 成品目录可能被用户搬到外部位置；脚本只根据目录中的实际文件判断断点。

### 当前代码状态

- `scripts/lib.mjs` 提供统一的 `DOWNLOAD_ROOT` 和 `resolveDownloadPath()`。
- `scripts/wiley.mjs` 遇到非 paywall 的 HTTP 403 时，会清理 Wiley profile/cookie、自动重登 WebVPN、重启浏览器并重试；默认最多 2 次。
- `scripts/scidir.mjs` 已有风控页清理和 CARSI/WebVPN 登录流程。
- `scripts/webvpn-auth.mjs` 默认拦截低置信度缺口识别，低质量结果只刷新验证码，不执行拖动。
- 在线验证码样本可用 `node scripts\collect_webvpn_captcha_samples.mjs --max 5` 采集，样本只含图片和指标，不提交登录。
- `scripts/watchdog.mjs` 不会把普通 `paywall` 计入连续故障。
- `scripts/verify.py` 支持 Unicode 归一化和紧凑 DOI 匹配。

### 当前数据

- 源表：`data\inputs\10月论文采集-6.xlsx`
- 当前更新清单：`data\manifests\list2_update_papers.json`
- 当前六期刊清单：`data\manifests\list2_skip_admt_papers.json`
- 当前 `admt` 清单：`data\manifests\list2_admt_papers.json`
- 清单生成：`scripts\filter_owner.py`

### 表结构

首个工作表列位置固定：

| 列 | 含义 |
|---|---|
| 0 | id |
| 1 | owner |
| 2 | url（doi.org 链接） |
| 3 | status |
| 5 | title |
| 6 | authors |
| 7 | submitted |
| 8 | domain |

Excel 的 `styles.xml` 可能包含空 `<fill/>`，`filter_owner.py` 会在内存中修复。

---

## 2. 项目目标

> 以下章节保留历史踩坑记录。涉及下载目录、入口和 403 行为时，以本文件第 0 节和 `README.md` 为准。

按 `{id}.pdf` 批量下载论文。支持的来源：

- **ScienceDirect**（Elsevier）—— 主力，已下载约 1030 篇
- **Wiley**（含 Advanced 系列）—— 已下 1779 篇（后被用户搬走/清空）
- **MDPI** —— 早期批次，清单 `data/newlist21_papers.json` 已被用户删除

---

## 3. 目录与关键文件

```
<PROJECT_ROOT>\
├─ 开始.cmd                     ← 总菜单（推荐入口）
├─ entry.ps1                    ← 任务分发器（497 行，重构后）
├─ entry.ps1.bak                ← 重构前备份（423 行，可删）
├─ 开始下载-SciDir.cmd          ← SciDir / WebVPN（有屏 800×600）
├─ 开始下载-SciDir-CARSI.cmd    ← SciDir / CARSI 直连
├─ 开始下载-SciDir-官方API.cmd  ← Elsevier 官方 API
├─ 开始下载-Wiley.cmd           ← Wiley 第一批
├─ 开始下载-Wiley-Advanced.cmd  ← Wiley 第二批（list2）
├─ 开始下载-MDPI.cmd
├─ 检查-ElsevierAPI.cmd         ← 3 秒判断 API 通不通
├─ 查看进度.cmd                 ← 进度/ETA
├─ 看门狗.cmd                   ← 选 1/2/3 监控对应批次
├─ webvpn-captcha.cmd           ← 用户自己写的滑块验证实验（我不参与）
├─ README.md                    ← 历史踩坑记录
├─ scripts\
│  ├─ lib.mjs                   ← 共用库：CDP、cookie、WebVPN URL 改写、指纹池
│  ├─ scidir.mjs                ← ScienceDirect（login / download / api / close）
│  ├─ wiley.mjs                 ← Wiley（login / check / download / close）
│  ├─ mdpi.mjs                  ← MDPI
│  ├─ watchdog.mjs              ← 看门狗（webvpn / carsi / wiley 三种 mode）
│  ├─ progress.mjs              ← 进度与 ETA
│  ├─ elscheck.mjs              ← Elsevier API 连通性检查
│  ├─ verify.py                 ← PDF 首页 DOI 校验
│  ├─ build_list.py             ← id 清单 + xlsx → JSON（含 xlsx sanitize）
│  └─ resolve_pii.mjs           ← DOI → ScienceDirect PII
├─ data\
│  ├─ inputs\                   ← 原始 Excel
│  ├─ manifests\                ← id/DOI 下载清单
│  │  └─ archive\               ← 历史派生清单
│  └─ reports\                  ← 快照与分析报告
├─ state\                       ← 运行时状态（cookie / 日志 / 校验报告）
├─ downloads_scidir\            ← SciDir 成果（约 1030 篇 / 8 GB）
└─ .browser_profile_*\          ← 浏览器 profile（登录态，勿删）
```

---

## 4. 当前数据状态（需复核）

| 项目 | 状态 |
|---|---|
| `downloads_scidir` | 约 **1030 篇 / 8.0 GB**，10-17 校验 **1030/1030 首页 DOI 命中**，0 损坏，0 重复 |
| `downloads_wiley2` | **0 篇**（原 1779 篇，被用户搬走，10-08 22:46 清空） |
| `downloads_wiley` | 0 篇（原 1525 篇，已搬走） |
| `downloads_mdpi` | 0 篇 |
| `state/noaccess_newlist3_sd.txt` | 3 个 id：`291676, 291810, 292183` |

复核命令：

```powershell
node scripts\progress.mjs
```

---

## 5. 已确认「拿不到」的清单

### SciDir（3 篇，学校未订阅 `10.1016/j.xphs`）

```
291676  10.1016/j.xphs.2024.07.003
291810  10.1016/j.xphs.2024.09.004
292183  10.1016/j.xphs.2025.01.008
```

已写入 `state/noaccess_newlist3_sd.txt`，脚本启动时自动跳过。

### Wiley Advanced（47 篇，学校未订阅 `10.1002/admt`）

`state/verify_wiley2.csv` 里有完整报告；`未下载id-wiley2.txt` 是清单。全在 Advanced Materials Technologies 这本刊。其余六本刊（adfm/advs/adma/aenm/adsc/admi）100% 下载成功。

### Wiley 第一批（67 篇，Small Methods `10.1002/smtd` 未订阅）

---

## 6. 各脚本用法速查

```powershell
# 总菜单
开始.cmd

# 直接指定任务
powershell -NoProfile -ExecutionPolicy Bypass -File entry.ps1 -Task scidir-webvpn

# 常用透传参数
entry.ps1 -Task scidir-webvpn -Max 5 -Only 292965,292966 -RetryNoAccess -DryRun
entry.ps1 -Task progress -Watch

# 校验
python scripts\verify.py --list data\manifests\newlist3_sd.json --dir <PROJECT_ROOT>\downloads\downloads_scidir --report state\verify_scidir.csv

# 生成清单
python scripts\build_list.py --ids list.txt --all --out data\manifests\newlist3_papers.json
node scripts\resolve_pii.mjs --src data\manifests\newlist3_papers.json --out data\manifests\newlist3_sd.json

# 关闭所有本项目浏览器
node scripts\scidir.mjs close
```

### entry.ps1 的任务表

批次任务集中在 `$BatchTasks` 哈希表里（`mdpi` / `scidir-webvpn` / `scidir-carsi` / `wiley` / `wiley-advanced`），加新批次 = 加一条表项。

退出码约定：`0` 正常；`10` 需要重新登录（入口会自动弹登录窗口，最多 3 次）。

---

## 7. 踩过的坑（新会话必须知道）

### 编码

1. **`.cmd` 必须纯 ASCII**。cmd.exe 按 GBK 解析批处理，UTF-8 中文字节会掉出 `&`、`|`，把一行切成碎片执行，症状是 `'tle' is not recognized`。中文只能出现在文件名上。
2. **`.ps1` 也建议纯 ASCII**（PS 5.1 无 BOM 时按 ANSI 读）。

自检：

```powershell
Get-ChildItem <PROJECT_ROOT>\*.cmd | ForEach-Object {
  $n = ([System.IO.File]::ReadAllBytes($_.FullName) | Where-Object { $_ -gt 127 }).Count
  "{0,-32} {1}" -f $_.Name, $(if ($n) { "X 含 $n 个非 ASCII" } else { "OK" })
}
```

### 进程互杀

3. `lib.mjs` 的 `closeOurBrowsers()` 按 `paper_snacher` 匹配，会杀掉**项目里所有批次**的浏览器。除 `close` 子命令外，一律用 `closeProfiles([...])` 按 profile 限定。

### 会话

4. **CARSI 会话绑定出口 IP**。登录用家庭宽带、下载走 Tailscale 出口 → Elsevier 判定换 IP，整段权限被撤销。
5. **CARSI 的 `_shibsession_elsevier` 是浏览器级会话 cookie**，关浏览器就没了。`--direct` 模式下登录窗口保持打开，下载复用同一 profile。
6. **WebVPN 无法用 node 重放**。它靠前端 JS 动态注入 cookie（`/wengine-vpn/cookie?method=set&...`），只有 cookie 文件不够，必须走浏览器。

### 风控

7. **Elsevier 的封禁是按 IP 的**。封禁页会印 `IP Address: 203.0.113.10`。重新登录换不了 IP，所以**自动登录不能解封**——只能等（约 30~50 分钟）或换通道（WebVPN ↔ CARSI 直出）。
8. **看门狗「清理 + 立刻重启」会把封禁一直续着**。实测刷了 34 轮，封禁从 18:09 拖到 20:15。
9. `no_access` = **没订阅**（页面写 `Example University does not subscribe to this content`），不是会话失效。早期误判成会话失效导致反复弹登录。
10. `md5 not found` = 页面还没渲染出内嵌 JSON（WebVPN 慢），重试 4 次（3/6/9 秒）能救回大部分；同刊其他文章成功、个别失败的情况基本是这个原因。

### 站点特性

11. **`Download full issue` 在 WebVPN 下无效**。机制是 `GET /journal/issue/pdf-token?pii=[...]` + `POST /sdfe/pdf/download`（body: `token=...&pii=P1&pii=P2...`），但第二步返回 **204 No Content**，浏览器存下 0 字节文件。逐篇下载是唯一可行路径。
12. **Wiley TDM API 用不了**：个人自助 key 拿不到全文，需要图书馆申请 **insttoken**（`state/elsevier_insttoken.txt` 同理）。
13. **Wiley 网页路线**（WebVPN + `/doi/pdfdirect/{doi}`）可用，走浏览器 `ctx.request`。

### 其他

15. xlsx 的 `xl/styles.xml` 有空 `<fill/>` 节点，openpyxl 会报 `Fill() takes no arguments`，必须先替换成 `<fill><patternFill patternType="none"/></fill>`。

---

## 8. 校验方法

`scripts/verify.py` 的逻辑：抽取 PDF 第一页文本 → 归一化 → 匹配清单里的 DOI；匹配不到再匹配标题前 60 字。

**已知假阳性**：PDF 里用 Unicode 连字符（如 `ﬃ` U+FB03）时 ASCII 归一化会拆坏，需要 `unicodedata.normalize('NFKD', ...)` 再处理。Wiley 批次 1 的 `291238` 就是这种情况。

另建议跑 SHA256 查重（`Get-FileHash`），确认真实内容无重复。

---

## 9. 建议的下一步

1. 确认 `exec_command` 恢复
2. 读 `data\inputs\10月论文采集-6.xlsx`，打印 sheet 名、表头、`owner` 列取值分布
3. 筛 `owner_04`，导出 id 清单
4. 看 domain 分布，选下载器
5. 小批量（`-Max 3`）验证后全量跑
6. 跑完用 `verify.py` + SHA256 校验

---

## 10. 清理记录

已删除（用户确认）：探测用浏览器 profile ×11（3.5 GB）、`.scratch`、`android\` APK 工程、`.local_wiley`、失败样本截图（41 MB）、`relaunch`、`PaperSnacher.apk*`。

保留：4 个 `.browser_profile_*`（636 MB，含 WebVPN/CARSI/Wiley 登录态，可删但需重新登录）。

`entry.ps1.bak` 是重构前备份，确认无问题后可删。
