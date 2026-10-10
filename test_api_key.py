"""Check a Bailian API key without printing or saving the credential."""
import argparse
import base64
import json
from pathlib import Path
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from server import load_env, endpoint, parse_image


def main():
    parser = argparse.ArgumentParser(description='检查百炼文字或图片接口连接')
    parser.add_argument('--image', type=Path, help='可选：用一张 JPG、PNG 或 WebP 图片检查视觉模型')
    args = parser.parse_args()
    cfg = load_env()
    key = cfg.get('DASHSCOPE_API_KEY', '').strip()
    base = cfg.get('DASHSCOPE_BASE_URL', '').strip()
    model = cfg.get('DASHSCOPE_MODEL', 'qwen-plus').strip() or 'qwen-plus'
    if not key:
        print('未找到 DASHSCOPE_API_KEY。请先填写 .env 或设置环境变量。')
        return 2
    try:
        if args.image:
            suffix = args.image.suffix.lower()
            mime = {'.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp'}.get(suffix)
            if not mime:
                raise ValueError('仅支持 JPG、PNG 或 WebP 照片')
            image = args.image.read_bytes()
            data_url = f'data:{mime};base64,{base64.b64encode(image).decode("ascii")}'
            result = parse_image(data_url, cfg)
            vision_model = cfg.get('DASHSCOPE_VISION_MODEL', 'qwen3-vl-plus').strip() or 'qwen3-vl-plus'
            print('图片接口连接成功。模型：' + vision_model)
            print('识别类型：' + result['documentType'])
            print('识别文字长度：' + str(len(result['text'])))
            print('可核对药品数：' + str(len(result['medications'])))
            return 0
        url = endpoint(base)
        data = json.dumps({'model': model, 'messages': [{'role': 'user', 'content': '请只回复：连接成功'}], 'max_tokens': 32}).encode('utf-8')
        request = Request(url, data=data, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'}, method='POST')
        with urlopen(request, timeout=20) as response:
            result = json.load(response)
        answer = result['choices'][0]['message']['content']
        print('连接成功。模型：' + model)
        print('返回内容：' + str(answer)[:80])
        return 0
    except HTTPError as exc:
        print(f'服务返回 HTTP {exc.code}。请检查密钥、地域、业务空间、模型权限和额度。')
    except (URLError, TimeoutError) as exc:
        print('网络连接失败或请求超时。请检查网络、服务地址和视觉模型响应时间。')
    except (ValueError, OSError) as exc:
        print('配置或文件错误：' + str(exc))
    except (KeyError, TypeError, json.JSONDecodeError):
        print('服务已响应，但返回格式不符合预期。')
    return 1


if __name__ == '__main__':
    sys.exit(main())
