import base64
import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import endpoint, image_data_url, parse_image, parse_plan
from leaflet_guidance import extract_leaflet_guidance


class ServerTests(unittest.TestCase):
    def test_rejects_other_hosts(self):
        with self.assertRaises(ValueError):
            endpoint('https://example.com/compatible-mode/v1')
        with self.assertRaises(ValueError):
            endpoint('https://<WorkspaceId>.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')

    def test_missing_key_returns_clear_error(self):
        with self.assertRaisesRegex(ValueError, '密钥'):
            parse_plan('已有安排文本', {'DASHSCOPE_API_KEY': ''})

    def test_source_must_support_returned_values(self):
        source = '药品甲 1片 08:00 2026-10-10 至 2026-10-12'
        reply = {'choices': [{'message': {'content': json.dumps({'medications': [{
            'name': '药品甲', 'dose': '2', 'unit': '片', 'times': ['08:00', '20:00'],
            'startDate': '2026-10-10', 'endDate': '2026-10-12', 'sources': source
        }]}, ensure_ascii=False)}}]}
        fake = io.BytesIO(json.dumps(reply, ensure_ascii=False).encode('utf-8'))
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_MODEL': 'qwen-plus'}
        with patch('server.urlopen', return_value=fake):
            result = parse_plan(source, cfg)
        med = result['medications'][0]
        self.assertEqual(med['dose'], '')
        self.assertEqual(med['times'], ['08:00'])

    def test_paraphrased_source_is_recovered_from_original_sentence(self):
        source = ('测试药甲：每次1片，每天09:00和21:00使用；开始日期2026-10-10，结束日期2026-10-12。\n'
                  '测试药乙：每次2粒，每天12:30使用；开始日期2026-10-10，结束日期2026-10-12。')
        medications = [
            {'name': '测试药甲', 'dose': '1', 'unit': '片', 'times': ['09:00', '21:00'],
             'startDate': '2026-10-10', 'endDate': '2026-10-12', 'sources': '测试药甲每次1片，每天09:00和21:00使用。'},
            {'name': '测试药乙', 'dose': '2', 'unit': '粒', 'times': ['12:30'],
             'startDate': '2026-10-10', 'endDate': '2026-10-12', 'sources': ''},
        ]
        reply = {'choices': [{'message': {'content': json.dumps({'medications': medications}, ensure_ascii=False)}}]}
        fake = io.BytesIO(json.dumps(reply, ensure_ascii=False).encode('utf-8'))
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_MODEL': 'qwen-plus'}
        with patch('server.urlopen', return_value=fake):
            result = parse_plan(source, cfg)
        self.assertEqual(len(result['medications']), 2)
        self.assertEqual(result['medications'][0]['times'], ['09:00', '21:00'])
        self.assertEqual(result['medications'][1]['dose'], '2')
        self.assertIn('测试药乙：', result['medications'][1]['sources'])

    def test_image_validation_rejects_bad_format(self):
        with self.assertRaisesRegex(ValueError, '仅支持'):
            image_data_url('data:image/svg+xml;base64,PHN2Zz4=')
        with self.assertRaisesRegex(ValueError, '不一致'):
            image_data_url('data:image/png;base64,' + base64.b64encode(b'not a png').decode())

    def test_prescription_image_uses_vision_then_grounded_text_extraction(self):
        image = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nimage').decode()
        transcript = '测试药甲 每次1片 每天09:00 2026-10-10至2026-10-12'
        vision_reply = {'choices': [{'message': {'content': json.dumps({'documentType': 'other', 'text': transcript}, ensure_ascii=False)}}]}
        text_reply = {'choices': [{'message': {'content': json.dumps({'medications': [{
            'name': '测试药甲', 'dose': '1', 'unit': '片', 'times': ['09:00'],
            'startDate': '2026-10-10', 'endDate': '2026-10-12', 'sources': transcript,
        }]}, ensure_ascii=False)}}]}
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_MODEL': 'qwen-plus', 'DASHSCOPE_VISION_MODEL': 'qwen3.8-max'}
        with patch('server.urlopen', side_effect=[io.BytesIO(json.dumps(vision_reply, ensure_ascii=False).encode()), io.BytesIO(json.dumps(text_reply, ensure_ascii=False).encode())]) as send:
            result = parse_image(image, cfg)
        self.assertEqual(send.call_count, 2)
        first_request = json.loads(send.call_args_list[0].args[0].data)
        self.assertEqual(first_request['model'], 'qwen3.8-max')
        self.assertEqual(first_request['messages'][1]['content'][1]['image_url']['url'], image)
        self.assertEqual(result['documentType'], 'prescription')
        self.assertEqual(result['medications'][0]['times'], ['09:00'])

    def test_leaflet_image_does_not_create_personal_plan(self):
        image = 'data:image/png;base64,' + base64.b64encode(b'\x89PNG\r\n\x1a\nimage').decode()
        vision_reply = {'choices': [{'message': {'content': json.dumps({'documentType': 'leaflet', 'text': '测试药甲说明书：成人每次1片。'}, ensure_ascii=False)}}]}
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1'}
        with patch('server.urlopen', return_value=io.BytesIO(json.dumps(vision_reply, ensure_ascii=False).encode())) as send:
            result = parse_image(image, cfg)
        self.assertEqual(send.call_count, 1)
        self.assertEqual(result['documentType'], 'leaflet')
        self.assertEqual(result['medications'], [])

    def test_real_leaflet_ocr_generates_grounded_as_needed_draft(self):
        source = (Path(__file__).resolve().parent / 'fixtures' / 'ibuprofen_leaflet_ocr.txt').read_text(encoding='utf-8')
        reply = {'choices': [{'message': {'content': json.dumps({
            'name': {'value': '布洛芬颗粒', 'evidence': '通用名称：布洛芬颗粒'},
            'doseOptions': [
                {'group': '4~8岁儿童', 'dose': '0.5', 'unit': '包', 'evidence': '4~8岁儿童，一次0.5包'},
                {'group': '8岁以上儿童及成人', 'dose': '1', 'unit': '包', 'evidence': '8岁以上儿童及成人，一次1包'},
            ],
            'interval': {'minHours': 4, 'maxHours': 6, 'evidence': '间隔4~6小时重复用药1次'},
            'maxPer24h': {'count': 4, 'evidence': '24小时不超过4次'},
            'durationLimits': [
                {'purpose': 'pain', 'maxDays': 5, 'evidence': '用于止痛不得超过5天'},
                {'purpose': 'fever', 'maxDays': 3, 'evidence': '用于解热不得超过3天'},
            ],
            'conditionalEvidence': '若持续疼痛或发热，可间隔4~6小时重复用药1次',
        }, ensure_ascii=False)}}]}
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_MODEL': 'qwen-plus'}
        with patch('leaflet_guidance.urlopen', return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode())):
            result = extract_leaflet_guidance(source, cfg, endpoint)
        self.assertEqual(result['name'], '布洛芬颗粒')
        self.assertEqual(result['mode'], 'asNeeded')
        self.assertEqual(result['doseOptions'][1]['dose'], '1')
        self.assertEqual(result['interval']['minHours'], 4)
        self.assertEqual(result['maxPer24h']['count'], 4)
        self.assertEqual(result['durationLimits']['fever']['maxDays'], 3)

    def test_leaflet_rejects_unquoted_dose_and_recovers_from_ocr(self):
        source = (Path(__file__).resolve().parent / 'fixtures' / 'ibuprofen_leaflet_ocr.txt').read_text(encoding='utf-8')
        reply = {'choices': [{'message': {'content': json.dumps({
            'name': {'value': '布洛芬颗粒', 'evidence': '通用名称：布洛芬颗粒'},
            'doseOptions': [{'group': '8岁以上儿童及成人', 'dose': '2', 'unit': '包', 'evidence': '8岁以上儿童及成人，一次1包'}],
            'interval': {}, 'maxPer24h': {}, 'durationLimits': [], 'conditionalEvidence': '',
        }, ensure_ascii=False)}}]}
        cfg = {'DASHSCOPE_API_KEY': 'test-key', 'DASHSCOPE_BASE_URL': 'https://dashscope.aliyuncs.com/compatible-mode/v1'}
        with patch('leaflet_guidance.urlopen', return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode())):
            result = extract_leaflet_guidance(source, cfg, endpoint)
        self.assertNotIn('2', [option['dose'] for option in result['doseOptions']])
        self.assertEqual(result['doseOptions'][1]['dose'], '1')
        self.assertEqual(result['mode'], 'asNeeded')


if __name__ == '__main__':
    unittest.main()
