import {build} from 'esbuild';
import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const read = path => readFile(new URL(`../${path}`,import.meta.url),'utf8');
const out = path => new URL(`../dist/${path}`,import.meta.url);
await mkdir(out('gas/'),{recursive:true});
const server=await build({entryPoints:[fileURLToPath(new URL('../server/core.mjs',import.meta.url))],bundle:true,write:false,format:'iife',globalName:'SHSSCore',target:'es2019',legalComments:'inline'});
// Keep the bundle and the GAS entry points in one file; no cross-file initialization order.
await writeFile(out('gas/Code.gs'),server.outputFiles[0].text+'\n'+await read('gas/Code.gs'));
await copyFile(new URL('../gas/appsscript.json',import.meta.url),out('gas/appsscript.json'));
const [shell, css, bridge]=await Promise.all(['index.html','style.css','bridge.js'].map(f=>read('web/'+f)));
const client=await build({entryPoints:[fileURLToPath(new URL('../web/app.js',import.meta.url))],bundle:true,write:false,format:'iife',target:'es2019',legalComments:'inline'});
const app=client.outputFiles[0].text;
const literal=text=>JSON.stringify(text).replace(/</g,'\\u003c');
if(/<\/script/i.test(app)||/<\/style/i.test(css))throw new Error('Invalid inline asset');
const page=shell.replace('/* STYLE */',()=>css).replace('/* BRIDGE */',()=>literal(bridge)).replace('/* APP */',()=>app);
await writeFile(out('gas/Index.html'),page.replace('/* BOOT */','<?!= boot ?>'));
console.log('Built dist/gas');
