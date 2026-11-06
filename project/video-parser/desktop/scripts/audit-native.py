"""Audit locked registry dependencies; distinguish Windows paths and advisory notices."""
import argparse
import json
import re
import subprocess
import time
import tomllib
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def request_json(url, payload=None):
    for attempt in range(3):
        try:
            request = urllib.request.Request(url, data=None if payload is None else json.dumps(payload).encode(),
                headers={'User-Agent': 'yinglian-dependency-audit', 'Content-Type': 'application/json'})
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.load(response)
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='qa/native-audit.json')
    args = parser.parse_args()
    locked = tomllib.loads((ROOT/'src-tauri/Cargo.lock').read_text('utf-8'))['package']
    packages = [p for p in locked if p.get('source', '').startswith('registry+')]
    tree = subprocess.check_output(['cargo', 'tree', '--locked', '--target', 'x86_64-pc-windows-msvc',
        '-e', 'normal,build', '--prefix', 'none', '--format', '{p}'], cwd=ROOT/'src-tauri', text=True)
    windows = set(re.findall(r'^([\w-]+) v([^\s]+)', tree, re.M))
    report = {'target': 'x86_64-pc-windows-msvc', 'packages': len(packages), 'findings': [], 'blocking': []}
    for offset in range(0, len(packages), 100):
        batch = packages[offset:offset+100]
        result = request_json('https://api.osv.dev/v1/querybatch', {'queries': [
            {'package': {'name': p['name'], 'ecosystem': 'crates.io'}, 'version': p['version']} for p in batch]})
        if len(result['results']) != len(batch):
            raise RuntimeError('Incomplete OSV response')
        for package, entry in zip(batch, result['results']):
            for item in entry.get('vulns', []):
                advisory = request_json('https://api.osv.dev/v1/vulns/'+item['id'])
                if advisory.get('withdrawn'):
                    continue
                informational = advisory.get('database_specific', {}).get('informational')
                if not informational:
                    for affected in advisory.get('affected', []):
                        informational = affected.get('database_specific', {}).get('informational') or informational
                row = {'name': package['name'], 'version': package['version'], 'id': item['id'],
                    'summary': advisory.get('summary'), 'windows_dependency': (package['name'],package['version']) in windows,
                    'informational': informational, 'aliases': advisory.get('aliases', [])}
                report['findings'].append(row)
                if row['windows_dependency'] and informational not in ('unmaintained', 'notice'):
                    report['blocking'].append(row)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', 'utf-8')
    print(f"Audited {len(packages)} locked packages; {len(report['blocking'])} blocking Windows advisories")
    raise SystemExit(1 if report['blocking'] else 0)

if __name__ == '__main__':
    main()
