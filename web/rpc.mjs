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

// Errors carry the server's code and retryable flag. A missing code means the
// request may not have reached the server, or its outcome is unknown.
export function createCaller(api) {
  return async function call(action, input = {}) {
    let reply;
    try {reply = await api(action, action==='getDocument'?{...input,acceptHtmlGzip:true}:input);} catch {throw new Error(NETWORK_ERROR);}
    if (!reply?.ok) throw Object.assign(new Error(reply?.error?.message || '通信に失敗しました。'), reply?.error);
    if(action==='getDocument'&&reply.value?.htmlGzip!==undefined){
      const {htmlGzip,...value}=reply.value;
      const html=gunzipText(htmlGzip,maxImportBytes,()=>{throw new Error('プレビューが上限を超えています。');});
      return {...value,html};
    }
    return reply.value;
  };
}
