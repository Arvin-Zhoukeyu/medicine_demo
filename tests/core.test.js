import test from 'node:test';
import assert from 'node:assert/strict';
import { validPlan, createPlan, addEvent, archiveIfEnded, conflictingSlots } from '../web/core.js';

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
