import { randomBytes } from "node:crypto";
import { SecretStore } from "./secret-store.js";

export function createDreamFaceSlots(store,{count,namePrefix}) {
  const secrets=new SecretStore(store.root);
  const offset=store.state.accounts.filter(account=>account.provider==="dreamface").length;
  return Array.from({length:count},(_,index)=>{
    const credentials={email:`viralstudio.${randomBytes(12).toString("hex")}@gmail.com`,password:randomBytes(24).toString("base64url")+"Aa7!"};
    const account=store.add("accounts",{
      name:`${namePrefix} ${String(offset+index+1).padStart(2,"0")}`,provider:"dreamface",loginMethod:"credentials",email:credentials.email,proxy:"",
      status:"needs_login",hasCredentials:true,message:"Sign-in details saved. Connect this profile to finish DreamFace registration.",
      rotationIndex:offset+index+1,rotationEnabled:true,rotationMode:"daily",rotationDay:"",
    });
    secrets.set(`dreamface-${account.id}`,credentials);
    return account;
  });
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
