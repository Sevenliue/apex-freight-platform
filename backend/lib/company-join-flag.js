// lib/company-join-flag.js — company-join flag rules (pure, no DB).
//
// A new signup is flagged for company-admin confirmation when:
//   (a) their email domain is already tied to a DIFFERENT company, or
//   (b) they claim a company name that already exists but their email
//       domain was never seen under that company.
// Freemail domains NEVER count as company domains, so freemail signups
// are never flagged. A flagged account gets NO company_id until a company
// admin approves the pending request — individual quoting still works.
//
// flagReason({domain, claimedCompanyId, claimedMemberDomains,
//             domainCompanyMap}) returns:
//   null                   — not flagged
//   'domain_other_company' — trigger (a)
//   'domain_unseen'        — trigger (b)
// claimedMemberDomains: iterable of domains of the claimed company's
//   CURRENT members. domainCompanyMap: Map domain -> Set of company ids
//   the domain is tied to (current members only).
'use strict';

const FREEMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.ca', 'ymail.com',
  'hotmail.com', 'hotmail.ca', 'outlook.com', 'outlook.ca',
  'live.com', 'live.ca', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me',
  'aol.com',
  'gmx.com', 'gmx.ca',
  'zoho.com',
  'yandex.com',
  'mail.com',
]);

function emailDomain(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0 || at === e.length - 1) return '';
  const domain = e.slice(at + 1);
  if (!domain || domain.indexOf('.') === -1 || /\s/.test(domain)) return '';
  return domain;
}

function isFreemailDomain(domain) {
  return FREEMAIL_DOMAINS.has(String(domain || '').trim().toLowerCase());
}

function flagReason(opts) {
  const o = opts || {};
  const domain = String(o.domain || '').trim().toLowerCase();
  if (!domain) return null;
  if (isFreemailDomain(domain)) return null;
  const claimedId = o.claimedCompanyId == null ? null : String(o.claimedCompanyId);
  if (!claimedId) return null;
  const claimedMembers = new Set(
    Array.from(o.claimedMemberDomains || []).map((d) => String(d).trim().toLowerCase())
  );
  if (claimedMembers.has(domain)) return null;
  const map = o.domainCompanyMap instanceof Map ? o.domainCompanyMap : new Map();
  const tied = map.get(domain);
  if (tied && tied.size) {
    const ids = Array.from(tied).map(String);
    if (!ids.includes(claimedId)) return 'domain_other_company';
    return null;
  }
  return 'domain_unseen';
}

module.exports = { FREEMAIL_DOMAINS, emailDomain, isFreemailDomain, flagReason };
