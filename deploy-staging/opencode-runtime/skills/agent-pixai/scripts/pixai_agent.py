# -*- coding: utf-8 -*-
"""agent-pixai 生图 CLI：呼叫 kotone-bridge 生图 + media 轮询补 URL + 下载。

用法:
  python pixai_agent.py --content "生成一张雪山的图" [--model momoka-v1] [--image-gen]
        [--outdir output/] [--api-key KEY] [--timeout 240]
环境变数 KOTONE_BRIDGE_API_KEY 没给 --api-key 时自动读取。
输出: stdout 一行 JSON {id, model, text, images:[{mediaId,url,width,height,prompt,file}]}
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

BASE = os.environ.get('KOTONE_BRIDGE_BASE', 'https://store.tinchak0207.xyz/kotone/v1')


def http_json(method, path, api_key, payload=None, timeout=240):
    headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api_key}
    body = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
        raw = r.read().decode('utf-8', 'ignore')
        return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode('utf-8', 'ignore')[:300]}
    except Exception as e:
        return 0, {'error': str(e)[:300]}


def wait_media(media_id, api_key, timeout=60):
    """轮询 /v1/media/{id} 直到有 public url（未就绪回 404，不是错误）。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, j = http_json('GET', '/v1/media/%s' % media_id, api_key, timeout=20)
        if st == 200 and j.get('url'):
            return j
        time.sleep(5)
    return j if st == 200 else None


def download(url, outdir):
    if not outdir:
        return None
    os.makedirs(outdir, exist_ok=True)
    name = url.rsplit('/', 1)[-1] or ('img_%d' % int(time.time()))
    if '.' not in name:
        name += '.img'
    path = os.path.join(outdir, name)
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'webstar/5.0', 'Origin': 'https://pixai.art'})
        with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
            f.write(r.read())
        return path
    except Exception as e:
        return None


def main():
    ap = argparse.ArgumentParser(description='PixAI Agent 生图')
    ap.add_argument('--content', required=True, help='生图/聊天内容')
    ap.add_argument('--model', default='momoka-v1')
    ap.add_argument('--image-gen', action='store_true', help='要求生图')
    ap.add_argument('--outdir', default=None, help='下载图片目录')
    ap.add_argument('--api-key', default=os.environ.get('KOTONE_BRIDGE_API_KEY', ''))
    ap.add_argument('--timeout', type=int, default=240)
    ap.add_argument('--media-timeout', type=int, default=60)
    args = ap.parse_args()

    if not args.api_key:
        print(json.dumps({'error': 'no api key (--api-key or KOTONE_BRIDGE_API_KEY)'}), flush=True)
        sys.exit(1)

    st, j = http_json('POST', '/v1/agent/chat', args.api_key, {
        'model': args.model, 'content': args.content,
        **({'imageGen': 'on'} if args.image_gen else {}),
    }, timeout=args.timeout)

    if st != 200:
        print(json.dumps({'error': 'chat failed %s: %s' % (st, j)}, ensure_ascii=False), flush=True)
        sys.exit(2)

    imgs = []
    for im in (j.get('images') or []):
        out = {'mediaId': im.get('mediaId'), 'url': im.get('url'),
               'width': im.get('width'), 'height': im.get('height'),
               'prompt': im.get('prompt'), 'file': None}
        mid = im.get('mediaId')
        if mid and not out['url']:
            mj = wait_media(mid, args.api_key, args.media_timeout)
            if mj:
                out['url'] = mj.get('url')
                out['width'] = mj.get('width', out['width'])
                out['height'] = mj.get('height', out['height'])
        if out['url']:
            out['file'] = download(out['url'], args.outdir)
        imgs.append(out)

    print(json.dumps({'id': j.get('id'), 'model': j.get('model'),
                      'text': j.get('text'), 'images': imgs}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
