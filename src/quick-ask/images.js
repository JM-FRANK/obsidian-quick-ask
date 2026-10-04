// Image bytes are transient request data. Only Vault paths belong in JSONL.
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_TOTAL_BYTES = 200 * 1024 * 1024;
const IMAGE_MAX_COUNT = 20;
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function imageError(code, path = '') {
  return Object.assign(new Error(`${code}${path ? `: ${path}` : ''}`), { code, path });
}

function imageMime(path) {
  return typeof path === 'string' ? MIME[path.split('.').at(-1).toLowerCase()] ?? null : null;
}

function imagePaths(paths = []) {
  return [...new Set(paths)].map(path => {
    if (typeof path !== 'string' || !path || /[\\\r\n\0]/.test(path) || path.startsWith('/')
      || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) throw imageError('IMAGE_PATH', path);
    if (!imageMime(path)) throw imageError('IMAGE_FORMAT', path);
    return path;
  });
}

function validateImageBatch(files) {
  if (files.length > IMAGE_MAX_COUNT) throw imageError('IMAGE_COUNT');
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size <= 0) throw imageError('IMAGE_MISSING', file.path);
    if (file.size > IMAGE_MAX_BYTES) throw imageError('IMAGE_SIZE', file.path);
    total += file.size;
  }
  if (total > IMAGE_TOTAL_BYTES) throw imageError('IMAGE_TOTAL');
}

function byteView(bytes) {
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (Object.prototype.toString.call(bytes) === "[object ArrayBuffer]") return new Uint8Array(bytes);
  throw imageError('IMAGE_MISSING');
}

function validateImage(bytes, path) {
  const data = byteView(bytes);
  const mime = imageMime(path);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const matches = mime === 'image/png' ? png.every((value, index) => data[index] === value)
    : mime === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : mime === 'image/webp' ? [82, 73, 70, 70].every((value, index) => data[index] === value)
        && [87, 69, 66, 80].every((value, index) => data[index + 8] === value) : false;
  if (!matches) throw imageError('IMAGE_FORMAT', path);
  validateImageBatch([{ path, size: data.byteLength }]);
  return data;
}

// No Node/DOM dependency and no spread of an entire image onto the call stack.
function base64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const chunks = [];
  let chunk = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index], b = bytes[index + 1], c = bytes[index + 2];
    chunk += alphabet[a >> 2] + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]
      + (index + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)] : '=')
      + (index + 2 < bytes.length ? alphabet[c & 63] : '=');
    if (chunk.length >= 16384) { chunks.push(chunk); chunk = ''; }
  }
  chunks.push(chunk);
  return chunks.join('');
}

async function prepareImages(paths, source) {
  const references = imagePaths(paths);
  if (!references.length) return [];
  if (!source?.stat || !source?.readBinary) throw imageError('IMAGE_MISSING', references[0]);
  const files = [];
  for (const path of references) {
    let stat;
    try { stat = await source.stat(path); } catch { /* Missing/read failure is one user-facing condition. */ }
    if (!stat) throw imageError('IMAGE_MISSING', path);
    files.push({ path, size: stat.size });
  }
  validateImageBatch(files);
  const images = [];
  let actualTotal = 0;
  for (const file of files) {
    let bytes;
    try { bytes = await source.readBinary(file.path); } catch { throw imageError('IMAGE_MISSING', file.path); }
    const data = validateImage(bytes, file.path);
    actualTotal += data.byteLength;
    if (actualTotal > IMAGE_TOTAL_BYTES) throw imageError('IMAGE_TOTAL');
    images.push({ path: file.path, size: data.byteLength, url: `data:${imageMime(file.path)};base64,${source.encodeBase64 ? source.encodeBase64(data) : base64(data)}` });
  }
  // Recheck actual bytes in case a source changed between stat and read.
  validateImageBatch(images);
  return images;
}

function createImageCache({ adapter, directory, id = () => globalThis.crypto.randomUUID() }) {
  return {
    async add({ name, bytes }) {
      const data = validateImage(bytes, name);
      const extension = imageMime(name) === 'image/jpeg' ? 'jpg' : name.split('.').at(-1).toLowerCase();
      let folder = '';
      for (const part of directory.split('/')) {
        folder = folder ? `${folder}/${part}` : part;
        try { await adapter.mkdir(folder); } catch (error) { if (!await adapter.exists(folder)) throw error; }
      }
      const path = `${directory}/${id()}.${extension}`;
      await adapter.writeBinary(path, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
      return path;
    },
    async clear() {
      let listed;
      try { listed = await adapter.list(directory); } catch { return; }
      for (const path of listed.files ?? []) {
        // Only immediate owned cache files, even with a surprising adapter result.
        if (path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes('/') && imageMime(path)) await adapter.remove(path);
      }
    },
  };
}

// Store the promise, not just a marker: a replacement plugin runtime must
// await the same cleanup before creating or reading images.
function initializeImageCache(sessions, app, directory, initialize) {
  let directories = sessions.get(app);
  if (!directories) { directories = new Map(); sessions.set(app, directories); }
  if (!directories.has(directory)) directories.set(directory, Promise.resolve().then(initialize));
  return directories.get(directory);
}

module.exports = { imageMime, imagePaths, imageError, validateImageBatch, prepareImages, createImageCache, initializeImageCache, IMAGE_MAX_BYTES, IMAGE_TOTAL_BYTES, IMAGE_MAX_COUNT };
