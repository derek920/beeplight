# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Beeplight（原名 Tasklight，更早叫 Claude Monitor）：本机所有 Claude Code 会话的状态监控，准备作为开源软件发布（Apache-2.0）。一个零依赖的 Node 服务（`src/`），每 333ms 轮询本机所有 Claude Code 会话，判定 Doing / Waiting / Done(成功|失败)，通过 SSE 推送。有两个开源客户端，读同一个 `/api/stream`：`public/` 里的原生 JS 网页看板，和 `desktop/` 里的 SwiftUI Mac 应用。另有一个不开源、在 App Store 收费的 iPhone 应用，在单独的私有仓库里，经局域网读同一个 `/api/stream`。面向用户的说明见 `README.md`。

## 常用命令

```sh
npm start                                   # http://localhost:7333，日志打到 stdout
npm test                                    # node --test，测试在 test/
node --test --test-name-pattern="verdict" test/status.test.js   # 跑单个测试
curl -s localhost:7333/api/state | python3 -m json.tool         # 看当前快照 + tick 频率 + 总结器状态
npm run service:status                      # LaunchAgent 模式（scripts/launchd.sh），日志在 data/server.log
curl -s localhost:7333/api/config | python3 -m json.tool        # 全部运行参数：当前值、默认值、来源
npm run app                                 # 构建 desktop/build/Beeplight.app（swiftc，只需 Command Line Tools）
npm run app:dist                            # 通用版（Apple 芯片 + Intel），打包成 desktop/build/Beeplight-<version>.dmg 用来分享
arch -x86_64 desktop/build/Beeplight.app/Contents/MacOS/Beeplight --snapshot /tmp/snap   # 在 Apple 芯片上用 Rosetta 验证 Intel 版
desktop/build/Beeplight.app/Contents/MacOS/Beeplight --snapshot /tmp/snap   # 把看板、菜单栏面板、菜单栏徽章渲染成 PNG 后退出
```

需要 Node ≥ 20.11（用到 `import.meta.dirname`）。改完前端直接刷新页面即可（静态文件 no-store）；改后端要重启服务（或 `npm run service:restart`）。

**Mac 应用会把 `src/` 和 `public/` 复制进 app 包**，所以改了服务端代码，要重新 `npm run app`，再退出并重开 app，它才会用上新代码。app 退出时会停掉自己启动的 Node 进程。但如果 7333 端口上已经有服务在跑（开发时的 `npm start`），app 会直接复用它，这时 app 内置的那份代码不生效。截图不能用 `screencapture`，因为终端没有屏幕录制权限，只能截到壁纸；用上面的 `--snapshot`。

## 开发约束

改代码前先读这一节。这里每一条都是约束，不是建议；确实要打破某一条时，先改这里并写明原因。安全约束和多语言约定在文末各自的章节。

### 架构

- 判断只在服务端做。Node 服务（`src/`）负责采集、判定状态、总结和统计用量；网页、Mac 应用、iPhone 应用都读同一个 `/api/stream`，只负责展示，不自己重新判定状态。
- 只读，不侵入。只读 agent 写下的文件和进程表：不装 hook，不改 agent 的配置，不往 `~/.claude`、`~/.codex` 里写东西。Codex 的 SQLite 也不打开（WAL 模式的读者也会写 `-shm`），锁文件只 stat 不加锁，不连它的 app-server。
- 各 agent 的内部格式都是逆向得来的，随时会变，只在各自的 `src/sources/<agent>/` 里解析，其他地方只用解析后的统一结果（`src/sources/common/analysis.js` 的对话分析、registry 形状的实时信号）。某个 agent 升级后的适配只改它自己的目录。
- 同一条规则只写在一处：状态判定只在 `deriveStatus()`；请求的安全检查只在 `src/transports/http.js`；Mac 和 iOS 画形象只用 `Figure.draw()`。
- 离开这台 Mac 的数据只有两类（局域网和蓝牙上给配对手机的看板不算「离开」，它们和本机网页看到的一样，只给持有配对码的设备）：一是总结时发出的对话摘录（默认经用户自己的 `claude` 登录发给 Anthropic；没装 claude 或 `summarizer.engine` 设为 `codex` 时，经用户自己的 `codex` 登录发给 OpenAI；`summarizer.titles` 设为 `original` 时不发），二是跨设备同步时经 `shareView()` 白名单裁剪并加密的任务摘要。新增任何对外发送，都要先在 README 的隐私说明里写清楚。
- 开源边界：本仓库按 Apache-2.0 开源。收费功能（iOS 上的抽卡形象）的逻辑和美术素材不进本仓库，本仓库只放格式定义和接口。
- 零依赖：Node 服务和 `relay/server.js` 不引入 npm 包；Mac 应用只用系统框架。

### 分层

`src/` 按层分目录。每层只能 import 自己这一层，以及右栏列出的层；`test/architecture.test.js` 会检查每一条 import。

| 目录 | 内容 | 可以 import |
|---|---|---|
| `lib/` | `util.js`、`i18n.js` | 无 |
| `config/` | 运行参数（`index.js`、`schema.js`）和路径 | lib |
| `sources/claude-code/` | Claude Code 写的文件：registry、transcript、subagents、jobs、usage；`index.js` 的 `ClaudeCodeSource` 把它们包成一个 agent 数据源。全是逆向得来的格式，Claude Code 升级后先查这里 | lib、config |
| `sources/codex/` | Codex（ChatGPT app 里的和 `codex` 命令行）写在 `~/.codex` 的文件：rollout（`rollout.js`）、线程锁、任务名、daemon pid；`index.js` 的 `CodexSource`。逆向自 0.166，Codex 升级后先查这里 | lib、config |
| `sources/common/` | 各 agent 数据源共用：对话分析的统一形状（`analysis.js`）、JSONL 增量读取（`jsonl-tail.js`） | lib、config |
| `sources/system/` | 进程表、各进程和整机的 CPU 时间（`proc.js`） | lib、config |
| `services/` | 模型调用：`claude -p`（`claude-cli.js`）、没有 Claude 时的 `codex exec`（`codex-cli.js`）；总结、额度 | lib、config |
| `core/` | collector、status、timeline、store、cpu | lib、config、sources、services |
| `actions/` | 在 Mac 上动手：跳转窗口（`focus.js`）、检测看过的标签页（`seen.js`） | lib、config |
| `transports/` | 对外：`http.js`（统一的请求检查）、`api.js`（全部接口）、`web.js`（页面外壳）、`stream.js`（SSE）、`lan.js`、`relay.js` | lib、config |

- `src/server.js` 是入口，也是唯一知道所有模块的地方，所有模块都在这里创建和接线。actions 和 transports 需要的 core 对象由它作为参数传入，它们不直接 import core。
- 任何模块都不能 import `server.js`。
- 新加一层或一个目录时，先想清楚它建立在哪些层之上，然后同时更新测试里的 `ALLOWED`、`server.js` 顶部的分层说明和这张表。
- transports 里不写业务逻辑。路由只取出参数，然后调用模块的方法。

### 模块化

