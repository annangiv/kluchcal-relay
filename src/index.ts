/** Customer-owned Oraplot relay. Private keys and decrypted data stay in this account. */
import {DurableObject} from 'cloudflare:workers'
import {tokenMatches,validBinding,sameBinding,type Binding} from './ownership'
import {ed25519,x25519} from '@noble/curves/ed25519.js'
import {decryptSubmission,fromB64,publicKeyFor,toB64} from './crypto'
import {targetFor,bodyFor,type Readable} from './format'
export interface Env {
 KEYS:DurableObjectNamespace<RelayKeys>;WEBHOOK_URL:string;ORAPLOT_ORIGIN?:string;
 RELAY_PAIRING_TOKEN:string;WEBHOOK_IDEMPOTENT?:string;ORAPLOT_PUBLIC_KEY?:string;WEBHOOK_SERVICE?:Fetcher;WEBHOOK_FORMAT?:string;
}
type Delivery={integration_id:string;workspace_id:string;event:string;booking:{id:string;version:number;starts_at?:string;ends_at?:string;status?:string};form?:{id:string;title:string};submission?:{id:string;key_version:number;sealed_key:string;ciphertext:string;created_at:number};sealed_form_sk?:string}
type Job={delivery:Delivery;next:number;attempts:number;reminderAt?:number;sent:boolean;sending?:boolean;blocked?:boolean}
function json(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}})}
export class RelayKeys extends DurableObject<Env> {
 async secretKey():Promise<Uint8Array>{
  return this.ctx.blockConcurrencyWhile(async()=>{const old=await this.ctx.storage.get<Uint8Array>('relay_sk');if(old)return new Uint8Array(old);const key=x25519.utils.randomSecretKey();await this.ctx.storage.put('relay_sk',key);return key})
 }
  async pair(binding: Binding): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      const key = `binding:${binding.integration_id}`
      // IDs are immutable, including expired/revoked bindings. Reconnect with a new ID.
      if (await tx.get(key)) return false
      await tx.put(key, { integration_id: binding.integration_id, form_id: binding.form_id, workspace_id: binding.workspace_id, expires_at: Date.now() + 90 * 86400_000, revoked: false })
      return true
    })
  }
  async bound(binding: Binding): Promise<boolean> {
    const saved = await this.ctx.storage.get<Binding & { expires_at: number; revoked: boolean }>(`binding:${binding.integration_id}`)
    return !!saved && !saved.revoked && saved.expires_at > Date.now() && sameBinding(saved, binding)
  }
  async revoke(binding: Binding): Promise<boolean> {
    return this.ctx.storage.transaction(async tx => {
      const key = `binding:${binding.integration_id}`
      const saved = await tx.get<Binding>(key)
      if (!saved || !sameBinding(saved, binding)) return false
      await tx.put(key, { ...saved, revoked: true, expires_at: 0 })
      return true
    })
  }
 async retry(binding:Binding,bookingId:string):Promise<boolean>{
  if(!await this.bound(binding))return false
  return this.ctx.blockConcurrencyWhile(async()=>{
   const key=`booking:${binding.integration_id}:${bookingId}`;const job=await this.ctx.storage.get<Job>(key)
   if(!job?.blocked)return false
   job.blocked=false;job.sending=false;job.next=Date.now();await this.ctx.storage.put(key,job);await this.scheduleNext();return true
  })
 }
 async accept(delivery:Delivery):Promise<void>{
  // One ordered record per booking prevents replays and stale changes resurrecting jobs.
  await this.ctx.blockConcurrencyWhile(async()=>{
   const key=`booking:${delivery.integration_id}:${delivery.booking.id}`;const old=await this.ctx.storage.get<Job>(key)
   if(old&&old.delivery.booking.version>=delivery.booking.version)return
   const active=['pending','confirmed'].includes(delivery.booking.status||'')
   const reminder=active?Date.parse(delivery.booking.starts_at||'')-24*60*60*1000:NaN
   await this.ctx.storage.put(key,{delivery,next:Date.now(),attempts:0,sent:false,...(Number.isFinite(reminder)&&reminder>Date.now()?{reminderAt:reminder}:{})} satisfies Job)
   await this.scheduleNext()
  })
 }
 async scheduleNext(){
  const rows=await this.ctx.storage.list<Job>({prefix:'booking:'});let next=Infinity
  for(const job of rows.values()){if(job.blocked)continue;if(!job.sent)next=Math.min(next,job.next);else if(job.reminderAt)next=Math.min(next,job.reminderAt)}
  if(Number.isFinite(next))await this.ctx.storage.setAlarm(Math.max(Date.now()+100,next));else await this.ctx.storage.deleteAlarm()
 }
 async alarm(){
  await this.ctx.blockConcurrencyWhile(async()=>{
   const rows=await this.ctx.storage.list<Job>({prefix:'booking:'})
   for(const [key,job] of rows){
    if(job.blocked)continue
    const binding={integration_id:job.delivery.integration_id,workspace_id:job.delivery.workspace_id,form_id:job.delivery.form?.id||''}
    if(!validBinding(binding)||!await this.bound(binding)||(job.sending&&this.env.WEBHOOK_IDEMPOTENT!=='1')){job.blocked=true;await this.ctx.storage.put(key,job);continue}
    const reminder=job.sent&&job.reminderAt!==undefined&&job.reminderAt<=Date.now()
    if(!reminder&&(job.sent||job.next>Date.now()))continue
    job.sending=true;await this.ctx.storage.put(key,job)
    try{
     const out=await this.output(job.delivery,reminder?'reminder':job.delivery.event)
     const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),10000)
     let response:Response
     try {const init={method:'POST',headers:{'content-type':'application/json','user-agent':'oraplot-relay/2','idempotency-key':`${job.delivery.integration_id}:${job.delivery.booking.id}:${job.delivery.booking.version}:${reminder?'reminder':job.delivery.event}`},body:JSON.stringify(out),signal:controller.signal};response=this.env.WEBHOOK_SERVICE?await this.env.WEBHOOK_SERVICE.fetch(this.env.WEBHOOK_URL,init):await fetch(this.env.WEBHOOK_URL,init)}finally{clearTimeout(timer)}
     if(!response.ok)throw new Error('destination did not accept delivery')
     if(reminder)delete job.reminderAt;else job.sent=true
     job.attempts=0;job.sending=false
    }catch{
     // Never log plaintext, keys, webhook destinations or delivery bodies.
     job.sending=false;if(this.env.WEBHOOK_IDEMPOTENT!=='1')job.blocked=true
     job.attempts++;const retry=Date.now()+Math.min(3600000,5000*2**Math.min(job.attempts,10));if(reminder)job.reminderAt=retry;else job.next=retry
    }
    // Persist ciphertext for retries. Successful deletion keeps only a version tombstone.
    if(job.sent&&job.delivery.event==='deleted')job.delivery={event:'deleted',booking:job.delivery.booking,integration_id:job.delivery.integration_id,workspace_id:job.delivery.workspace_id,form:job.delivery.form}
    await this.ctx.storage.put(key,job)
    break // Keep each alarm below the Durable Object concurrency-gate timeout.
   }
   await this.scheduleNext()
  })
 }
 async output(d:Delivery,event:string){
  const common={source:'oraplot',event,event_id:`${d.booking.id}:${d.booking.version}:${event}`,booking:d.booking}
  if(event==='deleted')return common
  if(!d.submission||!d.form||!d.sealed_form_sk)throw new Error('missing encrypted envelope')
  const envelope=decryptSubmission(await this.readSecret(),{form_id:d.form.id,key_version:d.submission.key_version,sealed_form_sk:d.sealed_form_sk,sealed_key:d.submission.sealed_key,ciphertext:d.submission.ciphertext})
  const readable:Readable={source:'oraplot',form:{id:d.form.id,title:`${event.toUpperCase()} · ${d.form.title} · ${d.booking.starts_at||''}`},submission_id:d.booking.id,submitted_at:new Date(envelope.submitted_at).toISOString(),answers:Object.entries(envelope.answers).map(([id,answer])=>({id,question:id.replace(/_/g,' '),type:'text',answer}))}
  const formatted=bodyFor(targetFor(this.env.WEBHOOK_URL,this.env.WEBHOOK_FORMAT),readable) as Record<string,unknown>
  if(targetFor(this.env.WEBHOOK_URL,this.env.WEBHOOK_FORMAT)==='json')return {...common,...formatted}
  // Chat payloads retain their native schema; prefix lifecycle event clearly.
  if('text' in formatted&&typeof formatted.text==='string')formatted.text=`${event.toUpperCase()} · ${d.booking.starts_at||''}\n${formatted.text}`
  if('content' in formatted&&typeof formatted.content==='string')formatted.content=`${event.toUpperCase()} · ${d.booking.starts_at||''}\n${formatted.content}`
  return formatted
 }
 private async readSecret(){const sk=await this.ctx.storage.get<Uint8Array>('relay_sk');if(!sk)throw new Error('key not initialized');return new Uint8Array(sk)}
}
let cached:{key:Uint8Array;at:number}|null=null
async function signingKey(env:Env,refresh=false){
 if(env.ORAPLOT_PUBLIC_KEY)return fromB64(env.ORAPLOT_PUBLIC_KEY)
 if(!refresh&&cached&&Date.now()-cached.at<3600000)return cached.key
 const origin=(env.ORAPLOT_ORIGIN||'https://oraplot.com').replace(/\/$/,'')
 const r=await fetch(origin+'/.well-known/oraplot-delivery-key');if(!r.ok)throw new Error('signing key unavailable')
 const data=await r.json() as {public_key:string};cached={key:fromB64(data.public_key),at:Date.now()};return cached.key
}
export default {
 async fetch(request:Request,env:Env){
  const u=new URL(request.url);const state=env.KEYS.get(env.KEYS.idFromName('relay'))
  if(request.method==='GET'&&u.pathname==='/')return json({service:'oraplot-relay',ok:true,pairing_required:true,webhook_configured:Boolean(env.WEBHOOK_URL)})
  if(['/key','/pair','/retry'].includes(u.pathname)){
   if(request.method!=='POST')return json({error:'method not allowed'},405)
   if(!await tokenMatches(request.headers.get('authorization'),env.RELAY_PAIRING_TOKEN))return json({error:'owner pairing code required'},403)
   if(u.pathname==='/key')return json({service:'oraplot-relay',public_key:toB64(publicKeyFor(await state.secretKey())),webhook_configured:Boolean(env.WEBHOOK_URL)})
   const text=await limitedText(request);if(text===null)return json({error:'payload too large'},413)
   let binding:Binding & {booking_id?:string};try{binding=JSON.parse(text)}catch{return json({error:'invalid JSON'},400)}
   if(!validBinding(binding))return json({error:'invalid binding'},400)
   if(u.pathname==='/pair')return await state.pair(binding)?json({paired:true,expires_in_days:90}):json({error:'binding exists; reconnect with a new integration'},409)
   return binding.booking_id&&await state.retry(binding,binding.booking_id)?json({retry_enabled:true}):json({error:'no blocked delivery for this binding'},409)
  }
  if(request.method!=='POST'||!['/deliver','/revoke'].includes(u.pathname))return json({error:'not found'},404)
  if(!env.WEBHOOK_URL&&u.pathname==='/deliver')return json({error:'Set WEBHOOK_URL in your Cloudflare account'},500)
  const body=await limitedText(request);if(body===null)return json({error:'payload too large'},413)
  const ts=Number(request.headers.get('x-oraplot-timestamp')||0);if(!ts||Math.abs(Date.now()/1000-ts)>300)return json({error:'stale request'},401)
  const message=new TextEncoder().encode(`${ts}.${body}`)
  async function verify(refresh:boolean){try{const sig=fromB64(request.headers.get('x-oraplot-signature')||'');return sig.length===64&&ed25519.verify(sig,message,await signingKey(env,refresh))}catch{return false}}
  if(!await verify(false)&&!await verify(true))return json({error:'bad signature'},401)
  try{
   const d=JSON.parse(body) as Delivery
   const binding={integration_id:d.integration_id,workspace_id:d.workspace_id,form_id:d.form?.id||''}
   if(!validBinding(binding))return json({error:'invalid binding'},400)
   if(u.pathname==='/revoke')return await state.revoke(binding)?json({revoked:true}):json({error:'unknown binding'},403)
   if(!await state.bound(binding))return json({error:'Unpaired, expired or revoked relay; reconnect with the owner code'},403)
   if(!d.booking?.id||!Number.isInteger(d.booking.version)||d.booking.version<1||!['created','confirmed','cancelled','completed','no_show','rescheduled','deleted'].includes(d.event))return json({error:'invalid event'},400)
   if(d.event!=='deleted'){
    if(!d.form||!d.submission||!d.sealed_form_sk)return json({error:'missing encrypted envelope'},422)
    // Authenticate the ciphertext before accepting it for future delivery.
    decryptSubmission(await state.secretKey(),{form_id:d.form.id,key_version:d.submission.key_version,sealed_form_sk:d.sealed_form_sk,sealed_key:d.submission.sealed_key,ciphertext:d.submission.ciphertext})
   }
   await state.accept(d)
   return json({accepted:true},202)
  }catch{return json({error:'could not accept encrypted delivery'},422)}
 }
}

async function limitedText(request: Request): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []; let size = 0
  while (true) {
    const part = await reader.read(); if (part.done) break
    size += part.value.byteLength
    if (size > 400000) { await reader.cancel(); return null }
    chunks.push(part.value)
  }
  const all = new Uint8Array(size); let offset = 0
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length }
  return new TextDecoder().decode(all)
}
