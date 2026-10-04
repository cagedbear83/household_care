import type { Report } from "./api";
import { formatDateTime } from "./dates";
import { clock, minutesLabel, PERCENT_ROWS, pctLabel, rangeLabel, TASK_ROWS, VISIT_STATUS } from "./report-format";

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const table = (head: string[], rows: (string | number)[][]) =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;

/**
 * The whole report as one printable page. It is built on the device from the
 * report just fetched, so the server never stores a copy; printing it (or
 * saving it as a PDF from the print window) is up to the person.
 */
export function reportToHtml(report: Report, householdName?: string): string {
  const { meta, tasks, attendance, exceptions } = report;
  const tz = meta.timezone;
  const parts: string[] = [];

  parts.push(`<h1>${esc(householdName ? `${householdName}: ` : "")}Care report</h1>`);
  parts.push(
    `<p class="meta"><b>Dates:</b> ${esc(rangeLabel(meta.from, meta.to))} (${meta.days} day${meta.days === 1 ? "" : "s"})<br>` +
      `<b>Timezone:</b> ${esc(tz)}<br>` +
      `<b>Created:</b> ${esc(formatDateTime(meta.generatedAt, tz))} by ${esc(meta.generatedBy.name)}<br>` +
      `<b>Contents:</b> ${meta.scope === "full" ? "Task results, attendance and exceptions" : "Task results only"}</p>`
  );

  parts.push("<h2>Task results</h2>");
  parts.push(table(["Measure", "Number"], TASK_ROWS.map(([label, key]) => [label, tasks.totals[key]])));
  parts.push(
    table(
      ["Percentage", "Result", "How it is worked out"],
      PERCENT_ROWS.map((p) => [p.label, pctLabel(tasks.percentages[p.key]), p.how])
    )
  );
  if (tasks.byDay.length > 0) {
    parts.push("<h3>By day</h3>");
    parts.push(table(["Date", "Assigned", "Submitted", "Approved", "Disputed", "Not done"], tasks.byDay.map((d) => [d.date, d.assigned, d.submitted, d.approved, d.disputed, d.missed])));
  }
  if (tasks.byGroup.length > 0) {
    parts.push("<h3>By area</h3>");
    parts.push(table(["Area", "Assigned", "Submitted", "Approved", "Disputed", "Not done"], tasks.byGroup.map((g) => [g.group, g.assigned, g.submitted, g.approved, g.disputed, g.missed])));
  }
  if (tasks.notCompleted.length > 0) {
    parts.push(`<h3>Tasks that were not completed${tasks.notCompletedTotal > tasks.notCompleted.length ? ` (first ${tasks.notCompleted.length} of ${tasks.notCompletedTotal})` : ""}</h3>`);
    parts.push(table(["Date", "Area", "Task", "What happened", "Reason"], tasks.notCompleted.map((t) => [t.date, t.group, t.title, t.outcome, t.reason ?? ""])));
  }

  if (attendance) {
    parts.push("<h2>Attendance</h2>");
    const t = attendance.totals;
    parts.push(
      table(
        ["Measure", "Total"],
        [
          ["Visits scheduled", t.visitsScheduled ?? 0],
          ["Visits attended", t.visitsAttended ?? 0],
          ["Visits with no check-in", t.visitsMissed ?? 0],
          ["Visits with no checkout recorded", t.visitsWithoutCheckout ?? 0],
          ["Scheduled time", minutesLabel(t.scheduledMinutes ?? 0)],
          ["Authorized time (counted toward the weekly limit)", minutesLabel(t.authorizedMinutes ?? 0)],
          ["Observed time (check-in to checkout)", minutesLabel(t.observedMinutes ?? 0)],
        ]
      )
    );
    if (attendance.weeks.length > 0) {
      parts.push("<h3>Weekly hours against the limit</h3>");
      parts.push(
        table(
          ["Week", "Authorized", "Observed", "Limit", "Note"],
          attendance.weeks.map((w) => [
            `${w.weekStart} to ${w.weekEnd}`,
            minutesLabel(w.authorizedMinutes),
            minutesLabel(w.observedMinutes),
            minutesLabel(w.capMinutes),
            [w.overCap ? "Over the limit" : "", w.partial ? "Only the days in this report" : ""].filter(Boolean).join("; "),
          ])
        )
      );
    }
    if (attendance.rows.length > 0) {
      parts.push("<h3>Visits</h3>");
      parts.push(
        table(
          ["Date", "Who", "Scheduled", "In", "Out", "Authorized", "Observed", "Status"],
          attendance.rows.map((r) => [
            r.date,
            r.ipName,
            `${clock(r.scheduledStart, tz)} to ${clock(r.scheduledEnd, tz)}`,
            clock(r.checkIn, tz),
            clock(r.checkOut, tz),
            minutesLabel(r.authorizedMinutes),
            r.observedMinutes === null ? "—" : minutesLabel(r.observedMinutes),
            [VISIT_STATUS[r.status] ?? r.status, ...r.correctionNotes.map((n) => `Note: ${n}`)].join(". "),
          ])
        )
      );
    }
    if (attendance.daysOff.length > 0) {
      parts.push("<h3>Days off</h3>");
      parts.push(table(["Date", "Who", "Reason"], attendance.daysOff.map((d) => [d.date, d.ipName, d.status.replace(/_/g, " ").toLowerCase()])));
    }
  }

  if (exceptions) {
    parts.push("<h2>Exceptions</h2>");
    if (exceptions.items.length === 0) parts.push("<p>No exceptions in these dates.</p>");
    else parts.push(table(["Date", "Time", "What", "Details"], exceptions.items.map((i) => [i.date, i.at ? clock(i.at, tz) : "", i.label, i.text])));
  }

  parts.push("<h2>Notes</h2><ul>" + meta.notes.map((n) => `<li>${esc(n)}</li>`).join("") + "</ul>");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Care report ${esc(meta.from)} to ${esc(meta.to)}</title>
<style>
  @page { margin: 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; line-height: 1.4; }
  h1 { font-size: 22px; margin: 0 0 8px; } h2 { font-size: 16px; margin: 22px 0 6px; border-bottom: 2px solid #111; padding-bottom: 2px; } h3 { font-size: 13px; margin: 14px 0 4px; }
  .meta { margin: 0 0 8px; }
  table { border-collapse: collapse; width: 100%; margin: 4px 0 8px; page-break-inside: auto; } tr { page-break-inside: avoid; }
  th, td { border: 1px solid #555; padding: 3px 6px; text-align: left; vertical-align: top; } th { background: #eee; }
  ul { padding-left: 18px; }
</style></head><body>${parts.join("\n")}</body></html>`;
}
