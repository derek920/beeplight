// UI strings: English is the source language and the lookup key; ZH holds the Simplified
// Chinese translations. The page uses the service's language (the server writes it into
// <html lang>), so it matches the labels and titles the service sends.
//   t('Open on Mac')                    → '在 Mac 上打开'
//   t('{n} running', { n: 3 })          → '3 个运行中'
// Static text in index.html carries data-i18n (textContent) or data-i18n-<attr> (title,
// placeholder, aria-label); applyI18n() translates it once on load. `?lang=en` or `?lang=zh`
// overrides it.

export const LANG = (() => {
  const l = (new URLSearchParams(location.search).get('lang') || document.documentElement.lang || navigator.language || 'en').toLowerCase();
  return l.startsWith('zh') ? 'zh-Hans' : 'en';
})();
export const ZH_UI = LANG === 'zh-Hans';

const ZH = {
  // Header
  'All Claude Code sessions and agents on this Mac · Click a card to jump to its window': '本机所有 Claude Code 会话与 agent · 点击卡片跳到对应窗口',
  'Connecting…': '连接中…',
  'Live · {hz}/s': '实时 · {hz} 次/秒',
  'Disconnected, reconnecting…': '已断开，重连中…',
  'Status screen': '状态屏',
  '◱ Simple': '◱ 简洁',
  'Full screen': '全屏',
  'Exit full screen': '退出全屏',
  Theme: '主题',
  'Native macOS': '原生',
  Neon: '赛博霓虹',
  Terminal: '黑客终端',
  Hologram: '全息 HUD',
  Minimal: '极简',
  Notifications: '桌面通知',
  'SDK sessions': 'SDK 会话',
  'Needs you': '需要你',
  Running: '进行中',
  Done: '已完成',
  Failed: '失败',
  '{n} new': '{n} 新',
  Today: '今天',
  '✓ {n} done': '✓ 完成 {n} 轮',
  '✕ {n} failed': '✕ 失败 {n} 轮',
  'Claude worked {t}': 'Claude 工作 {t}',
  'Waited for you {t}': '等你 {t}',
  'Waited for you {t} (longest {max})': '等你 {t}（最长 {max}）',

  // Browser tab title
  '{n} waiting': '{n} 待处理',
  '{n} done': '{n} 新完成',
  '{n} running · Beeplight': '{n} 进行中 · Beeplight',

  // Columns
  Lists: '切换列表',
  'Needs your attention': '需要你处理',
  'Claude is working': 'Claude 正在执行',
  'Turn ended': '本轮已结束',
  'Nothing is waiting for you': '没有在等你的任务',
  'Nothing is running': '当前没有在跑的任务',
  'Nothing has finished yet': '还没有完成的任务',
  '✓ Mark all read': '✓ 全部已读',
  'Filter by result': '筛选结果',
  All: '全部',
  Succeeded: '成功',

  // Cards
  'Just now': '刚刚',
  '{t} ago': '{t}前',
  'Waiting {t}': '已等待 {t}',
  'Running {t}': '已运行 {t}',
  'Background session': '后台会话',
  'Claude Desktop': 'Claude 桌面端',
  CLI: '终端',
  'Jump to task': '跳转',
  "Switch to this session's window": '切到这个会话所在的窗口',
  'Open on Mac': '在 Mac 上打开',
  "Switch to this session's window on the Mac": '在 Mac 上切到这个会话所在的窗口',
  Open: '打开',
  'Open this session in Claude Desktop': '在 Claude 桌面端打开这个会话',
  Attach: '接入',
  'Run claude attach {id} in a new terminal tab': '在新终端标签页运行 claude attach {id}',
  Resume: '恢复',
  'Run claude --resume in a new terminal tab': '在新终端标签页运行 claude --resume',
  'This turn: running {work}': '本轮 运行 {work}',
  'This turn: running {work} · waiting {wait}': '本轮 运行 {work} · 等你 {wait}',
  'This session: {n} tokens': '本会话 {n} tokens',
  '≈{p} of 5-hour limit': '占 5 小时额度 ≈{p}',
  '≈{p} of weekly limit': '本周 ≈{p}',
  '1 request': '1 次请求',
  '{n} requests': '{n} 次请求',
  "{requests} in total, {out} output tokens, ≈{cost} at API prices. Limit shares are estimated from this session's share of API-equivalent cost in this Mac's usage; other devices aren't counted.":
    '累计 {requests}，输出 {out} tokens，按 API 价约 {cost}。额度占比按 API 等价成本在本机用量中的比例估算，未计其他设备。',
  'Last request': '最近一次请求',
  'Last request: {prompt}': '最近一次请求：{prompt}',
  '… {n} more': '… 还有 {n} 个子 agent',
  'Process suspended (Ctrl+Z). Type fg in its terminal to resume.': '进程被挂起（Ctrl+Z），在终端里输入 fg 恢复',
  Suspended: '已挂起',
  'Switched to a new session': '已切换到新会话',
  Closed: '已关闭',
  'Summarize title and result again': '重新总结标题和结果',
  'Remove from board (it comes back when there is new activity)': '从看板移除（有新进展时会重新出现）',
  'Finished, not viewed yet. Open the task, stay on its terminal tab for a moment, or send it a new message to mark it read':
    '新完成，还没查看。点开这个任务、在它的终端标签页停留一下，或给它发新消息，就算已读',
  'Summarizing…': '总结中…',
  'Last 30 min': '最近 30 分钟',
  '{device} · offline': '{device} · 离线',
  'Runs on another device; synced through your relay': '在你的另一台设备上运行，通过中转服务同步',

  // Footer
  '1 empty session not shown': '另有 1 个还没开始的空会话未显示',
  '{n} empty sessions not shown': '另有 {n} 个还没开始的空会话未显示',
  '1 session inactive for 12+ hours not shown': '1 个超过 12 小时没有动静的会话未显示',
  '{n} sessions inactive for 12+ hours not shown': '{n} 个超过 12 小时没有动静的会话未显示',
  '1 SDK session hidden': '1 个 SDK 会话已隐藏',
  '{n} SDK sessions hidden': '{n} 个 SDK 会话已隐藏',
  'Titles and results by Haiku: {ok} done': '标题与结果由 Haiku 总结：已完成 {ok} 次',
  ', {inflight} in progress, {queued} queued': '，进行中 {inflight}，排队 {queued}',
  ', {failed} failed': '，失败 {failed}',
  'Haiku calls by Beeplight today: {n}, ≈{cost}': '监控自身今天调用 Haiku {n} 次 ≈{cost}',
  'Done keeps tasks from the last 12 hours': 'Done 只保留 12 小时内的任务',

  // Limits and usage
  'Limits and usage': '额度与用量',
  '5-hour limit': '5 小时额度',
  'Weekly limit': '本周额度',
  'Resets {time} · {left} left': '{time} 重置 · 还剩 {left}',
  'No limit data yet': '还没拿到额度数据',
  'Sampling; burn rate coming soon': '采样中，稍后给出消耗速度',
  'No new usage lately': '最近没有新增消耗',
  '+{rate}/hr, runs out in about {eta} (before reset)': '每小时 +{rate}，约 {eta}后用完（重置前）',
  "+{rate}/hr, won't run out before reset": '每小时 +{rate}，重置前用不完',
  "Usage in this Mac's transcripts within this window (subagents included); claude.ai on the web and other devices aren't counted":
    '本机 transcript 中这个窗口内的用量（含子 agent），不含 claude.ai 网页和其他设备',
  'This Mac: {tokens} tokens · {out} output · {cr} cache read · ≈{cost}': '本机 {tokens} tokens · 输出 {out} · 缓存读 {cr} · ≈{cost}',
  'Top sessions this week': '本周用量最多的会话',
  'share of weekly limit (est.)': '占周额度（估算）',
  'No usage this week yet': '本周还没有用量',
  Live: '在线',
  "Couldn't get limits: {error}": '额度获取失败：{error}',
  'Refreshing limits…': '正在刷新额度…',
  'Limits updated {time}': '额度更新于 {time}',
  'Refresh limits': '刷新额度',
  'Limits refreshed': '额度已刷新',
  'Refresh failed: {error}': '刷新失败：{error}',

  // Status screen. The lowercase words are the caption under the big number.
  'Claude is idle': 'Claude 空闲',
  'Nothing running or waiting for you': '没有在跑或等你的任务',
  '1 task needs you': '1 个任务等你处理',
  '{n} tasks need you': '{n} 个任务等你处理',
  '1 task just finished': '1 个任务新完成',
  '{n} tasks just finished': '{n} 个任务新完成',
  '1 task running': '1 个任务运行中',
  '{n} tasks running': '{n} 个任务运行中',
  waiting: '等你处理',
  new: '新完成',
  running: '运行中',
  idle: '空闲',
  '{p} left': '剩余 {p}',
  Waiting: '等你',
  Doing: '运行',
  New: '新完成',
  '5-hour': '5 小时',
  Weekly: '本周',
  'Thinking…': '思考中…',
  '{n} more · Tap Details to see all': '还有 {n} 个任务 · 点「详细」查看',
  'Recently finished': '最近完成',
  Details: '详细',

  // Notifications and toasts
  'Needs you: {title}': '需要你处理：{title}',
  'Failed: {title}': '任务失败：{title}',
  'Done: {title}': '任务完成：{title}',
  'Switched to {how}': '已切换到 {how}',
  "Couldn't jump: {error}": '跳转失败：{error}',
  'Queued to summarize again': '已重新排队总结',
  'Nothing to summarize in this session': '这个会话没有可总结的内容',
  'Removed from board': '已从看板移除',
  'Request failed: {error}': '请求失败：{error}',
  'Request failed': '请求失败',
  'Marked all read': '已全部标为已读',
  "Can't go full screen: {error}": '无法全屏：{error}',
  'On iPhone: in Safari, tap Share → Add to Home Screen, then open it from the Home Screen for full screen':
    'iPhone 上：点 Safari 的「分享 → 添加到主屏幕」，从主屏幕打开就是全屏',
  "The browser didn't grant notification permission": '浏览器没有授予通知权限',

  // Pairing
  'Not paired yet': '还没有配对',
  'On your Mac, open Beeplight → ⚙ → Phone Access and enter the 6-digit pairing code shown there:':
    '在 Mac 上打开「Beeplight → ⚙ → 手机访问」，输入那里显示的 6 位配对码：',
  '6-digit pairing code': '6 位配对码',
  Pair: '配对',
  'Or scan the QR code on that page with your camera. The code is valid for 5 minutes and works only once.':
    '也可以用相机扫那一页的二维码。配对码 5 分钟内有效，只能用一次。',
  'Enter all 6 digits': '请输入 6 位数字',
  'Pairing…': '配对中…',
  "Can't reach the Mac. Check the network.": '连不上 Mac，请检查网络',

  // Durations
  '{n} sec': '{n} 秒',
  '{n} min': '{n} 分钟',
  '{h} hr': '{h} 小时',
  '{h} hr {m} min': '{h} 小时 {m} 分',
  '1 day': '1 天',
  '{d} days': '{d} 天',
  '1 day {h} hr': '1 天 {h} 时',
  '{d} days {h} hr': '{d} 天 {h} 时',
};

export function t(key, params) {
  let s = (ZH_UI && ZH[key]) || key;
  if (params) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return s;
}

export function applyI18n(root = document) {
  document.documentElement.lang = LANG;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n || el.textContent.trim());
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const name = `data-i18n-${attr}`;
    for (const el of root.querySelectorAll(`[${name}]`)) el.setAttribute(attr, t(el.getAttribute(name) || el.getAttribute(attr)));
  }
}
