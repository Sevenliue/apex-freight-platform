// Cloudflare Email Worker — pod@shiprate.ca → ShipRate POD filing.
//
// WHAT IT DOES
//   Email Routing sends every mail to pod@shiprate.ca to this Worker.
//   The Worker pulls the first image attachment out of the email and POSTs
//   it to ShipRate's /api/waybills/pod-ingest endpoint, which matches the
//   WB number in the subject line to a saved waybill and files the photo
//   as that waybill's proof of delivery (POD). Unmatched photos go to the
//   unmatched queue in ShipRate and the sender gets an auto-reply.
//
// WHAT IT DOES NOT DO
//   - It never touches admin@ / info@ — those keep their existing
//     Email Routing rules (forward to Gmail).
//   - It never reads the WB number off the photo (no OCR). The number
//     must be in the subject line, e.g. "WB-000123".
//   - Mail with no image attachment is ignored (nothing to file).
//
// SETUP (see the POD setup doc in the ShipRate goal files for full steps)
//   1. Create a Worker in Cloudflare and paste this file in.
//   2. Worker Settings → Variables:
//        SHIPRATE_URL      = https://shiprate.ca
//        POD_INGEST_SECRET = the same secret set as POD_INGEST_SECRET in
//                            Render (generate with `openssl rand -hex 32`;
//                            never paste it in chat).
//   3. Email Routing → Routing rules: pod@shiprate.ca → Send to Worker →
//      this Worker.
//
// DEPENDENCIES: none. Plain Worker script — paste it straight into the
//   Cloudflare dashboard editor. No npm install, no wrangler needed.
//   (An earlier version imported `postal-mime`; the dashboard editor does
//   not bundle bare npm imports, so deploys from the editor failed. This
//   version parses MIME inline instead.)

// ShipRate rejects POD photos over ~9MB of base64 (~6-7MB of photo).
const MAX_BASE64_CHARS = 9000000;

// --- Minimal MIME parsing (no dependencies) ---

// Convert bytes to a string with a 1:1 byte -> char mapping, so header /
// boundary parsing works on the raw message without corrupting data.
function bytesToLatin1(bytes) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return s;
}

function latin1ToBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Split a MIME entity into { headers, body }. Headers are unfolded and
// returned as a Map of lowercase name -> value.
function splitEntity(text) {
  let idx = text.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (idx === -1) {
    idx = text.indexOf('\n\n');
    sepLen = 2;
  }
  let head = '';
  let body = text;
  if (idx !== -1) {
    head = text.slice(0, idx);
    body = text.slice(idx + sepLen);
  }
  const headers = new Map();
  let current = null;
  for (const rawLine of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && current) {
      headers.set(current, headers.get(current) + ' ' + rawLine.trim());
      continue;
    }
    const m = rawLine.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      headers.set(current, m[2].trim());
    }
  }
  return { headers, body };
}

// Parse `type/subtype; param=value; param="quoted"` into { value, params }.
function parseHeaderValue(v) {
  const parts = String(v || '').split(';');
  const value = (parts.shift() || '').trim().toLowerCase();
  const params = {};
  for (const p of parts) {
    const m = p.trim().match(/^([^=]+)=\s*(?:"([^"]*)"|([^;]*))\s*$/);
    if (m) params[m[1].trim().toLowerCase()] = (m[2] !== undefined ? m[2] : m[3] || '').trim();
  }
  return { value, params };
}

function filenameOf(headers) {
  const disp = parseHeaderValue(headers.get('content-disposition') || '');
  if (disp.params.filename) return disp.params.filename;
  const ct = parseHeaderValue(headers.get('content-type') || '');
  if (ct.params.name) return ct.params.name;
  return '';
}

// Decode one body per its Content-Transfer-Encoding.
function decodeBody(body, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (enc === 'base64') {
    const clean = body.replace(/[^A-Za-z0-9+/=]/g, '');
    return latin1ToBytes(atob(clean));
  }
  if (enc === 'quoted-printable') {
    const unfolded = body.replace(/=\r?\n/g, '');
    let out = '';
    for (let i = 0; i < unfolded.length; i++) {
      const ch = unfolded[i];
      if (ch === '=' && i + 2 < unfolded.length) {
        const hex = unfolded.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out += ch;
    }
    return latin1ToBytes(out);
  }
  // 7bit / 8bit / binary / unknown: raw bytes.
  return latin1ToBytes(body);
}

// Split a multipart body on `--boundary` delimiters. Returns the part
// texts (preamble and epilogue dropped).
function splitMultipart(body, boundary) {
  const norm = body.replace(/\r\n/g, '\n');
  const delim = '--' + boundary;
  const segments = norm.split(delim);
  const out = [];
  // segments[0] is the preamble, the last segment is the epilogue
  // (starts with '--' after the closing delimiter) — both ignored.
  for (let i = 1; i < segments.length - 1; i++) {
    let seg = segments[i];
    if (seg.startsWith('\n')) seg = seg.slice(1);
    if (seg.endsWith('\n')) seg = seg.slice(0, -1);
    if (seg.trim() !== '') out.push(seg);
  }
  return out;
}

// Walk a MIME entity tree; return the first image part with real content
// ({ mimeType, filename, content }) or null.
function findImage(entity) {
  const ct = parseHeaderValue(entity.headers.get('content-type') || 'text/plain');
  if (ct.value.startsWith('multipart/')) {
    const boundary = ct.params.boundary;
    if (!boundary) return null;
    for (const part of splitMultipart(entity.body, boundary)) {
      const found = findImage(splitEntity(part));
      if (found) return found;
    }
    return null;
  }
  if (ct.value.startsWith('image/')) {
    const content = decodeBody(entity.body, entity.headers.get('content-transfer-encoding') || '');
    if (content && content.length > 1024) {
      return { mimeType: ct.value, filename: filenameOf(entity.headers), content };
    }
  }
  return null;
}

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export default {
  // A fetch handler is included so the Worker also deploys/previews from
  // the Cloudflare dashboard editor (Email Routing ignores it).
  async fetch() {
    return new Response('pod-email worker running');
  },

  async email(message, env, ctx) {
    try {
      const subject = message.headers.get('subject') || '';
      const from = typeof message.from === 'string' ? message.from : String(message.from || '');

      // Parse the raw MIME message to reach the attachments.
      const raw = await new Response(message.raw).arrayBuffer();
      const photo = findImage(splitEntity(bytesToLatin1(new Uint8Array(raw))));
      if (!photo) {
        console.log(`[pod] no image attachment in mail from ${from} (subject: ${subject}) — ignored`);
        return;
      }

      const mimeType = photo.mimeType || 'image/jpeg';
      const imageData = `data:${mimeType};base64,${toBase64(photo.content)}`;
      if (imageData.length > MAX_BASE64_CHARS) {
        console.log(`[pod] photo too large (${imageData.length} chars) from ${from} — ignored`);
        return;
      }

      const res = await fetch(`${env.SHIPRATE_URL}/api/waybills/pod-ingest`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pod-secret': env.POD_INGEST_SECRET,
        },
        body: JSON.stringify({
          from,
          subject,
          filename: photo.filename || 'pod-photo',
          mime_type: mimeType,
          image_data: imageData,
        }),
      });
      if (!res.ok) {
        console.error(`[pod] ingest failed (${res.status}) for mail from ${from}: ${await res.text()}`);
      } else {
        console.log(`[pod] ingest ok for mail from ${from} (subject: ${subject})`);
      }
    } catch (err) {
      // Never bounce the email — log it so the failure shows in Worker logs.
      console.error(`[pod] worker error: ${err && err.message ? err.message : err}`);
    }
  },
};
