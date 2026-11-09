import {Inflate} from 'fflate';
import {AppError,KiB,MiB,decodeBase64 as decodeBase64Bytes,decodeUtf8,fail} from './util.mjs';
import {validateRaster} from './image.mjs';
import {maxImportBytes,maxImportMiB} from './limits.mjs';

// A strict ZIP reader: single disk, no ZIP64, stored or deflated entries only,
// with every byte of the archive accounted for by exactly one entry.
export const zipLimits={compressed:maxImportBytes,total:20*MiB,entries:200,files:100,pages:20,file:2*MiB,svg:512*KiB,ratio:100,elapsed:20000};

const MIME_TYPES=new Map(Object.entries({html:'text/html',htm:'text/html',js:'text/javascript',css:'text/css',svg:'image/svg+xml',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp'}));
const TEXT_EXTENSIONS=new Set(['html','htm','js','css','svg']);
const SIGNATURE={eocd:0x06054b50,central:0x02014b50,local:0x04034b50,descriptor:0x08074b50};
const FLAG={encrypted:0x1,compression:0x6,descriptor:0x8,utf8:0x800};
const S_IFMT=0xf000,S_IFREG=0x8000,S_IFDIR=0x4000;

const u16=(b,i)=>b[i]|b[i+1]<<8;
const u32=(b,i)=>(b[i]|b[i+1]<<8|b[i+2]<<16|b[i+3]<<24)>>>0;
const crcTable=Uint32Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crcUpdate=(crc,bytes)=>{for(const b of bytes)crc=crcTable[(crc^b)&255]^(crc>>>8);return crc>>>0;};
const extension=name=>name.toLowerCase().split('.').pop();
// macOS Finder metadata is tolerated in archives but never imported.
const ignored=name=>name.startsWith('__MACOSX/')||name==='.DS_Store';

export const utf8=bytes=>decodeUtf8(bytes,'INVALID_ARCHIVE','ZIP内のUTF-8が不正です。');
// The default limit applies to image data: URLs; inspectZip passes the archive limit.
export const decodeBase64=(value,maxBytes=5*MiB)=>decodeBase64Bytes(value,maxBytes,'INVALID_ARCHIVE','ZIPのbase64が不正です。');

function nameFor(bytes,flags,isDirectory) {
  if(bytes.length>240)fail('UNSAFE_PATH','ZIP内のパスが240 bytesを超えています。');
  if(!(flags&FLAG.utf8)&&bytes.some(b=>b>127))fail('UNSAFE_PATH','UTF-8フラグのない非ASCIIパスは使えません。');
  const raw=utf8(bytes),name=raw.normalize('NFC');
  if(!name||name.includes('\\')||/[\x00-\x1f\x7f%?#]/.test(name)||name.startsWith('/')||/^[a-z]:/i.test(name))fail('UNSAFE_PATH',`安全でないパス: ${raw}`);
  if(isDirectory!==name.endsWith('/'))fail('UNSAFE_PATH',`ディレクトリ表記が不正です: ${raw}`);
  const segments=(isDirectory?name.slice(0,-1):name).split('/');
  if(segments.length>10||segments.some(s=>!s||s==='.'||s==='..'||/[. ]$/.test(s)))fail('UNSAFE_PATH',`安全でないパス: ${raw}`);
  return name;
}
function extras(bytes,start,length) {
  const end=start+length;
  for(let at=start;at<end;) {
    if(at+4>end)fail('INVALID_ARCHIVE','ZIP extra fieldが壊れています。');
    const id=u16(bytes,at),size=u16(bytes,at+2);
    at+=4+size;
    if(at>end)fail('INVALID_ARCHIVE','ZIP extra fieldが壊れています。');
    if(id===1)fail('INVALID_ARCHIVE','ZIP64は対象外です。');
  }
}
function imageType(name,bytes) {
  const ext=extension(name);
  const ascii=(at,len)=>String.fromCharCode(...bytes.slice(at,at+len));
  const good=ext==='png'&&bytes.length>=24&&ascii(0,8)==='\x89PNG\r\n\x1a\n'||['jpg','jpeg'].includes(ext)&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255||ext==='gif'&&['GIF87a','GIF89a'].includes(ascii(0,6))||ext==='webp'&&ascii(0,4)==='RIFF'&&ascii(8,4)==='WEBP';
  if(!good)fail('UNSUPPORTED_TYPE',`画像形式が一致しません: ${name}`);
}
function findEndOfCentralDirectory(bytes) {
  // The record is 22 bytes plus a comment of at most 65535 bytes, and must end the file.
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(bytes,i)===SIGNATURE.eocd&&i+22+u16(bytes,i+20)===bytes.length)return i;
  return -1;
}
// Reads and checks one central directory record. Paths are compared
// case-insensitively so they cannot collide on Drive or Windows.
function centralEntry(bytes,at,eocd,names) {
  if(at+46>eocd||u32(bytes,at)!==SIGNATURE.central)fail('INVALID_ARCHIVE','ZIP中央ディレクトリが壊れています。');
  const flags=u16(bytes,at+8),method=u16(bytes,at+10),crc=u32(bytes,at+16),compressed=u32(bytes,at+20),size=u32(bytes,at+24),nameLen=u16(bytes,at+28),extraLen=u16(bytes,at+30),commentLen=u16(bytes,at+32),disk=u16(bytes,at+34),external=u32(bytes,at+38),offset=u32(bytes,at+42);
  const end=at+46+nameLen+extraLen+commentLen;
  // Allowed flags: compression options, data descriptor (bit 3) and UTF-8 names.
  if(end>eocd||!nameLen||disk||offset===0xffffffff||compressed===0xffffffff||size===0xffffffff||flags&~(FLAG.utf8|FLAG.descriptor|FLAG.compression)||![0,8].includes(method))fail('INVALID_ARCHIVE','未対応または破損したZIPエントリーです。');
  extras(bytes,at+46+nameLen,extraLen);
  const kind=(external>>>16)&S_IFMT;
  if(kind&&kind!==S_IFREG&&kind!==S_IFDIR)fail('UNSAFE_PATH','ZIPのsymlink・特殊ファイルは使えません。');
  const nameBytes=bytes.subarray(at+46,at+46+nameLen);
  const directory=nameBytes[nameLen-1]===47;
  const name=nameFor(nameBytes,flags,directory);
  if(names.has(name.toLowerCase()))fail('UNSAFE_PATH',`重複するパス: ${name}`);
  names.add(name.toLowerCase());
  if(directory&&kind&&kind!==S_IFDIR||!directory&&kind===S_IFDIR)fail('UNSAFE_PATH',`種別が一致しません: ${name}`);
  if(directory&&(compressed||size))fail('INVALID_ARCHIVE',`ディレクトリに内容があります: ${name}`);
  return {end,entry:{name,directory,flags,method,crc,compressed,size,offset,nameBytes}};
}
function checkDeclaredFile({name,compressed,size}) {
  const ext=extension(name),skip=ignored(name);
  if(!skip&&!MIME_TYPES.has(ext))fail('UNSUPPORTED_TYPE',`対象外の形式: ${name}`);
  if(size>(ext==='svg'?zipLimits.svg:zipLimits.file))fail('LIMIT_EXCEEDED',`ファイルが大きすぎます: ${name}`);
  if(compressed===0&&size>0||compressed>0&&size/compressed>zipLimits.ratio)fail('LIMIT_EXCEEDED',`展開率が高すぎます: ${name}`);
  return !skip&&MIME_TYPES.get(ext)==='text/html';
}
// Checks the local header against the central record and returns the byte range it covers.
function localRange(bytes,entry,centralOffset) {
  const {offset,nameBytes,flags,method,compressed,size,crc}=entry;
  if(offset+30>centralOffset||u32(bytes,offset)!==SIGNATURE.local)fail('INVALID_ARCHIVE',`ローカルヘッダーが壊れています: ${entry.name}`);
  const localFlags=u16(bytes,offset+6),localMethod=u16(bytes,offset+8),localName=u16(bytes,offset+26),localExtra=u16(bytes,offset+28),dataStart=offset+30+localName+localExtra;
  if(localFlags!==flags||localMethod!==method||localName!==nameBytes.length||dataStart+compressed>centralOffset||!nameBytes.every((b,i)=>bytes[offset+30+i]===b))fail('INVALID_ARCHIVE',`ローカルヘッダーが一致しません: ${entry.name}`);
  extras(bytes,offset+30+localName,localExtra);
  if(!(flags&FLAG.descriptor)&&(u32(bytes,offset+14)!==crc||u32(bytes,offset+18)!==compressed||u32(bytes,offset+22)!==size))fail('INVALID_ARCHIVE',`サイズまたはCRCが一致しません: ${entry.name}`);
  let end=dataStart+compressed;
  if(flags&FLAG.descriptor){
    if(u32(bytes,end)===SIGNATURE.descriptor)end+=4;
    if(end+12>centralOffset||u32(bytes,end)!==crc||u32(bytes,end+4)!==compressed||u32(bytes,end+8)!==size)fail('INVALID_ARCHIVE',`data descriptorが一致しません: ${entry.name}`);
    end+=12;
  }
  return {dataStart,end};
}
// Inflates one entry while enforcing the per-file, total and ratio limits.
function extract(bytes,entry,budget,checkTime) {
  const max=extension(entry.name)==='svg'?zipLimits.svg:zipLimits.file;
  const chunks=[];let length=0,crc=0xffffffff;
  const accept=chunk=>{
    length+=chunk.length;budget.total+=chunk.length;
    if(length>max||budget.total>zipLimits.total||length>entry.size||entry.compressed&&length/entry.compressed>zipLimits.ratio)fail('LIMIT_EXCEEDED',`展開容量が上限を超えました: ${entry.name}`);
    crc=crcUpdate(crc,chunk);chunks.push(chunk);checkTime();
  };
  const start=entry.dataStart,stop=start+entry.compressed;
  if(entry.method===0)accept(bytes.subarray(start,stop));
  else {
    if(!entry.compressed)fail('INTEGRITY_MISMATCH',`Deflateデータがありません: ${entry.name}`);
    const stream=new Inflate(chunk=>accept(chunk));
    try {
      for(let at=start;at<stop;at+=1024){const end=Math.min(at+1024,stop);stream.push(bytes.subarray(at,end),end===stop);checkTime();}
    }catch(e){if(e instanceof AppError)throw e;fail('INTEGRITY_MISMATCH',`Deflateデータが壊れています: ${entry.name}`);}
  }
  if(length!==entry.size||((crc^0xffffffff)>>>0)!==entry.crc)fail('INTEGRITY_MISMATCH',`展開サイズまたはCRCが一致しません: ${entry.name}`);
  const content=new Uint8Array(length);let pos=0;
  for(const chunk of chunks){content.set(chunk,pos);pos+=chunk.length;}
  return content;
}
function packageFile(name,content) {
  const ext=extension(name),mime=MIME_TYPES.get(ext);
  if(TEXT_EXTENSIONS.has(ext))return {mime,text:utf8(content),bytes:content};
  imageType(name,content);
  validateRaster(mime,content);
  return {mime,bytes:content};
}

// Validates a ZIP (base64 or bytes) and returns its files keyed by path, the
// HTML pages, and the start page when it can be chosen automatically.
export function inspectZip(input,started=Date.now()) {
  const bytes=typeof input==='string'?decodeBase64(input,zipLimits.compressed):input;
  if(!(bytes instanceof Uint8Array)||bytes.length>zipLimits.compressed||bytes.length<22)fail('INVALID_ARCHIVE','ZIPが空または'+maxImportMiB+' MiBを超えています。');
  const checkTime=()=>{if(Date.now()-started>zipLimits.elapsed)fail('PROCESSING_TIMEOUT','ZIPの検査が20秒を超えました。');};
  const eocd=findEndOfCentralDirectory(bytes);
  if(eocd<0||u16(bytes,eocd+4)||u16(bytes,eocd+6)||u16(bytes,eocd+8)!==u16(bytes,eocd+10))fail('INVALID_ARCHIVE','ZIP終端が不正です。');
  const count=u16(bytes,eocd+10),centralSize=u32(bytes,eocd+12),centralOffset=u32(bytes,eocd+16);
  if(count>zipLimits.entries||count===0)fail('LIMIT_EXCEEDED','ZIPエントリー数は1〜200件です。');
  if(centralSize===0xffffffff||centralOffset===0xffffffff||centralOffset+centralSize!==eocd)fail('INVALID_ARCHIVE','ZIPの中央ディレクトリが不正です。');

  let at=centralOffset,fileCount=0,pages=0,declaredTotal=0;
  const entries=[],names=new Set();
  for(let i=0;i<count;i++) {
    checkTime();
    const {end,entry}=centralEntry(bytes,at,eocd,names);
    if(!entry.directory){fileCount++;declaredTotal+=entry.size;if(checkDeclaredFile(entry))pages++;}
    entries.push(entry);at=end;
  }
  if(at!==eocd||fileCount>zipLimits.files||pages>zipLimits.pages||declaredTotal>zipLimits.total||pages===0)fail('LIMIT_EXCEEDED','ZIPのファイル数・容量・HTML数を確認してください。');
  const filesOnly=new Set(entries.filter(e=>!e.directory).map(e=>e.name.toLowerCase()));
  for(const entry of entries){
    const segments=entry.name.replace(/\/$/,'').toLowerCase().split('/');
    for(let i=1;i<segments.length;i++)if(filesOnly.has(segments.slice(0,i).join('/')))fail('UNSAFE_PATH',`ファイルとディレクトリが衝突します: ${entry.name}`);
  }

  // Every byte before the central directory must belong to exactly one entry.
  const intervals=[];
  for(const entry of entries) {
    checkTime();
    const {dataStart,end}=localRange(bytes,entry,centralOffset);
    intervals.push([entry.offset,end]);entry.dataStart=dataStart;
  }
  intervals.sort((a,b)=>a[0]-b[0]);
  if(intervals[0][0]!==0||intervals[intervals.length-1][1]!==centralOffset||intervals.some((x,i)=>i&&x[0]!==intervals[i-1][1]))fail('INVALID_ARCHIVE','ZIPのデータ範囲が重複または欠落しています。');

  const files=new Map(),budget={total:0};
  for(const entry of entries) {
    if(entry.directory)continue;
    checkTime();
    const content=extract(bytes,entry,budget,checkTime);
    if(!ignored(entry.name))files.set(entry.name,packageFile(entry.name,content));
  }
  const paths=[...files.keys()].filter(name=>/\.html?$/i.test(name));
  return {files,pages:paths,startPage:paths.includes('index.html')?'index.html':paths.length===1?paths[0]:null,archiveBytes:bytes};
}
