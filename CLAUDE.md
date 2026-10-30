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

保持零依赖，不要引入 npm 包。需要 Node ≥ 20.11（用到 `import.meta.dirname`）。改完前端直接刷新页面即可（静态文件 no-store）；改后端要重启服务（或 `npm run service:restart`）。

**Mac 应用会把 `src/` 和 `public/` 复制进 app 包**，所以改了服务端代码，要重新 `npm run app`，再退出并重开 app，它才会用上新代码。app 退出时会停掉自己启动的 Node 进程。但如果 7333 端口上已经有服务在跑（开发时的 `npm start`），app 会直接复用它，这时 app 内置的那份代码不生效。截图不能用 `screencapture`，因为终端没有屏幕录制权限，只能截到壁纸；用上面的 `--snapshot`。

## 架构

数据流：`Collector.tick()`（`src/collector.js`）每 tick 读取下面的数据源 → `deriveStatus()`（`src/status.js`）判定状态 → 必要时让 `Summarizer` 排队调 LLM → 拼出视图，签名有变化才 `emit('update')` → `src/server.js` 用 SSE 推送。

数据源都是 Claude Code 的内部文件（基于 2.1.312 逆向观察，升级后最先坏的就是这里）：

- **`~/.claude/sessions/<pid>.json`**（`src/registry.js`）：每个运行中的 Claude 进程都会写。`status` 为 `busy | idle | waiting`，`waitingFor` 为 `permission prompt | input needed | dialog open | goal proposal | sandbox request | worker request`。这是 Doing/Waiting 的主信号，所以不需要往用户的 settings.json 装 hook。进程正常退出时文件会被删；崩溃时会残留，所以 `isGenuine()` 用 `ps` 的启动时间和 `startedAt` 比对，排除 PID 复用。
- **`~/.claude/projects/<slug>/<sessionId>.jsonl`**（`src/transcript.js`）：增量 tail 读取。首次只读最后 4MB（有的文件超过 100MB），按字节切行，避免截断多字节字符。只有 `origin.kind === 'human'`（或没有 origin 的老格式）的 user 消息算一轮新请求；task-notification、isMeta、peer 消息都不算。`system/turn_duration` 标记一轮结束，`isApiErrorMessage` 是 API 失败，`[Request interrupted by user` 是中断。**transcript 有 3～4 秒写入缓冲**，正在执行的 tool_use 要过几秒才出现。
- **`<project>/<sessionId>/subagents/agent-*.jsonl` + `.meta.json`**（`src/subagents.js`）：子 agent。
- **`~/.claude/jobs/<short>/state.json`**（`src/jobs.js`）：`claude --bg` 后台会话，daemon 自己维护 `state = working|blocked|done|failed`。

三态规则只在 `deriveStatus()` 一处定义，优先级：registry 的 waiting/busy → 不在线的后台 job 用 daemon 判定 → 硬失败信号（中途退出、API 错误、中断）→ 本轮结束时的 LLM 判定（`blocked` 映射成 Waiting，`working` 映射成 Doing）→ 还没判定时临时显示为成功，并带 `pending`。改规则时同步改 `test/status.test.js`。

运行参数（`src/config-schema.js` 是参数表，`src/config.js` 的 `Config` 负责加载）：

- 优先级：默认值 < 数据目录下的 `config.json` < 环境变量。环境变量名是 `BEEPLIGHT_<键名大写下划线>`，旧变量名作为 `aliases` 保留。单位写在键名里（`…Ms`、`…Sec`、`…Minutes`、`…Hours`、`…MB`）。
- 模块在用到参数时才调用 `config.get(key)`，所以改动不用重启。带 `restart: true` 的参数（目前只有端口）只在启动时读一次。定时器用 `config.every(key, 倍数, fn)` 创建，间隔一改就自动重新计时。
- 各个类通过构造参数接收 `config`，默认用全局单例。测试里传 `new Config({ file: null, env: {} })`，就不会读到本机的配置文件和环境变量。
- `config.json` 每 2 秒检查一次修改时间，手改后自动重新加载。JSON 写坏时保留上一次的有效值。未知的键和非法值会忽略，但在文件里原样保留，并在设置页列出来。
- `GET/POST /api/config` 只对本机开放；POST 是全有或全无，任何一项非法就整批不保存。Mac 的「高级」设置页（`AdvancedSettings.swift`）完全按接口返回的描述生成。
- 新增参数：在 schema 里加一行，再到 `src/i18n.js` 补上标签和说明的中文译文。
- 故意不放进来的：其他程序依赖的约定（meta 每秒推一次，是 Mac 端判断连接的心跳；同步相关的时间要在所有设备上一致），以及解析细节。

