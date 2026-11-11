import cron from 'node-cron';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import * as store from './store.js';
import type { GitHubIssue, GitHubProvider } from './types.js';

/**
 * Weekly report, sent by EMAIL (nodemailer / SMTP) — not posted to Slack.
 *
 * Contents: completed/opened counts, per-person handled tasks + average resolution time,
 * top requesters, repeat-request topics, P0 + escalation counts, and what is still open.
 */

export interface WeeklyReport {
  subject: string;
  html: string;
  text: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function formatDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min`;
  const hours = ms / 3_600_000;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function avg(nums: number[]): number | null {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

export async function buildWeeklyReport(
  github: GitHubProvider,
  resolveName: (slackId: string) => Promise<string>,
  nowMs = Date.now()
): Promise<WeeklyReport> {
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  const sinceMs = nowMs - weekMs;
  const sinceIso = new Date(sinceMs).toISOString();

  const [closed, open] = await Promise.all([github.getClosedSince(sinceIso), github.getAllOpenIssues()]);
  const openedThisWeek = [...closed, ...open].filter(i => new Date(i.createdAt).getTime() >= sinceMs);
  const p0Count = openedThisWeek.filter(i => i.labels.includes('P0')).length;

  // Per-person completed work
  const perPerson = new Map<string, { done: number; durations: number[] }>();
  const allDurations: number[] = [];
  for (const i of closed) {
    const who = i.assignees[0] || 'unassigned';
    const entry = perPerson.get(who) || { done: 0, durations: [] };
    entry.done++;
    if (i.closedAt) {
      const d = new Date(i.closedAt).getTime() - new Date(i.createdAt).getTime();
      if (d >= 0) {
        entry.durations.push(d);
        allDurations.push(d);
      }
    }
    perPerson.set(who, entry);
  }
  const people = [...perPerson.entries()].sort((a, b) => b[1].done - a[1].done);
  const overallAvg = avg(allDurations);

  // Top requesters
  const requesterCounts = new Map<string, number>();
  for (const l of store.listIssueLinks().filter(l => l.createdAt >= sinceMs)) {
    requesterCounts.set(l.requesterId, (requesterCounts.get(l.requesterId) || 0) + 1);
  }
  const topRequesters = await Promise.all(
    [...requesterCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(async ([id, n]) => ({ name: await resolveName(id), n }))
  );

  // Repeat topics
  const topicCounts = new Map<string, Set<number>>();
  for (const t of store.listTopicsSince(nowMs - config.bot.repeatWindowDays * 24 * 60 * 60 * 1000)) {
    if (!topicCounts.has(t.topic)) topicCounts.set(t.topic, new Set());
    topicCounts.get(t.topic)!.add(t.issueNumber);
  }
  const repeatTopics = [...topicCounts.entries()]
    .filter(([, s]) => s.size >= 2)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 5)
    .map(([topic, s]) => ({ topic: topic.replace(/-/g, ' '), n: s.size }));

  const escalations = store.listAuditSince(sinceMs, 'p0.escalated').length;

  // Still open
  const oldestOpen = [...open]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, 3);
  const openByPerson = new Map<string, number>();
  for (const i of open) {
    const who = i.assignees[0] || 'unassigned';
    openByPerson.set(who, (openByPerson.get(who) || 0) + 1);
  }

  const range = `${new Date(sinceMs).toDateString()} – ${new Date(nowMs).toDateString()}`;
  const subject = `DevOps weekly report — ${closed.length} done, ${open.length} open`;

  // ── plain text
  const t: string[] = [];
  t.push(`DevOps weekly report`, range, '');
  t.push(`Completed: ${closed.length}   Opened: ${openedThisWeek.length}   Still open: ${open.length}   P0s: ${p0Count}   Escalations: ${escalations}`);
  if (overallAvg !== null) t.push(`Average time to resolve: ${formatDuration(overallAvg)}`);
  t.push('', 'Handled by');
  if (people.length === 0) t.push('  (nothing closed this week)');
  for (const [who, e] of people) {
    const a = avg(e.durations);
    t.push(`  ${who}: ${e.done} done${a !== null ? `, avg ${formatDuration(a)}` : ''}`);
  }
  t.push('', 'Top requesters');
  if (topRequesters.length === 0) t.push('  (none)');
  for (const r of topRequesters) t.push(`  ${r.name}: ${r.n}`);
  t.push('', 'Repeat requests (automation candidates)');
  if (repeatTopics.length === 0) t.push('  (none)');
  for (const r of repeatTopics) t.push(`  ${r.topic}: ${r.n}x`);
  t.push('', 'Still open');
  for (const [who, n] of openByPerson) t.push(`  ${who}: ${n}`);
  if (oldestOpen.length) {
    t.push('', 'Oldest open');
    for (const i of oldestOpen) t.push(`  #${i.number} ${i.title} (${formatDuration(nowMs - new Date(i.createdAt).getTime())} old) ${i.url}`);
  }

  // ── HTML
  const row = (cells: string[], head = false) =>
    `<tr>${cells.map(c => `<${head ? 'th' : 'td'} style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;font-weight:${head ? 600 : 400}">${c}</${head ? 'th' : 'td'}>`).join('')}</tr>`;
  const table = (head: string[], rows: string[][]) =>
    rows.length === 0
      ? '<p style="color:#6b7280;margin:4px 0">None.</p>'
      : `<table style="border-collapse:collapse;width:100%;font-size:14px">${row(head, true)}${rows.map(r => row(r)).join('')}</table>`;
  const stat = (label: string, value: string | number) =>
    `<td style="padding:10px 14px;background:#f3f4f6;border-radius:8px;text-align:center"><div style="font-size:22px;font-weight:700">${value}</div><div style="font-size:12px;color:#6b7280">${label}</div></td>`;
  const h = (s: string) => `<h3 style="margin:22px 0 6px;font-size:15px">${s}</h3>`;

  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111827;max-width:680px;margin:auto;padding:16px">
