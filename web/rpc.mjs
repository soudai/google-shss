// Calls the Apps Script rpc() entry point (gas/Code.gs) and turns its
// {ok, value} / {ok:false, error} replies into return values and exceptions.

import {gunzipText} from '../server/gzip.mjs';
import {maxImportBytes} from '../server/limits.mjs';

const NETWORK_ERROR = '通信に失敗しました。再試行してください。';

export function scriptRunApi(run) {
  return (action, input) => new Promise((resolve, reject) => {
    run.withSuccessHandler(resolve).withFailureHandler(() => reject(new Error(NETWORK_ERROR))).rpc(action, input);
  });
}

const BUSY_DELAYS = [1000, 2000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Comments retry through their outbox. Appending a version stages files before
// trying the lock, so its upload stays in the import queue for manual retry.
export function createCaller(api, {busyDelays = BUSY_DELAYS, wait = sleep, random = Math.random} = {}) {
  return async function call(action, input = {}) {
    const request = action === 'getDocument' ? {...input, acceptHtmlGzip: true} : input;
    const retryBusy = action === 'manageDocument' || action === 'importDocument';
    const retryList=action==='listDocuments';
    for (let attempt = 0; ; attempt++) {
      let reply;
      try {reply = await api(action, request);} catch {
        if(retryList&&attempt<busyDelays.length){await wait(busyDelays[attempt]*(0.5+random()));continue;}
        throw new Error(NETWORK_ERROR);
      }
      if (reply?.ok) {
        if (action === 'getDocument' && reply.value?.htmlGzip !== undefined) {
          const {htmlGzip, ...value} = reply.value;
          const html = gunzipText(htmlGzip, maxImportBytes, () => {throw new Error('プレビューが上限を超えています。');});
          return {...value, html};
        }
        return reply.value;
      }
      const retryRead=retryList&&reply?.error?.retryable===true&&['INTERNAL','BUSY','LIST_INCOMPLETE'].includes(reply.error.code);
      if (((retryBusy && reply?.error?.code === 'BUSY')||retryRead) && attempt < busyDelays.length) {
        await wait(busyDelays[attempt] * (0.5 + random()));
        continue;
      }
      // An absent error code can indicate an unknown write outcome.
      throw Object.assign(new Error(reply?.error?.message || '通信に失敗しました。'), reply?.error);
    }
  };
}