LLM 总结（`src/summarizer.js`）：

- 为什么需要：transcript 里的 `ai-title` 只在会话开头生成一次。用户要的是「当前核心任务」的标题，以及成功/失败的判定。
- 调用方式：`claude -p --model haiku --tools "" --setting-sources "" --no-session-persistence --json-schema …`，cwd 是空目录 `data/llm-cwd`。不能用 `--bare`，因为它不读 OAuth。子进程也会在 registry 里注册（`entrypoint: sdk-cli`），靠 `ownPids` 过滤掉。
- 去重键：`endKey(a) = <本轮首条 prompt uuid>@<最新时间线时间戳>`。Claude 在同一轮里恢复工作后（例如收到后台任务通知）键会变，旧判定随之失效；会话关闭后则沿用这一轮最后一次判定。
- 失败处理：连续失败全局指数退避（30 秒到 10 分钟），失败记录带 `retryAfter`，到点由 Collector 重新请求。
- 持久化：结果存在 `data/state.json`（`src/store.js`），同时保存已结束会话的视图。重启后 `restoreEnded()` 会把这些会话重新挂上 transcript，而不是展示冻结的快照。

Token 用量与额度：

- `src/usage.js` `UsageIndex`：每 5 秒增量扫描所有 transcript，包括 `<session>/subagents/*.jsonl`，子 agent 的用量算到父会话。首次只读最近 8 天改动过的文件，约 600MB，按块读取，中间让出事件循环。同一个 API 响应会按内容块写成多行，每行都带同一份 usage，所以要按 `message.id + requestId` 去重，取各字段最大值。`costOf()` 用 API 价格给 token 加权，只用来估算各会话的额度占比；新模型上线时记得更新 `PRICES`。
- `src/limits.js` `Limits`：`claude -p --output-format stream-json --verbose` 每次调用都会输出 `rate_limit_event`，里面的 `unifiedWindows.five_hour / seven_day` 带 `utilization` 和 `resetsAt`。`src/claude-cli.js` 是总结器和额度探测共用的运行器，它会把这个事件交给 `Limits.ingest()`。窗口边界用 `resetsAt - 5h/7d`，已过重置时间的读数视为失效。`project()` 用同一窗口内的历史样本估算增长速度。
- 汇总：`Collector.refreshUsageCache()` 算出各会话的窗口用量和账号视图，只在 usage 或 limits 的 version 变化时、或每 10 秒重算一次。账号视图放在 meta 事件里下发，不进 state 签名。

外观（`desktop/Sources/Appearance.swift`）：`AppearanceConfig` 包含主题、菜单栏样式、灵动岛、动效四项，存在 UserDefaults 的 `appearance` 键里；`Preset.all` 是五个预设。`Theme` 的颜色全部从 `Theme.palette` 计算，动效从 `Theme.motion` 读取，`Appearance` 改动时会更新这两个全局值。根视图（Board、Panel、Island、设置窗口）用 `.id(appearance.revision)` 强制整棵树重建，并用 `.themedRoot()` 应用配色方案、字体设计、文字色和扫描线。卡片统一用 `.themedCard()`。新增界面时不要写死系统颜色，一律用 `Theme.*`，否则换了主题会露馅。