- 一个文件只做一件事，放在它所属层的目录里。文件开头用一两句注释说明它负责什么，必要时说明为什么这样做。
- 依赖从构造参数传入（`store`、`runner`、`config` 等），不在模块内部创建别的模块。全局单例只有 `config` 和 i18n 的当前语言；接收 `config` 的类默认用单例，测试时可以换掉。
- 不直接改别的模块的内部字段，一律通过方法。例如从看板移除任务调用 `collector.dismiss()`，而不是在路由里改 `collector.sig`。
- 新增接口：在 `src/transports/api.js` 里声明路由和它的 `access`，并在 `test/http.test.js` 里补测试。
- 新增视图字段（`buildView()`）：客户端模型里写成可选，iPhone 应用才能继续解码。新字段默认不同步到其他设备，要同步就加进 `shareView()` 白名单。
- 和 iPhone 应用共用的文件有使用限制，见文末「和 iPhone 应用共用的文件」。
- 改动要配套测试：状态规则对应 `test/status.test.js`，接口对应 `test/http.test.js`，参数对应 `test/config.test.js`，分层由 `test/architecture.test.js` 自动检查。`npm test` 全部通过才能提交。

### 性能

目标：Mac 应用空闲时 CPU 接近 0，有任务执行时在个位数；服务端常态约 1%，一次 tick 在 1 毫秒左右（看 `/api/state` 的 `meta.tickMs`）。

服务端：

- tick 里只做轻活：不同步读大文件，不启动子进程，不调 LLM。重活异步、分块做，中间让出事件循环（参照 `UsageIndex`）。
- 文件只增量读：记住读到的位置，只读新写入的部分。首次读取和每次读取都有上限（`transcript.initialTailMB`、`transcript.maxReadMB`）。
- 只在变化时推送：state 按签名去重；每秒都在变的数据（今日统计、用量）放在 meta 里，不进 state 签名。SSE 每个事件只序列化一次。
- 外部命令按固定节奏调用，并且只在需要时调用：`ps` 每 2 秒一次，CPU 占用也从这次扫描里算，不另起命令；`osascript` 只在跳转时调用，另外在有未读任务时由 `seen.js` 每 1.5 秒调用一次。
- LLM 调用一律经过 `Summarizer` 的队列，由它负责去重、并发、每小时上限和失败退避；额度探测也有固定间隔，找不到 claude 时不探测。不要在别处直接调 `claude -p` 或 `codex exec`。
- 常驻内存和存盘的数据都要有上限或过期时间：解析结果只保留最近若干条，用量记录和额度样本只保留 8 天，store 里的历史最长保留 `store.keepDays` 天（见「LLM 总结」的持久化）。

Mac 应用：

- `Monitor` 是 `@Observable`，视图只在自己读过的属性变化时重算。所以属性一律变了才赋值（`assign`），变化频率不同的数据分开存，比如 meta 拆成 `hz`、`today`、`summarizer`、`usage`、`limits`。
- 每秒变一次的时钟只在叶子视图里读：用 `Ticking(monitor) { now in … }` 包住，不要在列表或窗口的 body 里读。按分钟显示的倒计时读 `minute`；判断任务是否紧急用 `isUrgent(_:)`，它不读时钟。
- 常驻动画用 `LayerEffects.swift` 里的 Core Animation 图层实现。不要用 `TimelineView(.animation)`、`.symbolEffect`、`repeatForever` 或按时钟切换的 `.animation`：SwiftUI 每一帧都会让整个窗口重新布局，并在 CPU 上重画。
- 阴影由形状投射（`themedCard` 给底板加阴影），不要给整张卡片加 `.shadow`。否则卡片里任何文字一变，就要连同模糊效果整张重画。
- 只有任务增减、换位置或换状态时才加列表动画；只是文字或数字变了，直接更新。
- 创建成本高的对象（`DateFormatter`、渲染好的图片）要缓存。父视图每次重算时，子视图的 `init` 和 `@State` 的初始值都会重新执行，里面不能做耗时操作。
- 菜单栏图标的帧按内容缓存，像素相同的帧共用一张图，图没变就不调用 `setImage`。

网页：

- 列表按任务 id 原地更新（`patchList()`），不整体重建。
- 常驻动画只改 CSS 的 `transform` 和 `opacity`，它们由合成器处理，不触发布局和重绘；`box-shadow`、`background-position` 这类属性每帧都要重绘。要让发光循环变亮变暗，就把阴影画在伪元素上、固定不变，只循环它的 `opacity`（关键帧 `glow-pulse`、`glow-dim`）。元素带 `overflow: hidden` 时，伪元素向外的阴影会被裁掉，只能画在边缘内侧。
- 例外：状态屏标题的文字流光 `amb-shine` 循环改 `background-position`，每帧重绘这一行字。渐变裁剪在文字形状上（`background-clip: text`），换不成 `transform`；它只有一行字，开销小，2026-10-30 决定保留，不要改掉。新加的常驻动画仍然按上一条执行。

验证：

- 性能相关的改动，要在相同条件下测改动前后：开着哪些窗口、几个任务在执行或等待，都要一致。提交说明里写上数字和条件。
- 平均 CPU 用 `top -l 16 -s 1 -pid <pid> -stats pid,cpu` 测（`top` 按单核算；app 自己显示的 CPU 是占整台 Mac 的比例，乘以核数才是 `top` 的数），热点用 `sample <pid> 4 -file <文件>` 找：看主线程里 `CA::Transaction::commit`、`_layoutSubtreeWithOldSize`、`NSStatusItem _updateReplicants` 的占比。窗口是否在屏幕上，用 `CGWindowListCopyWindowInfo` 确认。界面用 `--snapshot` 核对，它能截到图层画的效果。

### 配置化

服务端的运行参数集中在 `src/config/schema.js` 这一张表里，由 `src/config/index.js` 的 `Config` 加载。

- 优先级：默认值 < 数据目录下的 `config.json` < 环境变量。环境变量名是 `BEEPLIGHT_<键名大写下划线>`，旧的变量名作为 `aliases` 保留。
- `config.json` 每 2 秒检查一次修改时间，手改后自动重新加载。JSON 写坏时保留上一次的有效值；未知的键和非法值会被忽略，但在文件里原样保留，并在设置页列出来。
- `GET/POST /api/config` 只对本机开放，POST 是全有或全无。Mac 的「高级」设置页（`AdvancedSettings.swift`）完全按接口返回的描述生成。
- 参数组可以带操作按钮（schema 里 `GROUPS` 的 `actions`，例如「数据」组的「立即清理」）：按钮向一个只限本机的接口发 POST，再显示它返回的 `message`。页面同样按描述生成，加按钮不用改 Swift。

约束：

- 会影响行为、成本或性能、用户可能想调的数值，都放进 schema。模块里不新写这类魔法数字，也不直接读 `process.env`；数据目录、Claude 配置目录、语言这类路径和环境信息，只在 `src/config/index.js` 里读。
- schema 里一个参数一行：键名带单位后缀（`…Ms`、`…Sec`、`…Minutes`、`…Hours`、`…MB`），写明类型、默认值、范围（数字用 `min`/`max`，文本用 `pattern` 或 `maxLength`）、标签和说明，再到 `src/lib/i18n.js` 补上标签和说明的中文。Mac 端不用改。
- 用到的时候才调用 `config.get(key)`，不要在模块加载时把值存成常量，否则改了不会生效。定时器用 `config.every(key, 倍数, fn)`，间隔一改就自动重新计时。
- `restart: true` 只给确实无法热更新的参数（目前只有端口）。
- 校验只在 schema 里做一处：客户端把输入原样提交，由服务端校验并返回错误。
- 类型有 `int`、`number`、`string` 和 `choice`。`choice` 只能取 `choices` 里列出的值，每个选项带标签（同样要在 i18n 里补中文）；「高级」页把它画成分段选择器，其他类型画成文本框。
- 不放进配置的：别的程序依赖的约定（meta 每秒推一次，是 Mac 端判断连接是否断开的心跳；同步相关的时间要在所有设备上一致），以及解析细节。
- 测试里用 `new Config({ file: null, env: {} })`，不读本机的配置文件和环境变量。
- 客户端自己的偏好（外观、通知开关、语言）不属于服务端配置：Mac 存在 UserDefaults，网页存在 localStorage。UserDefaults 的解码要手写容错，缺少的字段用默认值（见「外观」）。

