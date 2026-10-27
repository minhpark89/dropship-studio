import { useEffect, useState } from "react";
import { Globe2, Download, CheckCircle2, Save } from "lucide-react";
import { api } from "../api.js";
import { Button, Field } from "../components.jsx";

export function WebsiteSettings({settings = {},notify}) {
  const sites=settings.connections || [];
  const [draft,setDraft]=useState(()=>({...sites.find(site=>site.id===settings.activeId),password:""}));
  const [busy,setBusy]=useState("");
  const [message,setMessage]=useState("");
  useEffect(()=>{if(!draft.id&&settings.activeId)setDraft({...sites.find(site=>site.id===settings.activeId),password:""});},[settings.activeId,sites]);
  const act=async(key,operation)=>{if(busy)return;setBusy(key);setMessage("");try{return await operation();}catch(error){notify(error.message,"error");setMessage(error.message);}finally{setBusy("");}};
  const importSite=source=>act(source,async()=>{const site=await api("/website/import",{source});await api("/website/settings",{activeId:site.id},"PATCH");setDraft({...site,password:""});notify(`Imported ${site.name}.`);});
  const selectSite=async id=>{setDraft({...sites.find(site=>site.id===id),password:""});await act("select",()=>api("/website/settings",{activeId:id},"PATCH"));};
  const save=async event=>{event.preventDefault();await act("save",async()=>{const site=await api("/website/connections",{id:draft.id||crypto.randomUUID(),name:draft.name||"News website",provider:draft.provider||"cms",baseUrl:draft.baseUrl,username:draft.username,password:draft.password||undefined});setDraft({...site,password:""});notify("Website settings saved.");});};
  const test=()=>act("test",async()=>{const result=await api("/website/test",{id:draft.id});setMessage(result.message);notify(result.message);});
  return <section className="panel settings-website-panel">
    <div className="panel-heading"><h3><Globe2 size={18}/> Website publishing</h3></div>
    <p className="muted small">Connect your own news website. News Broadcast can publish the generated article after rendering; its exact public URL is then placed in the matching first comment. Content still keeps the draft and any error for review.</p>
    <div className="hub-heading-actions"><Button type="button" onClick={()=>importSite("highlight")} busy={busy==="highlight"}><Download size={14}/> Import Highlight</Button><Button type="button" onClick={()=>importSite("longform")} busy={busy==="longform"}><Download size={14}/> Import Longform</Button></div>
    {sites.length>0 && <Field label="Active news website"><select value={settings.activeId || ""} onChange={event=>selectSite(event.target.value)}>{sites.map(site=><option key={site.id} value={site.id}>{site.name} · {site.baseUrl}</option>)}</select></Field>}
    <form onSubmit={save}>
      <div className="form-grid"><Field label="Website name"><input required value={draft.name||""} onChange={event=>setDraft({...draft,name:event.target.value})}/></Field><Field label="Website domain"><input required type="url" value={draft.baseUrl||""} onChange={event=>setDraft({...draft,baseUrl:event.target.value})} placeholder="https://your-news-site.com"/></Field></div>
      <div className="form-grid"><Field label="Website username"><input required autoComplete="username" value={draft.username||""} onChange={event=>setDraft({...draft,username:event.target.value})}/></Field><Field label="Website password" hint={draft.hasPassword?"Saved securely. Leave blank to keep it.":"Use the same website account as Highlight or Longform."}><input type="password" autoComplete="new-password" value={draft.password||""} onChange={event=>setDraft({...draft,password:event.target.value})}/></Field></div>
      <Field label="Website backend"><select value={draft.provider||"cms"} onChange={event=>setDraft({...draft,provider:event.target.value})}><option value="cms">Highlight CMS API</option><option value="legacy">Longform backend</option></select></Field>
      <div className="production-actions"><Button type="button" onClick={test} disabled={!draft.id} busy={busy==="test"}><CheckCircle2 size={15}/> Test website</Button><Button type="submit" variant="primary" busy={busy==="save"}><Save size={15}/> Save website</Button></div>
      {message && <p className="small muted">{message}</p>}
    </form>
  </section>;
}
