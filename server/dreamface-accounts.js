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
 * Parse the formats people commonly receive from proxy providers:
 * host:port, host:port:user:pass and user:pass@host:port. Credentials are
 * returned separately so callers can keep them in SecretStore instead of
 * exposing a proxy password in the public workspace snapshot.
 */
export function parseProxy(value) {
  const source = String(value || "").trim();
  if (!source) return { server: "", username: "", password: "" };
  let candidate = source;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(candidate);
  const scheme = hasScheme ? candidate.split("://", 1)[0].toLowerCase() : "http";
  if (!hasScheme && !candidate.includes("@")) {
    const parts = candidate.split(":");
    if (parts.length >= 4 && parts[0] && parts[1] && parts[2]) {
      const [host, port, username, ...rest] = parts;
      candidate = `${scheme}://${encodeURIComponent(username)}:${encodeURIComponent(rest.join(":"))}@${host}:${port}`;
    } else {
      candidate = `${scheme}://${candidate}`;
    }
  } else if (!hasScheme) {
    candidate = `${scheme}://${candidate}`;
  }
  let proxy;
  try {
    proxy = new URL(candidate);
  } catch {
    throw new StudioError("Địa chỉ proxy không hợp lệ.", "INVALID_PROXY");
  }
  if (!["http:", "https:", "socks5:"].includes(proxy.protocol) ||
      !proxy.hostname || !proxy.port ||
      !["", "/"].includes(proxy.pathname) || proxy.search || proxy.hash) {
    throw new StudioError(
      "Proxy dùng HTTP/HTTPS/SOCKS5 và cần đúng dạng host:port, host:port:user:pass hoặc user:pass@host:port.",
      "INVALID_PROXY",
    );
  }
  let username = "";
  let password = "";
  try {
    username = decodeURIComponent(proxy.username || "");
    password = decodeURIComponent(proxy.password || "");
  } catch {
    throw new StudioError("Thông tin user/pass của proxy không hợp lệ.", "INVALID_PROXY");
  }
  if ((username && !password) || (!username && password))
    throw new StudioError("Proxy phải có đủ user và password.", "INVALID_PROXY");
  return { server: `${proxy.protocol}//${proxy.host}`, username, password };
}

export function normalizeProxy(value) {
  return parseProxy(value).server;
}

export function proxySecretId(accountId) {
  return `proxy-${accountId}`;
}

export function saveDreamFaceProxy(store, account, value) {
  const parsed = parseProxy(value);
  const secrets = new SecretStore(store.root);
  if (parsed.username || parsed.password) secrets.set(proxySecretId(account.id), parsed);
  else secrets.delete(proxySecretId(account.id));
  return parsed;
}

export function getDreamFaceProxy(store, account) {
  const parsed = parseProxy(account?.proxy || "");
  const saved = new SecretStore(store.root).get(proxySecretId(account.id));
  return {
    server: parsed.server,
    username: saved?.username || parsed.username || "",
    password: saved?.password || parsed.password || "",
  };
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
  return parseProxy(selected);
}

export function createDreamFaceSlots(store,{count,namePrefix,proxy="",proxies=[]}) {
  const secrets=new SecretStore(store.root);
  const offset=store.state.accounts.filter(account=>account.provider==="dreamface").length;
  const usedEmails = dreamFaceEmails(store);
  return Array.from({length:count},(_,index)=>{
    const credentials=createDreamFaceCredentials("", usedEmails);
    usedEmails.add(credentials.email);
    const parsedProxy = proxyForSlot({proxy,proxies},index,count);
    const account=store.add("accounts",{
      name:`${namePrefix} ${String(offset+index+1).padStart(2,"0")}`,provider:"dreamface",loginMethod:"credentials",email:credentials.email,proxy:parsedProxy.server,proxyAuth:Boolean(parsedProxy.username),
      status:"needs_login",hasCredentials:true,gmailStatus:"idle",message:"Email mẫu và mật khẩu đã lưu an toàn. Bấm Tạo Gmail & điền để mở DreamFace.",
      rotationIndex:offset+index+1,rotationEnabled:true,rotationMode:"daily",rotationDay:"",
    });
    secrets.set(`dreamface-${account.id}`,credentials);
    if (parsedProxy.username || parsedProxy.password) secrets.set(proxySecretId(account.id), parsedProxy);
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