### 插件化（主题和形象）

格式规范见 `docs/packs.md`。内置包是 `public/` 下的 `themes.json`、`presets.json`、`characters.json`，共享解码在 `desktop/Sources/Packs.swift`，Mac 端的主题注册表和颜色映射在 `Themes.swift`。

已经实现：包格式、内置主题和预设都是包（目前各 8 个，其中莓果奶霜、玫瑰暮色、奶糖的配色来自 Catppuccin 和 Rosé Pine，出处写在主题的 `credit` 里）、Mac 应用和网页都从包里读主题和预设、形象走同一个宽松解码器、付费相关的字段和接口。还没做：下载签名包（只有 iPhone 应用会用到）。

网页的主题：服务端把 `themes.json`、`presets.json` 内嵌进首页（`<script id="packs">`，`src/transports/web.js`），所以首屏就是对的颜色。网页的主题菜单列的是预设，选择存在浏览器里（`prefs.skin`，存的是预设 id）。`app.js` 的 `applyPreset()` 把主题里的 `#RRGGBB` 颜色、`corner`、`scheme` 和 `web` 里的网页专用颜色写成 `:root` 上的 CSS 变量；系统色（`system:…`、`primary`）在 CSS 里没有对应，这些位置沿用页面自己的浅色、深色默认值，所以原生主题在网页上什么都不覆盖。装饰按特性生效，不按主题名：`data-font`、`data-glow`（`glow` ≥ 8 为 `strong`，和 Mac 画色块的门槛一致）、`data-effects`、`data-motion`（预设 `motion: off` 时停掉所有动画）。新加一种装饰：在 `ThemePack.knownEffects` 里登记，再在 `style.css` 里写 `:root[data-effects~='…']` 规则。

- 插件是只含数据的包（JSON 加图片或 SVG），不含可执行代码。原因：iOS 不允许下载并执行代码；Beeplight 能控制终端，加载外部代码风险太大；纯数据的包，Mac、网页、iPhone 三端可以共用同一份。
- 只有官方包。不提供让用户或第三方安装包的目录；app 包以外来源的包，必须带官方签名。
- 包分四类：agent 标记（`agents.json`，每个 agent 一个，画在任务标题前；是原创图形，不用各家官方 logo，那是商标）、主题（色板、发光、圆角、字体风格、深浅外观、`effects` 里的扫描线、网格、角标等装饰）、预设（主题、菜单栏样式、灵动岛、动效的组合）、形象（`characters.json` 里的条目）。动效属于预设，不属于主题。
- 加主题、预设或形象只改包文件，不改代码，改完跑 `npm test`：`test/packs.test.js` 会按 app 的解码规则检查内置包，允许的取值（菜单栏样式、系统色名、字体、效果等）直接从 Swift 源码里读，两边不会对不上。
- 菜单栏样式和灵动岛布局是绘制代码，不做成数据，包只能选用它们并调参数。
- 包格式带版本号（`format`），只有旧 app 读不懂的改动才升版本。解码要容错：不认识的字段忽略，新字段一律可选，条目逐个解码，坏一条只跳过这一条。选中的主题或形象不存在时，只让那一项回退到默认（`native`、机器人眼睛），不能重置整套外观设置（`Appearance` 启动时修正）。
- 包的数据结构和解码写在只依赖 SwiftUI 的共享文件里（`Packs.swift`），供 iPhone 应用编译；把包里的颜色变成平台颜色由各端自己做。
- 收费的抽卡形象只放在 iOS 应用里（2026-10-30 定）。本仓库不放付费逻辑和付费素材，只提供：条目上的 `requires`（解锁所需的权益）、`rarity`（稀有度）、`series`（系列）字段，权益接口 `EntitlementProvider`，以及抽卡池格式 `PoolPack`。开源版用 `NoPurchases`：带 `requires` 的条目一律不提供，内置条目全部免费（测试会检查内置条目没有 `requires`）。
- 付费包用 Ed25519 签名，app 内置公钥验签，信封格式见 `docs/packs.md`。签名只能证明包来自官方；开源的 app 被人改代码就能绕过解锁，这一点是接受的。
- App Store 审核指南 3.1.1 要求付费随机物品在购买前公示各档概率，所以概率表是包里的数据（`PoolPack.entries[].odds`，加起来等于 1），界面必须能展示出来。

## 架构

目录分层和各层的依赖规则见「开发约束 → 分层」。

数据流：`Collector.tick()`（`src/core/collector.js`）每 tick 轮询每个 agent 数据源（接口写在 `collector.js` 开头的注释里，`server.js` 创建后传入；目前只有 `ClaudeCodeSource`）→ `deriveStatus()`（`src/core/status.js`）判定状态 → 必要时让 `Summarizer` 排队调 LLM → 拼出视图，签名有变化才 `emit('update')` → `EventStream`（`src/transports/stream.js`）用 SSE 推送，每个事件只序列化一次。

数据源都是 Claude Code 的内部文件（基于 2.1.312 逆向观察，升级后最先坏的就是这里）：

- **`~/.claude/sessions/<pid>.json`**（`src/sources/claude-code/registry.js`）：每个运行中的 Claude 进程都会写。`status` 为 `busy | idle | waiting`，`waitingFor` 为 `permission prompt | input needed | dialog open | goal proposal | sandbox request | worker request`。这是 Doing/Waiting 的主信号，所以不需要往用户的 settings.json 装 hook。进程正常退出时文件会被删；崩溃时会残留，所以 `isGenuine()` 用 `ps` 的启动时间和 `startedAt` 比对，排除 PID 复用。
- **`~/.claude/projects/<slug>/<sessionId>.jsonl`**（`src/sources/claude-code/transcript.js`）：增量 tail 读取。首次只读最后 4MB（有的文件超过 100MB），按字节切行，避免截断多字节字符。只有 `origin.kind === 'human'`（或没有 origin 的老格式）的 user 消息算一轮新请求；task-notification、isMeta、peer 消息都不算。`system/turn_duration` 标记一轮结束，`isApiErrorMessage` 是 API 失败，`[Request interrupted by user` 是中断。**transcript 有 3～4 秒写入缓冲**，正在执行的 tool_use 要过几秒才出现。
- **`<project>/<sessionId>/subagents/agent-*.jsonl` + `.meta.json`**（`src/sources/claude-code/subagents.js`）：子 agent。
- **`~/.claude/jobs/<short>/state.json`**（`src/sources/claude-code/jobs.js`）：`claude --bg` 后台会话，daemon 自己维护 `state = working|blocked|done|failed`。