- 形象（`Face.swift`；不依赖 AppKit 的 `Energy`、`EyePose`、`Figure`、`SVGPath` 在 `Figure.swift`，iPhone 应用也编译这个文件）：外观设置里选，存为 `AppearanceConfig.character`（`eyes`、`classic` 或简笔形象的 id）。简笔形象是 `public/characters.json` 里的 SVG 路径（只支持 M L H V C Q Z，Mac 端用 `SVGPath.parse` 自己解析），Mac 端从 app 包里的 `server/public/` 读取，网页直接请求，加形象只需要改这个文件。Mac 端连上服务时和切换形象时会 `POST /api/character`，服务端记在 `store.flags.character`，通过 meta 下发给手机状态屏。没有任务时菜单栏、灵动岛显示所选形象，颜色和睁眼程度由 `Energy` 按两个额度窗口里用得更多的那个决定，阈值和额度条颜色一致（50% / 80% / 95%）。`FaceAnimator` 是事件驱动的：静止时只挂一个随机 2～12 秒的定时器，眨眼、张望时才以 30fps 出帧，菜单栏位图还按姿态缓存，所以空闲时几乎不耗电。手机状态屏上，机器人眼睛用纯 CSS 动画（`.amb-eyes`、`data-energy`）；简笔形象在所有状态下都显示，`syncFigure()` 按状态或剩余额度选一组 `MOODS`（睁眼程度、动作频率），只在动作时用 setTimeout 换帧，眼睛的画法和 Mac 端 `Figure.eyePath` 一致。
- 转天线：形象可以带 `spin`（`base` 加一组路径，目前只有机器人的天线），静止时竖直，动作时绕 `base` 像弹簧天线一样甩圈：`EyePose.spin`（朝向，单位是圈）和 `swing`（倾斜程度）经 `Figure.spinTransform` 变成一个斜切矩阵，网页端的 `spinMatrix()`、`whirlAt()` 用同一套公式。空闲时它是随机动作之一，圈数看 `Energy.turns`；手机状态屏和 iOS app 在执行中一直转。网页端的 SVG 每个形象只画一次，转天线时每 33ms 只改 `.s` 组的 `transform`，所以眨眼不会打断转圈。天线在转时不放 `alt` 帧，因为火花是按竖直的天线画的。Mac 和 iOS 都用 `Figure.draw()` 画形象，改画法只改这一处。
- 字符画形象（终端猫、终端狗）：`characters.json` 里用 `text` 代替路径字段，`face` 是一行颜文字（菜单栏、灵动岛、设置页和小组件用），`rest`/`alt` 是完整字符画（每行等宽），`*` 标出眼睛：睁眼画 `eye`，累了 `~`、快睁不开 `_`、眨眼 `-`、笑 `^`，规则在 `Figure.TextArt.eyeGlyph` 和网页的 `eyeGlyph()` 两处，要一起改。Swift 的 `Figure` 手写了解码，路径字段缺省为空，所以字符画和简笔形象能放在同一个数组里；新增字段也要在 `init(from:)` 里补，否则整个文件解码失败，所有形象都会消失。
- 走路（只在网页状态屏）：字符画形象可以带 `walk`（`facing`、`speed`、`step`、`frames`），状态屏用 `data-text` 把能量环换成一条虚线地面，`walk()`/`stepWalker()` 让它在线上走：空闲时按 `MOODS[].walk` 隔几秒溜达到一个点，执行中（`pace`）来回踱步，等你和失败时停下。位置以字符宽度为单位，帧号由走过的距离除以 `step` 算出；反方向走时整段字符画用 `scale` 镜像，转身是 `scale` 从 1 过 0 到 -1。每帧只改 `<pre>` 的 CSS `translate`/`scale`，所以晃动和跳的动画写在 `.amb-figure > *` 的 `transform` 上，两者不冲突。Mac 和 iOS app 里形象不走路，iOS 状态屏在环里显示完整字符画。
- `AppearanceConfig` 的解码在扩展里手写，缺少的字段用默认值。新增外观字段时要在这里补一行，否则旧版本存下的设置会整体解码失败，用户的外观被重置。
- 菜单栏的 6 种样式在 `Glyphs.swift` 的 `MenuBarBadge` 里，用 `ImageRenderer` 渲染成位图。徽章视图显式接收 `Palette` 和 `ink` 参数，所以设置页能用别的主题渲染预览。
- 灵动岛（`Island.swift`）是一块固定大小的透明 `NSPanel`，层级在 mainMenu 之上，透明区域的点击会穿透到下面。刘海尺寸取自 `NSScreen.auxiliaryTopLeftArea/RightArea`。岛体内不在 SwiftUI scene 里，打开看板窗口要通过 `WindowOpener`：由一直在渲染的 `MenuBarLabel` 在 onAppear 时注册 `openWindow`。
- 截图：`--snapshot <dir> --preset <id> [--island-open] [--island-click]` 会把 board、panel、settings、general、devices、advanced、island、phone 各渲染成一张图。截图模式下 `Appearance.persist = false`，不会改写用户设置。加 `--island-click` 时会往灵动岛第一行发一次合成点击，服务端日志里出现 `[focus] … from island` 就说明点击生效。改灵动岛的手势或布局后，用它回归测试。
- 灵动岛有两个点击相关的坑。一是 `.gesture(_, including: .none)` 会禁用整个子视图树的手势，按钮也会全部失效，只想关掉自己的手势时要用 `.subviews`。二是面板永远不是激活窗口，所以要用 `FirstMouseHostingView` 接受首次点击。悬停在这两种情况下都照常工作，所以看起来像「能展示但点不了」。
- 灵动岛「收不回去」：SwiftUI 的 `onHover` 偶尔收不到移出事件（从岛上点一行跳走之后出现过），`hovering` 就一直为真。现在有三道保险：从岛上跳转或打开看板后 `collapse()`；全局鼠标监听，点岛以外任何地方都收起（包括固定状态）；悬停展开期间 `watchHover()` 每 0.25 秒核对一次鼠标是否还在岛的范围内（`model.frame` 由 GeometryReader 记下），连续两次不在就收起，并递增 `hoverEpoch` 重建视图，清掉 SwiftUI 残留的悬停状态。

