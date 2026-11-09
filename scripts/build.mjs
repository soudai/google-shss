import {mkdir, writeFile} from 'node:fs/promises';
import {buildGas} from './bundle.mjs';

const out = new URL('../dist/gas/', import.meta.url);
const [files] = await Promise.all([buildGas(), mkdir(out, {recursive: true})]);
await Promise.all(Object.entries(files).map(([name, text]) => writeFile(new URL(name, out), text)));
console.log('Built dist/gas');
