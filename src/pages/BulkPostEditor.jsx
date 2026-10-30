import {useEffect,useMemo,useState} from 'react';
import {Button,Field,Modal,Notice} from '../components.jsx';
import {api} from '../api.js';

const fields={title:['Tiêu đề',200],caption:['Caption',20000],firstComment:['Bình luận đầu tiên',10000],articleBody:['Nội dung bài News',60000],notes:['Ghi chú',5000]};

export function BulkPostEditor({rows,onClose,onDone}){
  const [common,setCommon]=useState({}),[edits,setEdits]=useState({}),[field,setField]=useState('caption'),[value,setValue]=useState(''),[page,setPage]=useState(1),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const body=useMemo(()=>({action:'edit',items:rows.map(r=>({id:r.id,revision:r.revision})),changes:common,edits}),[rows,common,edits]);
  const dirty=Object.keys(common).length>0 || Object.values(edits).some(e=>Object.keys(e).length);
  useEffect(()=>{
    setPreview(null);setError('');if(!dirty)return;
    let cancelled=false;const timer=setTimeout(()=>api('/management/posts/bulk/preview',body,'POST').then(r=>{if(!cancelled)setPreview(r);}).catch(e=>{if(!cancelled)setError(e.message);}),300);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[body,dirty]);
  const total=Math.max(1,Math.ceil(rows.length/10)),visible=rows.slice((page-1)*10,page*10);
  const change=(id,key,text)=>setEdits(old=>({...old,[id]:{...old[id],[key]:text}}));
  const setForAll=()=>{
    setCommon(old=>({...old,[field]:value}));
    setEdits(old=>Object.fromEntries(Object.entries(old).map(([id,values])=>[id,Object.fromEntries(Object.entries(values).filter(([key])=>key!==field))])));
  };
  const submit=async()=>{if(!preview?.changed)return;setBusy(true);try{await onDone(await api('/management/posts/bulk',body,'POST'));}catch(e){setError(e.message);}finally{setBusy(false);}};
  return <Modal wide title={`Sửa ${rows.length} bài đã chọn`} onClose={busy?()=>{}:onClose}>
    <div className="mg-dialog-body mg-bulk-editor">
      <Notice>Danh sách dưới đây gồm tất cả bài đã chọn. Sửa riêng từng bài hoặc điền một trường cho tất cả. Chỉ lưu những nội dung đã đổi; bài chuyển về nháp và không tự đăng.</Notice>
      <details className="mg-common-edit"><summary>Điền một trường cho tất cả {rows.length} bài</summary><div className="form-grid"><Field label="Trường áp dụng chung"><select value={field} onChange={e=>{setField(e.target.value);setValue(common[e.target.value] || '');}}>{Object.entries(fields).map(([key,[label]])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="Nội dung áp dụng chung"><textarea rows={3} value={value} maxLength={fields[field][1]} onChange={e=>setValue(e.target.value)}/></Field></div><Button onClick={setForAll}>Điền cho {rows.length} bài</Button>{Object.keys(common).length>0&&<p className="muted">Đã điền chung: {Object.keys(common).map(key=>fields[key][0]).join(', ')}. Có thể chỉnh riêng bên dưới.</p>}</details>
      <div className="mg-edit-list">{visible.map((row,index)=><details key={row.id} open={index===0} className="mg-edit-item"><summary>{(page-1)*10+index+1}. {row.title} <small>{row.pageName || 'Trong kho'}</small></summary>{Object.entries(fields).filter(([key])=>key!=='articleBody'||row.contentType==='news').map(([key,[label,max]])=><Field key={key} label={`${label} · ${(page-1)*10+index+1}`}><textarea rows={key==='title'?1:3} aria-label={`${label} bài ${(page-1)*10+index+1}`} value={edits[row.id]?.[key] ?? common[key] ?? row[key] ?? ''} maxLength={max} onChange={e=>change(row.id,key,e.target.value)}/></Field>)}</details>)}</div>
      {total>1&&<div className="mg-editor-pager"><Button disabled={page===1} onClick={()=>setPage(page-1)}>Trang trước</Button><span>Trang {page}/{total} · {rows.length} bài đã chọn</span><Button disabled={page===total} onClick={()=>setPage(page+1)}>Trang sau</Button></div>}
      {error&&<p role="alert" className="mg-error">{error}</p>}
      {preview?<div className="mg-preview"><strong>{preview.changed} bài sẽ lưu · {preview.failed} bài không thay đổi hoặc cần xử lý riêng</strong>{preview.failed>0&&<ul>{preview.results.filter(r=>!r.ok).slice(0,20).map(r=><li key={r.id}>{r.name}: {r.error}</li>)}</ul>}</div>:<p className="muted">{dirty?'Đang kiểm tra các thay đổi…':'Chưa có nội dung thay đổi.'}</p>}
    </div><div className="modal-actions"><Button disabled={busy} onClick={onClose}>Hủy</Button><Button variant="primary" busy={busy} disabled={!preview?.changed} onClick={submit}>Lưu thay đổi cho {preview?.changed || 0} bài</Button></div>
  </Modal>;
}
