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
};

export function t(key, params) {
  let s = (LANG === 'zh-Hans' && ZH[key]) || key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}
