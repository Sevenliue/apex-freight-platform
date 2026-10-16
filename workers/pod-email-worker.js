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
// DEPENDENCY
//   postal-mime parses the raw MIME message. The Cloudflare dashboard
//   Quick Edit resolves this npm import automatically; with wrangler,
//   run `npm i postal-mime` in the Worker project instead.

import PostalMime from 'postal-mime';

// ShipRate rejects POD photos over ~9MB of base64 (~6-7MB of photo).
const MAX_BASE64_CHARS = 9000000;

function toBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export default {
  async email(message, env, ctx) {
    try {
      const subject = message.headers.get('subject') || '';
      const from = typeof message.from === 'string' ? message.from : String(message.from || '');

      // Parse the raw MIME message to reach the attachments.
      const raw = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(raw);
      const attachments = Array.isArray(parsed.attachments) ? parsed.attachments : [];
      const photo = attachments.find(
        (a) => a && typeof a.mimeType === 'string' && a.mimeType.startsWith('image/') && a.content && a.content.length > 1024,
      );
      if (!photo) {
        console.log(`[pod] no image attachment in mail from ${from} (subject: ${subject}) — ignored`);
        return;
      }

      const mimeType = photo.mimeType || 'image/jpeg';
      const imageData = `data:${mimeType};base64,${toBase64(new Uint8Array(photo.content))}`;
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
