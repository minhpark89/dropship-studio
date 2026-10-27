import { randomBytes } from "node:crypto";
import { SecretStore } from "./secret-store.js";
import { StudioError } from "./store.js";

export function createDreamFaceCredentials(email = "", usedEmails = new Set()) {
  const used = new Set([...usedEmails].map((value) => String(value || "").trim().toLowerCase()).filter(Boolean));
  const supplied = String(email || "").trim().toLowerCase();
  let address = /^[^@\s]+@gmail\.com$/i.test(supplied) && !used.has(supplied)
    ? supplied
    : "";
  while (!address || used.has(address)) {
    address = `viralstudio.${randomBytes(12).toString("hex")}@gmail.com`;
  }
  return {
    email: address,
    password: randomBytes(24).toString("base64url") + "Aa7!",
  };
}

function dreamFaceEmails(store, exceptId = "") {
  return new Set((store?.state?.accounts || [])
    .filter((account) => account.provider === "dreamface" && account.id !== exceptId)
    .map((account) => String(account.email || "").trim().toLowerCase())
    .filter(Boolean));
}

/**
 * Keep the proxy contract shared by single-account and bulk DreamFace setup.
 * Chrome/Playwright can use a proxy server, but the current owned-profile
 * launcher does not support credentials embedded in the URL.
 */
export function normalizeProxy(value) {
  const source = String(value || "").trim();
  if (!source) return "";
  let proxy;
  try {
    proxy = new URL(source.includes("://") ? source : `http://${source}`);
  } catch {
    throw new StudioError("Địa chỉ proxy không hợp lệ.", "INVALID_PROXY");
  }
  if (!["http:", "https:", "socks5:"].includes(proxy.protocol) ||
      proxy.username || proxy.password ||
      !["", "/"].includes(proxy.pathname) || proxy.search || proxy.hash ||
      !proxy.hostname) {
    throw new StudioError(
      "Proxy hỗ trợ HTTP/HTTPS/SOCKS5 dạng host:port và không chứa mật khẩu.",
      "INVALID_PROXY",
    );
  }
  return `${proxy.protocol}//${proxy.host}`;
}

function proxyForSlot({ proxy = "", proxies = [] }, index, count) {
  const entries = Array.isArray(proxies)
    ? proxies.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  if (entries.length > 1 && entries.length !== count) {
    throw new StudioError(
      "Nếu nhập nhiều proxy, cần nhập đúng một proxy cho mỗi profile.",
      "INVALID_PROXY_LIST",
    );
  }
  const selected = entries.length
    ? entries.length === 1 ? entries[0] : entries[index]
    : proxy;
  return normalizeProxy(selected);
}

export function createDreamFaceSlots(store,{count,namePrefix,proxy="",proxies=[]}) {
  const secrets=new SecretStore(store.root);
  const offset=store.state.accounts.filter(account=>account.provider==="dreamface").length;
  const usedEmails = dreamFaceEmails(store);
  return Array.from({length:count},(_,index)=>{
    const credentials=createDreamFaceCredentials("", usedEmails);
    usedEmails.add(credentials.email);
    const account=store.add("accounts",{
      name:`${namePrefix} ${String(offset+index+1).padStart(2,"0")}`,provider:"dreamface",loginMethod:"credentials",email:credentials.email,proxy:proxyForSlot({proxy,proxies},index,count),
      status:"needs_login",hasCredentials:true,gmailStatus:"idle",message:"Email mẫu và mật khẩu đã lưu an toàn. Bấm Tạo Gmail & điền để mở DreamFace.",
      rotationIndex:offset+index+1,rotationEnabled:true,rotationMode:"daily",rotationDay:"",
    });
    secrets.set(`dreamface-${account.id}`,credentials);
    return account;
  });
}

export function ensureDreamFaceCredentials(store, account) {
  const secrets = new SecretStore(store.root);
  const saved = secrets.get(`dreamface-${account.id}`);
  const usedEmails = dreamFaceEmails(store, account.id);
  if (saved?.email && saved?.password && !usedEmails.has(String(saved.email).trim().toLowerCase())) return saved;
  const credentials = createDreamFaceCredentials(account.email, usedEmails);
  secrets.set(`dreamface-${account.id}`, credentials);
  store.patch("accounts", account.id, {
    email: credentials.email,
    hasCredentials: true,
  });
  return credentials;
}

export function saveDreamFaceCredentials(store,account,input={}) {
  const secrets=new SecretStore(store.root);
  const saved=secrets.get(`dreamface-${account.id}`);
  const credentials=input.password?{email:input.email||account.email,password:input.password}:saved;
  if(credentials?.email&&credentials.password) {
    secrets.set(`dreamface-${account.id}`,credentials);
    store.patch("accounts",account.id,{email:credentials.email,hasCredentials:true});
    return credentials;
  }
  return input;
}
