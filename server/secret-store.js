import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export class SecretStore {
  constructor(root) {
    this.root=path.join(root,".private");
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    const keyPath=path.join(this.root,"key");
    if(!fs.existsSync(keyPath)) fs.writeFileSync(keyPath,randomBytes(32),{flag:"wx",mode:0o600});
    this.key=fs.readFileSync(keyPath);
  }
  file(id) {
    if(!/^[a-zA-Z0-9_-]{1,120}$/.test(id))throw new Error("Invalid secret identifier");
    return path.join(this.root,`${id}.json`);
  }
  set(id,value) {
    const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",this.key,iv);
    const data=Buffer.concat([cipher.update(JSON.stringify(value),"utf8"),cipher.final()]);
    fs.writeFileSync(this.file(id),JSON.stringify({iv:iv.toString("base64"),tag:cipher.getAuthTag().toString("base64"),data:data.toString("base64")}),{mode:0o600});
  }
  get(id) {
    if(!fs.existsSync(this.file(id)))return null;
    const value=JSON.parse(fs.readFileSync(this.file(id),"utf8"));
    const cipher=createDecipheriv("aes-256-gcm",this.key,Buffer.from(value.iv,"base64"));
    cipher.setAuthTag(Buffer.from(value.tag,"base64"));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(value.data,"base64")),cipher.final()]).toString("utf8"));
  }
  delete(id) {fs.rmSync(this.file(id),{force:true});}
}
