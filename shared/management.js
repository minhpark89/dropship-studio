export const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
export const lifecycleLabels = { active:'Đang dùng', review:'Chờ xử lý', archived:'Lưu trữ', deleted:'Thùng rác' };
export const healthLabels = { usable:'Truy cập tốt', published:'Đã đăng được', identity:'Cần xác minh danh tính', restricted:'Bị hạn chế', unpublished:'Không công khai', token:'Thiếu / lỗi token', unchecked:'Chưa kiểm tra' };
export const postLabels = { warehouse:'Đã trả về kho', draft:'Bản nháp', ready:'Sẵn sàng', scheduled:'Đã hẹn giờ', publishing:'Đang đăng', error:'Cần xử lý', comment_error:'Lỗi bình luận', published:'Lịch sử đã đăng', incomplete:'Thiếu nội dung', archived:'Lưu trữ', deleted:'Thùng rác' };

export function pageHealth(page) {
  const health = page.publishingHealth || {};
  if (health.blocked && health.details?.subcode === 4854002) return 'identity';
  if (health.blocked) return 'restricted';
  if (page.isPublished === false) return 'unpublished';
  if (!page.hasUsableToken || page.verification?.status === 'error') return 'token';
  if (health.lastSucceededAt) return 'published';
  return page.verification?.status === 'passed' ? 'usable' : 'unchecked';
}

export function managedPageUnavailable(page, local) {
  return Boolean(local?.archived || ['review','archived','deleted'].includes(page?.management?.status || local?.management?.status) || page?.publishingHealth?.blocked || page?.isPublished === false);
}

export function postStage(post) {
  if (post.automationStatus === 'publishing') return 'publishing';
  if (post.deletedAt) return 'deleted';
  if (post.archivedAt) return 'archived';
  if (post.status === 'published_comment_error' || post.firstCommentStatus === 'error' || post.publication?.firstCommentStatus === 'error') return 'comment_error';
  if (post.isPublication || post.status === 'published') return 'published';
  if (post.warehouse?.returnedAt) return 'warehouse';
  if (post.automationRetryBlocked || post.automationError) return 'error';
  if (post.status === 'scheduled') return 'scheduled';
  if (!post.mediaIds?.length || !post.caption?.trim() || !post.firstComment?.trim() || post.contentType === 'news' && !post.articleBody?.trim()) return 'incomplete';
  return post.status === 'ready' ? 'ready' : 'draft';
}

// CSV with quoted commas, escaped quotes and embedded newlines; also accepts TSV.
function csvRows(text) {
  const first = text.split(/\r?\n/,1)[0];
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (ch === '"') { if (quoted && text[i+1] === '"') {cell+='"';i++;} else quoted=!quoted; }
    else if (ch === delimiter && !quoted) {row.push(cell.trim());cell='';}
    else if (ch === '\n' && !quoted) {row.push(cell.trim());if(row.some(Boolean))rows.push(row);row=[];cell='';}
    else if (ch !== '\r' || quoted) cell+=ch;
  }
  if (quoted) throw new Error('CSV có dấu ngoặc kép chưa đóng.');
  row.push(cell.trim());if(row.some(Boolean))rows.push(row);
  return rows;
}

export function parsePageImport(input) {
  const text=String(input || '').replace(/^\uFEFF/,'').trim();
  if (!text) return { rows:[], errors:[], duplicates:0 };
  if (text.length > 2_000_000) throw new Error('Tệp quá lớn; chia thành các tệp dưới 2 MB.');
  let raw;
  if (text.startsWith('[') || text.startsWith('{')) {
    const json=JSON.parse(text);raw=Array.isArray(json)?json:json.pages;
    if (!Array.isArray(raw)) throw new Error('JSON cần là danh sách Page hoặc {"pages": [...]}.');
  } else {
    const rows=csvRows(text);
    const header=rows[0]?.map(fold);
    const hasHeader=header?.some(h=>['id','page id','page_id','pageid','externalid'].includes(h));
    raw=(hasHeader?rows.slice(1):rows).map(cols=>{
      if(!hasHeader)return {id:cols[0],name:cols[1],url:cols[2],source:cols[3]};
      const field=(names)=>cols[header.findIndex(h=>names.includes(h))];
      return {id:field(['id','page id','page_id','pageid','externalid']),name:field(['name','ten','ten page','page name']),url:field(['url','link']),source:field(['source','nguon'])};
    });
  }
  if(raw.length>5000)throw new Error('Mỗi lần nhập tối đa 5.000 Page.');
  const rows=[],errors=[],seen=new Set();let duplicates=0;
  raw.forEach((value,index)=>{
    const item=typeof value==='string'?{id:value}:value || {};
    let id=String(item.id || item.pageId || item.externalId || '').trim();
    if(/^https?:\/\//.test(id)) {
      try {const url=new URL(id);if(!['facebook.com','www.facebook.com','m.facebook.com'].includes(url.hostname))throw new Error();id=url.searchParams.get('id') || url.pathname.split('/').filter(Boolean).at(-1) || '';} catch {id='';}
    }
    if(!/^\d{1,40}$/.test(id)){errors.push({line:index+1,error:'Cần Page ID dạng số hoặc URL Facebook chứa ID.'});return;}
    if(seen.has(id)){duplicates++;return;}seen.add(id);
    rows.push({id,name:String(item.name || item.pageName || id).trim().slice(0,200),url:`https://www.facebook.com/${id}`,source:String(item.source || '').trim().slice(0,120)});
  });
  return {rows,errors,duplicates};
}

export function csvText(rows) {
  const quote=value=>{let s=String(value ?? '');if(/^[=+@\-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};
  return '\uFEFF'+rows.map(row=>row.map(quote).join(',')).join('\r\n');
}
