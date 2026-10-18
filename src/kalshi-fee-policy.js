'use strict';
// Human-reviewed source, separate from live series/event multipliers. Never auto-extend.
const REVIEW=Object.freeze({version:'kalshi-general-2026-07-07-reviewed-2026-10-05',source:'https://kalshi.com/docs/kalshi-fee-schedule.pdf',effectiveDate:'2026-07-07',reviewedAt:'2026-10-05T00:00:00Z',reviewBy:'2026-10-12T00:00:00Z',takerCoefficient:.07});
function assertCurrent(now){if(!Number.isFinite(now)||now>=Date.parse(REVIEW.reviewBy))throw Error('Revisar vigencia de fórmula base de tarifas');return REVIEW;}
function status(now=Date.now()){return {...REVIEW,valid:Number.isFinite(now)&&now<Date.parse(REVIEW.reviewBy),reviewDueSoon:now>=Date.parse(REVIEW.reviewBy)-86400000};}
module.exports={REVIEW,assertCurrent,status};
