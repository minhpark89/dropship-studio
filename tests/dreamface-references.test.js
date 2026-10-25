import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {chromium} from "playwright";
import {Store} from "../server/store.js";
import {prepareDreamFaceReferences} from "../server/providers/dreamface.js";

test("DreamFace uploads selected product images to the visible multi-reference input",async t=>{
  const root=path.resolve(".verification",`dreamface-refs-${randomUUID()}`),store=new Store(root),project=store.createProject("Product");
  const browser=await chromium.launch({headless:true,executablePath:"C:/Program Files/Google/Chrome/Application/chrome.exe"});
  t.after(async()=>{await browser.close();await fs.rm(root,{recursive:true,force:true});});
  const page=await browser.newPage();
  await page.setContent(`<button onclick="document.querySelector('#multi').hidden=false">References to Video</button><button>Image or Text</button><div hidden><input type="file"></div><section id="multi" hidden><label><input type="file" multiple></label><img hidden></section>`);
  await page.locator('#multi input').evaluate(input=>input.addEventListener('change',()=>{const img=document.querySelector('img');img.src=URL.createObjectURL(input.files[0]);img.hidden=false;}));
  const references=[];
  for(let i=0;i<2;i++) {
    const file=path.join(root,"media",`${i}.png`);
    await fs.writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=','base64'));
    references.push(store.add("media",{projectId:project.id,kind:"image",file}).id);
  }
  assert.deepEqual(await prepareDreamFaceReferences(store,page,{projectId:project.id,references}),[]);
  assert.equal(await page.locator('#multi input').evaluate(input=>input.files.length),2);
  assert.equal(await page.locator('div input').evaluate(input=>input.files.length),0);
});

test("DreamFace rejects references from another project before opening the upload control",async t=>{
  const root=path.resolve(".verification",`dreamface-refs-${randomUUID()}`),store=new Store(root);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const image=store.add("media",{kind:"image",projectId:randomUUID(),file:"private.png"});
  await assert.rejects(prepareDreamFaceReferences(store,{}, {projectId:randomUUID(),references:[image.id]}),error=>error.code==="INVALID_REFERENCE");
});
