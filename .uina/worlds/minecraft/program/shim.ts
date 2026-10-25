/** Evaluated after user declarations; returned helpers are held by the Worker, not globals. */
export const SHIM = String.raw`(() => {
  const post = globalThis.__uinaPost;
  delete globalThis.__uinaPost;
  const failures = new WeakMap();
  let latest = null, logs = [], logSize = 0, pending = 0;
  const error = (code, message) => {
    const e = new Error(message);
    const data = {code, source:'program', scope:'call', message};
    Object.assign(e,data); failures.set(e,data); return e;
  };
  const encode = (value, top = false) => {
    const active = new Set();
    const check = v => {
      if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object') throw error('PROGRAM_VALUE','only JSON values cross the program boundary');
      if (active.has(v)) throw error('PROGRAM_VALUE','cyclic JSON value');
      active.add(v);
      for (const key of Object.keys(v)) check(v[key]);
      active.delete(v);
    };
    check(value);
    const text = JSON.stringify(top && value === undefined ? null : value);
    if (text === undefined) throw error('PROGRAM_VALUE','undefined is only accepted as the main return value');
    return text;
  };
  const rpc = (method, args) => {
    const text = encode(args);
    if (pending >= 16) throw error('PROGRAM_CAPACITY','too many pending host RPCs');
    pending++;
    let result;
    try { result = post(method, text); }
    catch(e) { pending--; throw error(e.name === 'PROGRAM_VALUE' ? 'PROGRAM_VALUE' : 'PROGRAM_ERROR',e.message); }
    return result.then(reply => {
    if (reply.ok) return reply.value;
    const data = reply.error;
    const e = new Error(data.message || data.code);
    Object.assign(e, data); failures.set(e, data); throw e;
    }).finally(() => { pending--; });
  };
  const unavailable = () => { throw error('PROGRAM_UNAVAILABLE','this API is not delivered in batch 7'); };
  const windowHandle = h => ({
    snapshot: () => rpc('handleOp',{handle:h.handle,op:'snapshot',args:{}}),
    click: args => rpc('handleOp',{handle:h.handle,op:'click',args}),
    close: () => rpc('closeHandle',{handle:h.handle}),
  });
  const body = h => {
    const op = (name,args) => rpc('handleOp',{handle:h.handle,op:name,args});
    return Object.freeze({
      call: (selector,input={}) => rpc('call',{selector,args:input,delegateBody:true,handle:h.handle}),
      drive: (input,opts={}) => op('drive',{input,opts}),
      dig: (at,opts={}) => op('dig',{at,opts}),
      attack: target => op('attack',{target}),
      useItem: (opts={}) => op('useItem',opts),
      endUse: () => op('endUse',{}),
      interact: (target,opts={}) => op('interact',{target,opts}),
      equip: (item,hand='main') => op('equip',{item,hand}),
      lookAt: target => op('lookAt',{target}),
      writeSign: (at,opts) => op('writeSign',{at,opts}),
      openContainer: async target => windowHandle(await op('openContainer',{target})),
      feedback: unavailable, loop: unavailable,
    });
  };
  const mc = Object.freeze({
    call: (selector,input={}) => rpc('call',{selector,args:input}),
    read: async (selector,input={}) => {
      const r = await rpc('read',{targets:{target:{ref:selector,input}}});
      return {value:r.values.target,version:r.versions.target,unknown:r.unknown.target};
    },
    sleep: ms => rpc('sleep',{ms}).then(() => undefined),
    progress: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw error('PROGRAM_VALUE','progress requires an object');
      latest = JSON.parse(encode(value));
    },
    withBody: async work => {
      if (typeof work !== 'function') throw error('PROGRAM_INPUT_INVALID','withBody requires a function');
      const h = await rpc('acquireBody',{});
      try { return await work(body(h)); } finally { await rpc('releaseBody',{handle:h.handle}); }
    },
    waitUntil: unavailable, decide: unavailable,
    get checkpoint() { return unavailable(); },
  });
  const console = {};
  for (const level of ['log','info','warn','error']) console[level] = (...args) => {
    const text = level + ': ' + args.map(x => typeof x === 'string' ? x : encode(x,true)).join(' ');
    logs.push(text); logSize += text.length;
    while (logSize > 8192 && logs.length) logSize -= logs.shift().length;
  };
  globalThis.console = Object.freeze(console);
  return {
    mc, encode,
    errorData: e => JSON.stringify(failures.get(e) || {code:'PROGRAM_ERROR',scope:'call',source:'program',
      message:String(e && e.message || e), guestStack:String(e && e.stack || '').split('\n').slice(0,12)}),
    flush: () => { const v = JSON.stringify({progress:latest,logs}); latest=null;logs=[];logSize=0;return v; },
  };
})()`;
