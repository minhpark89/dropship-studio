import { lookup } from "node:dns/promises";

function publicAddress(address) {
  if (address.includes(":")) return /^2[0-9a-f]{3}:/i.test(address);
  const [a,b] = address.split(".").map(Number);
  return a > 0 && a < 224 && ![10,127].includes(a) && !(a===169 && b===254) && !(a===172 && b>=16 && b<=31) && !(a===192 && b===168) && !(a===100 && b>=64 && b<=127);
}

// Article text is optional context. Inaccessible pages fall back to attributed
// RSS summaries; we never send an internal network response to the LLM.
export async function readArticleText(article, {fetchImpl = globalThis.fetch} = {}) {
  try {
    let url = new URL(article.url);
    for (let hop=0;hop<4;hop++) {
      if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.port && !["80","443"].includes(url.port)) return "";
      const addresses = await lookup(url.hostname.replace(/^\[|\]$/g,""),{all:true});
      if (!addresses.length || addresses.some(({address})=>!publicAddress(address))) return "";
      const response = await fetchImpl(url,{redirect:"manual",signal:AbortSignal.timeout(10000),headers:{accept:"text/html, text/plain"}});
      if ([301,302,303,307,308].includes(response.status)) { url = new URL(response.headers.get("location"),url); continue; }
      if (!response.ok || !/text\/html|text\/plain/.test(response.headers.get("content-type") || "")) return "";
      const reader = response.body.getReader();
      const chunks=[]; let length=0;
      while (true) { const {value,done}=await reader.read(); if(done)break; length+=value.length; if(length>1500000){await reader.cancel();return "";} chunks.push(Buffer.from(value)); }
      const html=Buffer.concat(chunks).toString("utf8");
      const segment=html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] || "";
      return segment.replace(/<(script|style|nav|aside|footer|form)\b[^>]*>[\s\S]*?<\/\1>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/\s+/g," ").trim().slice(0,20000);
    }
  } catch { /* Source summaries remain available. */ }
  return "";
}
