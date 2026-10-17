import { loadQqWorldConfig } from '../../.uina/worlds/qq/src/config.js';
import { OneBotTransport } from '../../.uina/worlds/qq/src/transport.js';
const config = loadQqWorldConfig();
if (!config.ok) { console.log(JSON.stringify({ stage: 'config', available: false })); process.exit(0); }
const transport = new OneBotTransport({ connection: config.config.connection, expectedSelfId: config.config.selfId });
const abort = AbortSignal.timeout(6000);
try {
 await transport.start(abort);
 console.log(JSON.stringify({ stage: 'identity', matched: true }));
 const friends = await transport.call('get_friend_list', {}, abort);
 const groups = await transport.call('get_group_list', {}, abort);
 console.log(JSON.stringify({ stage: 'directory', friendsOk: friends.status === 'ok', groupsOk: groups.status === 'ok', friendCount: friends.status === 'ok' && Array.isArray(friends.data) ? friends.data.length : null, groupCount: groups.status === 'ok' && Array.isArray(groups.data) ? groups.data.length : null }));
 if (groups.status === 'ok' && Array.isArray(groups.data) && groups.data.length) {
  const history = await transport.call('get_group_msg_history', { group_id: groups.data[0].group_id, count: 1, reverse_order: true }, abort);
  console.log(JSON.stringify({ stage: 'history', ok: history.status === 'ok', count: history.status === 'ok' ? history.data?.messages?.length ?? null : null }));
 }
} catch { console.log(JSON.stringify({ stage: 'connection', available: false })); }
finally { await transport.stop(); }
