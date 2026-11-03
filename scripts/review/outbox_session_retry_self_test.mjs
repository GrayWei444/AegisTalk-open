/**
 * 沒有 session 時排的「待加密」訊息（移植群星 registerOutboxEncrypt(fn, owner, requestSession)，取代 registerSessionNudge）：
 *   真的 p2pSend.ts＋AppProvider 真的註冊那段。MQTT 斷線時不記「催過了」，連上後下一次 flush 馬上催；60 秒節流；
 *   session 好了加密送出、不再催；帳號離開之後什麼都不排、不催；換帳號後舊帳號還在跑的 flush 不能替新帳號催。
 * Run: node scripts/review/outbox_session_retry_self_test.mjs
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';
const {transformSync}=createRequire(new URL('../../packages/pwa/package.json',import.meta.url))('esbuild');
const read=p=>readFileSync(new URL('../../packages/pwa/src/'+p,import.meta.url),'utf8');
const module={exports:{}};
let now=1000, online=false, session=false, requests=[], delivered=[], pending=[];
const storage={
 getPendingMessageCount:async peer=>pending.filter(m=>m.recipientPubkey===peer).length,
 addPendingMessage:async m=>pending.push(m),
 getPendingMessagesForRecipient:async peer=>pending.filter(m=>m.recipientPubkey===peer),
 getAllPendingMessages:async()=>pending,
 removePendingMessage:async id=>{pending=pending.filter(m=>m.id!==id)},
 updatePendingMessageRetry:async()=>{},
};
runInNewContext(transformSync(read('services/p2pSend.ts'),{loader:'ts',format:'cjs'}).code,{
 module,exports:module.exports,crypto:webcrypto,Date:{now:()=>now},console:{error(){}},
 require:n=>{
  if(n==='./storage')return storage;
  if(n==='../utils/devLog')return{devLog(){},devWarn(){}};
  if(n==='../utils/diagLog')return{diagLog(){}};
  throw Error(n);
 },
});
const api=module.exports, flush=()=>new Promise(setImmediate);
const transport={isConnectedTo:()=>true,sendToPeer:(_p,data)=>{delivered.push(JSON.parse(data));return true},connectPeer:async()=>{}};
api.registerP2PFunctions(transport,'owner-A');
// Use the actual provider wiring: only signed prekey metadata travels, sealed to the peer's identity key (DIRECT_SEALED kind prekey, step 4).
const provider=read('providers/AppProvider.tsx');
const start=provider.indexOf('  useEffect(() => {\n    if (!cryptoReady) return;\n    registerOutboxEncrypt');
const end=provider.indexOf('\n\n  // FamilyGuard',start);
assert.ok(start>=0&&end>start);
const wire=(owner)=>runInNewContext(transformSync(provider.slice(start,end),{loader:'tsx'}).code,{
 useEffect:f=>f(),cryptoReady:true,publicKey:owner,
 signedPreKey:{publicKeyBase64:'signed-key',signatureBase64:'signature'},
 registerOutboxEncrypt:api.registerOutboxEncrypt,
 encrypt:async(_p,text)=>{if(!session)throw Error('No session with this recipient');return{toJson:()=>JSON.stringify({ciphertext:'encrypted:'+text}),free(){}}},
 mqttService:{isConnected:()=>online,sendToUser:()=>{throw Error('no plaintext prekey request over MQTT')}},
 sendPrekeyRequest:async(peer,bundle)=>{requests.push({peer,type:'prekey-request',payload:bundle});return true},
});
wire('owner-A');
api.enqueuePlaintextForSession('peer-A','private message');await flush();
assert.equal(pending.length,1);assert.equal(requests.length,0);
online=true;await api.flushQueueForPeer('peer-A');
assert.equal(requests.length,1);assert.equal(delivered.length,0);assert.equal(pending.length,1);
assert.deepEqual(JSON.parse(JSON.stringify(requests[0])),{peer:'peer-A',type:'prekey-request',payload:{signedPreKey:'signed-key',signature:'signature'}});
now+=59_999;await api.flushQueueForPeer('peer-A');assert.equal(requests.length,1);
now++;await api.flushQueueForPeer('peer-A');assert.equal(requests.length,2,'lost first request is retried');
session=true;assert.equal(await api.flushQueueForPeer('peer-A'),1);assert.equal(pending.length,0);
assert.equal(delivered[0].type,'encrypted_message');
assert.equal(requests.length,2,'working session must not reset');
// New identities cannot inherit the old throttle or callback; shutdown must not send anything.
await api.shutdownP2PAccount();
api.enqueuePlaintextForSession('peer-A','discard after logout');await flush();assert.equal(pending.length,0);
api.registerP2PFunctions(transport,'owner-B');session=false;
api.enqueuePlaintextForSession('peer-A','B pending');await flush();assert.equal(requests.length,2);
wire('owner-B');await api.flushQueueForPeer('peer-A');assert.equal(requests.length,3);
let release;
api.registerOutboxEncrypt(()=>new Promise(r=>release=r),'owner-B',()=>{throw Error('stale callback called')});
const stale=api.flushQueueForPeer('peer-A');await flush();
await api.shutdownP2PAccount();api.registerP2PFunctions(transport,'owner-C');wire('owner-C');
release(null);await stale;assert.equal(requests.length,3,'retired flush cannot nudge for the new account');
console.log('PASS: offline enqueue, reconnect retry, 60s throttle, encrypted delivery, logout and account isolation');
