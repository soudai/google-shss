import {Inflate} from 'fflate';
import {AppError} from './html.mjs';
import {validateRaster} from './image.mjs';
import {maxImportBytes,maxImportMiB} from './limits.mjs';

const MiB=1024*1024;
export const zipLimits={compressed:maxImportBytes,total:20*MiB,entries:200,files:100,pages:20,file:2*MiB,svg:512*1024,ratio:100,elapsed:20000};
const fail=(code,message)=>{throw new AppError(code,message);};
const u16=(b,i)=>b[i]|b[i+1]<<8;
const u32=(b,i)=>(b[i]|b[i+1]<<8|b[i+2]<<16|b[i+3]<<24)>>>0;
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crcUpdate=(crc,bytes)=>{for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return crc>>>0;};
export function utf8(bytes) {
  const parts=[];let chars=[];
  for(let i=0;i<bytes.length;) {
    const a=bytes[i++];let cp=a,need=0,min=0;
    if(a>=0xc2&&a<=0xdf){cp=a&31;need=1;min=0x80;}
    else if(a>=0xe0&&a<=0xef){cp=a&15;need=2;min=0x800;}
    else if(a>=0xf0&&a<=0xf4){cp=a&7;need=3;min=0x10000;}
    else if(a>=0x80)fail('INVALID_ARCHIVE','ZIP内のUTF-8が不正です。');
    if(i+need>bytes.length)fail('INVALID_ARCHIVE','ZIP内のUTF-8が不正です。');
    for(let j=0;j<need;j++){const b=bytes[i++];if((b&0xc0)!==0x80)fail('INVALID_ARCHIVE','ZIP内のUTF-8が不正です。');cp=cp<<6|b&63;}
    if(cp<min||cp>0x10ffff||cp>=0xd800&&cp<=0xdfff)fail('INVALID_ARCHIVE','ZIP内のUTF-8が不正です。');
    chars.push(String.fromCodePoint(cp));
    if(chars.length===8192){parts.push(chars.join(''));chars=[];}
  }
  return parts.join('')+chars.join('');
}
function nameFor(bytes,flags,isDirectory) {
  if(bytes.length>240)fail('UNSAFE_PATH','ZIP内のパスが240 bytesを超えています。');
  if(!(flags&0x800)&&bytes.some(b=>b>127))fail('UNSAFE_PATH','UTF-8フラグのない非ASCIIパスは使えません。');
  const raw=utf8(bytes),name=raw.normalize('NFC');
  if(!name||name.includes('\\')||/[\x00-\x1f\x7f%?#]/.test(name)||name.startsWith('/')||/^[a-z]:/i.test(name))fail('UNSAFE_PATH',`安全でないパス: ${raw}`);
  if(isDirectory!==name.endsWith('/'))fail('UNSAFE_PATH',`ディレクトリ表記が不正です: ${raw}`);
  const segments=(isDirectory?name.slice(0,-1):name).split('/');
  if(segments.length>10||segments.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)))fail('UNSAFE_PATH',`安全でないパス: ${raw}`);
  return name;
}
function extras(bytes,start,length) {
  let at=start;
  while(at<start+length){if(at+4>start+length)fail('INVALID_ARCHIVE','ZIP extra fieldが壊れています。');const id=u16(bytes,at),size=u16(bytes,at+2);at+=4+size;if(at>start+length)fail('INVALID_ARCHIVE','ZIP extra fieldが壊れています。');if(id===1)fail('INVALID_ARCHIVE','ZIP64は対象外です。');}
}
function imageType(name,bytes) {
  const ext=name.toLowerCase().split('.').pop();
  const ascii=(at,len)=>String.fromCharCode(...bytes.slice(at,at+len));
  const good=ext==='png'&&bytes.length>=24&&ascii(0,8)==='\x89PNG\r\n\x1a\n'||['jpg','jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255||ext==='gif'&&['GIF87a','GIF89a'].includes(ascii(0,6))||ext==='webp'&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP';
  if(!good)fail('UNSUPPORTED_TYPE',`画像形式が一致しません: ${name}`);
}
export function decodeBase64(value,maxBytes=5*MiB) {
  if(typeof value!=='string'||value.length>Math.ceil(maxBytes/3)*4+4||value.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))fail('INVALID_ARCHIVE','ZIPのbase64が不正です。');
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out=new Uint8Array(value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0));
  let pos=0;
  for(let i=0;i<value.length;i+=4){const n=chars.indexOf(value[i])<<18|chars.indexOf(value[i+1])<<12|(value[i+2]==='='?0:chars.indexOf(value[i+2]))<<6|(value[i+3]==='='?0:chars.indexOf(value[i+3]));out[pos++]=n>>>16;if(pos<out.length)out[pos++]=n>>>8&255;if(pos<out.length)out[pos++]=n&255;}
  return out;
}
export function inspectZip(input,started=Date.now()) {
  const bytes=typeof input==='string'?decodeBase64(input,zipLimits.compressed):input;
  if(!(bytes instanceof Uint8Array)||bytes.length>zipLimits.compressed||bytes.length<22)fail('INVALID_ARCHIVE','ZIPが空または'+maxImportMiB+' MiBを超えています。');
  const checkTime=()=>{if(Date.now()-started>zipLimits.elapsed)fail('PROCESSING_TIMEOUT','ZIPの検査が20秒を超えました。');};
  let eocd=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(bytes,i)===0x06054b50&&i+22+u16(bytes,i+20)===bytes.length){eocd=i;break;}
  if(eocd<0||u16(bytes,eocd+4)||u16(bytes,eocd+6)||u16(bytes,eocd+8)!==u16(bytes,eocd+10))fail('INVALID_ARCHIVE','ZIP終端が不正です。');
  const count=u16(bytes,eocd+10),centralSize=u32(bytes,eocd+12),centralOffset=u32(bytes,eocd+16);
  if(count>zipLimits.entries||count===0)fail('LIMIT_EXCEEDED','ZIPエントリー数は1〜200件です。');
  if(centralSize===0xffffffff||centralOffset===0xffffffff||centralOffset+centralSize!==eocd)fail('INVALID_ARCHIVE','ZIPの中央ディレクトリが不正です。');
  let at=centralOffset,fileCount=0,pages=0,declaredTotal=0;
  const entries=[],names=new Set(),intervals=[];
  for(let i=0;i<count;i++) {
    checkTime();if(at+46>eocd||u32(bytes,at)!==0x02014b50)fail('INVALID_ARCHIVE','ZIP中央ディレクトリが壊れています。');
    const made=u16(bytes,at+4),flags=u16(bytes,at+8),method=u16(bytes,at+10),crc=u32(bytes,at+16),compressed=u32(bytes,at+20),size=u32(bytes,at+24),nameLen=u16(bytes,at+28),extraLen=u16(bytes,at+30),commentLen=u16(bytes,at+32),disk=u16(bytes,at+34),external=u32(bytes,at+38),offset=u32(bytes,at+42);
    const end=at+46+nameLen+extraLen+commentLen;
    if(end>eocd||!nameLen||disk||offset===0xffffffff||compressed===0xffffffff||size===0xffffffff||flags&~0x80e||![0,8].includes(method))fail('INVALID_ARCHIVE','未対応または破損したZIPエントリーです。');
    // General purpose bit 3 (data descriptor) is supported below.
    if(flags&~(0x800|0x8|0x6))fail('INVALID_ARCHIVE','未対応のZIPフラグです。');
    extras(bytes,at+46+nameLen,extraLen);
    const mode=(external>>>16)&0xffff,kind=mode&0xf000;
    if(kind&&!([0x8000,0x4000].includes(kind)))fail('UNSAFE_PATH','ZIPのsymlink・特殊ファイルは使えません。');
    const directory=bytes[at+46+nameLen-1]===47;
    const name=nameFor(bytes.subarray(at+46,at+46+nameLen),flags,directory);
    if(names.has(name.toLowerCase()))fail('UNSAFE_PATH',`重複するパス: ${name}`);names.add(name.toLowerCase());
    if(directory&&kind&&kind!==0x4000||!directory&&kind===0x4000)fail('UNSAFE_PATH',`種別が一致しません: ${name}`);
    if(directory&&(compressed||size))fail('INVALID_ARCHIVE',`ディレクトリに内容があります: ${name}`);
    if(!directory){fileCount++;declaredTotal+=size;const ext=name.toLowerCase().split('.').pop(),ignored=name.startsWith('__MACOSX/')||name==='.DS_Store';if(!ignored&&!['html','htm','js','css','png','jpg','jpeg','gif','webp','svg'].includes(ext))fail('UNSUPPORTED_TYPE',`対象外の形式: ${name}`);if(!ignored&&['html','htm'].includes(ext))pages++;if(size>(ext==='svg'?zipLimits.svg:zipLimits.file))fail('LIMIT_EXCEEDED',`ファイルが大きすぎます: ${name}`);if(compressed===0&&size>0||compressed>0&&size/compressed>zipLimits.ratio)fail('LIMIT_EXCEEDED',`展開率が高すぎます: ${name}`);}
    entries.push({name,directory,flags,method,crc,compressed,size,offset,nameBytes:bytes.subarray(at+46,at+46+nameLen)});at=end;
  }
  if(at!==eocd||fileCount>zipLimits.files||pages>zipLimits.pages||declaredTotal>zipLimits.total||pages===0)fail('LIMIT_EXCEEDED','ZIPのファイル数・容量・HTML数を確認してください。');
  const filesOnly=new Set(entries.filter(e=>!e.directory).map(e=>e.name.toLowerCase()));
  for(const entry of entries){const segments=entry.name.replace(/\/$/,'').toLowerCase().split('/');for(let i=1;i<segments.length;i++)if(filesOnly.has(segments.slice(0,i).join('/')))fail('UNSAFE_PATH',`ファイルとディレクトリが衝突します: ${entry.name}`);}
  for(const entry of entries) {
    checkTime();const {offset,nameBytes,flags,method,compressed,size,crc}=entry;
    if(offset+30>centralOffset||u32(bytes,offset)!==0x04034b50)fail('INVALID_ARCHIVE',`ローカルヘッダーが壊れています: ${entry.name}`);
    const localFlags=u16(bytes,offset+6),localMethod=u16(bytes,offset+8),localName=u16(bytes,offset+26),localExtra=u16(bytes,offset+28),dataStart=offset+30+localName+localExtra;
    if(localFlags!==flags||localMethod!==method||localName!==nameBytes.length||dataStart+compressed>centralOffset||!nameBytes.every((b,i)=>bytes[offset+30+i]===b))fail('INVALID_ARCHIVE',`ローカルヘッダーが一致しません: ${entry.name}`);
    extras(bytes,offset+30+localName,localExtra);
    if(!(flags&8)&&(u32(bytes,offset+14)!==crc||u32(bytes,offset+18)!==compressed||u32(bytes,offset+22)!==size))fail('INVALID_ARCHIVE',`サイズまたはCRCが一致しません: ${entry.name}`);
    let end=dataStart+compressed;
    if(flags&8){const signed=u32(bytes,end)===0x08074b50;if(signed)end+=4;if(end+12>centralOffset||u32(bytes,end)!==crc||u32(bytes,end+4)!==compressed||u32(bytes,end+8)!==size)fail('INVALID_ARCHIVE',`data descriptorが一致しません: ${entry.name}`);end+=12;}
    intervals.push([offset,end]);entry.dataStart=dataStart;
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  if(intervals[0][0]!==0||intervals[intervals.length-1][1]!==centralOffset||intervals.some((x,i)=>i&&x[0]!==intervals[i-1][1]))fail('INVALID_ARCHIVE','ZIPのデータ範囲が重複または欠落しています。');
  const files=new Map();let actualTotal=0;
  for(const entry of entries) {
    if(entry.directory)continue;
    checkTime();const max=entry.name.toLowerCase().endsWith('.svg')?zipLimits.svg:zipLimits.file;
    const chunks=[];let length=0,crc=0xffffffff;
    const accept=chunk=>{length+=chunk.length;actualTotal+=chunk.length;if(length>max||actualTotal>zipLimits.total||length>entry.size||entry.compressed&&length/entry.compressed>zipLimits.ratio)fail('LIMIT_EXCEEDED',`展開容量が上限を超えました: ${entry.name}`);crc=crcUpdate(crc,chunk);chunks.push(chunk);checkTime();};
    if(entry.method===0)accept(bytes.subarray(entry.dataStart,entry.dataStart+entry.compressed));
    else {
      if(!entry.compressed)fail('INTEGRITY_MISMATCH',`Deflateデータがありません: ${entry.name}`);
      const stream=new Inflate((chunk)=>accept(chunk));
      try {for(let at=entry.dataStart;at<entry.dataStart+entry.compressed;at+=1024){const end=Math.min(at+1024,entry.dataStart+entry.compressed);stream.push(bytes.subarray(at,end),end===entry.dataStart+entry.compressed);checkTime();}}
      catch(e){if(e instanceof AppError)throw e;fail('INTEGRITY_MISMATCH',`Deflateデータが壊れています: ${entry.name}`);}
    }
    if(length!==entry.size||((crc^0xffffffff)>>>0)!==entry.crc)fail('INTEGRITY_MISMATCH',`展開サイズまたはCRCが一致しません: ${entry.name}`);
    const content=new Uint8Array(length);let pos=0;for(const chunk of chunks){content.set(chunk,pos);pos+=chunk.length;}
    if(entry.name.startsWith('__MACOSX/')||entry.name==='.DS_Store')continue;
    const ext=entry.name.toLowerCase().split('.').pop();
    if(['html','htm','js','css','svg'].includes(ext))files.set(entry.name,{mime:ext==='svg'?'image/svg+xml':ext==='css'?'text/css':ext==='js'?'text/javascript':'text/html',text:utf8(content),bytes:content});
    else {imageType(entry.name,content);const mime=ext==='png'?'image/png':['jpg','jpeg'].includes(ext)?'image/jpeg':ext==='gif'?'image/gif':'image/webp';validateRaster(mime,content);files.set(entry.name,{mime,bytes:content});}
  }
  const paths=[...files.keys()].filter(name=>/\.html?$/i.test(name));
  return {files,pages:paths,startPage:paths.includes('index.html')?'index.html':paths.length===1?paths[0]:null,archiveBytes:bytes};
}
