/**
 * Fault injection against actual client functions; no network or user secrets.
 *   C06: the device-transfer reload waits for the asynchronous data deletion (SettingsPage).
 * The official-only checks (C02 PIN change journal, C03 cloud backup flush; src/ext-official) are in
 * shared_safety_official_self_test.mjs (split in open-source step 6: the public repository does not have them).
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const require=createRequire(new URL('../../packages/pwa/package.json',import.meta.url));
const {transformSync}=require('esbuild');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
{
 const settings=readFileSync(new URL('../../packages/pwa/src/pages/SettingsPage.tsx',import.meta.url),'utf8');
 const a=settings.indexOf('  const handleDeviceTransferSuccess =');
 const b=settings.indexOf('\n\n  return (',a);
 const handler=transformSync(settings.slice(a,b),{loader:'ts'}).code;
 let finishDelete,deleted=false,reloaded=false;
 runInNewContext(handler+"\nhandleDeviceTransferSuccess('transfer');",{
   resetAll:async()=>{await new Promise(r=>{finishDelete=r});deleted=true},
   mqttService:{disconnect(){}},clearAllOutgoing:async()=>{},clearGuardianNativeData:async()=>{},
   shutdownFileTransfer:async()=>{},shutdownP2PAccount:async()=>{},
   flushToStore:async()=>{},localStorage:{removeItem(){}},window:{location:{reload:()=>{reloaded=true}}},setShowDeviceTransfer(){},
 });
 assert.ok(!reloaded && !deleted);
 // The handler awaits the MQTT outbox clear before it starts the wipe, so let that settle first.
 await flush();assert.equal(typeof finishDelete,'function');assert.ok(!reloaded && !deleted);
 finishDelete();await flush();assert.ok(reloaded && deleted);
 console.log('PASS C06: transfer reload waits for asynchronous data deletion');
}