新完成（未读）：`Collector.trackState()` 发现某个会话的轨迹从非 done 变成 `done:*`，并且判定已经出来（不是 `p: true`）时，写入 `store.unread[sid]`。下面几种情况会清除：会话回到 doing/waiting（发了新消息，或者 Claude 自己继续干活）；调用 focus 或 read 接口；`POST /api/read-all`；dismiss；`src/seen.js` 检测到这个会话的终端标签页连续两次是前台。`seen.js` 只有在 `store.flags.appleEventsOk` 为真时才轮询，这个标志在第一次通过 AppleScript 跳转成功时写入，所以轮询永远不会成为触发系统授权弹窗的原因。每次标记和清除都会打 `[unread]` / `[focus]` 日志，带上原因和来源（`via=panel|board|notification|web`）。查「徽章为什么没了 / 为什么清不掉」时先看这里。客户端的未读计数都从可见列表里算，菜单栏、面板、看板、Dock 用的是同一个判定。

桌面端的收尾卡片：Claude 桌面端结束一轮时会调用 `mcp__ccd_turn__wrap_up`，参数是 `recap / ask / actions`。向用户的提问只出现在这里，回复正文里看不到，所以 `transcript.js` 把它记到 `turn.wrapUp`。在 `deriveStatus()` 里，有 `ask` 就直接判 Waiting，不交给 LLM。

点击跳转（`src/focus.js`）：`detectHost()`（`src/proc.js`）沿父进程链找最外层的 `.app`。iTerm2/Terminal 用 AppleScript 按 TTY 选中标签页；桌面端用 `claude://code/continue?session=<hostSessionId>`（从 Claude.app 的 URL handler 逆向得到）；后台 job 用 `claude attach`；已关闭的会话用 `claude --resume`。外部命令一律走 `execFile`，拼进 AppleScript 的字符串用 `appleScriptString()` 转义，ID 先过 `util.js` 里的正则校验。