- **Codex（`~/.codex`，`src/sources/codex/`，基于 0.166 逆向）**：任务 id 是 `codex:<threadId>`（threadId 是 UUIDv7，前 48 位是创建时间，由此算出 rollout 所在的日期目录）。
  - `sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`：追加写的记录，`rollout.js` 解析成统一的对话分析。用户请求只认 `item_completed/UserMessage`（`response_item` 里 role=user 的有注入的上下文）；`task_started`/`task_complete` 是一轮的起止，`turn_aborted`（`reason: interrupted`）是中断；子 agent 发起的轮次（`parent_turn_id`）跳过。大行按行首前缀跳过不解析；首次只读尾部时另读开头一行拿 `session_meta`（cwd、`originator`：`Codex Desktop` 或 `codex-tui`）。
  - `thread-writer-locks/<threadId>.lock`：被 app 或命令行打开着的任务才有锁，只 stat 不加锁。桌面端任务由 ChatGPT.app 的 `codex app-server` 托管（`sharedHost`，app 活着就算打开着）；命令行任务经共享 daemon（`app-server-daemon/daemon.pid`，按 ps 启动时间核对）写，锁连续 2 次扫描不在才算结束，tty 上的 `codex` 进程按启动时间和锁的创建时间配对（只有唯一候选才配）。
  - **等你批准不落盘**，只能推断：本轮未结束、最后一个要求跳出沙箱的调用（`sandbox_permissions: require_escalated` 或 `request_permissions`）还没有输出、当前 `approval_policy` 会问人 → `waiting`。调用的输出要等用户回答后才写；别用"宿主下有没有新起的 shell"判断，Codex 在问人之前就会起 shell（实测），`needs` 是调用里的 `justification`。
  - 开关是 `codex.monitor`（on / off）：关掉后 `CodexSource` 不读 `~/.codex`、丢掉跟踪的线程，collector 看到 `enabled()` 为假就把它的任务直接从看板拿掉（不变成「已关闭」）。以后别的 agent 也用 `<agent>.monitor` 加 `enabled()` 这一套。
  - `session_index.jsonl` 是 Codex 自己的任务名，作标题候选。跳转：桌面端打开 `codex://threads/<id>`；命令行活着跳 tty，结束了新标签里 `codex resume <id>`。

总结开关和引擎是两个参数：`summarizer.titles`（`ai` / `original`）决定要不要 AI 总结；`summarizer.engine`（`auto` / `claude` / `codex`）决定由谁写，`auto` 装了 claude 就用 Haiku，没有就用 `codex exec --ephemeral`（不落盘，不会出现在用户的 Codex 任务里）。原文标题、或选中的引擎没装时，`deriveStatus()` 收到 `verdicts: false`，一轮正常结束直接算成功，不挂"正在核对结果"。

接入新 agent：在 `src/sources/<agent>/` 写一个实现 `collector.js` 开头那套接口的类（带 `<agent>.monitor` 开关和 `enabled()`）（id 用 `<agent>:` 前缀，解析成统一的对话分析和 registry 形状的实时信号）→ `server.js` 里加进 `sources` → 跳转需要新的 URL 或命令时加进 `focus.js` 的 `URLS`/`CLIS` → 用合成的 fixture 写测试（不放真实对话）→ README 的隐私说明写清楚读哪些文件 → 在 `public/agents.json` 加它的标记（测试会检查每个数据源都有）。

三态规则只在 `deriveStatus()` 一处定义，优先级：registry 的 waiting/busy → 不在线的后台 job 用 daemon 判定 → 硬失败信号（中途退出、API 错误、中断）→ 本轮结束时的 LLM 判定（`blocked` 映射成 Waiting，`working` 映射成 Doing）→ 还没判定时临时显示为成功，并带 `pending`。改规则时同步改 `test/status.test.js`。

运行参数见「开发约束 → 配置化」。

LLM 总结（`src/services/summarizer.js`）：

- 为什么需要：transcript 里的 `ai-title` 只在会话开头生成一次。用户要的是「当前核心任务」的标题，以及成功/失败的判定。
- 调用方式：`claude -p --model haiku --tools "" --setting-sources "" --no-session-persistence --json-schema …`，cwd 是空目录 `data/llm-cwd`。不能用 `--bare`，因为它不读 OAuth。子进程也会在 registry 里注册（`entrypoint: sdk-cli`），靠 `ownPids` 过滤掉。
- 去重键：`endKey(a) = <本轮首条 prompt uuid>@<最新时间线时间戳>`。Claude 在同一轮里恢复工作后（例如收到后台任务通知）键会变，旧判定随之失效；会话关闭后则沿用这一轮最后一次判定。
- 失败处理：连续失败全局指数退避（30 秒到 10 分钟），失败记录带 `retryAfter`，到点由 Collector 重新请求。
- 关闭总结：参数 `summarizer.titles`（`ai` | `original`）。为 `original` 时 `Collector` 不排队也不 pump 总结器，`summaryOf()` 忽略已存的总结，标题走 `buildView()` 里原有的回退链（自定义名 → 后台任务名 → Claude Code 的 ai-title → registry 名 → 最近一条消息）；`deriveStatus({ verdicts: false })` 让一轮结束直接算成功，不带 `pending`。meta 的 `titles` 告诉客户端隐藏「重新总结」按钮和页脚的总结统计。额度探测不受影响。
- 持久化：结果存在 `data/state.json`（`src/core/store.js`），同时保存已结束会话的视图。重启后 `restoreEnded()` 会把这些会话重新挂上 transcript，而不是展示冻结的快照。
- 保留期限：标题和判定、状态轨迹、移除记录最长保留 `store.keepDays` 天（默认 30，上限也是 30）；只在看板上用的已结束视图和未读标记按 `collector.retainHours`，同样不超过这个上限；设置项（flags）不清理。启动时、每小时、改了这两个参数时，以及「高级」页点「立即清理」（`POST /api/store/prune`，只限本机）时都会清理，最后一种会马上写盘并返回文件大小。

Token 用量与额度：

- `src/sources/claude-code/usage.js` `UsageIndex`：每 5 秒增量扫描所有 transcript，包括 `<session>/subagents/*.jsonl`，子 agent 的用量算到父会话。首次只读最近 8 天改动过的文件，约 600MB，按块读取，中间让出事件循环。同一个 API 响应会按内容块写成多行，每行都带同一份 usage，所以要按 `message.id + requestId` 去重，取各字段最大值。`costOf()` 用 API 价格给 token 加权，只用来估算各会话的额度占比；新模型上线时记得更新 `PRICES`。
- `src/services/limits.js` `Limits`：`claude -p --output-format stream-json --verbose` 每次调用都会输出 `rate_limit_event`，里面的 `unifiedWindows.five_hour / seven_day` 带 `utilization` 和 `resetsAt`。`src/services/claude-cli.js` 是总结器和额度探测共用的运行器，它会把这个事件交给 `Limits.ingest()`。窗口边界用 `resetsAt - 5h/7d`，已过重置时间的读数视为失效。`project()` 用同一窗口内的历史样本估算增长速度。
- 汇总：`Collector.refreshUsageCache()` 算出各会话的窗口用量和账号视图，只在 usage 或 limits 的 version 变化时、或每 10 秒重算一次。账号视图放在 meta 事件里下发，不进 state 签名。
- 额度详情：点额度卡片打开。数据走 `GET /api/usage/detail?window=5h|7d&step=…`，由 `src/core/usage-detail.js` 的 `buildDetail()` 拼出，来源是 `UsageIndex.detail(edges)`（按桶、模型、会话汇总）和 `Limits.history()`（这个窗口里的额度读数）。只在详情打开时请求，每 15 秒刷新一次，不进 SSE。分桶按本地时钟对齐（`edges()`：10 分钟从整点数起，6 小时从零点数起，按天以零点为界），窗口从重置时间开始，所以首尾两桶可能不完整；每个窗口可选的粒度在 `STEPS` 里。Mac 端是 `QuotaDetail.swift` 的独立窗口（Swift Charts），网页端是 `app.js` 里 `renderDetail()` 画的浮层（SVG 拉伸铺满，文字用 HTML 叠在上面，避免被拉变形）。两边内容一致，改一边要同步改另一边。

