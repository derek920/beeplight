import { execFileSync } from 'node:child_process';

// Text the service produces (task labels, error messages, LLM titles) follows one language:
// BEEPLIGHT_LANG (the Mac app passes its own), else the Mac's preferred language. English is the
// source and the lookup key; ZH holds the Simplified Chinese translations.
//   t('Retrying API{n}: {msg}', { n, msg })

export let LANG = normalize(process.env.BEEPLIGHT_LANG || systemLanguage());

export function setLang(lang) {
  LANG = normalize(lang);
}

function normalize(lang) {
  return String(lang || '').toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en';
}

function systemLanguage() {
  if (process.platform === 'darwin') {
    try {
      // "(\n    \"zh-Hans-CN\",\n    en\n)"
      const out = execFileSync('defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2000 });
      const first = out.match(/\(\s*"?([\w-]+)/)?.[1];
      if (first) return first;
    } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

const ZH = {
  // status.js
  'Needs permission': '等待授权',
  'Needs input': '等待输入',
  'Dialog open': '对话框待处理',
  'Confirm goal': '确认目标',
  'Sandbox network request': '沙箱联网请求',
  'Worker request': '子任务请求',
  'Needs confirmation': '等待确认',
  'Retrying API{n}: {msg}': 'API 重试中{n}：{msg}',
  'Subagents running: {n}': '{n} 个子 agent 运行中',
  'Thinking…': '思考中…',
  Running: '执行中',
  'Awaiting your reply': '等你回复',
  Failed: '失败',
  'Running in background': '后台执行中',
  Done: '完成',
  Idle: '空闲',
  'Exited mid-turn': '中途退出',
  'The session was closed or crashed while running': '会话在执行过程中被关闭或崩溃',
  'API error': 'API 错误',
  Interrupted: '已中断',
  'You interrupted this turn': '这一轮执行被你中断了',
  '{ask} ({options})': '{ask}（{options}）',
  'Background work running': '后台进行中',
  'Not finished': '未完成',
  'Checking the result…': '结果判定中…',
  // transcript.js
  'Interrupted by the user': '用户中断了执行',
  'Background task finished: {summary}': '后台任务完成：{summary}',
  'Background task failed: {summary}': '后台任务失败：{summary}',
  'Background task {status}: {summary}': '后台任务{status}：{summary}',
  'API error: {msg}': 'API 错误：{msg}',
  'Wrap-up: {recap}': '收尾：{recap}',
  '; asked the user: {ask}': '；向用户提问：{ask}',
  ' (options: {actions})': '（可选：{actions}）',
  // server.js
  "This Mac doesn't need pairing": '本机不需要配对',
  'Wrong or expired pairing code. Check the latest code under Phone Access on the Mac.': '配对码不对或已过期，请看 Mac 上「手机访问」页的最新配对码',
  'Not paired. Open this page from the QR code under Phone Access on the Mac.': '未配对：请用 Mac 上「手机访问」页的二维码打开',
  'This can only be changed on the Mac itself': '只能在 Mac 本机上修改',
  'Session not found': '会话不存在',
  'This task runs on {device}': '这个任务在「{device}」上运行',
  // focus.js
  'new iTerm2 tab': 'iTerm2 新标签页',
  'new Terminal window': 'Terminal 新窗口',
  "Couldn't find {tty} in the terminal": '没在终端里找到 {tty}',
  'Claude desktop app': 'Claude 桌面端',
  "{app} (couldn't select the exact tab)": '{app}（未能定位到具体标签页）',
  "The session runs in tmux, which can't be located yet": '会话运行在 tmux 里，暂不支持自动定位',
  "Couldn't find this session's window": '找不到这个会话的窗口',
  // config.js, config-schema.js
  'must be a number': '必须是数字',
  'must be a whole number': '必须是整数',
  'must be between {min} and {max}': '必须在 {min} 到 {max} 之间',
  'must be text': '必须是文本',
  'must be at most {n} characters': '最多 {n} 个字符',
  'has characters that are not allowed': '包含不允许的字符',
  'unknown setting': '未知的设置项',
  'not valid JSON: {msg}': '不是有效的 JSON：{msg}',
  'must be an object of settings': '必须是由设置项组成的对象',
  Monitoring: '监控',
  'Titles and verdicts': '标题和判定',
  'Usage limits': '额度',
  'Token usage': 'Token 用量',
  Transcripts: '对话记录',
  Subagents: '子 agent',
  'Read detection': '已读检测',
  'Phone access': '手机访问',
  Devices: '设备',
  Service: '服务',
  'Status check interval (ms)': '状态检查间隔（毫秒）',
  'How often every session is checked. Lower reacts faster and uses more CPU.': '多久检查一次所有会话。越小反应越快，CPU 占用也越高。',
  'Process scan interval (ms)': '进程扫描间隔（毫秒）',
  "How often the process list is read to find each session's terminal and app.": '多久读一次进程列表，用来找到每个会话所在的终端和 app。',
  'Keep finished tasks (hours)': '已结束任务保留（小时）',
  'Finished or quiet tasks leave the board after this long.': '已结束或长时间没有动静的任务，过了这么久就从看板上移走。',
  'Summary model': '总结模型',
  'Model that writes task titles and judges results, passed to claude --model.': '用来写任务标题、判定结果的模型，会传给 claude --model。',
  'Summaries at once': '同时总结数',
  'How many summary calls may run at the same time.': '最多同时进行几个总结调用。',
  'Summary timeout (seconds)': '总结超时（秒）',
  'A summary call that takes longer is stopped and retried later.': '超过这个时间的总结调用会被停止，稍后重试。',
  'Titles per hour while running': '执行中每小时最多总结次数',
  'Cap on summaries made while a turn is still running. Results at the end of a turn are never capped. 0 titles tasks only when a turn ends.':
    '一轮还在执行时，每小时最多总结几次。一轮结束时的判定不受限制。设为 0 就只在一轮结束时起标题。',
  'Wait before titling a new turn (seconds)': '新一轮起标题前等待（秒）',
  'Lets the first reply and tool calls arrive, so the title knows what the turn is about.': '等第一条回复和工具调用写进记录，标题才知道这一轮在做什么。',
  'Wait before judging a finished turn (seconds)': '判定结果前等待（秒）',
  "Lets Claude's last lines reach the transcript before the result is judged.": '等 Claude 的最后几行写进记录，再判定结果。',
  'Retitle long turns (minutes)': '长任务刷新标题（分钟）',
  'A turn still running after this long gets a fresh title this often.': '一轮执行超过这个时间后，每隔这么久重新起一次标题。',
  'Check limits while active (minutes)': '活跃时检查额度（分钟）',
  'When no summary has brought fresh limit numbers, a tiny request fetches them this often. 0 turns these checks off.':
    '如果总结调用没有顺带带回最新额度，每隔这么久发一次极小的请求去取。设为 0 关闭。',
  'Check limits while idle (minutes)': '空闲时检查额度（分钟）',
  'The same check when no session has been active for 30 minutes.': '30 分钟内没有会话活动时，用这个间隔检查。',
  'Count token usage (seconds)': '统计 token 用量（秒）',
  'How often transcripts are scanned for new token usage.': '多久扫描一次对话记录，统计新增的 token 用量。',
  'Read of a long transcript (MB)': '长对话记录读取量（MB）',
  'When a session is first seen, only this much of the end of its transcript is read.': '第一次发现某个会话时，只读它对话记录末尾的这么多。',
  'Most read per check (MB)': '每次最多读取（MB）',
  'Caps how much new transcript is read in one check, so a burst of output never stalls the service.': '每次检查最多读这么多新内容，大量输出时服务也不会卡住。',
  'Show finished subagents (minutes)': '已结束子 agent 显示（分钟）',
  "A finished subagent stays on its task's card this long.": '已结束的子 agent 在任务卡片上保留这么久。',
  'Front tab check (ms)': '前台标签页检测（毫秒）',
  'How often the front terminal tab is checked, to mark a task read once you have looked at it.': '多久检查一次前台的终端标签页。你看过某个任务的标签页后，它会被标为已读。',
  'Network address check (seconds)': '网络地址检查（秒）',
  'How often new network connections (Wi-Fi, USB tethering) are picked up for phone access.': '多久检查一次新的网络连接（Wi-Fi、USB 共享网络），供手机访问使用。',
  'Device name': '设备名称',
  "This Mac's name on your other devices. Empty uses the computer name.": '这台 Mac 在你其他设备上显示的名字。留空就用电脑名称。',
  'claude command': 'claude 命令',
  'Full path to the claude executable. Empty finds it on PATH, in nvm and in the usual install folders.': 'claude 可执行文件的完整路径。留空会从 PATH、nvm 和常见安装目录里查找。',
  Port: '端口',
  'The service listens on 127.0.0.1 at this port. The Mac app always uses 7333.': '服务在 127.0.0.1 的这个端口上监听。Mac 应用固定使用 7333。',
};

export function t(key, params) {
  let s = (LANG === 'zh-Hans' && ZH[key]) || key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}
