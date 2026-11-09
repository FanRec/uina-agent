/** Capture trusted intrinsics before user code; inject the bridge only after declarations. */
export const SHIM = String.raw`(() => {
  const failures = new WeakMap();
  const decisions = new WeakMap();
  const decisionGet = decisions.get.bind(decisions), decisionSet = decisions.set.bind(decisions);
  const failureGet = failures.get.bind(failures), failureSet = failures.set.bind(failures);
  const stringify=JSON.stringify, parse=JSON.parse, keys=Object.keys, values=Object.values, freeze=Object.freeze, assign=Object.assign, GuestError=Error;
  const trim=Function.prototype.call.bind(String.prototype.trim);
  const hasOwn=Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const then=Function.prototype.call.bind(Promise.prototype.then);
  const finallyPromise=Function.prototype.call.bind(Promise.prototype.finally);
  return (post,now,checkpointValue) => {
  const freezeJson = v => {
    if(v && typeof v==='object') { for(const child of values(v)) freezeJson(child); freeze(v); }
    return v;
  };
  const checkpoint = freezeJson(checkpointValue);
  let latest = null, logs = [], logSize = 0, pending = 0;
  const error = (code, message) => {
    const e = new Error(message);
    const data = {code, source:'program', scope:'call', message};
    assign(e,data); failureSet(e,data); return e;
  };
  const encode = (value, top = false) => {
    const active = new Set();
    const check = v => {
      if (v === undefined || v === null || typeof v === 'string' || typeof v === 'boolean') return;
      if (typeof v === 'number' && Number.isFinite(v)) return;
      if (typeof v !== 'object') throw error('PROGRAM_VALUE','only JSON values cross the program boundary');
      if (active.has(v)) throw error('PROGRAM_VALUE','cyclic JSON value');
      active.add(v);
      for (const key of keys(v)) check(v[key]);
      active.delete(v);
    };
    check(value);
    const text = stringify(top && value === undefined ? null : value);
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
    return finallyPromise(then(result,reply => {
    if (reply.ok) return reply.value;
    if (hasOwn(reply,'decisionJson')) {
      const request=freezeJson(parse(reply.decisionJson));
      const e=assign(new GuestError(request.reason),request);
      decisionSet(e,'{"kind":"host","request":'+reply.decisionJson+'}');
      throw e;
    }
    const data = reply.error;
    const e = new Error(data.message || data.code);
    assign(e, data); failureSet(e, data); throw e;
    }),() => { pending--; });
  };
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
      feedback: async (sensors={}) => {
        const stream=await op('feedback',{sensors});
        return freeze({next:(after=null)=>rpc('handleOp',{handle:stream.handle,op:'next',args:{after}}),
          apply:(frame,input)=>rpc('handleOp',{handle:stream.handle,op:'apply',args:{frame:{stream:frame.stream,sequence:frame.sequence},input}}),
          close:()=>rpc('closeHandle',{handle:stream.handle})});
      },
      loop: async (step,sensors={}) => {
        if(typeof step!=='function')throw error('PROGRAM_INPUT_INVALID','loop requires a synchronous step');
        const stream=await body(h).feedback(sensors);
        let after=null;
        try { while(true) {
          const frame=await stream.next(after); after=frame.sequence;
          const input=step(frame);
          if(input && typeof input.then==='function')throw error('STEP_ASYNC','loop step must be synchronous');
          if(input && input.done===true)return;
          await stream.apply(frame,input);
        }} finally {await stream.close();}
      },
    });
  };
  const mc = Object.freeze({
    call: (selector,input={}) => rpc('call',{selector,args:input}),
    verify: (effect,verifier,input={}) => {
      if(typeof effect!=='string'||!effect) throw error('PROGRAM_INPUT_INVALID','verify requires an effect ref');
      if(typeof verifier!=='string'||!verifier) throw error('PROGRAM_INPUT_INVALID','verify requires a verifier ref');
      if(input===null||typeof input!=='object'||Array.isArray(input)) throw error('PROGRAM_INPUT_INVALID','verify input must be an object');
      return rpc('verify',{effect,verifier,args:input});
    },
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
      try { return await Promise.race([work(body(h)),rpc('handleOp',{handle:h.handle,op:'waitClosed',args:{}})]); }
      finally { await rpc('releaseBody',{handle:h.handle}); }
    },
    waitUntil: async (targets,predicate,opts={}) => {
      const started=now();
      if(typeof predicate!=='function') throw error('PREDICATE_INVALID','predicate must be a synchronous function returning boolean');
      const captured=JSON.parse(encode(targets)), timeoutMs=opts.timeoutMs;
      if(!captured || typeof captured!=='object' || Array.isArray(captured) || !Object.keys(captured).length || Object.values(captured).some(t=>!t || typeof t.ref!=='string')) throw error('INVALID_INPUT','wait targets must be a nonempty query map');
      if(timeoutMs!==undefined && (!Number.isFinite(timeoutMs)||timeoutMs<0)) throw error('INVALID_INPUT','timeoutMs must be finite and non-negative');
      let after;
      const read=async()=>{
        const state=await rpc('read',{targets:captured,...(after?{after}:{})});
        if(state.kind==='invalidated')return state;
        if(Object.keys(captured).some(key=>typeof state.versions[key]!=='string')) throw error('INVALID_INPUT','query is not waitable; events need target.input.after from the final page, not an options field');
        after=state.versions;
        return state;
      };
      const test=state=>{
        const result=predicate(state.values,{unknown:state.unknown});
        if(typeof result!=='boolean') throw error('PREDICATE_INVALID','predicate must return boolean, not a Promise');
        return result;
      };
      const final=async()=>{const state=await read();return state.kind==='invalidated'?state:{kind:test(state)?'met':'timeout',...state};};
      while(true) {
        const state=await read();
        if(state.kind==='invalidated')return state;
        if(test(state))return {kind:'met',...state};
        const remaining=timeoutMs===undefined?undefined:timeoutMs-(now()-started);
        if(remaining!==undefined&&remaining<=0)return final();
        const change=await rpc('watch',{targets:captured,after:state.versions,...(remaining===undefined?{}:{timeoutMs:remaining})});
        if(change.status==='invalidated')return {kind:'invalidated',reason:change.reason};
        if(change.status==='timeout')return final();
      }
    },
    decide: (reason,cp) => {
      if(typeof reason!=='string' || !trim(reason)) throw error('PROGRAM_INPUT_INVALID','decide requires a nonempty reason');
      const encoded=cp===undefined?undefined:encode(cp);
      const e=assign(new GuestError(reason),{code:'NEEDS_DECISION',reason,...(encoded===undefined?{}:{checkpoint:parse(encoded)})});
      // Store bytes separately from Error fields and guest-controlled toJSON hooks.
      decisionSet(e,'{"kind":"local","reason":'+stringify(reason)+(encoded===undefined?'':',"checkpoint":'+encoded)+'}');
      throw e;
    },
    get checkpoint() { return checkpoint; },
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
    decisionData: e => decisionGet(e) || null,
    errorData: e => stringify(failureGet(e) || {code:'PROGRAM_ERROR',scope:'call',source:'program',
      message:String(e && e.message || e), guestStack:String(e && e.stack || '').split('\n').slice(0,12)}),
    flush: () => { const v = JSON.stringify({progress:latest,logs}); latest=null;logs=[];logSize=0;return v; },
  };
  };
})()`;
