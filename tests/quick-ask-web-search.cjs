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
