// quick-ask-suite: portable
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {searchRoute, nextSearchState}=require('../src/quick-ask/web-search');
test('authorization precedes the explicitly selected search method',()=>{
 assert.equal(searchRoute(false,{provider:'exa'}, {baseUrl:'https://api.openai.com/v1',model:'gpt-5'}).kind,'off');
 assert.equal(searchRoute(true,{provider:'exa',secretId:'search-key'}, {baseUrl:'https://api.openai.com/v1',model:'gpt-5'}).provider,'exa');
 assert.equal(searchRoute(true,{}, {baseUrl:'https://api.deepseek.com',model:'deepseek-flash'}).kind,'local');
 assert.equal(searchRoute(true,{}, {baseUrl:'https://api.openai.com.evil.test/v1',model:'gpt-5'}).kind,'local');
 assert.equal(searchRoute(true,{provider:'server'}, {baseUrl:'https://api.openai.com/v1',model:'gpt-5'}).kind,'server');
});
test('default-off consumes only started turns while default-on preserves manual off',()=>{
 assert.equal(nextSearchState(true,false,true),false);
 assert.equal(nextSearchState(true,false,false),true);
 assert.equal(nextSearchState(false,true,true),false);
 assert.equal(nextSearchState(true,true,true),true);
});
test('DeepSeek Search is inferred for all DeepSeek models and relay addresses in either chat protocol',()=>{
 for(const protocol of ['responses','chat-completions'])for(const model of ['deepseek-flash','deepseek-v4-flash','deepseek-v4-pro','deepseek-chat','deepseek-reasoner','deepseek/deepseek-v4-pro'])for(const baseUrl of ['https://api.deepseek.com','https://relay.example/deepseek/v1']){
  const route=searchRoute(true,{provider:'server'},{baseUrl,model,protocol,secretId:'model-key'});
  assert.equal(route.kind,'provider-api');assert.equal(route.provider,'deepseek');
  assert.equal(route.secretId,'model-key');assert.equal(route.queryLimit,128);assert.equal(route.baseUrl,baseUrl);
 }
 assert.equal(searchRoute(false,{provider:'server'},{model:'deepseek-flash'}).kind,'off');
 assert.equal(searchRoute(true,{provider:'exa',secretId:'search-key'},{model:'deepseek-flash'}).provider,'exa');
 assert.equal(searchRoute(true,{provider:'server'},{protocol:'responses',baseUrl:'https://openrouter.ai/api/v1',model:'deepseek/deepseek-v4-pro'}).provider,'openrouter');
});
test('Responses sources retain opened pages, find results and citations without scraping answer prose',()=>{
 const {responseSources}=require('../src/quick-ask/web-search');
 const output=[
  {type:'web_search_call',action:{type:'search',sources:[{url:'https://example.org/search',title:'Search'}]}},
  {type:'web_search_call',action:{type:'open_page',url:'https://example.org/open'}},
  {type:'web_search_call',action:{type:'find_in_page',url:'https://example.org/find'}},
  {type:'web_search_call',action:{type:'open_page',url:'javascript:alert(1)'}},
  {type:'message',content:[{text:'Unverified https://example.org/prose',annotations:[{type:'url_citation',url:'https://example.org/cited',title:'Citation'}]}]},
 ];
 assert.deepEqual(responseSources(output).map(s=>s.url),['https://example.org/search','https://example.org/open','https://example.org/find','https://example.org/cited']);
});
const {createSearchClient,parseDuckDuckGo}=require('../src/quick-ask/search-client');
const scheduler={delay:(ms,cb)=>setTimeout(cb,ms),cancelDelay:clearTimeout};
test('all independent providers retain safe sources without leaking their credential',async()=>{
 for(const provider of ['firecrawl','exa','parallel','perplexity']){
  let request;
  const client=createSearchClient({scheduler,secrets:{resolve:()=> 'PRIVATE_SECRET'},network:{request:async r=>{request=r; const results=[{title:'Example',url:'https://example.org',description:'excerpt',snippet:'excerpt',excerpts:['excerpt'],highlights:['excerpt']},{url:'javascript:alert(1)'}]; return {status:200,json:provider==='firecrawl'?{data:{web:results}}:{results}};}}});
  const result=await client.search('test',{kind:'independent',provider,secretId:'reference'});
  assert.equal(result.ok,true); assert.equal(result.sources.length,1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_SECRET'),false);
  assert.equal(request.body.includes('PRIVATE_SECRET'),false);
 }
});
test('DuckDuckGo decodes URLs and HTML without executing it and detects challenges',()=>{
 const html='<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org">A &amp; B</a><a class="result__snippet">Useful <b>text</b></a>';
 assert.deepEqual(parseDuckDuckGo(html),[{url:'https://example.org/',title:'A & B',snippet:'Useful text'}]);
 assert.throws(()=>parseDuckDuckGo('<form id="challenge-form">'),/CHALLENGE/);
 assert.throws(()=>parseDuckDuckGo('<html>unknown layout</html>'),/PARSE/);
 assert.deepEqual(parseDuckDuckGo('No results found'),[]);
});
const {createToolExecutor}=require('../src/quick-ask/tool');
test('cancelled searches settle without making a network request',async()=>{
 const controller=new AbortController();controller.abort();let calls=0;
 const client=createSearchClient({scheduler,secrets:{resolve:()=> 'key'},network:{request:async()=>{calls++;}}});
 const result=await client.search('q',{kind:'local',provider:'duckduckgo'},{signal:controller.signal});
 assert.equal(result.code,'ABORTED');assert.equal(calls,0);
 await new Promise(r=>setImmediate(r));
});
test('timeout remains TIMEOUT when the transport rejects immediately on abort',async()=>{
 let fire;
 const client=createSearchClient({scheduler:{delay:(ms,cb)=>{fire=cb;return 1;},cancelDelay(){}},secrets:{resolve:()=> 'key'},
 network:{request:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{name:'AbortError'}))))}});
 const task=client.search('q',{kind:'local',provider:'duckduckgo'});fire();
 assert.equal((await task).code,'TIMEOUT');
});
test('a failing search callback releases the shared executor queue',async()=>{
 const executor=createToolExecutor({vault:{},maxConcurrent:1});const question=executor.createQuestionState({callLimit:3});
 await assert.rejects(executor.executeCall({name:'web_search',arguments:{query:'q'}},{question,search:async()=>{throw new Error('disk failure');}}),/disk failure/);
 const result=await executor.executeCall({name:'web_search',arguments:{query:'q'}},{question,search:async()=>({ok:true,sources:[]})});
 assert.equal(result.ok,true);assert.equal(question.callsUsed,2);
});
test('auth and rate-limit failures never invoke a fallback service',async()=>{
 for(const status of [401,403,429,500]){
  let count=0;const client=createSearchClient({scheduler,secrets:{resolve:()=> 'key'},network:{request:async()=>{count++;return {status,text:'search not supported'};}}});
  const result=await client.search('q',{kind:'independent',provider:'exa',secretId:'id'});
  assert.equal(result.ok,false);assert.equal(result.next,undefined);assert.equal(count,1);
 }
});
test('server annotation citations become clickable without changing copied source',()=>{
 const {citedAnswer}=require('../src/quick-ask/web-search');
 const text='Fact [1]'; const output=[{type:'message',content:[{text,annotations:[{type:'url_citation',start_index:5,end_index:8,url:'https://example.org',title:'Evidence'}]}]}];
 assert.equal(citedAnswer(text,output),'Fact [\\[1\\]](https://example.org/)');
 assert.equal(output[0].content[0].text,text);
 assert.equal(citedAnswer('Already [1](https://example.org)',[]),'Already [1](https://example.org)');
});

