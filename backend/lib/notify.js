// Notification hooks: order created/paid, DG review, tendered, cancelled.
// Best-effort — a notification failure must never break the request.
//
// Provider is chosen by env:
//   NOTIFY_PROVIDER=resend   -> RESEND_API_KEY and NOTIFY_FROM required
//   NOTIFY_PROVIDER=webhook  -> POSTs JSON {to, subject, text, event} to NOTIFY_WEBHOOK_URL
//   unset/other              -> logs to console (no email sent)
//
// NOTIFY_ADMIN_EMAIL sets the admin recipient; otherwise the first address in
// ADMIN_EMAILS is used.

function provider() {
  return String(process.env.NOTIFY_PROVIDER || 'log').toLowerCase();
}

function adminEmail() {
  if (process.env.NOTIFY_ADMIN_EMAIL) return process.env.NOTIFY_ADMIN_EMAIL;
  const list = String(process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list[0] || null;
}

async function sendEmail({ to, subject, text, html, event, attachments }) {
  if (!to) return { skipped: 'no recipient' };
  const p = provider();
  const attachList = Array.isArray(attachments) ? attachments.filter((a) => a && a.filename && a.content) : [];
  try {
    if (p === 'resend') {
      const key = process.env.RESEND_API_KEY;
      const from = process.env.NOTIFY_FROM;
      if (!key || !from) return { skipped: 'resend not configured' };
      const body = { from, to, subject, text };
      if (html) body.html = html;
      if (attachList.length) {
        // Resend attachments: [{filename, content (base64 string), content_type?}]
        body.attachments = attachList.map((a) => ({
          filename: a.filename,
          content: a.content,
          ...(a.contentType ? { content_type: a.contentType } : {}),
        }));
      }
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`resend ${r.status}`);
      return { sent: true, provider: 'resend' };
    }
    if (p === 'webhook') {
      const url = process.env.NOTIFY_WEBHOOK_URL;
      if (!url) return { skipped: 'webhook not configured' };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, text, html: html || undefined, event }),
      });
      if (!r.ok) throw new Error(`webhook ${r.status}`);
      return { sent: true, provider: 'webhook' };
    }
  } catch (err) {
    console.error('[notify] send failed:', err.message);
    return { failed: err.message };
  }
  console.log(`[notify:${event || 'email'}] to=${to} subject=${subject}${attachList.length ? ` attachments=${attachList.length}` : ''}`);
  return { logged: true };
}

function routeOf(order) {
  const b = (order && order.bol) || {};
  const city = (p) => [p && p.city, p && (p.province || p.state)].filter(Boolean).join(', ');
  return `${city(b.shipper) || '?'} → ${city(b.consignee) || '?'}`;
}

