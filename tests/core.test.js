import test from 'node:test';
import assert from 'node:assert/strict';
import { validPlan, createPlan, addEvent, archiveIfEnded, conflictingSlots, asNeededUseWarnings, addAsNeededUse } from '../web/core.js';

const draft = () => ({
  title: '近期安排', startDate: '2026-10-10', endDate: '2026-10-12',
  medicines: [{ name: '药品甲', dose: '1', unit: '片', times: ['08:00', '20:00'], slot: 1 }],
});

test('明确日期和时间生成每次独立任务', () => {
  const plan = createPlan(draft(), 'test');
  assert.equal(plan.tasks.length, 6);
  assert.equal(new Set(plan.tasks.map(t => t.id)).size, 6);
  assert.equal(plan.tasks[0].scheduledAt, '2026-10-10T08:00');
});

test('缺少时间、重复格位和无效日期不能激活', () => {
  const missing = draft(); missing.medicines[0].times = [];
  assert.match(validPlan(missing).join(' '), /时间/);
  const repeated = draft(); repeated.medicines.push({ name:'药品乙',dose:'1',unit:'片',times:['09:00'],slot:1 });
  assert.match(validPlan(repeated).join(' '), /药格/);
  const invalid = draft(); invalid.endDate='2026-02-30';
  assert.match(validPlan(invalid).join(' '), /日期/);
});

test('开盒不改变任务状态，待核实和确认各自留痕', () => {
  const task = createPlan(draft(), 'test').tasks[0];
  const opened = addEvent(task, 'opened', '2026-10-10T08:01:00Z');
  assert.equal(opened.status, 'pending');
  const uncertain = addEvent(opened, 'uncertain', '2026-10-10T08:02:00Z');
  assert.equal(uncertain.status, 'uncertain');
  const confirmed = addEvent(uncertain, 'confirmed', '2026-10-10T08:03:00Z');
  assert.equal(confirmed.status, 'confirmed');
  assert.deepEqual(confirmed.events.map(e => e.type), ['opened', 'uncertain', 'confirmed']);
});

test('到期归档保留未确认状态', () => {
  const plan = createPlan(draft(), 'test');
  const archived = archiveIfEnded(plan, new Date('2026-10-13T00:00:01'));
  assert.equal(archived.active, false);
  assert.equal(archived.tasks[0].status, 'pending');
});

test('同期计划不能重复占用药格，不同期计划可复用', () => {
  const first = createPlan(draft(), 'first');
  const second = draft();
  second.medicines[0].slot = 2;
  assert.deepEqual(conflictingSlots(second, [first]), []);
  second.medicines[0].slot = 1;
  assert.deepEqual(conflictingSlots(second, [first]), [1]);
  second.startDate = '2026-10-13'; second.endDate = '2026-10-14';
  assert.deepEqual(conflictingSlots(second, [first]), []);
});

const leafletDraft = () => ({
  title: '说明书按需计划', mode: 'asNeeded', startDate: '2026-10-10', endDate: '2026-10-12', purpose: 'fever', selectedDoseOption: '1',
  leafletGuidance: {
    name: '测试颗粒', doseOptions: [{ group: '4~8岁儿童', dose: '0.5', unit: '包', evidence: '4~8岁儿童，一次0.5包' }, { group: '8岁以上儿童及成人', dose: '1', unit: '包', evidence: '8岁以上儿童及成人，一次1包' }],
    interval: { minHours: 4, maxHours: 6, evidence: '间隔4~6小时' }, maxPer24h: { count: 4, evidence: '24小时不超过4次' },
    durationLimits: { fever: { maxDays: 3, evidence: '用于解热不得超过3天' }, pain: { maxDays: 5, evidence: '用于止痛不得超过5天' } },
  },
  medicines: [{ name: '测试颗粒', dose: '1', unit: '包', times: [], slot: 1 }],
});

test('说明书按需计划不生成固定时间任务，且须选择适用人群', () => {
  const draft = leafletDraft();
  assert.equal(validPlan(draft).length, 0);
  const plan = createPlan(draft, 'leaflet');
  assert.equal(plan.tasks.length, 0);
  assert.equal(plan.mode, 'asNeeded');
  draft.selectedDoseOption = '';
  assert.match(validPlan(draft).join(' '), /人群/);
});

test('按需计划校验用途天数和说明书选项用量', () => {
  const draft = leafletDraft();
  draft.endDate = '2026-10-13';
  assert.match(validPlan(draft).join(' '), /天数/);
  draft.endDate = '2026-10-12';
  draft.medicines[0].dose = '2';
  assert.match(validPlan(draft).join(' '), /用量/);
});

test('按需使用记录检查滚动 24 小时次数与最短间隔', () => {
  let plan = createPlan(leafletDraft(), 'leaflet');
  plan = addAsNeededUse(plan, '2026-10-10T08:00:00Z');
  assert.match(asNeededUseWarnings(plan, '2026-10-10T10:00:00Z').join(' '), /间隔/);
  assert.deepEqual(asNeededUseWarnings(plan, '2026-10-10T12:00:00Z'), []);
  for (const at of ['2026-10-10T12:00:00Z', '2026-10-10T16:00:00Z', '2026-10-10T20:00:00Z']) plan = addAsNeededUse(plan, at);
  assert.match(asNeededUseWarnings(plan, '2026-10-10T23:00:00Z').join(' '), /24 小时/);
});
