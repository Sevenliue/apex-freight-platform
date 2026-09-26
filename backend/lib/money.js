// lib/money.js — small CAD money helpers.
'use strict';

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Retail (sell) price from a carrier buy cost and a markup percent.
function applyMarkup(costCad, markupPercent) {
  return round2(Number(costCad) * (1 + Number(markupPercent) / 100));
}

module.exports = { round2, applyMarkup };