外观（`desktop/Sources/Appearance.swift`）：`AppearanceConfig` 包含主题、菜单栏样式、灵动岛、动效四项，存在 UserDefaults 的 `appearance` 键里。主题是主题包里的 id（字符串），调色板由 `Themes.palette(id)` 从 `public/themes.json` 生成（`Themes.swift`）；`Preset.all` 读 `public/presets.json`，见「开发约束 → 插件化」。`Theme` 的颜色全部从 `Theme.palette` 计算，动效从 `Theme.motion` 读取，`Appearance` 改动时会更新这两个全局值。根视图（Board、Panel、Island、设置窗口）用 `.id(appearance.revision)` 强制整棵树重建，并用 `.themedRoot()` 应用配色方案、字体设计、文字色和扫描线。设置窗口的「外观」页要用 `.themedPage()`：`themedRoot()` 里的 `preferredColorScheme` 会作用到整个窗口的内容，深色主题下其他标签页会变成浅色背景上的白字，看不见。卡片统一用 `.themedCard()`。新增界面时不要写死系统颜色，一律用 `Theme.*`，否则换了主题会露馅。

- 形象（`Face.swift`；不依赖 AppKit 的 `Energy`、`EyePose`、`Figure`、`SVGPath` 在 `Figure.swift`，iPhone 应用也编译这个文件）：外观设置里选，存为 `AppearanceConfig.character`（`eyes`、`classic` 或简笔形象的 id）。简笔形象是 `public/characters.json` 里的 SVG 路径（只支持 M L H V C Q Z，Mac 端用 `SVGPath.parse` 自己解析），Mac 端从 app 包里的 `server/public/` 读取，网页直接请求，加形象只需要改这个文件。Mac 端连上服务时和切换形象时会 `POST /api/character`，服务端记在 `store.flags.character`，通过 meta 下发给手机状态屏。没有任务时菜单栏、灵动岛显示所选形象，颜色和睁眼程度由 `Energy` 按两个额度窗口里用得更多的那个决定，阈值和额度条颜色一致（50% / 80% / 95%）。`FaceAnimator` 是事件驱动的：静止时只挂一个随机 2～12 秒的定时器，眨眼、张望时才以 30fps 出帧，菜单栏位图还按姿态缓存，所以空闲时几乎不耗电。手机状态屏上，机器人眼睛用纯 CSS 动画（`.amb-eyes`、`data-energy`）；简笔形象在所有状态下都显示，`syncFigure()` 按状态或剩余额度选一组 `MOODS`（睁眼程度、动作频率），只在动作时用 setTimeout 换帧，眼睛的画法和 Mac 端 `Figure.eyePath` 一致。
- 转天线：形象可以带 `spin`（`base` 加一组路径，目前只有机器人的天线），静止时竖直，动作时绕 `base` 像弹簧天线一样甩圈：`EyePose.spin`（朝向，单位是圈）和 `swing`（倾斜程度）经 `Figure.spinTransform` 变成一个斜切矩阵，网页端的 `spinMatrix()`、`whirlAt()` 用同一套公式。空闲时它是随机动作之一，圈数看 `Energy.turns`；手机状态屏和 iOS app 在执行中一直转。网页端的 SVG 每个形象只画一次，转天线时每 33ms 只改 `.s` 组的 `transform`，所以眨眼不会打断转圈。天线在转时不放 `alt` 帧，因为火花是按竖直的天线画的。Mac 和 iOS 都用 `Figure.draw()` 画形象，改画法只改这一处。
- 字符画形象（终端猫、终端狗）：`characters.json` 里用 `text` 代替路径字段，`face` 是一行颜文字（菜单栏、灵动岛、设置页和小组件用），`rest`/`alt` 是完整字符画（每行等宽），`*` 标出眼睛：睁眼画 `eye`，累了 `~`、快睁不开 `_`、眨眼 `-`、笑 `^`，规则在 `Figure.TextArt.eyeGlyph` 和网页的 `eyeGlyph()` 两处，要一起改。Swift 的 `Figure` 手写了解码，路径字段缺省为空，所以字符画和简笔形象能放在同一个数组里；新增字段要在 `init(from:)` 里补上才读得到。文件经 `Packs.load` 逐条解码，某一条解码失败只会让这一条消失。
- 走路（只在网页状态屏）：字符画形象可以带 `walk`（`facing`、`speed`、`step`、`frames`），状态屏用 `data-text` 把能量环换成一条虚线地面，`walk()`/`stepWalker()` 让它在线上走：空闲时按 `MOODS[].walk` 隔几秒溜达到一个点，执行中（`pace`）来回踱步，等你和失败时停下。位置以字符宽度为单位，帧号由走过的距离除以 `step` 算出；反方向走时整段字符画用 `scale` 镜像，转身是 `scale` 从 1 过 0 到 -1。每帧只改 `<pre>` 的 CSS `translate`/`scale`，所以晃动和跳的动画写在 `.amb-figure > *` 的 `transform` 上，两者不冲突。Mac 和 iOS app 里形象不走路，iOS 状态屏在环里显示完整字符画。
- `AppearanceConfig` 的解码在扩展里手写，缺少的字段用默认值。新增外观字段时要在这里补一行，否则旧版本存下的设置会整体解码失败，用户的外观被重置。
- 菜单栏的 6 种样式在 `Glyphs.swift` 的 `MenuBarBadge` 里，用 `ImageRenderer` 渲染成位图。徽章视图显式接收 `Palette` 和 `ink` 参数，所以设置页能用别的主题渲染预览。
- 灵动岛（`Island.swift`）是一块固定大小的透明 `NSPanel`，层级在 mainMenu 之上，透明区域的点击会穿透到下面。刘海尺寸取自 `NSScreen.auxiliaryTopLeftArea/RightArea`。没有刘海时（刘海模式找不到带刘海的屏幕，或悬浮模式）是一个胶囊，可以拖动，位置存在 `islandTop`（胶囊顶边中点，画布改尺寸后位置不变；旧版本存的 `islandOrigin` 是 520 宽画布的左下角，读一次后换成新键）。刘海模式下右翼按计数的位数加宽（`countsWing`，三个数各到 999 也放得下），左翼不变，整体右移一半差值，让中间的空隙仍然对准刘海；画布 760 宽，容得下各种机型和缩放下的刘海。开了「自动隐藏」（`islandAutoHide`）时，没有等你的、也没有新完成的任务就隐藏：胶囊整个不画，这样透明画布让点击穿透；刘海模式收回刘海里，悬停刘海仍然能展开。弹出提示（`flash`）期间不隐藏。岛体内不在 SwiftUI scene 里，打开看板窗口要通过 `WindowOpener`：由一直在渲染的 `MenuBarLabel` 在 onAppear 时注册 `openWindow`。
- 截图：`--snapshot <dir> --preset <id> [--island-open] [--island-click] [--quota-week]` 会把 board、panel、settings、general、devices、advanced、island、phone、quota（额度详情，加 `--quota-week` 时显示本周额度）各渲染成一张图。截图模式下 `Appearance.persist = false`，不会改写用户设置。加 `--island-click` 时会往灵动岛第一行发一次合成点击，服务端日志里出现 `[focus] … from island` 就说明点击生效。改灵动岛的手势或布局后，用它回归测试。
- 灵动岛有两个点击相关的坑。一是 `.gesture(_, including: .none)` 会禁用整个子视图树的手势，按钮也会全部失效，只想关掉自己的手势时要用 `.subviews`。二是面板永远不是激活窗口，所以要用 `FirstMouseHostingView` 接受首次点击。悬停在这两种情况下都照常工作，所以看起来像「能展示但点不了」。
- 灵动岛「收不回去」：SwiftUI 的 `onHover` 偶尔收不到移出事件（从岛上点一行跳走之后出现过），`hovering` 就一直为真。现在有三道保险：从岛上跳转或打开看板后 `collapse()`；全局鼠标监听，点岛以外任何地方都收起（包括固定状态）；悬停展开期间 `watchHover()` 每 0.25 秒核对一次鼠标是否还在岛的范围内（`model.frame` 由 GeometryReader 记下），连续两次不在就收起，并递增 `hoverEpoch` 重建视图，清掉 SwiftUI 残留的悬停状态。

