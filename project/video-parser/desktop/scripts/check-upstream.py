"""Read-only scheduled runtime check. Never installs upstream releases."""
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
lock=json.loads((ROOT/'scripts/runtime-lock.json').read_text('utf-8'))
sources={'ytDlp':'yt-dlp/yt-dlp','ffmpeg':'BtbN/FFmpeg-Builds','whisper':'ggml-org/whisper.cpp','deno':'denoland/deno'}
rows=[]
for name, repo in sources.items():
    url=f'https://api.github.com/repos/{repo}/releases/latest'
    headers={'User-Agent':'yinglian-upstream-check','Accept':'application/vnd.github+json'}
    if os.environ.get('GITHUB_TOKEN'):
        headers['Authorization']='Bearer '+os.environ['GITHUB_TOKEN']
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers),timeout=30) as response:
        release=json.load(response)
    current=lock[name]['version'].split(' ')[0].lstrip('v')
    latest=release['tag_name'].lstrip('v')
    if name=='ffmpeg':
        newer=release['published_at'][:10] > re.search(r'autobuild-(\d{4}-\d{2}-\d{2})',lock[name]['source'])[1]
    else:
        newer=latest!=current
    rows.append({'component':name,'current':current,'upstream':latest,'published_at':release['published_at'],
        'url':release['html_url'],'review_required':newer})
out=ROOT/'qa/upstream-check.json'
out.write_text(json.dumps(rows,indent=2)+'\n','utf-8')
for row in rows:
    print(f"{row['component']}: {row['current']} -> {row['upstream']} ({'review required' if row['review_required'] else 'current'})")
sys.exit(1 if any(r['review_required'] for r in rows) else 0)
