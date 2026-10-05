import assert from 'node:assert/strict'
import {test} from 'node:test'
import {Miniflare,convertV4MiniflareOptions,Response} from 'miniflare'
import sodium from 'libsodium-wrappers-sumo'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await wait(50)}assert.fail('Timed out waiting for relay event')}
test('signed ciphertext, durable retry, replay protection, reminders, cancellation, deletion',{timeout:45000},async()=>{
 await sodium.ready;const s=sodium,b64=v=>s.to_base64(v,s.base64_variants.ORIGINAL),un64=v=>s.from_base64(v,s.base64_variants.ORIGINAL)
 const signing=s.crypto_sign_keypair(),directory=await mkdtemp(join(tmpdir(),'oraplot-relay-test-')),received=[]
 let failFirst=true
 const mf=new Miniflare(convertV4MiniflareOptions({name:'relay',modules:true,scriptPath:new URL('../.wrangler/build/index.js',import.meta.url).pathname,compatibilityDate:'2026-09-01',durableObjects:{KEYS:{className:'RelayKeys',useSQLite:true}},durableObjectsPersist:directory,bindings:{WEBHOOK_URL:'https://destination.example/receive',ORAPLOT_PUBLIC_KEY:b64(signing.publicKey)},serviceBindings:{WEBHOOK_SERVICE:async request=>{const value=await request.json();if(value.booking.id==='retry'&&failFirst){failFirst=false;return new Response('try again',{status:500})}received.push(value);return new Response('ok')}}}))
 try{
  const health=await (await mf.dispatchFetch('https://relay.example/')).json();assert.equal(health.service,'oraplot-relay')
  const form=s.crypto_box_keypair(),grant=b64(s.crypto_box_seal(form.privateKey,un64(health.public_key)))
  function delivery(id,version,event='created',reminderIn=0){const key=s.crypto_aead_xchacha20poly1305_ietf_keygen(),nonce=s.randombytes_buf(24),answers={client_name:'Secret Ada',client_email:'private@example.test',reference_image:[{file_id:'file1',name:'private-photo.jpg',key:'never-forward-this-file-key'}]};const ct=s.crypto_aead_xchacha20poly1305_ietf_encrypt(new TextEncoder().encode(JSON.stringify({v:1,answers,submitted_at:Date.now()})),'oraplot:response:v1:calendar:1',null,nonce,key);return {event,booking:{id,version,status:event==='cancelled'?'cancelled':'confirmed',starts_at:new Date(Date.now()+24*3600000+reminderIn).toISOString(),ends_at:new Date(Date.now()+24*3600000+reminderIn+1800000).toISOString()},form:{id:'calendar',title:'Clinic'},submission:{id,key_version:1,sealed_key:b64(s.crypto_box_seal(key,form.publicKey)),ciphertext:b64(new Uint8Array([...nonce,...ct])),created_at:Date.now()/1000},sealed_form_sk:grant}}
  async function send(d,signature=true,ts=Math.floor(Date.now()/1000)){const body=JSON.stringify(d),sig=b64(s.crypto_sign_detached(new TextEncoder().encode(`${ts}.${body}`),signing.privateKey));return mf.dispatchFetch('https://relay.example/deliver',{method:'POST',headers:{'x-oraplot-timestamp':String(ts),'x-oraplot-signature':signature?sig:'invalid'},body})}
  assert.equal((await send(delivery('invalid',1),false)).status,401)
  assert.equal((await send(delivery('old',1),true,Math.floor(Date.now()/1000)-600)).status,401)
  const retry=delivery('retry',1,'created',100000);assert.equal((await send(retry)).status,202)
  await until(()=>received.some(r=>r.booking.id==='retry'))
  const out=received.find(r=>r.booking.id==='retry');assert.equal(out.fields['client name'],'Secret Ada');assert.ok(!JSON.stringify(out).includes('never-forward-this-file-key'))
  assert.equal((await send(retry)).status,202);await wait(250);assert.equal(received.filter(r=>r.booking.id==='retry').length,1)
  const reminder=delivery('reminder',1,'created',500);await send(reminder);await until(()=>received.some(r=>r.booking.id==='reminder'&&r.event==='reminder'))
  const cancel=delivery('cancel',1,'created',1000);await send(cancel);await until(()=>received.some(r=>r.booking.id==='cancel'&&r.event==='created'))
  await send({...cancel,event:'cancelled',booking:{...cancel.booking,status:'cancelled',version:2}})
  await until(()=>received.some(r=>r.booking.id==='cancel'&&r.event==='cancelled'));await wait(1100);assert.ok(!received.some(r=>r.booking.id==='cancel'&&r.event==='reminder'))
  const move=delivery('move',1,'created',1000);await send(move);await until(()=>received.some(r=>r.booking.id==='move'&&r.event==='created'))
  await send({...move,event:'rescheduled',booking:{...move.booking,version:2,starts_at:new Date(Date.now()+48*3600000).toISOString()}})
  await until(()=>received.some(r=>r.booking.id==='move'&&r.event==='rescheduled'));await send(move);await wait(1100);assert.ok(!received.some(r=>r.booking.id==='move'&&r.event==='reminder'))
  await send({event:'deleted',booking:{id:'move',version:3}});await until(()=>received.some(r=>r.booking.id==='move'&&r.event==='deleted'))
  const deleted=received.find(r=>r.booking.id==='move'&&r.event==='deleted');assert.equal(deleted.fields,undefined);await send(move);await wait(200);assert.equal(received.filter(r=>r.booking.id==='move'&&r.event==='created').length,1)
  const again=await (await mf.dispatchFetch('https://relay.example/')).json();assert.equal(again.public_key,health.public_key)
 }finally{await mf.dispose();await rm(directory,{recursive:true,force:true})}
})