新完成（未读）：`Collector.trackState()` 发现某个会话的轨迹从非 done 变成 `done:*`，并且判定已经出来（不是 `p: true`）时，写入 `store.unread[sid]`。下面几种情况会清除：会话回到 doing/waiting（发了新消息，或者 Claude 自己继续干活）；调用 focus 或 read 接口；`POST /api/read-all`；dismiss；`src/actions/seen.js` 检测到这个会话的终端标签页连续两次是前台。`seen.js` 只有在 `store.flags.appleEventsOk` 为真时才轮询，这个标志在第一次通过 AppleScript 跳转成功时写入，所以轮询永远不会成为触发系统授权弹窗的原因。每次标记和清除都会打 `[unread]` / `[focus]` 日志，带上原因和来源（`via=panel|board|notification|web`）。查「徽章为什么没了 / 为什么清不掉」时先看这里。客户端的未读计数都从可见列表里算，菜单栏、面板、看板、Dock 用的是同一个判定。

桌面端的收尾卡片：Claude 桌面端结束一轮时会调用 `mcp__ccd_turn__wrap_up`，参数是 `recap / ask / actions`。向用户的提问只出现在这里，回复正文里看不到，所以 `transcript.js` 把它记到 `turn.wrapUp`。在 `deriveStatus()` 里，有 `ask` 就直接判 Waiting，不交给 LLM。

CPU 占用（`src/core/cpu.js` `CpuMeter`）：面板和看板底部、网页页脚显示整台 Mac、Claude、Beeplight 三个数，都是占整台 Mac 的比例（0～1），按 `collector.cpuAverageSec`（默认 10 秒）取平均，放在 meta 的 `cpu` 里下发，不进 state 签名，也不同步到其他设备。数据来自 `refreshPs()` 那次 `ps`：多读一列 `time`（进程累计 CPU 时间），两次扫描之差就是这段时间用的；整机用 `os.cpus()` 的累计时间（`machineCpu()`）。Claude 是每个在线会话的进程加上它启动的所有子进程（工具命令、MCP 服务）；Beeplight 是服务自己和它的子进程（Haiku 调用、ps、osascript），再加上 Mac 应用（可执行文件路径是 `…/Beeplight.app/Contents/MacOS/Beeplight` 的进程）。每个进程只算一次，先算 Beeplight，所以开发时从 Claude 会话的终端里 `npm start` 起的服务算 Beeplight。在两次扫描之间结束的进程，最后这段用量会丢掉；浏览器里打开的网页算在浏览器上。

点击跳转（`src/actions/focus.js`）：数据源只规划步骤（`source.focus(target)` 返回 `url` / `host` / `newTab` 组成的列表，`Collector.focusPlan()` 拼上目标），`focus.js` 按顺序执行，能打开的 URL、能运行的命令和对参数的校验都只在它这里。`detectHost()`（`src/sources/system/proc.js`）沿父进程链找最外层的 `.app`。iTerm2/Terminal 用 AppleScript 按 TTY 选中标签页；桌面端用 `claude://code/continue?session=<hostSessionId>`（从 Claude.app 的 URL handler 逆向得到）；后台 job 用 `claude attach`；已关闭的会话用 `claude --resume`。外部命令一律走 `execFile`，拼进 AppleScript 的字符串用 `appleScriptString()` 转义，ID 先过 `util.js` 里的正则校验。

状态轨迹（`src/core/timeline.js`）：`Collector.publish()` 每次构建视图后调用 `Timeline.track()`。只在状态键变化时追加 `{k, t}`，状态键为 `doing | waiting | waiting:q | done:success | done:failed`。判定未出时的临时 Done（`p: true`）会被判定结果原地改写，不新增一段。同时累计今日统计：`waiting:q` 表示一轮以提问结尾，不计入等待时长。轨迹持久化在 `store.histories`；今日统计通过 meta 事件下发，没放进 state 签名，所以不会每个 tick 都触发推送。

Mac 应用（`desktop/`）：

- `Server.swift`：健康检查，端口上没有服务时用内置代码拉起 Node。`build.sh` 打包的是官方 Node.js（版本固定在 `NODE_DIST`），第一次构建时从 nodejs.org 下载、按 SHASUMS256.txt 校验，缓存在 `desktop/build/node`；`--dist` 用 `lipo` 把 arm64 和 x64 合成通用版，平时只打本机架构（`BEEPLIGHT_NODE=` 可以换成指定的 node，`--dist` 不用它；不用 `NODE`，因为 `npm run` 会把它设成运行 npm 的那个 node）。它放在 `Contents/MacOS/node`，许可证放在 `Resources/node-LICENSE`，所以用户不用装 Node；`findNode()` 优先用它。因为 app 跑的不再是 nvm 的 node，`src/config/index.js` 的 `findClaudeBin()` 会自己去 `~/.nvm/versions/node/*/bin` 找 claude。
- `Monitor.swift`：SSE 客户端（`URLSession.bytes.lines` 会丢掉空行，所以收到 `data:` 行就立刻处理）、通知触发、菜单栏徽章。它是 `@Observable`，写法上的约束见「开发约束 → 性能」。有任务执行时，菜单栏徽章每秒换 12 帧。
- `LayerEffects.swift`：常驻动画（转圈、紧急卡片的呼吸发光、等待图标的脉冲）的 Core Animation 实现，由窗口服务器驱动，所有实例对齐到同一个相位。
- `Board.swift` / `Panel.swift`：两套界面。
- 关掉看板不退出 app：菜单栏图标、灵动岛和服务都还在，看起来像「点叉号退不出去」。所以第一次关看板时 `StillRunningNotice`（`App.swift`）弹一次说明，带「退出 Beeplight」按钮，看过的标记存在 UserDefaults 的 `stillRunningNoticeShown`。退出入口有三个：⚙ 菜单、看板打开时的 ⌘Q、右键灵动岛。弹窗用 `Timer` 排到下一轮再 `runModal`，不能放在 `DispatchQueue.main.async` 里：主队列的 block 里跑模态，弹窗开着的这段时间，其他主队列任务（SIGTERM 处理、`@MainActor` 任务）全部卡住。灵动岛的右键菜单由 `FirstMouseHostingView.rightMouseDown` 自己弹出：SwiftUI 的 `.contextMenu` 能用 `menu(for:)` 取到，但发到这块面板上的右键（用合成事件测的）不会把它弹出来。
- `Glyphs.swift`：状态图标、时间轴和菜单栏渲染。
- 菜单栏图标「看不见」有两种情况，先用 `CGWindowListCopyWindowInfo` 看 layer 25 的窗口：
  - 窗口不在屏幕上（`kCGWindowIsOnscreen` 为假）：带刘海的 Mac 上菜单栏挤满了，排在最左边的图标会被系统藏起来。用 ⌘ 拖动图标，或者设置 `defaults write dev.beeplight.mac "NSStatusItem Preferred Position Item-0" -float <离屏幕右边缘的距离>` 后重启 app。`BeeplightApp.init` 在这个键不存在时（首次启动）写入 400，让新用户的图标一开始就靠右。
  - 窗口在屏幕上但看不见：图标颜色要看菜单栏自己的深浅（`MenuBarLook`，读 `NSStatusBarWindow` 的外观），不能看 app 的外观。浅色模式配深色壁纸时，菜单栏是深色的。
