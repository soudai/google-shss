// Calls the Apps Script rpc() entry point (gas/Code.gs) and turns its
// {ok, value} / {ok:false, error} replies into return values and exceptions.

const NETWORK_ERROR = '通信に失敗しました。再試行してください。';

export function scriptRunApi(run) {
  return (action, input) => new Promise((resolve, reject) => {
    run.withSuccessHandler(resolve).withFailureHandler(() => reject(new Error(NETWORK_ERROR))).rpc(action, input);
  });
}

// Waits before resending a request the server rejected as BUSY. The jitter keeps
// several users who collided from colliding again.
export const BUSY_DELAYS = [1000, 2000, 4000, 8000];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Errors carry the server's code and retryable flag. A missing code means the
// request may not have reached the server, or its outcome is unknown.
// BUSY means the server could not take the write lock and changed nothing, so
// the same request is resent automatically.
export function createCaller(api, {busyDelays = BUSY_DELAYS, wait = sleep, random = Math.random} = {}) {
  return async function call(action, input = {}) {
    for (let attempt = 0; ; attempt++) {
      let reply;
      try {reply = await api(action, input);} catch {throw new Error(NETWORK_ERROR);}
      if (reply?.ok) return reply.value;
      if (reply?.error?.code === 'BUSY' && attempt < busyDelays.length) {
        await wait(busyDelays[attempt] * (0.5 + random()));
        continue;
      }
      throw Object.assign(new Error(reply?.error?.message || '通信に失敗しました。'), reply?.error);
    }
  };
}