状态轨迹（`src/timeline.js`）：`Collector.publish()` 每次构建视图后调用 `Timeline.track()`。只在状态键变化时追加 `{k, t}`，状态键为 `doing | waiting | waiting:q | done:success | done:failed`。判定未出时的临时 Done（`p: true`）会被判定结果原地改写，不新增一段。同时累计今日统计：`waiting:q` 表示一轮以提问结尾，不计入等待时长。轨迹持久化在 `store.histories`；今日统计通过 meta 事件下发，没放进 state 签名，所以不会每个 tick 都触发推送。

Mac 应用（`desktop/`）：

- `Server.swift`：健康检查，端口上没有服务时用内置代码拉起 Node。`build.sh` 打包的是官方 Node.js（版本固定在 `NODE_DIST`），第一次构建时从 nodejs.org 下载、按 SHASUMS256.txt 校验，缓存在 `desktop/build/node`；`--dist` 用 `lipo` 把 arm64 和 x64 合成通用版，平时只打本机架构（`NODE=` 可以换成指定的 node，`--dist` 不用它）。它放在 `Contents/MacOS/node`，许可证放在 `Resources/node-LICENSE`，所以用户不用装 Node；`findNode()` 优先用它。因为 app 跑的不再是 nvm 的 node，`config.js` 的 `resolveClaudeBin()` 会自己去 `~/.nvm/versions/node/*/bin` 找 claude。
- `Monitor.swift`：SSE 客户端（`URLSession.bytes.lines` 会丢掉空行，所以收到 `data:` 行就立刻处理）、通知触发、菜单栏徽章。
  - `Monitor` 是 `@Observable`：视图只在自己读过的属性变化时重算。所以属性一律变了才赋值（`assign`）；meta 拆成 `hz`、`today`、`summarizer`、`usage`、`limits` 分开存。
  - 每秒变一次的 `now` 只在 `Ticking(monitor) { now in … }` 这类叶子视图里读，不要在列表或窗口的 body 里读，否则整个窗口每秒重算。按分钟显示的倒计时读 `minute`；任务是否紧急读 `isUrgent(_:)`，它不依赖时钟。
  - 快照里只有文字或数字变化时不加动画，只有任务增减、换位置或换状态才用弹簧动画。
  - 有任务执行时，菜单栏徽章每秒换 12 帧。帧按计数、样式、相位、主题、深浅缓存，像素相同的帧共用一张图，图没变就不调用 `setImage`。
- 常驻动画（转圈、紧急卡片的呼吸发光、等待图标的脉冲）写在 `LayerEffects.swift` 里，用 Core Animation 图层实现，由窗口服务器驱动，app 每帧没有开销。不要用 `TimelineView(.animation)`、`.symbolEffect`、`repeatForever` 或按时钟切换的 `.animation` 做常驻动画：SwiftUI 每帧都会让整个窗口重新布局，并在 CPU 上重画。卡片阴影由底板形状投射（`themedCard`），不要给整张卡片加 `.shadow`，否则卡片里任何文字一变，就要连同模糊效果整张重画。
- 查 CPU：`sample <pid> 4 -file <文件>`，看主线程里 `CA::Transaction::commit`、`_layoutSubtreeWithOldSize`、`NSStatusItem _updateReplicants` 的占比。截图验证用 `--snapshot`，它能截到图层画的效果。
- `Board.swift` / `Panel.swift`：两套界面。
- `Glyphs.swift`：状态图标、时间轴和菜单栏渲染。
- 菜单栏图标「看不见」有两种情况，先用 `CGWindowListCopyWindowInfo` 看 layer 25 的窗口：
  - 窗口不在屏幕上（`kCGWindowIsOnscreen` 为假）：带刘海的 Mac 上菜单栏挤满了，排在最左边的图标会被系统藏起来。用 ⌘ 拖动图标，或者设置 `defaults write app.beeplight.mac "NSStatusItem Preferred Position Item-0" -float <离屏幕右边缘的距离>` 后重启 app。`BeeplightApp.init` 在这个键不存在时（首次启动）写入 400，让新用户的图标一开始就靠右。
  - 窗口在屏幕上但看不见：图标颜色要看菜单栏自己的深浅（`MenuBarLook`，读 `NSStatusBarWindow` 的外观），不能看 app 的外观。浅色模式配深色壁纸时，菜单栏是深色的。
