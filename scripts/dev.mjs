// Local development server: the built viewer page backed by the real core
// service over an in-memory store, so the UI can be tried without deploying to
// Apps Script. Data is lost on restart. Run with `npm run dev`.
//
//   PORT=8080          port to listen on (default 8080)
//   SHSS_DEV_DELAY=800 milliseconds added to each RPC, to try slow networks
import {createServer} from 'node:http';
import {buildPage} from './bundle.mjs';
import {localService} from './memory-store.mjs';
import {maxImportBytes} from '../server/limits.mjs';

const port = Number(process.env.PORT) || 8080;
const delay = Number(process.env.SHSS_DEV_DELAY) || 0;
const {run} = localService();
const maxRequestBytes = 6 * maxImportBytes + 8192;

run('importDocument', {title: 'サンプル文書', html: `<!doctype html><html lang="ja"><meta charset="utf-8"><title>サンプル</title>
<h1>四半期レポート</h1><p>この文章を選択して、コメントを投稿してください。</p>
<svg width="240" height="120" role="img" aria-label="棒グラフ"><rect x="20" y="40" width="40" height="80" fill="#4285f4"/><rect x="100" y="20" width="40" height="100" fill="#34a853"/><rect x="180" y="60" width="40" height="60" fill="#fbbc04"/></svg>
<p><a href="https://example.com/">外部リンク</a></p></html>`});

// Mirrors rpc() in gas/Code.gs: errors become {ok:false, error}.
function rpc(action, input) {
  try {return {ok: true, value: run(action, input)};}
  catch (error) {
    if (error.code) return {ok: false, error: {code: error.code, message: error.message, retryable: !!error.retryable}};
    console.error(error);
    return {ok: false, error: {code: 'INTERNAL', message: '処理に失敗しました。時間をおいて再試行してください。', retryable: true}};
  }
}

// Replaces google.script.run with a fetch to this server.
const devApi = `window.SHSS_API=(action,input)=>fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,input})}).then(r=>{if(!r.ok)throw new Error(r.statusText);return r.json();});`;

async function page() {
  // Built on every request, so edits under web/ show up on reload.
  const html = await buildPage();
  const boot = JSON.stringify({url: `http://localhost:${port}/`, documentId: '', versionId: '', pagePath: '', local: true});
  return html.replace('/* BOOT */', () => boot).replace('<script>window.SHSS_BOOT', () => `<script>${devApi}</script><script>window.SHSS_BOOT`);
}

createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/rpc') {
      if (request.headers['content-type'] !== 'application/json') {
        response.writeHead(415).end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxRequestBytes) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const {action, input} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      response.writeHead(200, {'content-type': 'application/json; charset=utf-8'});
      response.end(JSON.stringify(rpc(action, input)));
    } else if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, {'content-type': 'text/html; charset=utf-8'});
      response.end(await page());
    } else {
      response.writeHead(404).end();
    }
  } catch (error) {
    console.error(error);
    response.writeHead(500, {'content-type': 'text/plain; charset=utf-8'}).end(String(error.message));
  }
}).listen(port, '127.0.0.1', () => console.log(`SHSS dev server: http://localhost:${port}/`));
