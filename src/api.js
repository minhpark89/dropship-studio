export async function api(url, body, method = 'POST') {
  const response = await fetch(`/api${url}`, body === undefined ? undefined : {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Yêu cầu thất bại.');
    error.code = data.code;
    throw error;
  }
  return data;
}

export async function uploadFiles(files, projectId) {
  const form = new FormData();
  form.append('projectId', projectId);
  for (const file of files) form.append('files', file);
  const response = await fetch('/api/media/upload', { method: 'POST', body: form });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Tải tệp thất bại.');
  const errors = data.results.filter((item) => !item.ok);
  if (errors.length) throw new Error(errors.map((item) => `${item.name}: ${item.error}`).join('\n'));
  return data.results;
}

export const timecode = (seconds = 0) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`;
export const bytes = (value) => value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export const uid = () => crypto.randomUUID();
export const clipFrom = (media) => ({ id: uid(), mediaId: media.id, inSec: 0, outSec: media.duration, speed: 1, zoom: 1, fit: 'cover', volume: 1 });
