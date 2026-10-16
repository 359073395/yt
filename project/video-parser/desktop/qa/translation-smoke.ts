const button = document.querySelector<HTMLButtonElement>('#run')!
const result = document.querySelector('#result')!
const builtWorker = new URLSearchParams(location.search).get('worker')
const worker = builtWorker
  ? new Worker(builtWorker, { type: 'module' })
  : new Worker(new URL('../src/translation-worker.ts', import.meta.url), { type: 'module' })
if (builtWorker) document.querySelector('h1')!.textContent += '（生产构建）'
const cases = [
  { requestId: 'en', source: 'en', texts: ['This sunscreen feels light on the skin.', 'Choose your favorite color and order today.'] },
  { requestId: 'id', source: 'id', texts: ['Produk ini ringan dan mudah digunakan.', 'Pilih warna favoritmu dan pesan sekarang.'] },
]
let index = 0
function send() { worker.postMessage({ ...cases[index], action: 'translate', modelBaseUrl: 'http://127.0.0.1:41831/' }) }
button.onclick = () => { button.disabled = true; index = 0; result.textContent = '开始加载原有模型…\n'; send() }
worker.onmessage = ({ data }) => {
  if (data.type === 'error') { result.textContent += `失败：${data.message}\n`; button.disabled = false }
  if (data.type === 'ready') result.textContent += `${data.requestId}：模型已加载\n`
  if (data.type === 'complete') {
    result.textContent += JSON.stringify({ source: cases[index].texts, translations: data.translations }, null, 2) + '\n'
    if (!Array.isArray(data.translations) || data.translations.length !== 2 || !data.translations.every((text: string) => /[\u3400-\u9fff]/.test(text))) {
      result.textContent += '失败：译文缺少中文或条数不一致\n'; button.disabled = false; return
    }
    if (++index < cases.length) send()
    else { result.textContent += '通过：英语和印尼语均返回逐条中文译文\n'; button.disabled = false }
  }
}
worker.onerror = event => { result.textContent += `Worker 失败：${event.message}\n`; button.disabled = false }
