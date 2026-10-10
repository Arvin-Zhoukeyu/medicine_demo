export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function validPlan(draft) {
  const errors = [];
  if (!draft || !/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate || '')) {
    errors.push('请填写开始和结束日期');
  } else {
    const start = new Date(`${draft.startDate}T12:00:00`);
    const end = new Date(`${draft.endDate}T12:00:00`);
    const days = Math.round((end - start) / 86400000) + 1;
    if (localDate(start) !== draft.startDate || localDate(end) !== draft.endDate || !Number.isFinite(days) || days < 1 || days > 30) errors.push('计划日期无效，时长应为 1 至 30 天');
  }
  if (!Array.isArray(draft.medicines) || draft.medicines.length < 1 || draft.medicines.length > 3) errors.push('请选择 1 至 3 种药品');
  const slots = new Set();
  for (const [index, med] of (draft.medicines || []).entries()) {
    if (!med.name?.trim()) errors.push(`第 ${index + 1} 种药品缺少名称`);
    if (!med.dose?.trim() || !med.unit?.trim()) errors.push(`第 ${index + 1} 种药品缺少用量或单位`);
    if (!Array.isArray(med.times) || !med.times.length || med.times.some(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))) errors.push(`第 ${index + 1} 种药品缺少明确时间`);
    if (Array.isArray(med.times) && new Set(med.times).size !== med.times.length) errors.push(`第 ${index + 1} 种药品的时间重复`);
    if (![1, 2, 3].includes(Number(med.slot))) errors.push(`第 ${index + 1} 种药品尚未绑定药格`);
    if (slots.has(Number(med.slot))) errors.push('药格不能重复绑定');
    slots.add(Number(med.slot));
  }
  return errors;
}

export function occupiedSlots(draft, plans) {
  const used = new Set();
  for (const plan of plans) {
    if (!plan.active || draft.endDate < plan.startDate || draft.startDate > plan.endDate) continue;
    for (const med of plan.medicines) used.add(Number(med.slot));
  }
  return used;
}

export function conflictingSlots(draft, plans) {
  const used = occupiedSlots(draft, plans);
  return draft.medicines.map(m => Number(m.slot)).filter(slot => used.has(slot));
}

export function createPlan(draft, id = `p-${Date.now()}`) {
  const errors = validPlan(draft);
  if (errors.length) throw new Error(errors[0]);
  const tasks = [];
  const cursor = new Date(`${draft.startDate}T12:00:00`);
  const last = new Date(`${draft.endDate}T12:00:00`);
  while (cursor <= last) {
    const day = localDate(cursor);
    draft.medicines.forEach((med, medIndex) => {
      med.times.forEach((time, timeIndex) => {
        tasks.push({ id: `${id}:${day}:${medIndex}:${timeIndex}`, medicineIndex: medIndex, scheduledAt: `${day}T${time}`, status: 'pending', events: [], remindAt: null });
      });
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  tasks.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  return { id, title: draft.title?.trim() || '短期用药计划', startDate: draft.startDate, endDate: draft.endDate, medicines: draft.medicines.map(m => ({ ...m, times: [...m.times] })), tasks, active: true, createdAt: new Date().toISOString() };
}

export function addEvent(task, type, at = new Date().toISOString(), source = 'user') {
  const next = { ...task, events: [...task.events, { id: `${type}-${at}-${task.events.length}`, type, at, source }] };
  if (type === 'confirmed') next.status = 'confirmed';
  if (type === 'uncertain') next.status = 'uncertain';
  if (type === 'corrected') next.status = 'pending';
  return next;
}

export function archiveIfEnded(plan, now = new Date()) {
  if (!plan.active) return plan;
  const end = new Date(`${plan.endDate}T23:59:59`);
  return now > end ? { ...plan, active: false, archivedAt: now.toISOString() } : plan;
}

export function statusLabel(status) {
  return ({ pending: '待确认', uncertain: '待核实', confirmed: '已确认', cancelled: '已取消' })[status] || '待确认';
}