<h2 style="margin:0">DevOps weekly report</h2>
<p style="color:#6b7280;margin:4px 0 14px">${esc(range)}</p>
<table style="border-spacing:8px;width:100%"><tr>${stat('Completed', closed.length)}${stat('Opened', openedThisWeek.length)}${stat('Still open', open.length)}${stat('P0s', p0Count)}${stat('Escalations', escalations)}${stat('Avg resolve', overallAvg !== null ? formatDuration(overallAvg) : '—')}</tr></table>
${h('Handled by')}${table(['Person', 'Done', 'Avg time'], people.map(([who, e]) => { const a = avg(e.durations); return [esc(who), String(e.done), a !== null ? formatDuration(a) : '—']; }))}
${h('Top requesters')}${table(['Requester', 'Requests'], topRequesters.map(r => [esc(r.name), String(r.n)]))}
${h('Repeat requests — automation candidates')}${table(['Topic', 'Times'], repeatTopics.map(r => [esc(r.topic), String(r.n)]))}
${h('Still open')}${table(['Person', 'Open'], [...openByPerson.entries()].map(([who, n]) => [esc(who), String(n)]))}
${h('Oldest open')}${table(['Issue', 'Age'], oldestOpen.map((i: GitHubIssue) => [`<a href="${esc(i.url)}">#${i.number}</a> ${esc(i.title)}`, formatDuration(nowMs - new Date(i.createdAt).getTime())]))}
</body></html>`;

  return { subject, html, text: t.join('\n') };
}

export function isEmailConfigured(): boolean {
  const { smtp, from, to } = config.report;
  return Boolean(smtp.host && from && to.length > 0);
}

export async function sendReportEmail(
  report: WeeklyReport,
  /** Injectable for tests (e.g. nodemailer's jsonTransport). */
  transporter: Transporter = nodemailer.createTransport({
    host: config.report.smtp.host,
    port: config.report.smtp.port,
    secure: config.report.smtp.secure,
    auth: config.report.smtp.user ? { user: config.report.smtp.user, pass: config.report.smtp.pass } : undefined,
  })
): Promise<unknown> {
  const { from, to } = config.report;
  return transporter.sendMail({ from, to, subject: report.subject, text: report.text, html: report.html });
}

export function startWeeklyReport(
  github: GitHubProvider,
  resolveName: (slackId: string) => Promise<string>
): void {
  if (!isEmailConfigured()) {
    console.warn('⚠️ Weekly email report disabled — set SMTP_HOST, REPORT_FROM (or SMTP_USER) and REPORT_TO to enable it.');
    return;
  }
  if (!cron.validate(config.report.cron)) {
    console.warn(`⚠️ Invalid WEEKLY_REPORT_CRON "${config.report.cron}" — weekly report disabled.`);
    return;
  }
  cron.schedule(
    config.report.cron,
    async () => {
      try {
        const report = await buildWeeklyReport(github, resolveName);
        await sendReportEmail(report);
        store.insertAudit({ action: 'report.sent', detail: `to ${config.report.to.join(', ')}` });
        console.log(`📧 Weekly report emailed to ${config.report.to.join(', ')}`);
      } catch (err) {
        console.error('❌ Weekly report failed:', err);
      }
    },
    { timezone: config.report.timezone }
  );
  console.log(`✓ Weekly email report scheduled: "${config.report.cron}" (${config.report.timezone}) → ${config.report.to.join(', ')}`);
}