function money(n) {
  return n == null ? '' : '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// notify(event, order, opts): fire-and-forget wrapper, never throws.
async function notify(event, order, opts = {}) {
  try {
    const customer = opts.customerEmail || (order ? (((order.bol || {}).shipper || {}).email || null) : null);
    const admin = adminEmail();
    const route = order ? routeOf(order) : '';
    const ref = order && order.shipper_order_no ? ` (your order #${order.shipper_order_no})` : '';
    const testPrefix = (order && order.test_mode) || opts.testMode ? '[TEST] ' : '';
    switch (event) {
      case 'order_created':
        await sendEmail({
          to: customer, event, subject: testPrefix + `Shipment received — ${route}`,
          text: `Thanks — we received your shipment request${ref} for ${route}.\nCarrier: ${order.carrier || '—'}\nAmount: ${money(order.charged_amount)} CAD\nRequested pickup: ${((order.bol || {}).pickup_date) || '—'}\nWe will confirm scheduling shortly.`,
        });
        break;
      case 'dg_review':
        await sendEmail({
          to: customer, event, subject: testPrefix + `Dangerous goods review — ${route}`,
          text: `Your shipment${ref} for ${route} contains dangerous goods and is under review.\nNo payment has been collected. We will confirm whether a carrier accepts the load and then release it for payment.`,
        });
        await sendEmail({
          to: admin, event, subject: testPrefix + `DG review needed — ${route}`,
          text: `A dangerous-goods shipment is waiting in the DG review queue.\nRoute: ${route}\nCarrier: ${order.carrier || '—'}\nAmount: ${money(order.charged_amount)} CAD\nApprove or reject it in Admin → Dangerous goods review.`,
        });
        break;
      case 'payment_succeeded':
        await sendEmail({
          to: customer, event, subject: testPrefix + `Payment received — load scheduled (${route})`,
          text: `Payment of ${money(order.charged_amount)} CAD received — your load${ref} is scheduled.\nRoute: ${route}\nCarrier: ${order.carrier || '—'}\nPRO / tracking: ${order.tracking_code || '—'}\nRequested pickup: ${((order.bol || {}).pickup_date) || '—'}`,
        });
        break;
      case 'tendered':
        await sendEmail({
          to: customer, event, subject: testPrefix + `Your load is booked — ${route}`,
          text: `Your load${ref} is now booked with the carrier.\nCarrier: ${order.carrier || '—'}\nCarrier PRO: ${order.carrier_pro || '—'}\nRequested pickup: ${((order.bol || {}).pickup_date) || '—'}`,
        });
        break;
      case 'cancelled':
        await sendEmail({
          to: customer, event, subject: testPrefix + `Shipment cancelled — ${route}`,
          text: `Your shipment${ref} for ${route} has been cancelled.${opts.refunded ? '\nYour payment has been refunded.' : ''}`,
        });
        break;
      case 'new_signup': {
        const u = opts.user || {};
        await sendEmail({
          to: admin, event, subject: `New account registered — ${u.name || u.email || 'unknown'}`,
          text: `A new account just registered and is waiting for shipping approval.\nName: ${u.name || '—'}\nCompany: ${u.company || '—'}\nEmail: ${u.email || '—'}\n\nThey can get quotes now. Approve them in Admin → Account approvals to let them schedule shipments.`,
        });
        break;
      }
      case 'full_load_request': {
        const r = opts.request || {};
        const eq = { dry_van: 'Dry van', reefer: 'Reefer', flatbed: 'Flatbed', other: 'Other' }[r.equipment] || r.equipment || '—';
        await sendEmail({
          to: admin, event, subject: `Full-load pricing request — ${r.origin_city || '?'} → ${r.dest_city || '?'}`,
          text: `A customer requested custom full-load pricing.\nRoute: ${r.origin_city || '?'}, ${r.origin_province || ''} → ${r.dest_city || '?'}, ${r.dest_province || ''}\nEquipment: ${eq}\nWeight: ${r.weight_lb || '—'} lb\nPieces: ${r.pieces || '—'}\nPickup: ${r.pickup_date || '—'}\nCommodity: ${r.commodity || '—'}\nCustomer: ${r.user_email || '—'}${opts.ftl_hint ? `\n\n${opts.ftl_hint}` : ''}\n\nFollow up with a price directly.`,
        });
        break;
      }
      case 'shipping_approved': {
        const u = opts.user || {};
        await sendEmail({
          to: u.email || customer, event, subject: 'Your ShipRate account is approved',
          text: `Good news — your ShipRate account has been approved.`,
        });
        break;
      }
      case 'pickup_requested': {
        const p = opts.pickup || {};
        await sendEmail({
          to: admin, event, subject: testPrefix + `Pickup requested — ${p.pickup_date || '?'} (${p.time_window || '?'})`,
          text: `A customer booked a carrier pickup.\nOrder: ${p.order_ref || '—'}\nRoute: ${p.route || '—'}\nPickup date: ${p.pickup_date || '—'}\nTime window: ${p.time_window || '—'}\nContact: ${p.contact_name || '—'} ${p.contact_phone || ''}\nNotes: ${p.notes || '—'}\nCustomer: ${p.user_email || '—'}\n\nConfirm it with the carrier, then update the status in Admin → Pickup requests.`,
        });
        break;
      }
      case 'carrier_upload_received': {
        const up = opts.upload || {};
        const ins = up.insurer_name
          ? `\nInsurance: ${up.insurer_name}${up.policy_number ? ' · policy ' + up.policy_number : ''}${up.cargo_limit_cad != null ? ' · limit $' + up.cargo_limit_cad : ''}${up.policy_expiry ? ' · expires ' + up.policy_expiry : ''}`
          : '\nInsurance: not provided';
        await sendEmail({
          to: admin, event, subject: `New carrier rate upload — ${up.carrier_name || '?'}`,
          text: `A carrier uploaded a rate sheet for review.\nCarrier: ${up.carrier_name || '—'}\nContact: ${up.contact_email || '—'}\nLanes: ${up.lane_count || '—'}${ins}\nUpload ID: ${up.id || '—'}\n\nReview it in Admin → Carrier uploads. Nothing goes live until you approve it.`,
        });
        break;
      }
      case 'shipper_rate_uploaded': {
        const up = opts.upload || {};
        await sendEmail({
          to: admin, event, subject: `New shipper rate upload — ${up.carrier_name || '?'}`,
          text: `A shipper uploaded their own carrier rate sheet for review.\nShipper: ${up.user_name || '—'} (${up.user_email || '—'})\nCompany: ${up.company || '—'}\nCarrier: ${up.carrier_name || '—'}\nFile: ${up.file_name || '—'}\nUpload ID: ${up.id || '—'}\n\nReview it under My Rates while signed in as admin. The sheet stays private to the shipper's account and never enters the shared rate panel until you load it.`,
        });
        break;
      }
      case 'carrier_requested': {
        const r = opts.request || {};
        await sendEmail({
          to: admin, event, subject: `Carrier requested — ${r.carrier_name || '?'} (${r.origin_city || '?'} → ${r.dest_city || '?'})`,
          text: `A shipper asked for a carrier or lane ShipRate doesn't cover yet.\nCarrier / lane wanted: ${r.carrier_name || '—'}\nRoute: ${r.origin_city || '?'} → ${r.dest_city || '?'}\nShipper: ${r.name || '—'} (${r.email || '—'})\nNotes: ${r.notes || '—'}\n\nFollow up by loading the carrier or lane.`,
        });
        break;
      }
      case 'rate_requested': {
        const r = opts.request || {};
        await sendEmail({
          to: admin, event, subject: `Rate requested — ${r.carrier_name || '?'} (${r.origin_city || '?'} → ${r.dest_city || '?'})`,
          text: `A shipper asked for a rate from a carrier that may serve this lane (shown in the "May also serve this lane" section — no priced rate on file).\nCarrier: ${r.carrier_name || '—'} (${r.carrier_id || '—'})\nRoute: ${r.origin_city || '?'} → ${r.dest_city || '?'}\nShipper: ${r.email || '—'}\nRequested at: ${r.at || '—'}\n\nFollow up with the carrier for a rate on this lane.`,
        });
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error('[notify] hook failed (non-fatal):', err.message);
  }
}

module.exports = { notify, sendEmail, adminEmail };
