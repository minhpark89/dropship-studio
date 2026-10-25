import test from "node:test";
import assert from "node:assert/strict";
import { readChatCompletion } from "../server/llm-response.js";
import { editorialImages } from "../server/image-search.js";

test("compatible gateway JSON plus a trailing DONE marker yields only final content",async()=>{
  const envelope={choices:[{finish_reason:"stop",message:{content:'{"title":"News"}',reasoning_content:"Private reasoning is not content"}}]};
  for(const ending of ["","data: [DONE]\n\n","\n\ndata: [DONE]\n\n"]) {
    assert.equal(await readChatCompletion(new Response(JSON.stringify(envelope)+ending)),'{"title":"News"}');
  }
});
test("SSE content chunks are joined without reasoning or keepalive events",async()=>{
  const events=[{choices:[{delta:{reasoning_content:"omit"}}]},{choices:[{delta:{content:'{"title":'}}]},{choices:[{delta:{content:'"News"}'},finish_reason:"stop"}]}];
  const body=": keepalive\n\n"+events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join("")+"data: [DONE]\n\n";
  assert.equal(await readChatCompletion(new Response(body)),'{"title":"News"}');
});
test("truncated completions and invalid trailing data are rejected",async()=>{
  await assert.rejects(()=>readChatCompletion(new Response(JSON.stringify({choices:[{finish_reason:"length",message:{content:"partial"}}]}))),/truncated/);
  await assert.rejects(()=>readChatCompletion(new Response('{"choices":[]} unrelated suffix')));
});
test("news preview skips tiny graphics and SVG logos",()=>{
  const photos=[{title:"Satellite dish.jpg",mime:"image/jpeg",width:1200,height:800}];
  assert.deepEqual(editorialImages([...photos,{title:"SpaceX-Logo-Xonly.svg",mime:"image/svg+xml",width:100,height:50},{title:"Tiny photo.jpg",mime:"image/jpeg",width:100,height:80}]),photos);
});
