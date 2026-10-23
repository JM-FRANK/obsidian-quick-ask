// quick-ask-suite: portable
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runProviderSearch, mixedSearchErrorHint } = require('../src/quick-ask/provider-search');
function fixture(payload) {
  const requests=[];
  const environment={
    network:{AbortController,async request(request){requests.push(request);return {status:200,json:payload};}},
    scheduler:{now:()=>0,delay:(ms,callback)=>setTimeout(callback,ms),cancelDelay:clearTimeout,frame:callback=>setTimeout(callback,0),cancelFrame:clearTimeout},
  };
  return {requests,options:{environment,config:{protocol:'chat-completions',baseUrl:'https://relay.test/v1beta/openai',model:'gemini-3.8-flash'},
    route:{kind:'provider-search',provider:'google',server:{provider:'google',native:true}},apiKey:'fixture-only'}};
}
const answer={responseId:'search-result',candidates:[{content:{role:'model',parts:[{text:'Search summary'}]},finishReason:'STOP',
  groundingMetadata:{webSearchQueries:['query'],groundingChunks:[{web:{uri:'https://example.org/evidence',title:'Evidence'}}]}}],
  usageMetadata:{promptTokenCount:5,candidatesTokenCount:6,totalTokenCount:11}};

test('provider search sends only query and native search, returning bounded evidence and usage', async () => {
  const f=fixture(answer), result=await runProviderSearch('  query  ',f.options);
  assert.equal(result.ok,true);assert.equal(result.answer,'Search summary');assert.equal(result.sources[0].url,'https://example.org/evidence');
  assert.equal(f.requests.length,1);
  const body=JSON.parse(f.requests[0].body);
  assert.deepEqual(body.tools,[{google_search:{}}]);
  assert.deepEqual(body.contents,[{role:'user',parts:[{text:'query'}]}]);
  assert.equal(body.systemInstruction,undefined);
  assert.equal(body.generationConfig.maxOutputTokens,2048);
  assert.equal(body.previous_response_id,undefined);
  assert.equal(result.usageSamples[0].usage.prompt_tokens,5);
});

test('child function calls never execute or leak signed native payloads into main history', async () => {
  const f=fixture({candidates:[{content:{role:'model',parts:[{functionCall:{id:'unexpected',name:'get-full-file',args:{path:'private.md'}}}]},finishReason:'STOP'}]});
  const result=await runProviderSearch('query',f.options);
  assert.equal(result.ok,false);assert.equal(result.code,'UNEXPECTED_TOOL');
  assert.equal(JSON.stringify(result).includes('private.md'),false);assert.equal(f.requests.length,1);
});

test('invalid query and pre-cancelled provider searches never contact a service', async () => {
  const f=fixture(answer);
  assert.equal((await runProviderSearch(' '.repeat(10),f.options)).code,'QUERY');
  assert.equal((await runProviderSearch('q'.repeat(501),f.options)).code,'QUERY');
  const controller=new AbortController();controller.abort();
  assert.equal((await runProviderSearch('query',{...f.options,signal:controller.signal})).code,'ABORTED');
  assert.equal(f.requests.length,0);
});

test('mixed incompatibility supplies only a manual switch hint; unrelated failures do not', () => {
  const route={kind:'server',provider:'google'};
  assert.equal(mixedSearchErrorHint({status:400,code:'PROVIDER_ERROR',message:'Tool use with function calling is unsupported'},route),'search.switchIndependent');
  for(const code of ['AUTH','RATE_LIMIT','TIMEOUT','ABORTED','NETWORK'])
    assert.equal(mixedSearchErrorHint({code,message:'search unsupported'},route),null);
  assert.equal(mixedSearchErrorHint({message:'tool unsupported'},{kind:'provider-search'}),null);
  assert.equal(mixedSearchErrorHint({message:'invalid image'},route),null);
});
