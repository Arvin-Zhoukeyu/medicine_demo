import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from medicine_assistant import answer_question
from server import endpoint


CONFIG = {
    'DASHSCOPE_API_KEY': 'test-key',
    'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'DASHSCOPE_MODEL': 'qwen-plus',
}
TODAY = '2026-10-10'


class AssistantTests(unittest.TestCase):
    def ask(self, question, plans=None, history=None, document=None):
        return answer_question(question, plans or [], TODAY, history or [], CONFIG, endpoint, document)

    def test_plan_answer_uses_only_current_plan(self):
        plans = [
            {'active': True, 'startDate': TODAY, 'endDate': '2026-10-12', 'medicines': [
                {'name': '测试药甲', 'dose': '1', 'unit': '片', 'times': ['09:00', '21:00']},
            ]},
            {'active': False, 'startDate': TODAY, 'endDate': '2026-10-12', 'medicines': [
                {'name': '已停药', 'dose': '2', 'unit': '粒', 'times': ['12:00']},
            ]},
        ]
        result = self.ask('今天几点吃药？', plans)
        self.assertIn('09:00', result['answer'])
        self.assertIn('21:00', result['answer'])
        self.assertNotIn('已停药', result['answer'])
        self.assertEqual(result['sources'][0]['title'], '当前浏览器中的已启用计划')

    def test_as_needed_plan_has_no_fixed_dose_time(self):
        plans = [{'active': True, 'mode': 'asNeeded', 'startDate': TODAY, 'endDate': TODAY, 'medicines': [
            {'name': '测试颗粒', 'dose': '1', 'unit': '包', 'times': []},
        ]}]
        result = self.ask('今天几点吃药？', plans)
        self.assertIn('没有固定服药时刻', result['answer'])
        self.assertNotIn('09:00', result['answer'])

    def test_emergency_does_not_call_model(self):
        with patch('medicine_assistant.urlopen') as send:
            result = self.ask('吃了阿莫西林后呼吸困难怎么办？')
        send.assert_not_called()
        self.assertIn('急救', result['answer'])

    def test_personal_dose_change_is_not_decided(self):
        with patch('medicine_assistant.urlopen') as send:
            result = self.ask('阿莫西林漏服了，现在能加倍补吃吗？')
        send.assert_not_called()
        self.assertIn('不要自行加倍', result['answer'])
        self.assertTrue(result['sources'][0]['url'].startswith('https://medlineplus.gov/'))
        self.assertIn('不能据此替你', self.ask('今天能不能吃阿莫西林？', [{'active': True, 'startDate': TODAY, 'endDate': TODAY, 'medicines': [{'name': '阿莫西林', 'dose': '1', 'unit': '粒', 'times': ['09:00']}]}])['answer'])

    def test_known_fact_is_quoted_from_allowlist_with_source(self):
        reply = {'choices': [{'message': {'content': json.dumps({'factIds': ['food']})}}]}
        with patch('medicine_assistant.urlopen', return_value=io.BytesIO(json.dumps(reply).encode())) as send:
            result = self.ask('布洛芬可以随餐吃吗？')
        self.assertEqual(send.call_count, 1)
        self.assertIn('食物或牛奶', result['answer'])
        self.assertEqual(result['sources'][0]['url'], 'https://medlineplus.gov/druginfo/meds/a682159.html')

    def test_unknown_or_unapproved_facts_are_not_invented(self):
        self.assertIn('没有足够可靠的来源', self.ask('测试药甲有什么副作用？')['answer'])
        reply = {'choices': [{'message': {'content': json.dumps({'factIds': ['made_up', 'not_a_fact']})}}]}
        with patch('medicine_assistant.urlopen', return_value=io.BytesIO(json.dumps(reply).encode())):
            result = self.ask('布洛芬能治什么病？')
        self.assertIn('没有找到足够的资料', result['answer'])

    def test_confirmed_leaflet_supports_other_drugs_with_exact_quote(self):
        document = {'confirmed': True, 'text': '测试药甲说明书。贮藏：密闭，置阴凉处。请按处方或药师指导使用。'}
        reply = {'choices': [{'message': {'content': json.dumps({'evidence': '贮藏：密闭，置阴凉处。'}, ensure_ascii=False)}}]}
        with patch('medicine_assistant.urlopen', return_value=io.BytesIO(json.dumps(reply).encode())):
            result = self.ask('测试药甲怎么贮藏？', document=document)
        self.assertIn('贮藏：密闭，置阴凉处。', result['answer'])
        self.assertEqual(result['sources'][0]['title'], '本次上传的说明书识别文字（请对照原件）')

    def test_leaflet_rejects_unverified_model_text(self):
        document = {'confirmed': True, 'text': '测试药甲说明书。贮藏：密闭，置阴凉处。请按处方或药师指导使用。'}
        reply = {'choices': [{'message': {'content': json.dumps({'evidence': '每天服用两片'}, ensure_ascii=False)}}]}
        with patch('medicine_assistant.urlopen', return_value=io.BytesIO(json.dumps(reply).encode())):
            result = self.ask('测试药甲怎么贮藏？', document=document)
        self.assertIn('没有找到可直接核对', result['answer'])

    def test_leaflet_requires_confirmation_and_does_not_override_safety(self):
        document = {'confirmed': False, 'text': '测试药甲说明书。贮藏：密闭，置阴凉处。请按处方或药师指导使用。'}
        with self.assertRaisesRegex(ValueError, '确认'):
            self.ask('测试药甲怎么贮藏？', document=document)
        with patch('medicine_assistant.urlopen') as send:
            result = self.ask('测试药甲漏服了可以加倍补吃吗？', document={**document, 'confirmed': True})
        send.assert_not_called()
        self.assertIn('不要自行加倍', result['answer'])


if __name__ == '__main__':
    unittest.main()
