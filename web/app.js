import { localDate, validPlan, createPlan, addEvent, archiveIfEnded, statusLabel, occupiedSlots, conflictingSlots, asNeededUseWarnings, addAsNeededUse } from './core.js?v=20261011-leaflet-autofill-2';

const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const today = () => localDate();
const UNIT_OPTIONS = ['片', '粒', '袋', '包', '支', '瓶', '毫升', '滴', '贴', '喷', '丸', '克'];
const emptyMed = () => ({ name: '', dose: '', unit: '', unitCustom: false, times: [], slot: 0, sources: '' });
let plans = loadPlans();
let activeTab = 'home';
let sheet = null;
let step = 1;
let draft = newDraft();
let selectedTask = null;
let busy = false;
let toastTimer;
let assistantOpen = false;
let assistantBusy = false;
let assistantDocument = null;
let assistantMessages = [{ role: 'assistant', content: '你好，可以问我当前计划的时间，也可以问药品资料。你还可以上传药品说明书照片，核对识别文字后就其中的内容提问。回答会标明依据；没有可核对的内容时我会说明。个人用药调整请向医生或药师确认。', sources: [] }];

function newDraft() { return { title: '', startDate: today(), endDate: today(), sourceText: '', imageData: '', imageName: '', photoText: '', photoKind: '', leafletError: '', mode: 'fixed', leafletGuidance: null, selectedDoseOption: '', purpose: '', medicines: [emptyMed()] }; }
function loadPlans() {
  try {
    const value = JSON.parse(localStorage.getItem('medicine-box-plans-v1') || '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}
function runReminders() {
  const now = Date.now();
  let changed = false;
  for (const plan of plans) {
    if (!plan.active) continue;
    for (const task of plan.tasks) {
      if (task.status !== 'pending') continue;
      const target = task.remindAt ? Date.parse(task.remindAt) : Date.parse(task.scheduledAt);
      if (Number.isFinite(target) && now >= target && now - target < 60000 && task.lastNotifiedAt !== (task.remindAt || task.scheduledAt)) {
        task.lastNotifiedAt = task.remindAt || task.scheduledAt;
        const med = medicine(plan, task);
        const message = `${med.name} · ${formatTime(task.scheduledAt)} · ${med.slot} 号药格`;
        toast(`当前任务：${message}`);
        if ('Notification' in window && Notification.permission === 'granted') new Notification('智能药盒 · 当前任务', { body: message });
        changed = true;
      }
    }
  }
  if (changed) { save(); render(); }
}
function save() { localStorage.setItem('medicine-box-plans-v1', JSON.stringify(plans)); }
function refreshArchive() {
  const updated = plans.map(p => archiveIfEnded(p));
  if (updated.some((p, i) => p !== plans[i])) { plans = updated; save(); }
}
function activePlans() { refreshArchive(); return plans.filter(p => p.active); }
function byId(planId, taskId) { const plan = plans.find(p => p.id === planId); return { plan, task: plan?.tasks.find(t => t.id === taskId) }; }
function formatDay(value) { if (!value) return ''; const [y, m, d] = value.split('-'); return `${Number(m)}月${Number(d)}日`; }
function formatTime(value) { return value?.slice(11, 16) || ''; }
function toast(message) {
  const box = $('#toast'); box.textContent = message; box.classList.add('show'); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 3000);
}

function pageIntro(kicker, title, sub = '') {
  return `<div class="eyebrow">${esc(kicker)}</div><h1 class="page-title">${esc(title)}</h1>${sub ? `<p class="lead">${esc(sub)}</p>` : ''}`;
}
function empty(icon, title, body, button = '新建计划') {
  return `<div class="card empty"><div class="empty-icon">${icon}</div><h2>${esc(title)}</h2><p>${esc(body)}</p><button class="primary" data-action="create">${esc(button)}</button></div>`;
}
function stats(active) {
  const tasks = active.flatMap(plan => plan.tasks);
  const completed = tasks.filter(t => t.status === 'confirmed').length;
  const uncertain = tasks.filter(t => t.status === 'uncertain').length;
  const pending = tasks.filter(t => t.status === 'pending').length;
  return `<div class="stat-row"><div class="stat"><strong>${completed}</strong><span>已确认</span></div><div class="stat"><strong>${pending}</strong><span>待确认</span></div><div class="stat"><strong>${uncertain}</strong><span>待核实</span></div></div>`;
}
function medicine(plan, task) { return plan.medicines[task.medicineIndex]; }
function taskCard(plan, task) {
  const med = medicine(plan, task);
  const opens = task.events.filter(e => e.type === 'opened').length;
  const pillClass = task.status === 'uncertain' ? 'warn' : task.status === 'confirmed' ? '' : 'neutral';
  return `<article class="card task-card"><div class="task-head"><div><div class="task-time">${esc(formatTime(task.scheduledAt))}</div><div class="task-name">${esc(med.name)}</div></div><span class="pill ${pillClass}">${statusLabel(task.status)}</span></div><div class="task-meta">${esc(plan.title)} · ${esc(med.dose)} ${esc(med.unit)} · ${esc(med.slot)} 号药格<br>${opens ? `已记录 ${opens} 次开盒，开盒不代表已经服用` : '尚无开盒记录'}${task.remindAt ? `<br>下次提醒：${esc(new Date(task.remindAt).toLocaleString('zh-CN'))}` : ''}</div><div class="button-row"><button class="secondary" data-action="task" data-plan="${esc(plan.id)}" data-task="${esc(task.id)}">查看任务</button>${task.status !== 'confirmed' && task.status !== 'cancelled' ? `<button class="primary" data-action="confirm" data-plan="${esc(plan.id)}" data-task="${esc(task.id)}">我已服用</button>` : ''}</div></article>`;
}
function asNeededCard(plan) {
  const med = plan.medicines[0];
  const guidance = plan.leafletGuidance || {};
  const parts = [guidance.interval ? `至少间隔 ${guidance.interval.minHours} 小时` : '', guidance.maxPer24h ? `24 小时最多 ${guidance.maxPer24h.count} 次` : ''].filter(Boolean);
  return `<article class="card task-card"><div class="task-head"><div><div class="task-name">${esc(med.name)}</div><div class="row-sub">按需使用 · ${esc(plan.title)}</div></div><span class="pill neutral">不设定时提醒</span></div><div class="task-meta">已选说明书人群：${esc(guidance.doseOptions?.[plan.selectedDoseOption]?.group || '')}<br>单次用量：${esc(med.dose)} ${esc(med.unit)} · ${esc(med.slot)} 号药格${parts.length ? `<br>${esc(parts.join('；'))}` : ''}<br>症状出现时按已核对的说明书或专业人员指导使用。</div><div class="button-row"><button class="secondary" data-action="plan" data-plan="${esc(plan.id)}">查看依据</button><button class="primary" data-action="record-prn" data-plan="${esc(plan.id)}">记录已服用</button></div></article>`;
}
function home() {
  const active = activePlans();
  const d = new Date();
  let html = pageIntro(`${d.getMonth()+1} 月 ${d.getDate()} 日`, '今天，照顾好自己', '查看当前安排，逐项留下清楚的记录。');
  if (!active.length) return html + `<div class="hero"><div class="eyebrow">开始使用</div><h2>从一份清楚的计划开始</h2><p>整理已有安排，按天查看任务，到期自动收起提醒。</p><button class="primary" data-action="create">创建用药计划</button></div><div class="section-title">当前任务</div>${empty('▤', '还没有进行中的计划', '创建计划后，今天的任务会显示在这里。')}`;
  const todayTasks = active.flatMap(plan => plan.tasks.filter(t => t.scheduledAt.startsWith(today())).map(task => ({ plan, task }))).sort((a, b) => a.task.scheduledAt.localeCompare(b.task.scheduledAt));
  const headline = active.length === 1 ? active[0].title : `${active.length} 个进行中的计划`;
  const subline = active.length === 1 ? `${formatDay(active[0].startDate)} — ${formatDay(active[0].endDate)}` : `今天共有 ${todayTasks.length} 项任务`;
  html += `<div class="hero"><div class="eyebrow">进行中的计划</div><h2>${esc(headline)}</h2><p>${esc(subline)}</p><button class="primary" data-action="create">＋ 新建计划</button></div>${stats(active)}<div class="section-title">今日任务 <span class="muted small">${todayTasks.length} 项</span></div>`;
  html += todayTasks.length ? todayTasks.map(({ plan, task }) => taskCard(plan, task)).join('') : `<div class="card empty"><div class="empty-icon">✓</div><h2>今天没有定时任务</h2><p>可到“计划”查看完整安排。</p></div>`;
  const asNeeded = active.filter(plan => plan.mode === 'asNeeded' && plan.startDate <= today() && plan.endDate >= today());
  if (asNeeded.length) html += `<div class="section-title">按需计划</div>${asNeeded.map(asNeededCard).join('')}`;
  return html;
}
function planCard(plan) {
  const status = plan.active ? '进行中' : '已归档';
  return `<article class="card"><div class="row"><div><div class="row-title">${esc(plan.title)}</div><div class="row-sub">${formatDay(plan.startDate)} — ${formatDay(plan.endDate)} · ${plan.medicines.length} 种药品${plan.mode === 'asNeeded' ? ' · 按需' : ''}</div></div><span class="pill ${plan.active ? '' : 'neutral'}">${status}</span></div><hr class="divider"><div class="row plan-card-actions-row"><span class="muted small">${plan.mode === 'asNeeded' ? `已记录 ${plan.prnEvents?.length || 0} 次使用` : `${plan.tasks.length} 项任务 · ${plan.tasks.filter(t => t.status === 'confirmed').length} 项已确认`}</span><div class="plan-actions"><button class="link-button stop" data-action="delete-plan" data-plan="${esc(plan.id)}" aria-label="删除计划：${esc(plan.title)}">删除</button><button class="link-button" data-action="plan" data-plan="${esc(plan.id)}">查看详情 ›</button></div></div></article>`;
}
function plansPage() {
  let html = pageIntro('我的安排', '用药计划', '计划到期后自动归档，记录仍可查看。');
  html += plans.length ? plans.slice().reverse().map(planCard).join('') : empty('▤', '还没有计划', '把已有安排整理为短期任务。');
  if (plans.length) html += `<button class="primary full" data-action="create">＋ 新建计划</button>`;
  return html;
}
function eventLabel(event) {
  return ({ opened: '记录开盒', confirmed: '确认已服用', uncertain: '标记待核实', corrected: '更正记录', reminded: '调整提醒' })[event.type] || '更新记录';
}
function recordsPage() {
  let html = pageIntro('可查的时间线', '记录', '开盒与服用确认分别记录，方便回看。');
  const entries = plans.flatMap(plan => [...plan.tasks.flatMap(task => task.events.map(event => ({ plan, task, event }))), ...(plan.prnEvents || []).map(event => ({ plan, task: null, event }))]).sort((a, b) => b.event.at.localeCompare(a.event.at));
  if (!entries.length) return html + empty('◷', '还没有记录', '完成任务操作后，记录会显示在这里。');
  html += `<div class="card"><ul class="timeline">${entries.slice(0, 80).map(({ plan, task, event }) => `<li><b>${esc(task ? eventLabel(event) : '记录按需服用')} · ${esc(task ? medicine(plan, task).name : plan.medicines[0].name)}</b><p>${esc(new Date(event.at).toLocaleString('zh-CN'))} · ${event.source === 'device' ? '药盒' : '手动记录'}</p></li>`).join('')}</ul></div>`;
  return html;
}
function devicePage() {
  const used = Object.fromEntries(activePlans().filter(plan => plan.startDate <= today() && plan.endDate >= today()).flatMap(plan => plan.medicines.map(m => [m.slot, m.name])));
  let html = pageIntro('设备与格位', '我的药盒', '计划中的格位与盒体编号保持一致。');
  html += `<div class="card"><div class="row"><div><div class="row-title">药盒连接</div><div class="row-sub">当前尚未连接实体药盒</div></div><span class="pill neutral">未连接</span></div><div class="notice">现在可在任务详情中手动记录开盒。接入设备后，格位开盖事件将自动进入时间线。</div></div>`;
  html += `<div class="section-title">药格对应</div><div class="slot-grid">${[1,2,3].map(n => `<div class="slot ${used[n] ? 'active' : ''}"><b>${n}</b><span>${esc(used[n] || '尚未分配')}</span></div>`).join('')}</div>`;
  html += `<div class="section-title">使用提示</div><div class="card"><div class="row-title">先核对，再放入</div><div class="row-sub">请根据已确认的计划核对药品与格位。开盒事件只代表盒盖打开，不能用来判断是否已经服用。</div></div>`;
  return html;
}
function render() {
  refreshArchive();
  $('#screen').innerHTML = ({ home, plans: plansPage, records: recordsPage, device: devicePage })[activeTab]();
  document.querySelectorAll('.bottom-nav button').forEach(button => button.classList.toggle('selected', button.dataset.tab === activeTab));
  $('#top-add').style.display = '';
  renderSheet();
}

function openCreate() { assistantOpen = false; renderAssistant(); draft = newDraft(); step = 1; sheet = 'create'; renderSheet(); }
function closeSheet() { sheet = null; selectedTask = null; renderSheet(); }
function renderAssistant() {
  $('#assistant-toggle').setAttribute('aria-expanded', String(assistantOpen));
  $('#assistant-toggle').textContent = assistantOpen ? '关闭助手' : '用药助手';
  if (!assistantOpen) { $('#assistant-root').innerHTML = ''; return; }
  const messages = assistantMessages.map(message => `<div class="assistant-message ${message.role === 'user' ? 'mine' : ''}"><div>${esc(message.content)}</div>${message.sources?.length ? `<div class="assistant-sources">依据：${message.sources.map(source => source.url?.startsWith('https://') ? `<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a>` : `<span>${esc(source.title)}</span>`).join('、')}</div>` : ''}</div>`).join('');
  const documentView = assistantDocument ? `<div class="assistant-document"><div class="row"><strong>说明书：${esc(assistantDocument.name)}</strong><button class="link-button" data-action="assistant-clear-document">移除</button></div>${assistantDocument.imageData ? `<img class="photo-preview" src="${assistantDocument.imageData}" alt="上传的说明书原图">` : ''}<label class="form-label" for="assistant-document-text">识别文字，请对照原图核对</label><textarea id="assistant-document-text" class="textarea" maxlength="6000">${esc(assistantDocument.text)}</textarea><button class="secondary full" data-action="assistant-confirm-document" ${assistantDocument.confirmed ? 'disabled' : ''}>${assistantDocument.confirmed ? '已确认文字，可提问' : '确认文字作为提问依据'}</button></div>` : '';
  $('#assistant-root').innerHTML = `<section class="assistant-panel" role="dialog" aria-label="用药助手"><div class="assistant-head"><strong>用药助手</strong><button data-action="assistant-toggle" aria-label="关闭用药助手">×</button></div><div class="assistant-messages" id="assistant-messages">${messages}${assistantBusy ? '<div class="assistant-message">正在处理…</div>' : ''}</div>${documentView}<div class="assistant-examples"><button data-action="assistant-prompt" data-question="今天几点吃药？">今天几点吃药？</button><label class="assistant-upload" for="assistant-photo">上传说明书<input id="assistant-photo" type="file" accept="image/jpeg,image/png,image/webp" hidden ${assistantBusy ? 'disabled' : ''}></label></div><form id="assistant-form" class="assistant-form"><input id="assistant-input" maxlength="500" placeholder="输入药品或计划问题" aria-label="向用药助手提问"><button class="primary" type="submit" ${assistantBusy ? 'disabled' : ''}>发送</button></form></section>`;
  $('#assistant-messages').scrollTop = $('#assistant-messages').scrollHeight;
}
async function askAssistant(question) {
  question = question.trim();
  if (!question || assistantBusy) return;
  if (assistantDocument && !assistantDocument.confirmed) return toast('请先核对并确认说明书文字，或移除说明书');
  const history = assistantMessages.filter(message => message.role === 'user').slice(-6).map(message => ({ role: 'user', content: message.content }));
  assistantMessages.push({ role: 'user', content: question });
  assistantBusy = true; renderAssistant();
  try {
    const snapshot = activePlans().map(plan => ({ active: plan.active, mode: plan.mode, startDate: plan.startDate, endDate: plan.endDate, medicines: plan.medicines.map(med => ({ name: med.name, dose: med.dose, unit: med.unit, times: med.times })) }));
    const document = assistantDocument?.confirmed ? { text: assistantDocument.text, confirmed: true } : undefined;
    const response = await fetch('/api/assistant', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, plans: snapshot, today: today(), history, document }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '暂时无法回答');
    assistantMessages.push({ role: 'assistant', content: body.answer, sources: body.sources || [] });
  } catch (error) {
    assistantMessages.push({ role: 'assistant', content: `暂时无法回答：${error.message}`, sources: [] });
  } finally { assistantBusy = false; renderAssistant(); }
}
async function selectAssistantPhoto(file) {
  if (!file || assistantBusy) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) return toast('请选择不超过 5 MB 的 JPG、PNG 或 WebP 照片');
  assistantBusy = true; renderAssistant();
  try {
    const imageData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('无法读取照片'));
      reader.readAsDataURL(file);
    });
    const response = await fetch('/api/parse-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: imageData }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '照片暂时无法识别');
    if (body.documentType !== 'leaflet') throw new Error('这张照片未识别为药品说明书，请选择说明书照片');
    assistantDocument = { name: file.name, imageData, text: body.text.slice(0, 6000), confirmed: false };
    assistantMessages.push({ role: 'assistant', content: '已识别说明书文字。请对照原图检查并修改识别错误，确认后再提问。', sources: [] });
  } catch (error) { toast(error.message); }
  finally { assistantBusy = false; renderAssistant(); }
}
function shell(title, body) {
  $('#sheet-root').innerHTML = `<div class="sheet-overlay"><section class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sheet-handle"></div><div class="sheet-head"><h2>${esc(title)}</h2><button data-action="close" aria-label="关闭">×</button></div>${body}</section></div>`;
}
function medicationEditor(med, index) {
  if (draft.mode === 'asNeeded') {
    return `<div class="med-editor"><h3>说明书建议草稿</h3>${med.sources ? `<div class="source-line">原文：${esc(med.sources)}</div>` : ''}<div class="kv"><span>药品</span><span>${esc(med.name || '待选择人群')}</span></div><div class="kv"><span>单次用量</span><span>${esc(med.dose || '请选择适用人群')} ${esc(med.unit)}</span></div><div class="notice">按需计划不会生成固定服药时刻或到点催服提醒。只有实际使用后，才手动记录一次。</div><label class="form-label">对应药格</label><select class="select" data-med="${index}" data-field="slot"><option value="0">请选择药格</option>${[1,2,3].map(n => `<option value="${n}" ${Number(med.slot) === n ? 'selected' : ''}>${n} 号药格</option>`).join('')}</select></div>`;
  }
  const customUnit = med.unitCustom || (med.unit && !UNIT_OPTIONS.includes(med.unit));
  const unitChoice = customUnit ? 'other' : med.unit;
  const timeRows = (med.times.length ? med.times : ['']).map((time, timeIndex) => `<div class="time-row"><input class="input" type="time" step="60" aria-label="第 ${timeIndex + 1} 次执行时间" data-med="${index}" data-time-index="${timeIndex}" value="${esc(time)}">${timeIndex > 0 ? `<button class="time-remove" type="button" data-action="remove-time" data-med="${index}" data-time-index="${timeIndex}" aria-label="移除第 ${timeIndex + 1} 次时间">移除</button>` : ''}</div>`).join('');
  return `<div class="med-editor"><div class="row"><h3>药品 ${index + 1}</h3>${draft.medicines.length > 1 ? `<button class="link-button stop" data-action="remove-med" data-index="${index}">移除</button>` : ''}</div>${med.sources ? `<div class="source-line">原文：${esc(med.sources)}</div>` : ''}<label class="form-label">药品名称</label><input class="input" data-med="${index}" data-field="name" value="${esc(med.name)}" placeholder="按已有安排填写"><div class="form-grid"><div><label class="form-label">单次用量</label><input class="input" data-med="${index}" data-field="dose" value="${esc(med.dose)}" placeholder="例如 1"></div><div><label class="form-label">单位</label><select class="select" data-med="${index}" data-field="unit-choice"><option value="" ${!unitChoice ? 'selected' : ''}>请选择单位</option>${UNIT_OPTIONS.map(unit => `<option value="${unit}" ${unitChoice === unit ? 'selected' : ''}>${unit}</option>`).join('')}<option value="other" ${unitChoice === 'other' ? 'selected' : ''}>其他单位</option></select></div></div>${customUnit ? `<input class="input custom-unit" data-med="${index}" data-field="unit" value="${esc(med.unit)}" placeholder="请输入单位" aria-label="其他单位">` : ''}<label class="form-label">执行时间（24 小时制）</label>${timeRows}${med.times.length < 6 ? `<button class="link-button" type="button" data-action="add-time" data-med="${index}">＋ 添加时间</button>` : ''}<div class="field-note">请选择 HH:MM 格式的时间；多次服用可逐项添加。</div><label class="form-label">对应药格</label><select class="select" data-med="${index}" data-field="slot"><option value="0">请选择药格</option>${[1,2,3].map(n => `<option value="${n}" ${Number(med.slot) === n ? 'selected' : ''}>${n} 号药格</option>`).join('')}</select><div class="field-note">药格位置预览</div><div class="slot-grid mini">${[1,2,3].map(n => `<div class="slot ${Number(med.slot) === n ? 'active' : ''}"><b>${n}</b></div>`).join('')}</div></div>`;
}
function photoReview(expanded = false) {
  if (!draft.photoText) return '';
  const kind = draft.photoKind === 'leaflet' ? '药品说明书' : draft.photoKind === 'prescription' ? '处方或用药安排' : '其他图片';
  return `<div class="notice">已识别为${kind}。请对照原照片核对文字；看不清或缺失的字段需要依据原件补充。${draft.photoKind === 'leaflet' ? '说明书可提供分人群用量与使用限制草稿；请先确认适用人群和用途，不会自动安排固定服药时刻。' : ''}</div><details class="photo-text" ${expanded ? 'open' : ''}><summary>查看原照片与识别文字</summary>${draft.imageData ? `<img class="photo-preview" src="${draft.imageData}" alt="原照片">` : ''}<pre>${esc(draft.photoText)}</pre></details>`;
}
function leafletGuidanceView() {
  const guidance = draft.leafletGuidance;
  if (!guidance) return '';
  const lines = [guidance.interval?.evidence, guidance.maxPer24h?.evidence, guidance.durationLimits?.pain?.evidence, guidance.durationLimits?.fever?.evidence].filter(Boolean);
  return `<div class="card"><div class="row-title">说明书建议 · ${esc(guidance.name)}</div><p class="row-sub">以下内容只来自已识别的说明书原文。请先对照照片核对年龄人群、禁忌、正在使用的其他药品和医嘱。</p><label class="form-label">适用人群（由你选择）</label><select class="select" data-draft="selectedDoseOption"><option value="">请选择与本人相符的人群</option>${guidance.doseOptions.map((option, index) => `<option value="${index}" ${String(draft.selectedDoseOption) === String(index) ? 'selected' : ''}>${esc(option.group)} · 每次 ${esc(option.dose)} ${esc(option.unit)}</option>`).join('')}</select><label class="form-label">本次用途（由你选择）</label><select class="select" data-draft="purpose"><option value="">请选择</option><option value="pain" ${draft.purpose === 'pain' ? 'selected' : ''}>缓解疼痛</option><option value="fever" ${draft.purpose === 'fever' ? 'selected' : ''}>退热</option></select>${guidance.conditionalEvidence ? `<div class="source-line">按需条件原文：${esc(guidance.conditionalEvidence)}</div>` : ''}${lines.map(line => `<div class="source-line">${esc(line)}</div>`).join('')}<div class="field-note">间隔、24 小时次数和使用天数是上限或条件，不代表应当按上限服药。若有个人医嘱或不确定是否适用，请先咨询医生或药师。</div></div>`;
}
function createSheet() {
  const steps = `<div class="steps">${[1,2,3].map(n => `<span class="${n <= step ? 'on' : ''}"></span>`).join('')}</div>`;
  if (step === 1) {
    shell('建立计划', `${steps}<p class="lead">上传说明书后自动填写计划草稿；缺少的信息由你补充并确认。</p><label class="form-label">计划名称</label><input class="input" data-draft="title" value="${esc(draft.title)}" placeholder="例如 近期用药"><div class="form-grid"><div><label class="form-label">开始日期</label><input class="input" type="date" data-draft="startDate" value="${esc(draft.startDate)}"></div><div><label class="form-label">结束日期</label><input class="input" type="date" data-draft="endDate" value="${esc(draft.endDate)}"></div></div><label class="form-label">已有用药安排</label><textarea class="textarea" data-draft="sourceText" placeholder="可粘贴已有安排，随后核对提取结果">${esc(draft.sourceText)}</textarea><div class="field-note">自动整理的内容需要逐项核对；没有配置时可直接手动填写。</div><div class="button-row" style="margin-top:18px"><button class="secondary" data-action="manual">手动填写</button><button class="primary" data-action="parse" ${busy ? 'disabled' : ''}>${busy ? '整理中…' : '整理安排'}</button></div><div class="section-title">从照片整理</div><p class="row-sub">支持处方或药品说明书照片。说明书识别后会自动填写草稿；照片文件不保存在计划中。</p><div class="photo-choices"><label class="secondary photo-picker" for="camera-photo">拍照<input id="camera-photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" data-photo-input hidden></label><label class="secondary photo-picker" for="upload-photo">选择照片<input id="upload-photo" type="file" accept="image/jpeg,image/png,image/webp" data-photo-input hidden></label></div>${draft.imageData ? `<img class="photo-preview" src="${draft.imageData}" alt="待识别照片"><div class="field-note">${esc(draft.imageName)} · 请确认照片清晰且文字完整</div><button class="primary full" data-action="parse-image" ${busy ? 'disabled' : ''}>${busy ? '识别并填写中…' : '识别并填写草稿'}</button>` : ''}${photoReview()}${draft.leafletError ? `<div class="notice">自动填写失败：${esc(draft.leafletError)}。请核对识别文字后重新提取。</div>` : ""}${draft.photoKind === 'leaflet' ? `<label class="form-label">核对并修正识别文字</label><textarea class="textarea" data-draft="photoText" maxlength="12000">${esc(draft.photoText)}</textarea><button class="primary full" data-action="extract-leaflet" ${busy ? 'disabled' : ''}>${busy ? '提取中…' : '提取说明书建议'}</button>` : ''}`);
    return;
  }
  if (step === 2) {
    const used = [...occupiedSlots(draft, activePlans())].sort();
    shell('核对药品', `${steps}<p class="lead">${draft.leafletGuidance ? '已按说明书填写药品建议，日期暂填今天；请选择适用人群和用途，再核对计划。' : '逐项核对药品、用量、时间和药格，缺少的内容请依据原安排补充。'}</p>${photoReview()}${draft.leafletError ? `<div class="notice">自动填写失败：${esc(draft.leafletError)}。请核对识别文字后重新提取。</div>` : ""}${draft.leafletGuidance ? leafletGuidanceView() : ''}${draft.photoText ? `<div class="form-grid"><div><label class="form-label">开始日期</label><input class="input" type="date" data-draft="startDate" value="${esc(draft.startDate)}"></div><div><label class="form-label">结束日期</label><input class="input" type="date" data-draft="endDate" value="${esc(draft.endDate)}"></div></div>` : ''}${used.length ? `<div class="notice">当前时段已有计划占用 ${used.join('、')} 号药格，请为新计划选择其他药格。</div>` : ''}${draft.medicines.map(medicationEditor).join('')}${!draft.leafletGuidance && draft.medicines.length < 3 ? `<button class="ghost full" data-action="add-med">＋ 添加药品</button>` : ''}<div class="button-row" style="margin-top:18px"><button class="secondary" data-action="step-back">上一步</button><button class="primary" data-action="review">查看计划</button></div>`);
    return;
  }
  const errors = validPlan(draft);
  const count = errors.length ? 0 : createPlan(draft, 'preview').tasks.length;
  shell('确认计划', `${steps}<p class="lead">已生成计划草稿。请对照原照片或原安排核对，确认后计划才会生效。</p>${draft.photoText ? photoReview(true) : ''}<div class="card"><div class="row-title">${esc(draft.title || '短期用药计划')}</div><div class="row-sub">${formatDay(draft.startDate)} — ${formatDay(draft.endDate)} · ${draft.mode === 'asNeeded' ? '按需记录，不生成定时任务' : `共 ${count} 项任务`}</div><hr class="divider">${draft.medicines.map(m => `<div class="kv"><span>${esc(m.name)}</span><span>${esc(m.dose)} ${esc(m.unit)} · ${draft.mode === 'asNeeded' ? '按需' : esc(m.times.join('、'))} · ${m.slot} 号格</span></div>`).join('')}${draft.mode === 'asNeeded' ? `<div class="source-line">已选人群：${esc(draft.leafletGuidance.doseOptions[Number(draft.selectedDoseOption)].group)}；用途：${draft.purpose === 'pain' ? '缓解疼痛' : '退热'}</div>` : ''}</div><div class="notice">${draft.mode === 'asNeeded' ? '说明书的间隔、次数和天数是限制条件，不是定时服药建议。请确认所选人群与用途适用于本人；如有个人医嘱，以专业人员确认的安排为准。' : '开盒只会留下事件记录。只有你主动确认，任务才会显示“已确认”。'}</div><label class="row small"><input type="checkbox" id="review-checked"> <span>${draft.mode === 'asNeeded' ? '我已对照说明书核对适用人群、用量、用途、日期、药格及注意事项' : '我已核对药品、单次用量、日期、时间和药格'}</span></label><div class="button-row" style="margin-top:19px"><button class="secondary" data-action="step-back">返回修改</button><button class="primary" data-action="activate">确认并创建计划</button></div>`);
}
function taskSheet() {
  const { plan, task } = byId(selectedTask.planId, selectedTask.taskId);
  if (!plan || !task) return closeSheet();
  const med = medicine(plan, task);
  const ordered = task.events.slice().reverse();
  const actions = task.status === 'confirmed'
    ? `<button class="ghost full" data-action="correct">更正记录</button>`
    : task.status === 'cancelled'
      ? ''
      : `<div class="button-row"><button class="secondary" data-action="open-event">记录开盒</button><button class="secondary" data-action="uncertain">不确定</button></div><div class="button-row" style="margin-top:8px"><button class="ghost" data-action="remind">稍后提醒</button><button class="primary" data-action="confirm-selected">我已服用</button></div>`;
  const details = `<div class="card"><div class="row"><div><div class="eyebrow">${formatDay(task.scheduledAt.slice(0,10))} · ${formatTime(task.scheduledAt)}</div><div class="task-name">${esc(med.name)}</div><div class="task-meta">${esc(med.dose)} ${esc(med.unit)} · ${esc(med.slot)} 号药格${task.remindAt ? `<br>下次提醒：${esc(new Date(task.remindAt).toLocaleString('zh-CN'))}` : ''}</div></div><span class="pill">${statusLabel(task.status)}</span></div>${med.sources ? `<hr class="divider"><div class="source-line">安排原文：${esc(med.sources)}</div>` : ''}</div><div class="section-title">任务记录</div><div class="card">${ordered.length ? `<ul class="timeline">${ordered.map(e => `<li><b>${esc(eventLabel(e))}</b><p>${esc(new Date(e.at).toLocaleString('zh-CN'))} · ${e.source === 'device' ? '药盒' : '手动记录'}</p></li>`).join('')}</ul>` : `<div class="row-sub">目前没有记录</div>`}</div><div class="notice">开盒记录无法证明已服用。如果不确定，请先查看记录并保留待核实状态。</div>${actions}`;
  shell('任务详情', details);
}
function planSheet() {
  const plan = plans.find(p => p.id === selectedTask?.planId);
  if (!plan) return closeSheet();
  if (plan.mode === 'asNeeded') {
    const med = plan.medicines[0];
    const guidance = plan.leafletGuidance || {};
    const excerpts = [guidance.doseOptions?.[plan.selectedDoseOption]?.evidence, guidance.interval?.evidence, guidance.maxPer24h?.evidence, guidance.durationLimits?.[plan.purpose]?.evidence].filter(Boolean);
    shell('按需计划详情', `<div class="card"><div class="row-title">${esc(plan.title)}</div><div class="row-sub">${formatDay(plan.startDate)} — ${formatDay(plan.endDate)} · ${esc(med.name)} · ${esc(med.dose)} ${esc(med.unit)}</div><div class="row-sub">已选人群：${esc(guidance.doseOptions?.[plan.selectedDoseOption]?.group || '')} · 用途：${plan.purpose === 'pain' ? '缓解疼痛' : '退热'} · ${esc(med.slot)} 号药格</div></div><div class="section-title">说明书依据</div><div class="card">${excerpts.map(line => `<div class="source-line">${esc(line)}</div>`).join('')}<div class="field-note">请始终对照原说明书，必要时咨询医生或药师。</div></div><div class="section-title">已记录的使用</div><div class="card">${plan.prnEvents?.length ? `<ul class="timeline">${plan.prnEvents.slice().reverse().map(event => `<li><b>已服用</b><p>${esc(new Date(event.at).toLocaleString('zh-CN'))} · 手动记录</p></li>`).join('')}</ul>` : '<div class="row-sub">尚无使用记录</div>'}</div>${plan.active && plan.startDate <= today() && plan.endDate >= today() ? `<button class="primary full" data-action="record-prn" data-plan="${esc(plan.id)}">记录已服用</button>` : ''}${plan.active ? `<button class="danger full delete-plan-button" data-action="stop" data-plan="${esc(plan.id)}">停止此计划</button>` : ''}<button class="danger full delete-plan-button" data-action="delete-plan" data-plan="${esc(plan.id)}">删除计划及其记录</button>`);
    return;
  }
  const medRows = plan.medicines.map(m => `<div class="kv"><span>${esc(m.name)}</span><span>${esc(m.times.join('、'))} · ${esc(m.slot)} 号格</span></div>`).join('');
  const taskRows = plan.tasks.slice(0, 80).map(t => `<div class="row" style="padding:10px 0;border-top:1px solid #edf0eb"><div><div class="row-title small">${formatDay(t.scheduledAt.slice(0,10))} ${formatTime(t.scheduledAt)} · ${esc(medicine(plan,t).name)}</div><div class="row-sub">${statusLabel(t.status)}</div></div><button class="link-button" data-action="task" data-plan="${esc(plan.id)}" data-task="${esc(t.id)}">查看 ›</button></div>`).join('');
  shell('计划详情', `<div class="card"><div class="row-title">${esc(plan.title)}</div><div class="row-sub">${formatDay(plan.startDate)} — ${formatDay(plan.endDate)}</div><hr class="divider">${medRows}</div><div class="section-title">任务时间表</div><div class="card">${taskRows}${plan.tasks.length > 80 ? `<p class="row-sub">仅显示前 80 项</p>` : ''}</div>${plan.active ? `<button class="danger full" data-action="stop" data-plan="${esc(plan.id)}">停止此计划的提醒</button>` : ''}<button class="danger full delete-plan-button" data-action="delete-plan" data-plan="${esc(plan.id)}">删除计划及其记录</button>`);
}
function renderSheet() {
  if (!sheet) { $('#sheet-root').innerHTML = ''; return; }
  if (sheet === 'create') createSheet();
  if (sheet === 'task') taskSheet();
  if (sheet === 'plan') planSheet();
}