- 改名：项目先叫 Claude Monitor（bundle ID `local.claude-monitor`，数据目录 `ClaudeMonitor`），后来叫 Tasklight（`app.tasklight.mac`，数据目录 `Tasklight`），改名 Beeplight 后先用过 `app.beeplight.mac`，都没有公开发布过。现在的 bundle ID 是 `dev.beeplight.mac`，和域名 beeplight.dev 对应，发布后不要再改。`Legacy.swift` 在 `BeeplightApp.init` 里最先执行，一次性把旧设置和数据目录搬过来，新名字的优先。网页端 `app.js` 开头也会把旧的 `tasklight-*`、`claude-monitor-*` localStorage 键搬过来。通知、自动化权限和「登录时启动」都按 bundle ID 记，换 ID 后系统会重新询问，登录时启动要重新打开。
- `Info.plist`：必须带 `NSAppleEventsUsageDescription`，否则由 app 拉起的 Node 调 osascript 控制 iTerm2 会被 TCC 静默拒绝。
- 签名：默认 ad-hoc 签名，每次重新构建签名都会变，系统可能会重新询问通知和自动化权限。发布版见下面的「发布」。

看板过滤（`Collector.publish()`）：从没收到过请求的会话（`state: idle`）不显示；超过 `collector.retainHours`（默认 12 小时）没有动静、且不是执行中或真实授权等待的也不显示，例如桌面端在启动时重新拉起的老对话。

手机访问（`src/transports/lan.js`）：默认关闭。打开后，为每个 Wi-Fi / 有线网卡地址（`en*`、`bridge*`，不含 VPN 的 `utun*`）各起一个额外的 http.Server，和本机服务共用同一个 `handler`。
- 本机请求的判定：来源是 loopback，并且 Host 是 localhost / 127.0.0.1。除此之外都按局域网请求处理：Host 必须是网卡地址或 `<LocalHostName>.local`，`/api/*` 必须带配对码（`x-beeplight-token` 头或 `?t=`）。
- 页面外壳、图标和 manifest 不需要配对码就能访问；`/api/lan*` 只允许本机调用。
- 网页图标（`public/icons/`）和 Mac 图标出自同一个 `desktop/Icon.swift`，改了画法要重新生成：`swiftc -o /tmp/make-icon desktop/Icon.swift && /tmp/make-icon --mobile public/icons`。manifest 里 `maskable` 图标铺满整张图，由系统裁形状；`any` 图标会被原样显示（比如 Chrome 把网页应用放进程序坞），所以画成带透明边距的 Mac 圆角图标。两种不能共用一个文件，否则总有一边难看（以前上下有白边）。
- 配对码故意保留在 URL 里：iOS 主屏幕 web app 有独立的存储，只认它被添加时的 URL；manifest 的 `start_url` 也会带上配对码。
- Mac 端的「手机」设置页在 `desktop/Sources/PhoneSettings.swift`，二维码用 CoreImage 的 `CIQRCodeGenerator` 生成。
- 页面版本：服务端启动时对 `public/` 的文件算一个哈希，放在 meta 的 `page` 字段里；网页发现它变了就自动刷新，所以一直开着的手机状态屏在更新后会换上新代码。
- 手机布局是 `public/style.css` 末尾的两个媒体查询：竖屏用标签页，横屏（`orientation: landscape` 且 `max-height: 540px`）三列并排。
- 蓝牙（`desktop/Sources/BluetoothBridge.swift`，协议在 `BluetoothWire.swift`）：给 iPhone app 用，局域网连不上时、以及 app 在后台时（iOS 允许后台 app 保持蓝牙连接，不允许保持 socket）经低功耗蓝牙收看板。Node 服务零依赖、做不了蓝牙，所以放在 Mac 应用里：它像本机网页一样读 `/api/stream` 转发出去，把手机的 focus / read / read-all 转成本机请求。打开手机访问、并且「手机」设置里「也通过蓝牙连接」开着（默认开）时才广播。服务 UUID 和加密密钥都由配对码派生（HKDF），每条消息压缩后用 AES-256-GCM 封装再分包；手机先发 `hello` 才收数据，局域网通时发 `pause`。`BluetoothWire.swift` 也编进 iPhone app，只能用 Foundation、CryptoKit、CoreBluetooth；改协议要两端一起改。
- 状态屏（`#ambient`，触屏设备默认；Mac 上的网页也能用顶栏的「◱ 简洁」切过去，「详情」切回看板）：中间的能量环按 等你/运行/失败/成功 分段，由 `renderCoreArcs()` 生成 SVG；配色变量 `--tone/--tone2` 用 `@property` 注册，状态切换时会渐变。`mode-ambient` 必须同时加在 `<html>` 上：iOS 主屏幕 app 会在 Home 指示条下面露出根元素背景，否则底部是一条白边。环的发光用 SVG `<filter>`，因为 Safari 不对 SVG 子元素应用 CSS `filter`。列表用 `patchList()` 按任务 id 原地更新，不整体重建，否则每次点按、每个新步骤都会让所有卡片重放入场动画；卡片不压缩高度（`flex-shrink: 0`），放不下时列表滚动。点开一条新完成的任务会把它标为已读，`ambKept` 让它留在原位，收起后才离开列表。

## 发布（Mac 应用）

发布的 DMG 要用 Developer ID 签名并经过 Apple 公证，否则 Gatekeeper 会拦，Homebrew 官方仓库也不收。这需要付费的 Apple 开发者账号。

1. 一次性准备：在 Xcode 的 Settings → Accounts 里创建「Developer ID Application」证书；`xcrun notarytool store-credentials <profile> --apple-id <邮箱> --team-id <团队 ID>`，按提示填 App 专用密码，把公证凭据存进钥匙串。
2. 改 `package.json` 的 `version`，然后 `SIGN_IDENTITY="Developer ID Application: <名字> (<团队 ID>)" NOTARY_PROFILE=<profile> npm run app:dist`：构建通用版，开启 hardened runtime 签名，公证 DMG 并把公证票据装订（staple）进去，最后打印 sha256。
3. `gh release create v<version> desktop/build/Beeplight-<version>.dmg`。
4. `sh scripts/homebrew-cask.sh <owner>/<repo> > <tap 仓库>/Casks/beeplight.rb`，提交并推送 tap 仓库（`<owner>/homebrew-tap`）。用户安装：`brew install <owner>/tap/beeplight`。cask 写法用 `brew style` 检查过。

