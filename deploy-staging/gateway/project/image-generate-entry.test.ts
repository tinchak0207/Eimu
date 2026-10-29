// Real public tool → internal HTTP → graph/runner → shared SQLite. Only provider is a local fixture.
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
const root=mkdtempSync(join(tmpdir(),'image-tool-common-'))
process.env.WORKSPACE_DIR=join(root,'workspace')
process.env.SESSIONS_DB_PATH=join(root,'sessions.db')
process.env.LEDGER_PATH=join(root,'ledger.jsonl')
process.env.EIMU_TASK_JOURNAL_PATH=join(root,'journal.sqlite')
process.env.EIMU_RUNTIME_DIR=fileURLToPath(new URL('../../opencode-runtime/',import.meta.url))
process.env.HARNESS_INTERNAL_TOKEN='local-tool-fixture'
const posts:any[]=[]
const jobs=new Map<string,any>()
let mode='ok'
const heldPrompts=new Set<string>()
const musicReceipts=new Map<string,{body:any;receipt:any}>()
let musicCalls=0
let speechCalls=0
let musicFile=''
let releaseMusic:(()=>void)|undefined
let holdMusic=false
let routes:any, media:any, internal:any, delivery:any
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=','base64')
const dataReference=`data:image/png;base64,${png.toString('base64')}`
const catalog={data:[{id:'fixture-img',x_coins_per_image:{standard:0.5,hd:0.75},x_capabilities:{mediaType:'image'}},{id:'fixture-video',x_coins_per_second:{'720p':0.3},x_capabilities:{mediaType:'video',defaultResolution:'720p',resolutions:['720p'],defaultAudio:false,audio:true},x_billing:{currency:'coins',unit:'per_video',prices:{'720p':{'5':1.5}},prices_with_audio:{'720p':{'5':2}}}}]}
const j=(v:any,status=200)=>Response.json(v,{status})
const server=Bun.serve({port:0,async fetch(req){
  const u=new URL(req.url), p=u.pathname
  if(req.method==='DELETE'&&p.startsWith('/api/generation-jobs/'))return j({previous_status:'queued',refund:{coins:0.5}})
  if(p==='/api/agent/biz/resolve-owner')return j({user_id:71,canonical_key:'sk-biz-fixture'})
  if(p==='/openai/v1/audio/speech'){speechCalls++;return new Response(readFileSync(musicFile),{headers:{'content-type':'audio/mpeg'}})}
  if(p==='/v1/exec/music_gen'){
    const body=await req.json();musicCalls++;if(holdMusic)await new Promise<void>(resolve=>{releaseMusic=resolve})
    const bytes=readFileSync(musicFile),files=[{path:musicFile,mime:'audio/mpeg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}]
    const receipt={state:'done',files,costCoins:1,chargeRef:`local-charge:${body.idemKey}`};musicReceipts.set(body.idemKey,{body,receipt})
    return j({ok:true,...receipt,provider:'local-fixture'})
  }
  if(p.startsWith('/v1/exec/result/')){
    const entry=musicReceipts.get(decodeURIComponent(p.slice('/v1/exec/result/'.length)))
    if(!entry)return j({state:'unknown'})
    if(['sessionId','projectId','nodeId','signature'].some(k=>u.searchParams.get(k)!==entry.body[k]))return j({state:'unknown'},403)
    return j(entry.receipt)
  }
  if(p==='/v1/exec/ingested')return j({ok:true})
  if(p==='/v1/models')return j(catalog)
  if(p==='/v1/openapi.json')return j({components:{schemas:{ImageGenerationRequest:{properties:{size:{enum:['1024x1024','1024x1536']}}}}}})
  if(p==='/v1/model-status')return j({})
  if(p==='/v1/uploads')return j({mediaId:'frozen-ref',url:`http://127.0.0.1:${server.port}/pixel.png`})
  if(p==='/internal/project-budget')return delivery.handleGenerationDelivery(req,p)
  if(p==='/pixel.png')return new Response(png,{headers:{'content-type':'image/png'}})
  if(p==='/internal/session-key')return internal.handleSessionKey(req)
  if(p==='/internal/session-tasks')return internal.handleSessionTasks(req)
  if(p==='/internal/confirm-request')return media.handleConfirmRequest(req)
  if(p==='/internal/confirm-status')return internal.handleConfirmStatus(req)
  if(p.startsWith('/internal/project/'))return routes.handleProjectInternal(req,p)
  if(p==='/v1/images/generations'||p==='/v1/videos/generations'||p==='/v1/images/edits'||p==='/v1/upscale'){
    const body=await req.json(), key=req.headers.get('idempotency-key')
    posts.push({body,key,path:p})
    if(mode==='unknown')return j({},502)
    const task_id=crypto.randomUUID();jobs.set(task_id,body)
    return j({task_id,status:'queued'},202)
  }
  const match=/^\/v1\/(images|videos)\/([^/]+)$/.exec(p)
  if(match){const body=jobs.get(match[2]);if(heldPrompts.has(body?.prompt))return j({task_id:match[2],status:'queued'});return j({task_id:match[2],status:'succeeded',data:Array.from({length:body?.n??1},(_,i)=>({url:`http://127.0.0.1:${server.port}/pixel.png?i=${i}`})),cost_coins:(body?.quality==='hd'?0.75:0.5)*(body?.n??1)})}
  return j({error:{message:p}},404)
}})
process.env.PLATFORM_BASE=`http://127.0.0.1:${server.port}`
process.env.PLATFORM_API_BASE=`http://127.0.0.1:${server.port}/v1`
process.env.GATEWAY_URL=`http://127.0.0.1:${server.port}`
process.env.EXEC_BRIDGE_URL=`http://127.0.0.1:${server.port}`
process.env.TTS_UPSTREAM_BASE=`http://127.0.0.1:${server.port}`
const persistence=await import('../persistence.ts');persistence.initPersistence()
const {hydrateRow}=await import('../persistence-io.ts')
const {sessions}=await import('../sessions-core.ts')
const {reopenSessionsDbForTest}=await import('../job-store.ts');reopenSessionsDbForTest()
delivery=await import('../job-delivery.ts');routes=await import('./routes.ts'); media=await import('../media-internal-routes.ts');internal=await import('../internal-http.ts')
const {installDefaultExecutors}=await import('./executors/index.ts');installDefaultExecutors()
const {ensureProject}=await import('./store.ts')
const client=await import('../../opencode-runtime/lib/client.ts')
const imageTool=(await import('../../opencode-runtime/tools/image_generate.ts')).default
const sid='tool-common-session', key='sk-biz-fixture'
const state:any=hydrateRow({sessionId:sid,apiKey:key,opencodeSessionId:sid,data:{projectMode:false,seat:'creator_legacy'},updatedAt:Date.now()} as any)
sessions.set(sid,state)
const {ArtifactStore}=await import('./artifacts.ts')
await ensureProject(sid,{artifacts:new ArtifactStore({projectDir:join(process.env.WORKSPACE_DIR!,'projects',sid),allowPrivateNetwork:true})})
persistence.saveUserSettings(key,{interaction_mode:'auto'} as any)
const restore=routes.configureProjectRoutes({authorized:async()=>true})
const ctx:any={sessionID:sid,abort:new AbortController().signal}
async function invoke(args:any){const result=await imageTool.execute(args,ctx);return JSON.parse(typeof result==='string'?result:result.output)}
afterAll(()=>{restore();server.stop(true)})

test('n4 HD image keeps exact prepared payload, one graph operation/SQLite reservation; replay has zero new POST',async()=>{
  const result=await invoke({prompt:'四张水墨猫',model:'fixture-img',n:4,quality:'hd',size:'1024x1536',style_lock:'水墨，留白',style_version:'ink-v1',reference_images:[dataReference],reference_version:'cat-canonical-v1',request_id:'tool-four-hd'})
  expect(result.ok).toBe(true)
  expect(posts.length).toBe(1)
  expect(posts[0].body).toMatchObject({prompt:'水墨，留白\n四张水墨猫',model:'fixture-img',n:4,quality:'hd',size:'1024x1536',reference_images:[dataReference],cap_coins:3})
  const {store}=await ensureProject(sid);const graph=await store.read()
  expect(graph.nodes[result.node_id]).toBeDefined()
  const db=new Database(process.env.EIMU_TASK_JOURNAL_PATH!,{readonly:true})
  const rows=db.query('SELECT * FROM tool_submission WHERE request_id=?').all('tool-four-hd') as any[]
  expect(rows.length).toBe(1);expect(rows[0].reservation).toBe(3)
  const again=await invoke({prompt:'四张水墨猫',model:'fixture-img',n:4,quality:'hd',size:'1024x1536',style_lock:'水墨，留白',style_version:'ink-v1',reference_images:[dataReference],reference_version:'cat-canonical-v1',request_id:'tool-four-hd'})
  expect(again.ok).toBe(true);expect(again.task_id).toBe(result.task_id);expect(posts.length).toBe(1)
  db.close()
  for(let i=0;i<500;i++){const latest=await store.read();if(['done','failed','manual'].includes(latest.nodes[result.node_id]?.status))break;await Bun.sleep(10)}
  expect((await store.read()).nodes[result.node_id].status).toBe('done')
},20000)

test('concurrent original tool same request_id has one provider POST and one durable reservation',async()=>{
 const args={prompt:'并发同一单',model:'fixture-img',request_id:'concurrent-common-tool'}
 const before=posts.length
 const results=await Promise.all([invoke(args),invoke(args)])
 expect(results.some(r=>r.ok)).toBe(true);expect(posts.length).toBe(before+1)
 const db=new Database(process.env.EIMU_TASK_JOURNAL_PATH!,{readonly:true})
 expect((db.query('SELECT count(*) AS n FROM tool_submission WHERE request_id=?').get(args.request_id) as any).n).toBe(1);db.close()
 const {store}=await ensureProject(sid)
 const id=results.find(r=>r.ok).node_id
 for(let i=0;i<500;i++){if(['done','failed','manual'].includes((await store.read()).nodes[id]?.status))break;await Bun.sleep(10)}
 const spent=(await store.read()).budget.spentCoins
 await invoke(args);expect((await store.read()).budget.spentCoins).toBe(spent);expect(posts.length).toBe(before+1)
},20000)

test('real child identity automatically maps unique image lane; explicit outside node cannot submit',async()=>{
 const {store}=await ensureProject(sid)
 const patch=await store.applyPatches({ops:[{op:'add_node',node:{id:'expert_image',type:'keyframe',params:{prompt:'专家镜头',model:'fixture-img'}}},{op:'add_node',node:{id:'outside_image',type:'keyframe',params:{prompt:'别人的镜头',model:'fixture-img'}}}]} as any,{kind:'agent'})
 expect(patch.receipt.ok).toBe(true)
 const child='ses_tool_child'
 const {initSubagent,byChildOc}=await import('../subagent-runs.ts')
 initSubagent({resolveSession:(id:string)=>sessions.get(id),findSessionByOpenCodeId:(id:string)=>[...sessions.values()].find(s=>s.opencodeSessionId===id)} as any)
 const {bindGenerationConsumer}=await import('../job-store.ts');bindGenerationConsumer(child,sid,sid)
 byChildOc.set(child,{id:'expert-run',status:'running',parentGatewaySessionId:sid,parentOpencodeSessionId:sid,lane:['expert_image']} as any)
 const before=posts.length
 const run=async(args:any)=>{const r=await imageTool.execute(args,{...ctx,sessionID:child});return JSON.parse(typeof r==='string'?r:r.output)}
 const result=await run({prompt:'专家镜头',model:'fixture-img',request_id:'child-lane-image'})
 expect(result.ok).toBe(true);expect(result.node_id).toBe('expert_image');expect(posts.length).toBe(before+1)
 for(let i=0;i<500;i++){if(['done','failed','manual'].includes((await store.read()).nodes.expert_image?.status))break;await Bun.sleep(10)}
 const rejected=await run({prompt:'越界镜头',model:'fixture-img',request_id:'child-outside',node_id:'outside_image'})
 expect(rejected.ok).toBe(false);expect(rejected.error.code).toBe('lane_denied');expect(posts.length).toBe(before+1)
 byChildOc.delete(child)
},20000)

test('legacy expert without lane retains two independent calls; same order recovers and stopped worker cannot submit',async()=>{
 const child='ses_legacy_expert'
 const {byChildOc}=await import('../subagent-runs.ts')
 const {bindGenerationConsumer}=await import('../job-store.ts');bindGenerationConsumer(child,sid,sid)
 const run:any={id:'legacy-expert-run',status:'running',parentGatewaySessionId:sid,parentOpencodeSessionId:sid,opencodeSessionId:child,startedAt:Date.now(),label:'legacy expert',prompt:'两张图',modelChain:[],attempt:1,messageRole:new Map(),partEmitted:new Map()}
 byChildOc.set(child,run)
 const call=async(request_id:string)=>{const r=await imageTool.execute({prompt:request_id,model:'fixture-img',request_id},{...ctx,sessionID:child});return JSON.parse(typeof r==='string'?r:r.output)}
 const before=posts.length
 const {store}=await ensureProject(sid)
 for(const id of ['legacy-expert-a','legacy-expert-b']){
  const result=await call(id);expect(result.ok,JSON.stringify(result)).toBe(true)
  for(let i=0;i<500;i++){if(['done','failed','manual'].includes((await store.read()).nodes[result.node_id]?.status))break;await Bun.sleep(10)}
  expect((await store.read()).nodes[result.node_id].status).toBe('done')
  const again=await call(id);expect(again.task_id).toBe(result.task_id)
 }
 expect(posts.length).toBe(before+2)
 run.status='stopped';run.stoppedAt=Date.now()
 const stopped=await call('legacy-expert-c');expect(stopped.ok).toBe(false);expect(posts.length).toBe(before+2)
 byChildOc.delete(child)
},20000)

test('independent prepared B posts while A is queued; common cancel isolates old callbacks from next generation',async()=>{
 heldPrompts.add('parallel-hang-A');heldPrompts.add('parallel-hang-B')
 const before=posts.length
 const a=await invoke({prompt:'parallel-hang-A',model:'fixture-img',request_id:'parallel-A'})
 expect(a.ok,JSON.stringify(a)).toBe(true)
 const {store}=await ensureProject(sid)
 const epoch=(await store.read()).activeRun
 const b=await invoke({prompt:'parallel-hang-B',model:'fixture-img',request_id:'parallel-B'})
 expect(b.ok,JSON.stringify(b)).toBe(true);expect(posts.length).toBe(before+2)
 expect((await store.read()).activeRun).toBe(epoch)
 const {cancelProjectRun}=await import('./run.ts');await cancelProjectRun(store)
 heldPrompts.clear()
 for(let i=0;i<500;i++){if(!(await store.read()).activeRun)break;await Bun.sleep(10)}
 const c=await invoke({prompt:'next-epoch-C',model:'fixture-img',request_id:'parallel-C'})
 expect(c.ok,JSON.stringify(c)).toBe(true)
 for(let i=0;i<500;i++){if(['done','failed','manual'].includes((await store.read()).nodes[c.node_id]?.status))break;await Bun.sleep(10)}
 const graph=await store.read()
 expect(graph.nodes[c.node_id].status).toBe('done')
 expect(graph.nodes[a.node_id].status).not.toBe('done');expect(graph.nodes[b.node_id].status).not.toBe('done')
 expect(graph.nodes[a.node_id].outputs.length).toBe(0);expect(graph.nodes[b.node_id].outputs.length).toBe(0)
 expect(posts.length).toBe(before+3)
},20000)

test('root A finishing cannot close activeRun while joined B still waits; B completion closes the same generation',async()=>{
 heldPrompts.add('finish-race-B')
 const a=await invoke({prompt:'finish-race-A',model:'fixture-img',request_id:'finish-A'})
 expect(a.ok).toBe(true)
 const {store}=await ensureProject(sid),epoch=(await store.read()).activeRun
 const b=await invoke({prompt:'finish-race-B',model:'fixture-img',request_id:'finish-B'})
 expect(b.ok,JSON.stringify(b)).toBe(true)
 for(let i=0;i<500;i++){if((await store.read()).nodes[a.node_id].status==='done')break;await Bun.sleep(10)}
 const halfway=await store.read()
 expect(halfway.nodes[a.node_id].status).toBe('done');expect(halfway.nodes[b.node_id].status).toBe('running');expect(halfway.activeRun).toBe(epoch)
 heldPrompts.delete('finish-race-B')
 for(let i=0;i<500;i++){const g=await store.read();if(g.nodes[b.node_id].status==='done'&&!g.activeRun)break;await Bun.sleep(10)}
 const final=await store.read();expect(final.nodes[b.node_id].status).toBe('done');expect(final.activeRun).toBeNull()
},20000)

test('pre-upgrade journal+owned receipt reconnects original artifact into graph without new provider submission or charge',async()=>{
 const legacyTask=crypto.randomUUID(),request_id='pre-upgrade-order',project='pre-upgrade-film'
 const scope=await client.productionScope(sid,project)
 const journal=await import('../../opencode-runtime/lib/image-journal.ts')
 const identity={scope,session_id:sid,project,request_id,model:'fixture-img',cost_coins:0.5,input_signature:'legacy-input'}
 journal.prepareSubmission(identity,{model:'fixture-img',prompt:'old genuine image'},null)
 journal.acceptTaskSubmission(scope,request_id,legacyTask,{task_id:legacyTask,session_id:sid,kind:'image',project,request_id})
 journal.settleSubmission(scope,request_id,0.5)
 const {registerGenerationReceipt,completeGenerationReceipt}=await import('../job-store.ts')
 const url=`http://127.0.0.1:${server.port}/pixel.png?old=true`
 registerGenerationReceipt({task_id:legacyTask,parent_gw:sid,producer_oc:sid,consumer_oc:sid,credential_session_id:sid,kind:'image',project,request_id,model:'fixture-img',requested_count:1})
 completeGenerationReceipt(legacyTask,'succeeded',[{url}],{cost_coins:0.5})
 const before=posts.length
 const result=await invoke({prompt:'旧图只读恢复',project,model:'fixture-img',request_id,retry_task_id:legacyTask})
 expect(result.ok,JSON.stringify(result)).toBe(true);expect(result.task_id).toBe(legacyTask);expect(result.new_generation).toBe(false)
 expect(posts.length).toBe(before)
 const {store}=await ensureProject(sid);const graph=await store.read()
 expect(Object.values(graph.nodes).some((node:any)=>node.type==='reference'&&node.outputs.some((out:any)=>out.url===url&&out.sha256))).toBe(true)
 expect(journal.getSubmission(scope,request_id).reservation).toBe(0.5)
 const again=await invoke({prompt:'旧图只读恢复',project,model:'fixture-img',retry_task_id:legacyTask})
 expect(again.ok).toBe(true);expect(again.request_id).toBe(request_id);expect(posts.length).toBe(before)
},20000)

test('same production inputs with a new request_id remain a deliberate new take',async()=>{
 const before=posts.length, results:any[]=[]
 const {store}=await ensureProject(sid)
 for(const request_id of ['same-input-take-1','same-input-take-2']){
  const result=await invoke({prompt:'同参数主动重拍',model:'fixture-img',style_lock:'墨色',style_version:'same-style-v1',request_id})
  expect(result.ok,JSON.stringify(result)).toBe(true);results.push(result)
  for(let i=0;i<500;i++){const g=await store.read();if(g.nodes[result.node_id].status==='done'&&!g.activeRun)break;await Bun.sleep(10)}
 }
 expect(posts.length).toBe(before+2);expect(results[0].task_id).not.toBe(results[1].task_id);expect(results[0].node_id).not.toBe(results[1].node_id)
 expect(posts.at(-1).body.prompt).toBe(posts.at(-2).body.prompt)
},20000)

test('video batch preserves n/audio/resolution/duration and confirms full batch quote without a second submit',async()=>{
  mode='unknown'
  const before=posts.length
  const result=await invoke({prompt:'人物从门口走到窗边',model:'fixture-video',kind:'video',n:4,size:'9:16',duration_seconds:5,generate_audio:true,resolution:'720p',request_id:'video-four-audio'})
  expect(result.ok).toBe(false);expect(result.request_id).toBe('video-four-audio')
  expect(posts.length).toBe(before+1)
  expect(posts.at(-1).body).toMatchObject({model:'fixture-video',n:4,size:'9:16',duration_seconds:5,generate_audio:true,resolution:'720p',cap_coins:8})
  expect(posts.at(-1).body.prompt).toContain('人物从门口走到窗边')
  expect(media.readSpendConfirmation(state,'video-four-audio')).toMatchObject({outcome:'approved',model:'fixture-video',amount_coins:8})
  mode='ok'
},20000)

test('unknown stays on original request identity and cannot issue second provider POST',async()=>{
  mode='unknown'
  const args={prompt:'耐久原单',model:'fixture-img',request_id:'tool-unknown'}
  const first=await invoke(args),count=posts.length
  expect(first.ok).toBe(false);expect(first.request_id).toBe(args.request_id)
  const again=await invoke(args)
  expect(again.ok).toBe(false);expect(again.request_id).toBe(args.request_id);expect(posts.length).toBe(count)
  mode='ok'
},20000)

test('durable confirmation cannot authorize changed input, amount, model or another session',async()=>{
 const request_id='confirmed-exact',input_signature='a'.repeat(64)
 const request=(over:any={})=>new Request('http://localhost/internal/confirm-request',{method:'POST',body:JSON.stringify({session_id:sid,request_id,amount_coins:3,model:'fixture-img',input_signature,...over})})
 expect((await media.handleConfirmRequest(request())).status).toBe(200)
 state.resolvedConfirms.clear();state.pendingConfirms.clear()
 expect(media.readSpendConfirmation(state,request_id)).toMatchObject({outcome:'approved',amount_coins:3,model:'fixture-img',input_signature})
 for(const over of [{amount_coins:4},{model:'other'},{input_signature:'b'.repeat(64)}])expect((await media.handleConfirmRequest(request(over))).status).toBe(409)
 expect(media.readSpendConfirmation({...state,sessionId:'other-account-session',resolvedConfirms:new Map()},request_id)).toBeUndefined()
 expect(()=>media.readSpendConfirmation({...state,apiKey:'sk-biz-other-account'},request_id)).toThrow('confirmation_owner_changed')
})


test('legacy edits/upscale concurrent same-key entry respects SQLite submit permit and unknown retries do not POST',async()=>{
 for(const path of ['/images/edits','/upscale']) {
  const request_id=`legacy-cas-${path.split('/').pop()}`, before=posts.length
  const payload={model:'fixture-img',prompt:'原图调整',image:dataReference,n:1,workflow:{metadata:{project:'legacy-guard',request_id,input_signature:request_id}}}
  const init={method:'POST',headers:{'Idempotency-Key':request_id},body:JSON.stringify(payload)}
  mode='unknown'
  const [a,b]=await Promise.all([client.platformFetch(path,init,sid),client.platformFetch(path,init,sid)])
  expect(posts.length).toBe(before+1)
  const responses=await Promise.all([a.json(),b.json()])
  expect(responses.some((r:any)=>r.error?.code==='submission_unknown'&&r.request_id===request_id)).toBe(true)
  const again=await client.platformFetch(path,init,sid)
  expect(again.ok).toBe(false);expect(posts.length).toBe(before+1)
 }
 mode='ok'
},20000)


test('cross-media: original music completion followed by legal image preserves remaining budget',async()=>{
 const mediaSid='cross-media-sequential'
 const st:any=hydrateRow({sessionId:mediaSid,apiKey:key,opencodeSessionId:mediaSid,data:{projectMode:false,seat:'creator_legacy'},updatedAt:Date.now()} as any);sessions.set(mediaSid,st)
 const {store}=await ensureProject(mediaSid,{artifacts:new ArtifactStore({projectDir:join(process.env.WORKSPACE_DIR!,'projects',mediaSid),allowPrivateNetwork:true})})
 musicFile=join(store.paths.dir,'scratch','music-fixture.mp3');mkdirSync(join(store.paths.dir,'scratch'),{recursive:true})
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1','-codec:a','libmp3lame','-y',musicFile])
 await store.update(g=>{g.budget.capCoins=1.5})
 expect((await store.applyPatches({ops:[{op:'add_node',node:{id:'score',type:'music',params:{prompt:'原创宁静钢琴'}}}]} as any,{kind:'agent'})).receipt.ok).toBe(true)
 const started=await fetch(`http://127.0.0.1:${server.port}/internal/project/run`,{method:'POST',headers:{'content-type':'application/json','x-internal-token':process.env.HARNESS_INTERNAL_TOKEN!},body:JSON.stringify({session_id:mediaSid,targets:['score'],wait_sec:10})})
 const music=await started.json();expect(music.status,JSON.stringify(music)).toBe('done');expect(musicCalls).toBe(1)
 const oldOperation=(await store.read()).nodes.score.outputs[0].meta?.bridgeOperation as any
 const legacyDb=new Database(process.env.EIMU_TASK_JOURNAL_PATH!)
 legacyDb.query('DELETE FROM tool_submission WHERE request_id=?').run(oldOperation.idemKey);legacyDb.close()
 const before=posts.length
 const raw=await imageTool.execute({prompt:'音乐后的合法图片',model:'fixture-img',request_id:'cross-after-music'},{...ctx,sessionID:mediaSid})
 const image=JSON.parse(typeof raw==='string'?raw:raw.output)
 writeFileSync('/tmp/eimu-cross-media-observation.json',JSON.stringify({music,image,imagePosts:posts.length-before,graph:(await store.read()).budget},null,2))
 expect(image.ok,JSON.stringify(image)).toBe(true);expect(posts.length).toBe(before+1);expect(musicCalls).toBe(1)
 for(let i=0;i<500;i++){const g=await store.read();if(g.nodes[image.node_id].status==='done'&&!g.activeRun)break;await Bun.sleep(10)}
 const calls=musicCalls
 const replay=await routes.handleProjectInternal(new Request('http://localhost/internal/project/run',{method:'POST',headers:{'content-type':'application/json','x-internal-token':process.env.HARNESS_INTERNAL_TOKEN!},body:JSON.stringify({session_id:mediaSid,targets:['score'],wait_sec:10})}),'/internal/project/run')
 expect((await replay.json()).ok).toBe(true);expect(musicCalls).toBe(calls)
},20000)


test('cross-media: simultaneous music and image cannot exceed graph cap1.2 or leave a second reservation',async()=>{
 const mediaSid='cross-media-parallel'
 const st:any=hydrateRow({sessionId:mediaSid,apiKey:key,opencodeSessionId:mediaSid,data:{projectMode:false,seat:'creator_legacy'},updatedAt:Date.now()} as any);sessions.set(mediaSid,st)
 const {store}=await ensureProject(mediaSid,{artifacts:new ArtifactStore({projectDir:join(process.env.WORKSPACE_DIR!,'projects',mediaSid),allowPrivateNetwork:true})})
 musicFile=join(store.paths.dir,'scratch','music-fixture.mp3');mkdirSync(join(store.paths.dir,'scratch'),{recursive:true})
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1','-codec:a','libmp3lame','-y',musicFile])
 await store.update(g=>{g.budget.capCoins=1.2})
 await store.applyPatches({ops:[{op:'add_node',node:{id:'score',type:'music',params:{prompt:'原创并发钢琴'}}}]} as any,{kind:'agent'})
 holdMusic=true;const musicBefore=musicCalls,imageBefore=posts.length
 const music=fetch(`http://127.0.0.1:${server.port}/internal/project/run`,{method:'POST',headers:{'content-type':'application/json','x-internal-token':process.env.HARNESS_INTERNAL_TOKEN!},body:JSON.stringify({session_id:mediaSid,targets:['score'],wait_sec:10})})
 for(let i=0;i<500;i++){if(musicCalls>musicBefore)break;await Bun.sleep(5)}
 expect(musicCalls).toBe(musicBefore+1)
 const raw=await imageTool.execute({prompt:'不能越过音乐在途预算',model:'fixture-img',request_id:'cross-parallel-image'},{...ctx,sessionID:mediaSid})
 const image=JSON.parse(typeof raw==='string'?raw:raw.output)
 releaseMusic?.();holdMusic=false
 expect(image.ok).toBe(false);expect(posts.length).toBe(imageBefore)
 const runReceipt=await(await music).json()
 expect(runReceipt.done).toBe(1);expect(runReceipt.failed).not.toContain('score');expect((await store.read()).nodes.score.status).toBe('done')
 const db=new Database(process.env.EIMU_TASK_JOURNAL_PATH!,{readonly:true})
 const {sharedGenerationScope}=await import('../generation-scope.ts')
 const graphScope=sharedGenerationScope((await delivery.stableGenerationOwnerScope(mediaSid))!,`graph:${(await store.read()).id}`)
 const rows=db.query("SELECT reservation,state,metadata_json FROM tool_submission WHERE json_extract(metadata_json,'$.graph_scope')=?").all(graphScope) as any[]
 const rejected=db.query('SELECT count(*) AS n FROM tool_submission WHERE request_id=?').get('cross-parallel-image') as any
 expect(rejected.n).toBe(0)
 expect(rows.length).toBe(1);expect(rows[0].state).toBe('completed');expect(rows.reduce((sum:number,row:any)=>sum+row.reservation,0)).toBe(1)
 expect((await store.read()).budget.spentCoins).toBe(1)
 db.close()
},20000)

test('cross-media: original voice executor real MP3 then image uses the same durable budget',async()=>{
 const mediaSid='cross-media-voice'
 const st:any=hydrateRow({sessionId:mediaSid,apiKey:key,opencodeSessionId:mediaSid,data:{projectMode:false,seat:'creator_legacy'},updatedAt:Date.now()} as any);sessions.set(mediaSid,st)
 const {store}=await ensureProject(mediaSid,{artifacts:new ArtifactStore({projectDir:join(process.env.WORKSPACE_DIR!,'projects',mediaSid),allowedPathRoots:[join(process.env.WORKSPACE_DIR!,'tts-audio')],allowPrivateNetwork:true})})
 musicFile=join(store.paths.dir,'scratch','voice-fixture.mp3');mkdirSync(join(store.paths.dir,'scratch'),{recursive:true})
 execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:duration=1','-codec:a','libmp3lame','-y',musicFile])
 await store.update(g=>{g.budget.capCoins=0.503})
 await store.applyPatches({ops:[{op:'add_node',node:{id:'narration',type:'voice',params:{text:'开场白'}}}]} as any,{kind:'agent'})
 const before=speechCalls
 const voice=await routes.handleProjectInternal(new Request('http://localhost/internal/project/run',{method:'POST',headers:{'content-type':'application/json','x-internal-token':process.env.HARNESS_INTERNAL_TOKEN!},body:JSON.stringify({session_id:mediaSid,targets:['narration'],wait_sec:10})}),'/internal/project/run')
 const voiceResult=await voice.json();expect(voiceResult.status,JSON.stringify(voiceResult)).toBe('done');expect(speechCalls).toBeGreaterThan(before)
 const raw=await imageTool.execute({prompt:'旁白后的合法图片',model:'fixture-img',request_id:'cross-after-voice'},{...ctx,sessionID:mediaSid})
 const image=JSON.parse(typeof raw==='string'?raw:raw.output);expect(image.ok,JSON.stringify(image)).toBe(true)
 for(let i=0;i<500;i++){const g=await store.read();if(g.nodes[image.node_id].status==='done'&&!g.activeRun)break;await Bun.sleep(10)}
 expect((await store.read()).budget.spentCoins).toBe(0.503)
},20000)