test('Google search identifies Gemini family without restricting models to two names or official hosts',()=>{
 for(const model of ['gemini-2.0-flash','gemini-2.5-pro','gemini-2.5-flash','gemini-2.5-flash-lite','gemini-3-flash-preview','gemini-3.1-pro-preview','gemini-3.8-flash','google/gemini-4-argon'])for(const baseUrl of ['https://generativelanguage.googleapis.com/v1beta/openai','https://relay.example/gemini/v1beta/openai']){
  const route=searchRoute(true,{provider:'server'},{protocol:'chat-completions',baseUrl,model});
  assert.equal(route.kind,'server');assert.equal(route.provider,'google');assert.equal(route.native,true);assert.equal(route.localTools,false);
 }
 const vertex='https://relay.example/v1/projects/project/locations/global/endpoints/openapi';
 assert.equal(searchRoute(true,{provider:'server'},{protocol:'chat-completions',baseUrl:vertex,model:'google/gemini-2.5-flash'}).native,false);
 assert.equal(searchRoute(true,{provider:'server'},{protocol:'responses',model:'gemini-2.5-flash'}).toolChoice,'required');
 assert.equal(searchRoute(false,{provider:'server'},{protocol:'chat-completions',model:'gemini-2.5-flash'}).kind,'off');
 assert.equal(searchRoute(true,{provider:'server'},{protocol:'responses',baseUrl:'https://relay.example/v1',model:'gpt-5'}).provider,'openai');
});