- 改名：项目先叫 Claude Monitor（bundle ID `local.claude-monitor`，数据目录 `ClaudeMonitor`），后来叫 Tasklight（`app.tasklight.mac`，数据目录 `Tasklight`），都没有公开发布过。`Legacy.swift` 在 `BeeplightApp.init` 里最先执行，一次性把旧设置和数据目录搬过来，新名字的优先。网页端 `app.js` 开头也会把旧的 `tasklight-*`、`claude-monitor-*` localStorage 键搬过来。通知和自动化权限按 bundle ID 记，改名后系统会重新询问。bundle ID `app.beeplight.mac` 要和最终的域名对上，正式发布前确认。
- `Info.plist`：必须带 `NSAppleEventsUsageDescription`，否则由 app 拉起的 Node 调 osascript 控制 iTerm2 会被 TCC 静默拒绝。
- 签名：默认 ad-hoc 签名，每次重新构建签名都会变，系统可能会重新询问通知和自动化权限。发布版见下面的「发布」。

看板过滤（`Collector.publish()`）：从没收到过请求的会话（`state: idle`）不显示；超过 `RETAIN_ENDED_MS` 没有动静、且不是执行中或真实授权等待的也不显示，例如桌面端在启动时重新拉起的老对话。

手机访问（`src/lan.js`）：默认关闭。打开后，为每个 Wi-Fi / 有线网卡地址（`en*`、`bridge*`，不含 VPN 的 `utun*`）各起一个额外的 http.Server，和本机服务共用同一个 `handler`。
- 本机请求的判定：来源是 loopback，并且 Host 是 localhost / 127.0.0.1。除此之外都按局域网请求处理：Host 必须是网卡地址或 `<LocalHostName>.local`，`/api/*` 必须带配对码（`x-beeplight-token` 头或 `?t=`）。
- 页面外壳、图标和 manifest 不需要配对码就能访问；`/api/lan*` 只允许本机调用。
- 配对码故意保留在 URL 里：iOS 主屏幕 web app 有独立的存储，只认它被添加时的 URL；manifest 的 `start_url` 也会带上配对码。
- Mac 端的「手机」设置页在 `desktop/Sources/PhoneSettings.swift`，二维码用 CoreImage 的 `CIQRCodeGenerator` 生成。
- 页面版本：服务端启动时对 `public/` 的文件算一个哈希，放在 meta 的 `page` 字段里；网页发现它变了就自动刷新，所以一直开着的手机状态屏在更新后会换上新代码。
- 手机布局是 `public/style.css` 末尾的两个媒体查询：竖屏用标签页，横屏（`orientation: landscape` 且 `max-height: 540px`）三列并排。
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

不开源的 iPhone 应用直接编译 `desktop/Sources/Models.swift`、`desktop/Sources/Figure.swift` 和 `public/characters.json`。所以 `Models.swift` 里只能用 Foundation，`Figure.swift` 只能用 SwiftUI，不能引入 AppKit；改字段或格式时要兼容 iPhone 端（新字段写成可选）。

## 跨设备同步

