/**
 * 图片抓取：只能在 Service Worker 里做（设计文档 §5.2）。
 * 内容脚本 fetch 跨域图片会被页面 CORS 拦截；
 * SW 持有 host_permissions，fetch 不受 CORS 限制。
 */

/** 单张图片的大小上限：超过就放弃（大图 base64 后会让请求体膨胀到超时/被拒） */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** 从文件头魔数猜图片类型（服务器给 octet-stream 时兜底） */
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  return null;
}

export async function fetchImageAsDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > MAX_IMAGE_BYTES) return null; // 跳过大图，避免拖垮整次请求
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);

    // btoa 只接受 latin1 字符串，分块拼接避免栈溢出
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const type =
      blob.type && blob.type.startsWith('image/')
        ? blob.type
        : (sniffImageType(bytes) ?? 'image/jpeg');
    return `data:${type};base64,${btoa(bin)}`;
  } catch {
    return null; // 单张图失败不阻塞整题，只是少了这张图
  }
}

export async function fetchImagesAsDataUrls(
  urls: string[],
): Promise<{ url: string; dataUrl: string }[]> {
  const results = await Promise.all(
    urls.map(async (url) => ({ url, dataUrl: await fetchImageAsDataUrl(url) })),
  );
  return results.filter((r): r is { url: string; dataUrl: string } => r.dataUrl !== null);
}