test('Chat URL annotations share safe source and display projections without modifying native data',()=>{
 const {responseSources,citedAnswer}=require('../src/quick-ask/web-search');
 const item={role:'assistant',content:'Fact [1]',annotations:[
  {type:'url_citation',url_citation:{start_index:5,end_index:8,url:'https://example.org/evidence',title:'Evidence'}},
  {type:'url_citation',url_citation:{start_index:0,end_index:4,url:'javascript:alert(1)',title:'Unsafe'}},
 ]};
 const before=JSON.stringify(item);
 assert.deepEqual(responseSources([item]).map(s=>s.url),['https://example.org/evidence']);
 assert.equal(citedAnswer(item.content,[item]),'Fact [\\[1\\]](https://example.org/evidence)');
 assert.equal(JSON.stringify(item),before);
 assert.deepEqual(responseSources([{role:'assistant',content:'https://example.org/ungrounded'}]),[]);
});

test('malformed vendor citation metadata cannot crash source or display projection',()=>{
 const {responseSources,citedAnswer}=require('../src/quick-ask/web-search');
 const malformed=[
  {role:'assistant',content:'Answer',annotations:[null,{type:'url_citation',url_citation:null}]},
  {role:'assistant',content:'Answer',annotations:{}},
  {type:'message',content:[null,{text:'Answer',annotations:{}}]},
 ];
 assert.deepEqual(responseSources(malformed),[]);
 assert.equal(citedAnswer('Answer',malformed),'Answer');
});

test('DeepSeek Search reuses the model secret and configured base URL with the official request shape',async()=>{
 for(const baseUrl of ['https://api.deepseek.com','https://api.deepseek.com/v1/','https://custom.example/deepseek/']){
  let sent, resolved;
  const route={kind:'provider-api',provider:'deepseek',secretId:'model-key',baseUrl,queryLimit:128};
  const client=createSearchClient({scheduler,secrets:{resolve:id=>{resolved=id;return 'PRIVATE_MODEL_KEY';}},network:{request:async request=>{
   sent=request;return {status:200,json:{results:[{url:'https://example.org/evidence',title:'Evidence',summary:'Model-facing long summary',snippet:'Short UI snippet'},{url:'https://example.org/fallback',snippet:'Fallback snippet'},{url:'javascript:alert(1)',summary:'Unsafe'}]}};
  }}});
  const result=await client.search('public query',route);
  assert.equal(resolved,'model-key');assert.equal(result.ok,true);
  const base=baseUrl.replace(/\/+$/,'');
  assert.equal(sent.url,base+(base.endsWith('/v1')?'/tools/search':'/v1/tools/search'));
  assert.equal(sent.method,'POST');assert.equal(sent.headers.Authorization,'Bearer PRIVATE_MODEL_KEY');
  assert.deepEqual(JSON.parse(sent.body),{query:'public query',count:5,need_content:false});
  assert.deepEqual(result.sources.map(source=>source.snippet),['Model-facing long summary','Fallback snippet']);
  assert.equal(JSON.stringify(result).includes('PRIVATE_MODEL_KEY'),false);
 }
});

test('DeepSeek Search validates 128 Unicode code points without truncating queries or issuing invalid requests',async()=>{
 let sent,calls=0;
 const route={kind:'provider-api',provider:'deepseek',secretId:'model-key',baseUrl:'https://api.deepseek.com',queryLimit:128};
 const client=createSearchClient({scheduler,secrets:{resolve:()=> 'key'},network:{request:async request=>{sent=request;calls++;return {status:200,json:{results:[]}};}}});
 const query='😀'.repeat(128);
 assert.equal((await client.search(query,route)).ok,true);
 assert.equal(JSON.parse(sent.body).query,query);
 for(const invalid of ['😀'.repeat(129),'a'.repeat(129),' ','',null]){
  const result=await client.search(invalid,route);
  assert.equal(result.code,'QUERY');assert.match(result.message,/128/);assert.match(result.message,/Retry/);
 }
 assert.equal(calls,1);
});

test('DeepSeek Search never requests without its model secret or falls back after HTTP failures',async()=>{
 const route={kind:'provider-api',provider:'deepseek',secretId:'model-key',baseUrl:'https://api.deepseek.com',queryLimit:128};
 for(const key of [null,'','   ']){
  let calls=0;
  const client=createSearchClient({scheduler,secrets:{resolve:()=>key},network:{request:async()=>{calls++;}}});
  assert.equal((await client.search('query',route)).code,'MISSING_SECRET');assert.equal(calls,0);
 }
 for(const status of [400,401,402,403,429,500]){
  let calls=0;
  const client=createSearchClient({scheduler,secrets:{resolve:()=> 'key'},network:{request:async()=>{calls++;return {status};}}});
  const result=await client.search('query',route);
  assert.equal(result.code,[401,403].includes(status)?'AUTH':status===429?'RATE_LIMIT':'HTTP');
  assert.equal(result.status,status);assert.equal(calls,1);assert.equal(result.next,undefined);
 }
});

