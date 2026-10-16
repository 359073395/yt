// Loopback-only read-only QA server. Only public model files under the chosen
// directory are served, never app configuration, cookies or API credentials.
import { createServer } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
const root = resolve(process.argv[2] || 'E:/model')
createServer((req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
    const rel = relative(root, path)
    if (!rel || isAbsolute(rel) || rel.startsWith('..') || !/\.(json|onnx|model)$/.test(path)) throw new Error('Not a model file')
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('Not a file')
    res.writeHead(200, { 'Content-Length': stat.size, 'Access-Control-Allow-Origin': '*', 'Content-Type': path.endsWith('.json') ? 'application/json' : 'application/octet-stream' })
    createReadStream(path).pipe(res)
  } catch { res.writeHead(404); res.end('Not found') }
}).listen(41831, '127.0.0.1', () => console.log('Public QA model files available on loopback :41831'))
