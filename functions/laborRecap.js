// ── DAILY LABOR RECAP ─────────────────────────────────────────────────────────
// Builds the HTML for the 6am "labor recap" email. Pure reporting: it only READS
// timeLogs and receipts and never writes anything. Kept in its own module (db and Timestamp are
// passed in) so it can be exercised against a fake Firestore without deploying.
//
// Overtime rules mirror the payroll report in index.html (Colorado, Sun-Sat workweek):
//   per day:  first 8 h regular, 8-12 h overtime, over 12 h double-time
//   per week: regular hours over 40 convert to overtime
const TZ = "America/Denver";
const OT_WATCH_FROM = 32;      // list an employee as "approaching 40" once weekly regular hours reach this
const LONG_OPEN_HRS = 12;      // an open session this old is flagged as a likely missed clock-out

const partsFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit"
});
function tzParts(ms) {
  const o = {};
  partsFmt.formatToParts(new Date(ms)).forEach(p => { if (p.type !== "literal") o[p.type] = +p.value; });
  return o;
}
// "YYYY-MM-DD" of an instant, on the Denver calendar
function ymdOf(ms) {
  const p = tzParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function dowOf(ymd) { // 0 = Sunday
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function weekStartOf(ymd) { return addDaysYmd(ymd, -dowOf(ymd)); }
// The UTC instant at which Denver's wall clock reads `hour`:00 on `ymd` (DST-safe)
function wallToUtcMs(ymd, hour) {
  const [y, m, d] = ymd.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, hour, 0, 0);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const p = tzParts(guess);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess = guess - (asUtc - target);
  }
  return guess;
}
const fmtStamp = ms => new Date(ms).toLocaleString("en-US", {
  timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
});
const fmtClock = ms => new Date(ms).toLocaleString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtDay = ymd => {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric"
  });
};
const hrs = ms => ms / 3600000;
const money = n => (Number(n) || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });
const f2 = n => (Math.round(n * 100) / 100).toFixed(2);
const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Tue-Fri recaps cover the prior 24 hours; Monday's covers Friday 6am through Monday 6am.
function recapWindow(scheduledMs) {
  const endYmd = ymdOf(scheduledMs);
  const endMs = Math.min(wallToUtcMs(endYmd, 6), scheduledMs);
  const isMonday = dowOf(endYmd) === 1;
  const startYmd = addDaysYmd(endYmd, isMonday ? -3 : -1);
  return { startMs: wallToUtcMs(startYmd, 6), endMs, startYmd, endYmd, isMonday };
}