function updateTask(planId, taskId, updater) {
  const plan = plans.find(p => p.id === planId);
  if (!plan) return;
  const index = plan.tasks.findIndex(t => t.id === taskId);
  if (index < 0) return;
  plan.tasks[index] = updater(plan.tasks[index]);
  save(); render();
}
function commitEvent(type) {
  if (!selectedTask) return;
  updateTask(selectedTask.planId, selectedTask.taskId, task => addEvent(task, type));
  toast(({ opened:'已记录开盒', confirmed:'已确认本项任务', uncertain:'已标记待核实', corrected:'已更正记录' })[type]);
}
async function parseSource() {
  if (!draft.sourceText.trim()) { toast('请先填写已有安排'); return; }
  busy = true; renderSheet();
  try {
    const response = await fetch('/api/parse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: draft.sourceText }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '暂时无法整理');
    draft.mode = 'fixed';
    draft.leafletGuidance = null;
    draft.selectedDoseOption = '';
    draft.purpose = '';
    draft.medicines = body.medications.map((m, i) => ({ name:m.name, dose:m.dose, unit:m.unit, unitCustom: Boolean(m.unit && !UNIT_OPTIONS.includes(m.unit)), times:m.times, slot:i+1, sources:m.sources }));
    const starts = body.medications.map(m => m.startDate).filter(Boolean);
    const ends = body.medications.map(m => m.endDate).filter(Boolean);
    if (starts.length === body.medications.length && new Set(starts).size === 1) draft.startDate = starts[0];
    if (ends.length === body.medications.length && new Set(ends).size === 1) draft.endDate = ends[0];
    step = 2;
    toast('请逐项核对整理结果');
  } catch (error) { toast(error.message); }
  finally { busy = false; renderSheet(); }
}
function selectPhoto(file) {
  if (!file) return;
  if (busy) return toast('当前照片处理中，请稍后重新选择');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return toast('请选择 JPG、PNG 或 WebP 照片');
  if (file.size > 5 * 1024 * 1024) return toast('照片不能超过 5 MB');
  const currentDraft = draft;
  const reader = new FileReader();
  reader.onload = () => {
    if (draft !== currentDraft || sheet !== 'create') return;
    draft.imageData = String(reader.result || '');
    draft.imageName = file.name;
    draft.photoText = '';
    draft.photoKind = '';
    draft.leafletError = '';
    draft.mode = 'fixed';
    draft.leafletGuidance = null;
    draft.selectedDoseOption = '';
    draft.purpose = '';
    renderSheet();
    parseImage();
  };
  reader.onerror = () => toast('无法读取照片，请重新选择');
  reader.readAsDataURL(file);
}
async function parseImage() {
  if (!draft.imageData || busy) return;
  const currentDraft = draft;
  busy = true; renderSheet();
  try {
    const response = await fetch('/api/parse-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: currentDraft.imageData }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || '照片暂时无法识别');
    if (draft !== currentDraft || sheet !== 'create') return;
    draft.photoText = body.text;
    draft.photoKind = body.documentType;
    draft.leafletError = '';
    draft.startDate = '';
    draft.endDate = '';
    if (body.documentType === 'prescription' && body.medications?.length) {
      draft.sourceText = body.text;
      draft.medicines = body.medications.map((m, i) => ({ name:m.name, dose:m.dose, unit:m.unit, unitCustom:Boolean(m.unit && !UNIT_OPTIONS.includes(m.unit)), times:m.times, slot:i+1, sources:m.sources }));
      const starts = body.medications.map(m => m.startDate).filter(Boolean);
      const ends = body.medications.map(m => m.endDate).filter(Boolean);
      if (starts.length === body.medications.length && new Set(starts).size === 1) draft.startDate = starts[0];
      if (ends.length === body.medications.length && new Set(ends).size === 1) draft.endDate = ends[0];
      const ready = !validPlan(draft).length && !conflictingSlots(draft, activePlans()).length;
      step = ready ? 3 : 2;
      toast(ready ? '已生成计划草稿，请对照照片确认' : '识别完成，请补充或核对缺少的信息');
    } else if (body.documentType === 'leaflet') {
      draft.sourceText = '';
      draft.mode = 'fixed';
      draft.leafletGuidance = null;
      draft.selectedDoseOption = '';
      draft.purpose = '';
      draft.medicines = [emptyMed()];
      step = 1;
      toast('说明书已识别，正在自动填写计划草稿');
      renderSheet();
      try {
        const guidance = await requestLeafletGuidance(body.text);
        if (draft !== currentDraft || sheet !== 'create') return;
        if (draft.photoText !== body.text) return toast('识别文字已修改，请重新提取说明书建议');
        applyLeafletGuidance(guidance);
        toast('已填写说明书计划草稿，请补充并核对信息');
      } catch (error) {
        if (draft === currentDraft) {
          draft.leafletError = error.message;
          toast('已识别说明书，但自动填写失败；请查看原因并重试');
        }
      }
    } else {
      draft.sourceText = '';
      draft.medicines = [emptyMed()];
      toast('已识别文字，请核对后手动填写');
    }
  } catch (error) { if (draft === currentDraft) toast(error.message); }
  finally { busy = false; if (draft === currentDraft && sheet === 'create') renderSheet(); }
}
async function requestLeafletGuidance(text) {
  const response = await fetch('/api/parse-leaflet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '暂时无法提取说明书建议');
  return body;
}
function applyLeafletGuidance(guidance) {
  draft.leafletError = '';
  draft.leafletGuidance = guidance;
  draft.mode = guidance.mode;
  draft.selectedDoseOption = '';
  draft.purpose = '';
  draft.startDate = today();
  draft.endDate = today();
  const usedSlots = occupiedSlots(draft, activePlans());
  const availableSlot = [1, 2, 3].find(slot => !usedSlots.has(slot)) || 0;
  draft.medicines = [{ ...emptyMed(), name: guidance.name, slot: availableSlot }];
  if (!draft.title) draft.title = `${guidance.name}短期计划`;
  step = 2;
}
async function extractLeaflet() {
  if (busy || draft.photoKind !== 'leaflet' || !draft.photoText.trim()) return;
  const currentDraft = draft;
  busy = true; renderSheet();
  try {
    const source = currentDraft.photoText;
    const body = await requestLeafletGuidance(source);
    if (draft !== currentDraft || sheet !== 'create') return;
    if (draft.photoText !== source) return toast('识别文字已修改，请重新提取说明书建议');
    applyLeafletGuidance(body);
    toast(body.mode === 'asNeeded' ? '已生成按需建议草稿，请选择人群和用途' : '已提取说明书用量，请补充个人执行时间');
  } catch (error) { if (draft === currentDraft) { draft.leafletError = error.message; toast('提取失败，请查看原因并重试'); } }
  finally { busy = false; if (draft === currentDraft && sheet === 'create') renderSheet(); }
}

document.addEventListener('input', event => {
  const el = event.target;
  if (el.id === 'assistant-document-text' && assistantDocument) {
    assistantDocument.text = el.value;
    assistantDocument.confirmed = false;
    const confirmButton = document.querySelector('[data-action="assistant-confirm-document"]');
    if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = '确认文字作为提问依据'; }
    return;
  }
  if (el.dataset.draft) {
    draft[el.dataset.draft] = el.value;
    if (el.dataset.draft === 'photoText') draft.leafletGuidance = null;
  }
  if (el.dataset.med !== undefined) {
    const med = draft.medicines[Number(el.dataset.med)];
    if (!med) return;
    if (el.dataset.timeIndex !== undefined) {
      med.times[Number(el.dataset.timeIndex)] = el.value;
      return;
    }
    if (el.dataset.field === 'unit-choice') return;
    med[el.dataset.field] = el.dataset.field === 'slot' ? Number(el.value) : el.value;
  }
});
document.addEventListener('change', event => {
  const el = event.target;
  if (el.id === 'assistant-photo') return selectAssistantPhoto(el.files?.[0]);
  if (el.matches('[data-photo-input]')) return selectPhoto(el.files?.[0]);
  if (el.dataset.draft) draft[el.dataset.draft] = el.value;
  if (el.dataset.draft === 'selectedDoseOption' && draft.leafletGuidance) {
    const option = el.value === '' ? null : draft.leafletGuidance.doseOptions[Number(el.value)];
    const med = draft.medicines[0];
    med.name = draft.leafletGuidance.name;
    med.dose = option?.dose || '';
    med.unit = option?.unit || '';
    med.sources = option?.evidence || '';
    return renderSheet();
  }
  if (el.dataset.draft === 'purpose' && draft.leafletGuidance) return renderSheet();
  if (el.dataset.med !== undefined && el.dataset.timeIndex !== undefined) {
    draft.medicines[Number(el.dataset.med)].times[Number(el.dataset.timeIndex)] = el.value;
  }
  if (el.dataset.med !== undefined && el.dataset.field === 'unit-choice') {
    const med = draft.medicines[Number(el.dataset.med)];
    med.unitCustom = el.value === 'other';
    med.unit = med.unitCustom ? '' : el.value;
    const position = document.querySelector('.sheet')?.scrollTop || 0;
    renderSheet(); document.querySelector('.sheet').scrollTop = position;
  }
  if (el.dataset.med !== undefined && el.dataset.field === 'slot') {
    draft.medicines[Number(el.dataset.med)].slot = Number(el.value);
    const position = document.querySelector('.sheet')?.scrollTop || 0;
    renderSheet(); document.querySelector('.sheet').scrollTop = position;
  }
});
document.addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { activeTab = tab.dataset.tab; closeSheet(); render(); return; }
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  if (action === 'assistant-toggle') { assistantOpen = !assistantOpen; renderAssistant(); if (assistantOpen) $('#assistant-input')?.focus(); return; }
  if (action === 'assistant-prompt') return askAssistant(button.dataset.question || '');
  if (action === 'assistant-clear-document') { assistantDocument = null; renderAssistant(); return; }
  if (action === 'assistant-confirm-document') {
    if (!assistantDocument || assistantDocument.text.trim().length < 20) return toast('请先核对至少 20 字说明书文字');
    assistantDocument.confirmed = true; renderAssistant(); return toast('已确认说明书文字');
  }
  if (action === 'create') return openCreate();
  if (action === 'close') return closeSheet();
  if (action === 'manual') { draft.mode='fixed'; draft.leafletGuidance=null; draft.selectedDoseOption=''; draft.purpose=''; step=2; return renderSheet(); }
  if (action === 'parse') return parseSource();
  if (action === 'parse-image') return parseImage();
  if (action === 'extract-leaflet') return extractLeaflet();
  if (action === 'add-med') { draft.medicines.push(emptyMed()); return renderSheet(); }
  if (action === 'remove-med') { draft.medicines.splice(Number(button.dataset.index), 1); return renderSheet(); }
  if (action === 'add-time') {
    const med = draft.medicines[Number(button.dataset.med)];
    if (med.times.length >= 6) return;
    if (!med.times.length) med.times.push('');
    med.times.push('');
    const position = document.querySelector('.sheet')?.scrollTop || 0;
    renderSheet(); document.querySelector('.sheet').scrollTop = position;
    return;
  }
  if (action === 'remove-time') {
    const med = draft.medicines[Number(button.dataset.med)];
    med.times.splice(Number(button.dataset.timeIndex), 1);
    const position = document.querySelector('.sheet')?.scrollTop || 0;
    renderSheet(); document.querySelector('.sheet').scrollTop = position;
    return;
  }
  if (action === 'step-back') { step=Math.max(1,step-1); return renderSheet(); }
  if (action === 'review') {
    const errors = validPlan(draft); if (errors.length) return toast(errors[0]);
    const conflicts = conflictingSlots(draft, activePlans());
    if (conflicts.length) return toast(`${conflicts[0]} 号药格已被同期计划占用`);
    step=3; return renderSheet();
  }
  if (action === 'activate') {
    if (!$('#review-checked')?.checked) return toast('请先核对计划内容');
    const conflicts = conflictingSlots(draft, activePlans());
    if (conflicts.length) return toast(`${conflicts[0]} 号药格已被同期计划占用`);
    try { plans.push(createPlan(draft)); save(); closeSheet(); activeTab='home'; render(); toast('计划已创建并启用'); if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); }
    catch(error) { toast(error.message); }
    return;
  }
  if (action === 'task') { selectedTask={planId:button.dataset.plan,taskId:button.dataset.task}; sheet='task'; return renderSheet(); }
  if (action === 'plan') { selectedTask={planId:button.dataset.plan}; sheet='plan'; return renderSheet(); }
  if (action === 'record-prn') {
    const plan = plans.find(item => item.id === button.dataset.plan);
    if (!plan || plan.mode !== 'asNeeded' || !plan.active || today() < plan.startDate || today() > plan.endDate) return toast('当前按需计划未生效');
    const warnings = asNeededUseWarnings(plan);
    const message = warnings.length
      ? `${warnings.join('；')}。若已经实际服用，仍可如实记录；请勿据此再次服药，并向医生或药师咨询。确定记录这次已经发生的使用吗？`
      : `确认记录刚刚已服用 ${plan.medicines[0].name} ${plan.medicines[0].dose}${plan.medicines[0].unit}？此操作只记录事实，不建议现在服药。`;
    if (!confirm(message)) return;
    const index = plans.indexOf(plan);
    plans[index] = addAsNeededUse(plan);
    save(); render(); toast('已记录这次使用');
    return;
  }
  if (action === 'delete-plan') {
    const index = plans.findIndex(plan => plan.id === button.dataset.plan);
    if (index < 0) return toast('计划不存在');
    if (!confirm(`确定删除“${plans[index].title}”？该计划的任务和记录也会一并删除，无法恢复。`)) return;
    plans.splice(index, 1);
    save(); closeSheet(); render(); toast('计划已删除');
    return;
  }
  if (action === 'confirm') { selectedTask={planId:button.dataset.plan,taskId:button.dataset.task}; return commitEvent('confirmed'); }
  if (action === 'confirm-selected') return commitEvent('confirmed');
  if (action === 'open-event') return commitEvent('opened');
  if (action === 'uncertain') return commitEvent('uncertain');
  if (action === 'correct') return commitEvent('corrected');
  if (action === 'remind') {
    const minutes = prompt('多少分钟后再次提醒？请输入 5、10 或 15', '10');
    if (!['5','10','15'].includes(minutes)) return toast('请选择 5、10 或 15 分钟');
    const { plan, task }=byId(selectedTask.planId,selectedTask.taskId);
    const next = new Date(Date.now()+Number(minutes)*60000);
    if (next > new Date(`${plan.endDate}T23:59:59`)) return toast('已超过计划结束时间');
    updateTask(plan.id,task.id,t=>({...addEvent(t,'reminded'),remindAt:next.toISOString()}));
    return toast(`已设置 ${minutes} 分钟后再次提醒`);
  }
  if (action === 'stop') {
    if (!confirm('停止此计划的后续提醒？历史记录仍会保留。')) return;
    const plan = plans.find(p=>p.id===button.dataset.plan); if(!plan) return;
    plan.active=false; plan.archivedAt=new Date().toISOString();
    plan.tasks=plan.tasks.map(t=>new Date(t.scheduledAt)>new Date() && t.status==='pending' ? {...t,status:'cancelled'}:t);
    save(); closeSheet(); render(); toast('已停止后续提醒');
  }
});

document.addEventListener('submit', event => {
  if (event.target.id !== 'assistant-form') return;
  event.preventDefault();
  askAssistant($('#assistant-input')?.value || '');
});

render();
renderAssistant();
setInterval(runReminders, 15000);