test('DeepSeek Search preserves cancellation and timeout behavior',async()=>{
 const route={kind:'provider-api',provider:'deepseek',secretId:'model-key',baseUrl:'https://api.deepseek.com',queryLimit:128};
 const controller=new AbortController();controller.abort();let calls=0;
 const client=createSearchClient({scheduler,secrets:{resolve:()=> 'key'},network:{request:async()=>{calls++;}}});
 assert.equal((await client.search('query',route,{signal:controller.signal})).code,'ABORTED');assert.equal(calls,0);
 let fire;
 const timed=createSearchClient({scheduler:{delay:(ms,callback)=>{fire=callback;return 1;},cancelDelay(){}},secrets:{resolve:()=> 'key'},network:{request:({signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))}});
 const pending=timed.search('query',route);fire();assert.equal((await pending).code,'TIMEOUT');
});

test('Google grounding projects UTF-8 part offsets, multiple sources and original Search Suggestions',()=>{
 const {responseSources,responseSuggestions,citedAnswer}=require('../src/quick-ask/web-search');
 const text='前言中文🌏事实';
 const metadata={groundingChunks:[{web:{uri:'https://example.org/one',title:'One'}},{web:{uri:'https://example.org/two',title:'Two'}},{web:{uri:'javascript:alert(1)'}}],
  groundingSupports:[{segment:{partIndex:1,startIndex:0,endIndex:10,text:'中文🌏'},groundingChunkIndices:[0,1,2]},{segment:{partIndex:1,startIndex:1,endIndex:2,text:'x'},groundingChunkIndices:[0]}],
  searchEntryPoint:{renderedContent:'<div>Google Search suggestions</div>'}};
 const item={role:'assistant',content:text,extra_content:{google:{groundingMetadata:metadata,nativeContent:{role:'model',parts:[{text:'前言'},{text:'中文🌏事实'}]}}}};
 const original=JSON.stringify(item);
 assert.deepEqual(responseSources([item]).map(s=>s.title),['One','Two']);
 assert.equal(citedAnswer(text,[item]),'前言中文🌏[1](https://example.org/one), [2](https://example.org/two)事实');
 assert.deepEqual(responseSuggestions([item,item]),['<div>Google Search suggestions</div>']);
 assert.equal(JSON.stringify(item),original);
});

test('malformed Google grounding supports are skipped without breaking terminal persistence',()=>{
 const {citedAnswer}=require('../src/quick-ask/web-search');
 for(const supports of [[null],[{}],[{segment:null}],[{segment:[]}],[{segment:{partIndex:1,startIndex:0,endIndex:4,text:'Fact'},groundingChunkIndices:[0]}]]){
  const item={role:'assistant',content:'Fact',extra_content:{google:{nativeContent:{role:'model',parts:[null,{text:'Fact'}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://example.org'}}],groundingSupports:supports}}}};
  assert.doesNotThrow(()=>citedAnswer('Fact',[item]));
 }
});

test('CPA Gemini Responses search keeps the selected protocol and separates hosted search from functions',()=>{
 for(const model of ['gemini-3-flash','gemini-3.8-flash-high','google/gemini-2.5-flash']){
  const route=searchRoute(true,{provider:'server'},{protocol:'responses',baseUrl:'http://127.0.0.1:8317/v1',model});
  assert.equal(route.kind,'server');assert.equal(route.provider,'google');assert.equal(route.native,undefined);
  assert.equal(route.localTools,false);assert.equal(route.toolChoice,'required');assert.deepEqual(route.tool,{type:'web_search'});
  assert.equal(searchRoute(false,{provider:'server'},{protocol:'responses',baseUrl:'http://127.0.0.1:8317/v1',model}).kind,'off');
 }
});

test('CPA Gemini CC search stays on CC, separate from explicit Gemini native and Vertex endpoints',()=>{
 for(const baseUrl of ['http://127.0.0.1:8317/v1','https://relay.example/v1','https://relay.example']){
  const route=searchRoute(true,{provider:'server'},{protocol:'chat-completions',baseUrl,model:'gemini-3-flash'});
  assert.equal(route.kind,'server');assert.equal(route.chatSearch,'google-search');assert.equal(route.native,undefined);assert.equal(route.localTools,false);
 }
 assert.equal(searchRoute(true,{provider:'server'},{protocol:'chat-completions',baseUrl:'https://generativelanguage.googleapis.com/v1beta/openai',model:'gemini-3-flash'}).native,true);
});
