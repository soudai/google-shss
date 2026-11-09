import {fail,MiB,PIXEL_LIMITS} from './util.mjs';

// Parses just enough of each raster format to bound the decoded size, so that a
// small file cannot expand into a huge bitmap in the reviewer's browser.
const {side:maxSide,area:maxArea,frames:maxFrames}=PIXEL_LIMITS;
const u16=(b,i)=>b[i]|b[i+1]<<8;
const u16be=(b,i)=>b[i]<<8|b[i+1];
const u24=(b,i)=>b[i]|b[i+1]<<8|b[i+2]<<16;
const u32be=(b,i)=>(b[i]*0x1000000+(b[i+1]<<16|b[i+2]<<8|b[i+3]))>>>0;
const ascii=(b,i,n)=>String.fromCharCode(...b.subarray(i,i+n));
function size(width,height,pixels=width*height) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>maxSide||height>maxSide||pixels>maxArea)fail('LIMIT_EXCEEDED','画像の幅・高さ・フレーム画素数が上限を超えています。');
}
function png(bytes) {
  if(bytes.length<24||ascii(bytes,0,8)!=='\x89PNG\r\n\x1a\n'||ascii(bytes,12,4)!=='IHDR'||u32be(bytes,8)!==13)fail('UNSUPPORTED_TYPE','PNGのヘッダーが不正です。');
  size(u32be(bytes,16),u32be(bytes,20));
  for(let at=8;at+12<=bytes.length;){
    const n=u32be(bytes,at),end=at+12+n;
    if(end>bytes.length)fail('UNSUPPORTED_TYPE','PNGのチャンクが不正です。');
    if(ascii(bytes,at+4,4)==='acTL')fail('UNSUPPORTED_TYPE','アニメーションPNGは対象外です。');
    at=end;
  }
}
function gif(bytes) {
  if(bytes.length<13||!['GIF87a','GIF89a'].includes(ascii(bytes,0,6)))fail('UNSUPPORTED_TYPE','GIFのヘッダーが不正です。');
  const width=u16(bytes,6),height=u16(bytes,8);size(width,height);
  let at=13,pixels=0,frames=0;
  if(bytes[10]&0x80)at+=3*(1<<((bytes[10]&7)+1));
  const blocks=()=>{for(;;){if(at>=bytes.length)fail('UNSUPPORTED_TYPE','GIFのブロックが壊れています。');const n=bytes[at++];if(!n)return;at+=n;if(at>bytes.length)fail('UNSUPPORTED_TYPE','GIFのブロックが壊れています。');}};
  while(at<bytes.length) {
    const marker=bytes[at++];
    if(marker===0x3b){if(!frames||at!==bytes.length)fail('UNSUPPORTED_TYPE','GIFが途中で終わっています。');size(width,height,pixels);return;}
    if(marker===0x21){if(at>=bytes.length)fail('UNSUPPORTED_TYPE','GIFの拡張が壊れています。');at++;blocks();continue;}
    if(marker!==0x2c||at+9>bytes.length)fail('UNSUPPORTED_TYPE','GIFの画像が不正です。');
    const w=u16(bytes,at+4),h=u16(bytes,at+6);size(w,h);pixels+=w*h;frames++;at+=9;
    if(pixels>maxArea||frames>maxFrames)fail('LIMIT_EXCEEDED','GIFの総フレーム画素数が上限を超えています。');
    if(bytes[at-1]&0x80)at+=3*(1<<((bytes[at-1]&7)+1));
    if(at>=bytes.length)fail('UNSUPPORTED_TYPE','GIFの画像が途中で終わっています。');
    at++;blocks();
  }
  fail('UNSUPPORTED_TYPE','GIFの終端がありません。');
}
function jpeg(bytes) {
  if(bytes.length<4||bytes[0]!==255||bytes[1]!==216)fail('UNSUPPORTED_TYPE','JPEGのヘッダーが不正です。');
  let at=2;
  while(at+4<=bytes.length) {
    if(bytes[at++]!==255)fail('UNSUPPORTED_TYPE','JPEGのマーカーが不正です。');
    while(bytes[at]===255)at++;
    const marker=bytes[at++];if(marker===0xd9)break;
    if(marker===0xd8||marker>=0xd0&&marker<=0xd7)continue;
    const length=u16be(bytes,at);if(length<2||at+length>bytes.length)fail('UNSUPPORTED_TYPE','JPEGのセグメントが不正です。');
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(length<7)fail('UNSUPPORTED_TYPE','JPEGのサイズが不正です。');
      size(u16be(bytes,at+5),u16be(bytes,at+3));return;
    }
    at+=length;
  }
  fail('UNSUPPORTED_TYPE','JPEGのサイズを確認できません。');
}
function webp(bytes) {
  if(bytes.length<20||ascii(bytes,0,4)!=='RIFF'||ascii(bytes,8,4)!=='WEBP')fail('UNSUPPORTED_TYPE','WebPのヘッダーが不正です。');
  let at=12,width=0,height=0,pixels=0,frames=0;
  while(at+8<=bytes.length){
    const tag=ascii(bytes,at,4),n=(bytes[at+4]|bytes[at+5]<<8|bytes[at+6]<<16|bytes[at+7]<<24)>>>0,from=at+8;
    if(from+n>bytes.length)fail('UNSUPPORTED_TYPE','WebPのチャンクが不正です。');
    if(tag==='VP8X'&&n>=10){width=u24(bytes,from+4)+1;height=u24(bytes,from+7)+1;size(width,height);}
    if(tag==='VP8 '&&n>=10&&ascii(bytes,from+3,3)==='\x9d\x01\x2a'){width=u16(bytes,from+6)&0x3fff;height=u16(bytes,from+8)&0x3fff;size(width,height);}
    if(tag==='VP8L'&&n>=5&&bytes[from]===0x2f){width=1+((bytes[from+2]&0x3f)<<8|bytes[from+1]);height=1+((bytes[from+4]&0xf)<<6|bytes[from+3]>>2);size(width,height);}
    if(tag==='ANMF'&&n>=16){const w=u24(bytes,from+6)+1,h=u24(bytes,from+9)+1;size(w,h);pixels+=w*h;frames++;if(pixels>maxArea||frames>maxFrames)fail('LIMIT_EXCEEDED','WebPの総フレーム画素数が上限を超えています。');}
    at=from+n+(n&1);
  }
  if(!width||!height||at!==bytes.length)fail('UNSUPPORTED_TYPE','WebPのサイズを確認できません。');
}
export function validateRaster(mime,bytes) {
  if(!(bytes instanceof Uint8Array)||bytes.length>2*MiB)fail('LIMIT_EXCEEDED','画像は2 MiBまでです。');
  if(mime==='image/png')png(bytes);
  else if(mime==='image/jpeg')jpeg(bytes);
  else if(mime==='image/gif')gif(bytes);
  else if(mime==='image/webp')webp(bytes);
  else fail('UNSUPPORTED_TYPE','画像形式が対象外です。');
  return bytes;
}