- 中转服务 `relay/server.js`（零依赖，不打进 app）：按「组」存每台设备最新的一份密文，用 SSE 推给同组设备；每 20 秒发一次带服务端时间的 `tick`，设备据此判断在线，不依赖各自的时钟。全部在内存里，所有请求都要 `BEEPLIGHT_RELAY_TOKEN`。
- 设备端 `src/relay.js`：组密钥（32 字节）用 HKDF 派生出组 id（中转服务上的空间名）和 AES-256-GCM 密钥；AAD 是「组 id:设备 id」，一台设备的密文不能冒充另一台。加入码 `beeplight-relay:1:<base64url(JSON{u,t,k})>` 带中转地址、令牌和密钥，所以 `/api/relay` 只对本机开放。配置存在 `store.flags.relay`，设备 id 在 `store.flags.relayDevice`。
- 同步内容由 `shareView()` 白名单决定：新增的视图字段默认不会同步出去，要同步就加到这里（路径、提问、对话、用量故意不在里面）。SDK 会话不同步。
- 合并在 `Collector.publish()`：本机看板变了才 `relay.share()`（另有 30 秒心跳），快照里再拼上 `relay.remoteViews()`。远程任务的 id 是 `<设备 id>~<会话 id>`，带 `remote: {id, name, online}`。远程任务只读：服务端的 focus/read/dismiss/resummarize 直接返回「这个任务在某某设备上」，Mac 端 `Monitor.perform` 也会拦下，界面上不显示操作按钮。
- 本机测试：中转服务跑在 127.0.0.1:7350，第二个实例用 `PORT=7444 BEEPLIGHT_DATA_DIR=… CLAUDE_CONFIG_DIR=<假的 ~/.claude> BEEPLIGHT_DEVICE_NAME=…`；`test/relay.test.js` 会起一个真的中转服务，验证加密、令牌和双向同步。

## 多语言

界面和服务端文案都是英文 + 简体中文，跟随系统语言。代码里写英文原文，英文原文同时就是翻译的 key；中文译文放在各自的表里。术语统一按 `docs/i18n-glossary.md`，新增文案先查这张表。

- Mac 应用：译文在 `desktop/Resources/zh-Hans.lproj/Localizable.strings`（`en.lproj` 故意留空），`build.sh` 把两个 `.lproj` 复制进 app 包。SwiftUI 接收字面量的 API（`Text("…")`、`Button("…")` 等）会自动翻译；凡是 `String` 值（计算出来的文案、枚举名、通知、toast）要用 `String(localized:)`，因为 `Text(字符串变量)` 不会翻译。插值在 key 里写成格式符：Int → `%lld`，Double → `%lf`，String → `%@`，写错了就静默显示英文。验证中文界面：`--snapshot <dir> -AppleLanguages '(zh-Hans)'`。
- 网页：`public/i18n.js` 的 `t('English', { 参数 })` 和 `ZH` 字典；`index.html` 里的静态文字用 `data-i18n` 标注，启动时 `applyI18n()` 翻译一次。网页用服务端的语言（服务端返回首页时写进 `<html lang>`），这样页面文字和服务端发来的标签、标题是同一种语言；`?lang=en` / `?lang=zh` 可以强制指定。
- 服务端：`src/i18n.js` 的 `t()`。语言取 `BEEPLIGHT_LANG`（app 会传入自己的 `Bundle.main.preferredLocalizations.first`），没有就读 macOS 的 `AppleLanguages`。服务端生成的状态标签、detail、时间线备注、错误信息和 LLM 标题都已经是目标语言，客户端不要再翻译这些字段。总结器的系统提示词是英文，只按语言切换输出语言和长度要求（`summarizer.js` 的 `STYLE`）。测试用 `setLang()` 固定语言，不受本机语言影响。
- 语言设置在设置窗口的「通用」页（`GeneralSettings.swift`）：写 app 自己域里的 `AppleLanguages`，和系统设置里按应用设的语言是同一个键。本地化在启动时就定了，所以要重启 app，「立即重启」按钮会等当前进程退出后再 `open` 一个新的，新进程用新语言拉起 Node。服务端的页面版本号包含语言，开着的网页和手机状态屏会自动刷新。如果 7333 上跑的是开发时的 `npm start`，app 会复用它，服务端的语言不会跟着变。
- 切换语言后，已有的标题不会立刻重新总结：进行中的会话在下一次总结时换成新语言，已结束的会话保留原来的语言，直到过期。

## 安全约束

服务只监听 127.0.0.1；所有请求都校验 `Host` 头（防 DNS rebinding）；POST 必须带 `x-beeplight: 1`，这会触发 CORS 预检，其他网页无法跨站触发跳转。新增接口时保持这两条。