- hardened runtime 下 node 要的权限在 `desktop/node.entitlements`：Apple 芯片缺 `allow-jit` 会启动即崩，Intel 缺 `allow-unsigned-executable-memory` 也会崩。官方 node 自带的权限里有 `get-task-allow`，公证会拒绝，所以签名时换成这份。app 的 `desktop/Beeplight.entitlements` 带 Apple Events 权限，没有它，跳转 iTerm2/Terminal 会被系统直接拒绝，也不会弹窗询问。
- 没有证书时，可以用 `SIGN_IDENTITY=- npm run app:dist`，按 ad-hoc 加 hardened runtime 的方式构建，在本机验证两种架构都能跑（Intel 用 `arch -x86_64`）。注意：构建会替换 `desktop/build/Beeplight.app`，正在运行的 app 要先退出。

## 和 iPhone 应用共用的文件

不开源的 iPhone 应用直接编译 `desktop/Sources/Models.swift`、`desktop/Sources/Figure.swift` 和 `public/characters.json`。所以 `Models.swift` 里只能用 Foundation，`Figure.swift` 只能用 SwiftUI，不能引入 AppKit；改字段或格式时要兼容 iPhone 端（新字段写成可选）。`desktop/Sources/Packs.swift`（只用 SwiftUI）和 `public/themes.json`、`presets.json` 也是为 iPhone 应用准备的，它要用包、权益接口或抽卡池时把它们加进工程即可；`Figure.swift` 不依赖 `Packs.swift`，只编译前者不受影响。

## 跨设备同步

- 中转服务 `relay/server.js`（零依赖，不打进 app）：按「组」存每台设备最新的一份密文，用 SSE 推给同组设备；每 20 秒发一次带服务端时间的 `tick`，设备据此判断在线，不依赖各自的时钟。全部在内存里，所有请求都要 `BEEPLIGHT_RELAY_TOKEN`。
- 设备端 `src/transports/relay.js`：组密钥（32 字节）用 HKDF 派生出组 id（中转服务上的空间名）和 AES-256-GCM 密钥；AAD 是「组 id:设备 id」，一台设备的密文不能冒充另一台。加入码 `beeplight-relay:1:<base64url(JSON{u,t,k})>` 带中转地址、令牌和密钥，所以 `/api/relay` 只对本机开放。配置存在 `store.flags.relay`，设备 id 在 `store.flags.relayDevice`。
- 同步内容由 `shareView()` 白名单决定：新增的视图字段默认不会同步出去，要同步就加到这里（路径、提问、对话、用量故意不在里面）。SDK 会话不同步。
- 合并在 `Collector.publish()`：本机看板变了才 `relay.share()`（另有 30 秒心跳），快照里再拼上 `relay.remoteViews()`。远程任务的 id 是 `<设备 id>~<会话 id>`，带 `remote: {id, name, online}`。远程任务只读：服务端的 focus/read/dismiss/resummarize 直接返回「这个任务在某某设备上」，Mac 端 `Monitor.perform` 也会拦下，界面上不显示操作按钮。
- 本机测试：中转服务跑在 127.0.0.1:7350，第二个实例用 `PORT=7444 BEEPLIGHT_DATA_DIR=… CLAUDE_CONFIG_DIR=<假的 ~/.claude> BEEPLIGHT_DEVICE_NAME=…`；`test/relay.test.js` 会起一个真的中转服务，验证加密、令牌和双向同步。

## 多语言

界面和服务端文案都是英文 + 简体中文，跟随系统语言。代码里写英文原文，英文原文同时就是翻译的 key；中文译文放在各自的表里。术语统一按 `docs/i18n-glossary.md`，新增文案先查这张表。

- Mac 应用：译文在 `desktop/Resources/zh-Hans.lproj/Localizable.strings`（`en.lproj` 故意留空），`build.sh` 把两个 `.lproj` 复制进 app 包。SwiftUI 接收字面量的 API（`Text("…")`、`Button("…")` 等）会自动翻译；凡是 `String` 值（计算出来的文案、枚举名、通知、toast）要用 `String(localized:)`，因为 `Text(字符串变量)` 不会翻译。插值在 key 里写成格式符：Int → `%lld`，Double → `%lf`，String → `%@`，写错了就静默显示英文。验证中文界面：`--snapshot <dir> -AppleLanguages '(zh-Hans)'`。
- 网页：`public/i18n.js` 的 `t('English', { 参数 })` 和 `ZH` 字典；`index.html` 里的静态文字用 `data-i18n` 标注，启动时 `applyI18n()` 翻译一次。网页用服务端的语言（服务端返回首页时写进 `<html lang>`），这样页面文字和服务端发来的标签、标题是同一种语言；`?lang=en` / `?lang=zh` 可以强制指定。
- 服务端：`src/lib/i18n.js` 的 `t()`。语言取 `BEEPLIGHT_LANG`（app 会传入自己的 `Bundle.main.preferredLocalizations.first`），没有就读 macOS 的 `AppleLanguages`。服务端生成的状态标签、detail、时间线备注、错误信息和 LLM 标题都已经是目标语言，客户端不要再翻译这些字段。总结器的系统提示词是英文，只按语言切换输出语言和长度要求（`summarizer.js` 的 `STYLE`）。测试用 `setLang()` 固定语言，不受本机语言影响。
- 语言设置在设置窗口的「通用」页（`GeneralSettings.swift`）：写 app 自己域里的 `AppleLanguages`，和系统设置里按应用设的语言是同一个键。本地化在启动时就定了，所以要重启 app，「立即重启」按钮会等当前进程退出后再 `open` 一个新的，新进程用新语言拉起 Node。服务端的页面版本号包含语言，开着的网页和手机状态屏会自动刷新。如果 7333 上跑的是开发时的 `npm start`，app 会复用它，服务端的语言不会跟着变。
- 切换语言后，已有的标题不会立刻重新总结：进行中的会话在下一次总结时换成新语言，已结束的会话保留原来的语言，直到过期。

## 安全约束

服务只监听 127.0.0.1（打开手机访问后才在局域网地址上额外监听）。所有检查都在 `src/transports/http.js` 里统一做，路由本身不做检查。唯一的例外是蓝牙：Mac 应用的 `BluetoothBridge` 先核对请求（用配对码派生的密钥解得开、发出不到 2 分钟、nonce 没见过、手机已发过 `hello`），只放行 focus / read / read-all 三种，再以本机身份调接口；它不做蓝牙以外的检查，其余仍由 `http.js` 管。

- `Host` 必须是本机的回环名称，或者已开启手机访问时的局域网地址（防 DNS rebinding）。
- `/api/` 下的路径都要配对，路径不存在也先返回 401，不暴露有哪些接口。
- 每条路由声明 `access`：`public`（页面外壳）、`pairing`（只有 `POST /api/pair`）、`paired`（本机或带配对码的手机）、`local`（只限本机：设置，以及会暴露密钥的接口）。
- 所有 POST 必须带 `x-beeplight: 1`。自定义头会触发 CORS 预检，其他网页无法跨站调用。
- 路由抛出的异常会变成 500，不会让进程退出。

新增接口：在 `src/transports/api.js` 里加一条路由，选好 `access`，在 `test/http.test.js` 里补测试。