async function buildLaborRecap(db, Timestamp, scheduledMs) {
  const { startMs, endMs, startYmd, endYmd, isMonday } = recapWindow(scheduledMs);
  const ts = ms => Timestamp.fromDate(new Date(ms));
  const weekFloorMs = wallToUtcMs(weekStartOf(startYmd), 0);

  // Four reads. Every query filters on a single field, so no composite index is needed.
  const [weekSnap, activeSnap, editedSnap, receiptSnap] = await Promise.all([
    db.collection("timeLogs").where("clockIn", ">=", ts(weekFloorMs)).where("clockIn", "<", ts(endMs)).get(),
    db.collection("timeLogs").where("status", "==", "active").get(),
    db.collection("timeLogs").where("updatedAt", ">=", ts(startMs)).where("updatedAt", "<", ts(endMs)).get(),
    db.collection("receipts").where("submittedAt", ">=", ts(startMs)).where("submittedAt", "<", ts(endMs)).get()
  ]);
  const norm = d => {
    const e = d.data();
    return { id: d.id, ...e,
      inMs: e.clockIn && e.clockIn.toMillis ? e.clockIn.toMillis() : null,
      outMs: e.clockOut && e.clockOut.toMillis ? e.clockOut.toMillis() : null,
      editedMs: e.updatedAt && e.updatedAt.toMillis ? e.updatedAt.toMillis() : null };
  };
  const live = snap => snap.docs.map(norm).filter(e => e.archived !== true);
  const weekEntries = live(weekSnap);
  const active = live(activeSnap);
  const edited = live(editedSnap);
  const receipts = receiptSnap.docs.map(d => {
    const e = d.data();
    return { id: d.id, ...e, subMs: e.submittedAt && e.submittedAt.toMillis ? e.submittedAt.toMillis() : null };
  }).filter(e => e.archived !== true && e.subMs != null).sort((a, b) => a.subMs - b.subMs);

  const winEntries = weekEntries.filter(e => e.inMs >= startMs && e.inMs < endMs);
  const winDone = winEntries.filter(e => e.status === "complete" && e.durationMs > 0);
  const who = e => e.userName || e.userId || "Unknown";
  const proj = e => e.projectName || e.projectId || "(no project)";

  // ── Hours by employee / by project (completed entries that started in the window)
  const byEmp = {}, byProj = {};
  const dayKeys = [];
  for (let d = startYmd; d < endYmd; d = addDaysYmd(d, 1)) dayKeys.push(d);
  winDone.forEach(e => {
    const k = e.userId || who(e);
    const dk = ymdOf(e.inMs);
    const r = byEmp[k] || (byEmp[k] = { name: who(e), ms: 0, n: 0, first: e.inMs, last: e.outMs || e.inMs, byDay: {} });
    r.ms += e.durationMs; r.n++; r.byDay[dk] = (r.byDay[dk] || 0) + e.durationMs;
    r.first = Math.min(r.first, e.inMs); r.last = Math.max(r.last, e.outMs || e.inMs);
    const p = byProj[proj(e)] || (byProj[proj(e)] = { name: proj(e), ms: 0, people: new Set(), byDay: {} });
    p.ms += e.durationMs; p.people.add(k); p.byDay[dk] = (p.byDay[dk] || 0) + e.durationMs;
  });
  const empRows = Object.values(byEmp).sort((a, b) => b.ms - a.ms);
  const projRows = Object.values(byProj).sort((a, b) => b.ms - a.ms);
  const totalMs = empRows.reduce((s, r) => s + r.ms, 0);

  // ── Overtime watch: week-to-date for each workweek the window touches, for people who worked in it
  const workedInWindow = new Set(winDone.map(e => e.userId || who(e)));
  const otRows = [];
  const weeks = [];
  for (let w = weekStartOf(startYmd); w <= endYmd; w = addDaysYmd(w, 7)) weeks.push(w);
  weeks.forEach(wk => {
    const wkEnd = addDaysYmd(wk, 7);
    const perEmp = {};
    weekEntries.forEach(e => {
      if (e.status !== "complete" || !(e.durationMs > 0)) return;
      const y = ymdOf(e.inMs);
      if (y < wk || y >= wkEnd) return;
      const k = e.userId || who(e);
      if (!workedInWindow.has(k)) return;
      const emp = perEmp[k] || (perEmp[k] = { name: who(e), days: {} });
      emp.days[y] = (emp.days[y] || 0) + hrs(e.durationMs);
    });
    Object.values(perEmp).forEach(emp => {
      let reg = 0, ot = 0, dt = 0, worked = 0;
      Object.values(emp.days).forEach(h => {
        worked += h; reg += Math.min(h, 8); ot += h > 8 ? Math.min(h - 8, 4) : 0; dt += h > 12 ? h - 12 : 0;
      });
      const weeklyOt = reg > 40 ? reg - 40 : 0;
      const notes = [];
      if (weeklyOt > 0) notes.push(`over 40 regular hours: ${f2(weeklyOt)} h weekly overtime`);
      else if (reg >= OT_WATCH_FROM) notes.push(`approaching 40 (${f2(reg)} regular hours so far)`);
      if (ot > 0) notes.push(`${f2(ot)} h daily overtime`);
      if (dt > 0) notes.push(`${f2(dt)} h double-time`);
      if (notes.length) otRows.push({ name: emp.name, week: wk, worked, notes: notes.join("; ") });
    });
  });
  otRows.sort((a, b) => a.week.localeCompare(b.week) || a.name.localeCompare(b.name));

  // ── Exceptions
  const nowMs = endMs;
  const exc = [];
  active.forEach(e => {
    const h = hrs(nowMs - e.inMs);
    exc.push({ sev: h >= LONG_OPEN_HRS ? 0 : 1, text:
      `<b>${esc(who(e))}</b> is still clocked in on ${esc(proj(e))} (since ${esc(fmtStamp(e.inMs))}, ${f2(h)} h)` +
      (h >= LONG_OPEN_HRS ? " &mdash; <b>likely a missed clock-out</b>" : "") +
      ". Open sessions are not included in the hours above." });
  });
  winEntries.forEach(e => {
    if (e.clockInGeoStatus === "offsite" || e.clockOutGeoStatus === "offsite") {
      const side = e.clockInGeoStatus === "offsite" && e.clockOutGeoStatus === "offsite" ? "in and out"
        : e.clockInGeoStatus === "offsite" ? "in" : "out";
      exc.push({ sev: 2, text: `<b>${esc(who(e))}</b> clocked ${side} away from the job site on ${esc(proj(e))} (${esc(fmtStamp(e.inMs))}).` });
    }
    if (e.clockInGeoStatus === "manual") {
      exc.push({ sev: 3, text: `<b>${esc(who(e))}</b> has a manually entered time entry on ${esc(proj(e))} (${esc(fmtStamp(e.inMs))}, ${e.durationMs ? f2(hrs(e.durationMs)) + " h" : "open"})` + (e.loggedBy ? `, entered by ${esc(e.loggedBy)}` : "") + "." });
    }
    if (!e.projectId || !e.costCode) {
      exc.push({ sev: 3, text: `<b>${esc(who(e))}</b> has an entry with no ${!e.projectId ? "project" : "cost code"} (${esc(fmtStamp(e.inMs))}).` });
    }
  });
  edited.forEach(e => {
    exc.push({ sev: 3, text: `An entry for <b>${esc(who(e))}</b> on ${esc(proj(e))} (${esc(fmtStamp(e.inMs))}) was edited during this period.` });
  });
  exc.sort((a, b) => a.sev - b.sev);

  // ── Receipts and vendor invoices submitted in the window
  const isInvoice = e => e.billType === "bill";
  const rcpts = receipts.filter(e => !isInvoice(e));
  const invs = receipts.filter(isInvoice);
  const sum = arr => arr.reduce((s, e) => s + (parseFloat(e.amount) || 0), 0);
  const reimbNeeded = rcpts.filter(e => e.reimbursementNeeded === true);
  const reimbUnanswered = rcpts.filter(e => typeof e.reimbursementNeeded !== "boolean");

  // ── HTML
  const th = "text-align:left;padding:6px 10px;background:#4a7c59;color:#fff;font-size:12px";
  const td = "padding:6px 10px;border-bottom:1px solid #e3e3e3;font-size:13px";
  const tdr = td + ";text-align:right";
  const h2 = t => `<h3 style="margin:22px 0 6px;font-size:15px;color:#2f4f3a">${t}</h3>`;
  const table = (head, rows) => `<table style="border-collapse:collapse;width:100%;max-width:640px"><tr>${head}</tr>${rows}</table>`;
  const range = isMonday
    ? `${fmtDay(startYmd)} 6:00 AM &ndash; ${fmtDay(endYmd)} 6:00 AM (Friday through Sunday)`
    : `${fmtDay(startYmd)} 6:00 AM &ndash; ${fmtDay(endYmd)} 6:00 AM`;

  let body = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:680px">`;
  body += `<h2 style="margin:0 0 4px;color:#2f4f3a">MOTIF Labor Recap</h2>`;
  body += `<div style="color:#666;font-size:13px">${range}, Mountain Time</div>`;
  body += `<p style="font-size:14px;margin:14px 0 0">` + (winDone.length
    ? `<b>${f2(hrs(totalMs))} hours</b> across <b>${empRows.length}</b> ${empRows.length === 1 ? "person" : "people"} and <b>${projRows.length}</b> ${projRows.length === 1 ? "project" : "projects"}.`
    : `No completed labor was logged in this period.`) + `</p>`;
  body += `<p style="font-size:14px;margin:6px 0 0">` + (receipts.length
    ? `<b>${rcpts.length}</b> ${rcpts.length === 1 ? "receipt" : "receipts"} (${money(sum(rcpts))}) and <b>${invs.length}</b> vendor ${invs.length === 1 ? "invoice" : "invoices"} (${money(sum(invs))}) entered.`
    : `No receipts or vendor invoices were entered in this period.`) + `</p>`;

  const dayHead = dayKeys.map(d => `<th style="${th};text-align:right">${esc(fmtDay(d))}</th>`).join("");
  const dayCells = byDay => dayKeys.map(d => `<td style="${tdr}">${byDay[d] ? f2(hrs(byDay[d])) : "&ndash;"}</td>`).join("");
  const dayTotals = rows => dayKeys.map(d => { const m = rows.reduce((s, r) => s + (r.byDay[d] || 0), 0); return `<td style="${tdr};font-weight:bold">${m ? f2(hrs(m)) : "&ndash;"}</td>`; }).join("");
  body += h2(isMonday ? "Hours by employee, by day" : "Hours by employee");
  if (!empRows.length) body += `<div style="font-size:13px;color:#666">None.</div>`;
  else if (isMonday) body += table(
    `<th style="${th}">Employee</th>${dayHead}<th style="${th};text-align:right">Total</th>`,
    empRows.map(r => `<tr><td style="${td};white-space:nowrap">${esc(r.name)}</td>${dayCells(r.byDay)}<td style="${tdr};font-weight:bold">${f2(hrs(r.ms))}</td></tr>`).join("") +
    `<tr><td style="${td};font-weight:bold">All employees</td>${dayTotals(empRows)}<td style="${tdr};font-weight:bold">${f2(hrs(totalMs))}</td></tr>`
  );
  else body += table(
    `<th style="${th}">Employee</th><th style="${th};text-align:right">Hours</th><th style="${th}">First in &ndash; last out</th>`,
    empRows.map(r => `<tr><td style="${td}">${esc(r.name)}</td><td style="${tdr}">${f2(hrs(r.ms))}</td><td style="${td}">${esc(fmtClock(r.first))} &ndash; ${esc(fmtClock(r.last))}</td></tr>`).join("")
  );

  body += h2(isMonday ? "Hours by job / project, by day" : "Hours by job / project");
  if (!projRows.length) body += `<div style="font-size:13px;color:#666">None.</div>`;
  else if (isMonday) body += table(
    `<th style="${th}">Project</th>${dayHead}<th style="${th};text-align:right">Total</th>`,
    projRows.map(r => `<tr><td style="${td}">${esc(r.name)}</td>${dayCells(r.byDay)}<td style="${tdr};font-weight:bold">${f2(hrs(r.ms))}</td></tr>`).join("") +
    `<tr><td style="${td};font-weight:bold">All projects</td>${dayTotals(projRows)}<td style="${tdr};font-weight:bold">${f2(hrs(totalMs))}</td></tr>`
  );
  else body += table(
    `<th style="${th}">Project</th><th style="${th};text-align:right">Hours</th><th style="${th};text-align:right">People</th>`,
    projRows.map(r => `<tr><td style="${td}">${esc(r.name)}</td><td style="${tdr}">${f2(hrs(r.ms))}</td><td style="${tdr}">${r.people.size}</td></tr>`).join("")
  );

  body += h2("Overtime watch");
  body += otRows.length ? table(
    `<th style="${th}">Employee</th><th style="${th}">Week of</th><th style="${th};text-align:right">Hours this week</th><th style="${th}">Flag</th>`,
    otRows.map(r => `<tr><td style="${td};white-space:nowrap">${esc(r.name)}</td><td style="${td};white-space:nowrap">${esc(fmtDay(r.week))}</td><td style="${tdr}">${f2(r.worked)}</td><td style="${td}">${esc(r.notes)}</td></tr>`).join("")
  ) + `<div style="font-size:12px;color:#666;margin-top:6px">Week-to-date, Sunday through Saturday. Daily overtime starts after 8 hours and double-time after 12; weekly overtime starts after 40 regular hours.</div>`
    : `<div style="font-size:13px;color:#666">No one is over or approaching overtime.</div>`;

  body += h2("Receipts &amp; vendor invoices entered");
  if (!receipts.length) body += `<div style="font-size:13px;color:#666">None.</div>`;
  else {
    const MAX_ROWS = 40;
    const reimbTxt = e => isInvoice(e) ? "" : e.reimbursementNeeded === true ? "<b>Reimburse</b>" : e.reimbursementNeeded === false ? "Company-paid" : "Not answered";
    body += table(
      `<th style="${th}">Entered</th><th style="${th}">By</th><th style="${th}">Vendor</th><th style="${th}">Project</th><th style="${th};text-align:right">Amount</th><th style="${th}">Type</th><th style="${th}">Reimbursement</th>`,
      receipts.slice(0, MAX_ROWS).map(e => `<tr><td style="${td};white-space:nowrap">${esc(fmtStamp(e.subMs))}</td><td style="${td}">${esc(e.submittedByName || "")}</td><td style="${td}">${esc(e.vendor || "")}</td><td style="${td}">${esc(e.projectName || e.projectId || "")}</td><td style="${tdr}">${money(e.amount)}</td><td style="${td}">${isInvoice(e) ? "Vendor invoice" : "Receipt"}</td><td style="${td}">${reimbTxt(e)}</td></tr>`).join("")
    );
    if (receipts.length > MAX_ROWS) body += `<div style="font-size:12px;color:#666;margin-top:6px">Showing the first ${MAX_ROWS} of ${receipts.length}.</div>`;
    const notes = [];
    if (reimbNeeded.length) notes.push(`<b>${reimbNeeded.length}</b> ${reimbNeeded.length === 1 ? "receipt needs" : "receipts need"} a reimbursement check (${money(sum(reimbNeeded))}).`);
    if (reimbUnanswered.length) notes.push(`${reimbUnanswered.length} ${reimbUnanswered.length === 1 ? "receipt has" : "receipts have"} no answer yet to the company-or-reimburse question.`);
    if (notes.length) body += `<div style="font-size:13px;margin-top:8px">${notes.join(" ")}</div>`;
  }

  body += h2("Exceptions");
  body += exc.length
    ? `<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.6">${exc.map(x => `<li>${x.text}</li>`).join("")}</ul>`
    : `<div style="font-size:13px;color:#666">None.</div>`;

  body += `<p style="font-size:11px;color:#999;margin-top:26px">Sent automatically by MOTIF Lotus every weekday at 6:00 AM Mountain. Hours count completed time entries that started in the period above; receipts and invoices are those entered in it.</p></div>`;

  const subject = isMonday
    ? `MOTIF Labor Recap — ${fmtDay(startYmd)} to ${fmtDay(addDaysYmd(endYmd, -1))}`
    : `MOTIF Labor Recap — ${fmtDay(startYmd)}`;
  return { subject, html: body, stats: { totalHours: hrs(totalMs), people: empRows.length, projects: projRows.length, exceptions: exc.length, otFlags: otRows.length, receipts: rcpts.length, vendorInvoices: invs.length } };
}

module.exports = { buildLaborRecap, recapWindow, wallToUtcMs, ymdOf };
