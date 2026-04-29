// onboarding/notifications.js
// Modulo notifiche email per l'Onboarding.
// Invia: 2 briefing email al giorno (mattino + sera), niente alert immediati.
//
// La funzione runNotificationsTick è chiamata dall'endpoint /api/onboarding/cron-tick
// con un trigger esterno (cron-job.org ogni 2 ore).

// ── Finestre orarie italiane (timezone Europe/Rome) ────────────────
// Mattino: 8:00 - 9:59  → briefing "anteprima del giorno"
// Sera:    18:00 - 19:59 → briefing "recap di fine giornata"
const MORNING_WINDOW = { start: 8, end: 10 };
const EVENING_WINDOW = { start: 18, end: 20 };

/**
 * Restituisce l'ora attuale in fuso italiano come oggetto {hour, dateKey}.
 * Usa Intl per gestire correttamente DST (CEST/CET).
 */
function getItalianTime() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  });
  const parts = {};
  fmt.formatToParts(now).forEach(p => { parts[p.type] = p.value; });
  return {
    hour: parseInt(parts.hour, 10),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`, // "2026-04-29"
  };
}

/**
 * Formatta data come "29 apr 2026"
 */
function fmtDateIt(d) {
  return new Date(d).toLocaleDateString('it-IT', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Europe/Rome',
  });
}

/**
 * Calcola giorni di delta dalla data target (negativo = già scaduto).
 */
function daysDelta(targetIso) {
  const target = new Date(targetIso).getTime();
  const now = Date.now();
  return Math.round((target - now) / 86400000);
}

/**
 * Restituisce nome leggibile del task (gestendo custom subtasks).
 */
function getTaskName(instance, catalogById) {
  if (instance.custom_subtask) return instance.custom_name || 'Task custom';
  const tpl = catalogById.get(instance.task_id);
  return tpl ? tpl.name : 'Task';
}

/**
 * Costruisce l'oggetto email + body HTML per il briefing.
 * @param {Object} criticals - {overdue: [], dueSoon: []}
 * @param {string} period - 'morning' | 'evening'
 */
function buildBriefing(criticals, period) {
  const overdue = criticals.overdue || [];
  const dueSoon = criticals.dueSoon || [];
  const isMorning = period === 'morning';

  const icon = isMorning ? '☀' : '🌙';
  const title = isMorning ? 'Anteprima del giorno' : 'Recap di fine giornata';
  const subjectLabel = isMorning ? 'Briefing mattino' : 'Briefing sera';

  const subject = `${icon} ${subjectLabel} Onboarding · ${overdue.length} ritardi · ${dueSoon.length} in scadenza`;

  let html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1535;background:#f0f4ff;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:30px;box-shadow:0 2px 16px rgba(67,97,238,0.08)">

  <h1 style="font-size:20px;color:#4361ee;margin:0 0 4px;font-weight:700">${icon} ${title}</h1>
  <p style="font-size:13px;color:#8892b0;margin:0 0 24px">${fmtDateIt(new Date())}</p>
`;

  if (overdue.length === 0 && dueSoon.length === 0) {
    html += `<div style="background:#f0fdf4;border-left:4px solid #00c48c;padding:16px;border-radius:8px;font-size:14px;color:#27500a">
      ✓ Tutto sotto controllo. Nessuna attività in ritardo o in scadenza nei prossimi 7 giorni.
    </div>`;
  } else {
    if (overdue.length > 0) {
      html += `<h2 style="font-size:14px;color:#f04060;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 12px;font-weight:700">🔴 In ritardo (${overdue.length})</h2>`;
      html += '<ul style="list-style:none;padding:0;margin:0 0 24px">';
      for (const item of overdue) {
        const days = Math.abs(item.daysDelta);
        html += `<li style="background:#fcebeb;border-left:4px solid #f04060;padding:12px 16px;border-radius:8px;margin-bottom:8px">
          <div style="font-weight:600;font-size:14px;color:#0f1535">${escapeHtml(item.taskName)}</div>
          <div style="font-size:12px;color:#3d4b7c;margin-top:2px">${escapeHtml(item.propertyName)} · scaduto da ${days} ${days === 1 ? 'giorno' : 'giorni'}${item.assignee ? ' · ' + escapeHtml(item.assignee) : ''}</div>
        </li>`;
      }
      html += '</ul>';
    }

    if (dueSoon.length > 0) {
      html += `<h2 style="font-size:14px;color:#a06400;text-transform:uppercase;letter-spacing:0.06em;margin:0 0 12px;font-weight:700">🟡 In scadenza ≤ 7 giorni (${dueSoon.length})</h2>`;
      html += '<ul style="list-style:none;padding:0;margin:0 0 24px">';
      for (const item of dueSoon) {
        const d = item.daysDelta;
        const dayLabel = d === 0 ? 'oggi' : (d === 1 ? 'domani' : `tra ${d} giorni`);
        html += `<li style="background:#faeeda;border-left:4px solid #f5a623;padding:12px 16px;border-radius:8px;margin-bottom:8px">
          <div style="font-weight:600;font-size:14px;color:#0f1535">${escapeHtml(item.taskName)}</div>
          <div style="font-size:12px;color:#3d4b7c;margin-top:2px">${escapeHtml(item.propertyName)} · ${dayLabel} (${fmtDateIt(item.targetDate)})${item.assignee ? ' · ' + escapeHtml(item.assignee) : ''}</div>
        </li>`;
      }
      html += '</ul>';
    }
  }

  html += `
  <div style="margin-top:30px;padding-top:20px;border-top:1px solid #dde3f8;text-align:center">
    <a href="https://houzly-tool.onrender.com" style="display:inline-block;background:linear-gradient(135deg,#3d5af1 0%,#0fbcd4 100%);color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Apri il cockpit →</a>
  </div>
  <p style="font-size:11px;color:#8892b0;text-align:center;margin:20px 0 0">Houzly Tool · Onboarding briefing ${isMorning ? 'mattutino' : 'serale'}</p>
</div>
</body></html>`;

  return { subject, html };
}

function escapeHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * Logic principale: legge stato DB e decide se mandare un briefing.
 *
 * @param {Object} db - MongoDB Db instance
 * @param {Object} resend - Resend client
 * @param {Object} opts
 * @param {string[]} opts.recipients - email destinatarie
 * @param {string} opts.from - email mittente
 * @param {boolean} opts.dryRun - se true, ritorna cosa farebbe senza mandare
 * @param {string|boolean} opts.forceBriefing - 'morning' | 'evening' | true (= morning) | false
 * @returns {Object} riepilogo operazioni
 */
async function runNotificationsTick(db, resend, opts) {
  const recipients = opts.recipients || ['info@houzly.it'];
  const from = opts.from || 'Houzly Onboarding <onboarding@houzly.it>';
  const dryRun = !!opts.dryRun;
  let forceBriefing = opts.forceBriefing;
  if (forceBriefing === true) forceBriefing = 'morning';

  const results = {
    briefingSent: false,
    briefingPeriod: null,
    skipped: { briefing: false },
    errors: [],
  };

  // ── 1. Determina la finestra ──
  const italian = getItalianTime();
  const inMorningWindow = (italian.hour >= MORNING_WINDOW.start && italian.hour < MORNING_WINDOW.end);
  const inEveningWindow = (italian.hour >= EVENING_WINDOW.start && italian.hour < EVENING_WINDOW.end);

  let period = null;
  if (forceBriefing === 'morning' || forceBriefing === 'evening') {
    period = forceBriefing;
  } else if (inMorningWindow) {
    period = 'morning';
  } else if (inEveningWindow) {
    period = 'evening';
  }

  if (!period) {
    results.skipped.briefing = `outside_windows_hour=${italian.hour}`;
    return results;
  }

  // ── 2. Idempotenza: già inviato oggi questo briefing? ──
  const metaId = period === 'morning' ? 'last_briefing_morning' : 'last_briefing_evening';
  const meta = await db.collection('onboarding_meta').findOne({ _id: metaId });
  const lastDate = meta?.last_date || '';
  const todayKey = italian.dateKey;

  if (!forceBriefing && lastDate === todayKey) {
    results.skipped.briefing = `already_sent_today_${period}`;
    return results;
  }

  // ── 3. Carica i dati ──
  const [instances, catalog] = await Promise.all([
    db.collection('onboarding_instances').find({
      status: { $in: ['pending', 'in_progress'] },
    }).toArray(),
    db.collection('onboarding_catalog').find({}).toArray(),
  ]);

  const catalogById = new Map(catalog.map(t => [t._id, t]));
  const now = Date.now();
  const sevenDays = 7 * 86400000;

  const allOverdue = [];
  const allDueSoon = [];
  for (const inst of instances) {
    const target = new Date(inst.target_date).getTime();
    const item = {
      taskName: getTaskName(inst, catalogById),
      propertyName: inst.property_name,
      targetDate: inst.target_date,
      daysDelta: daysDelta(inst.target_date),
      assignee: inst.override_assignee || (catalogById.get(inst.task_id)?.default_assignee || ''),
    };
    if (target < now) allOverdue.push(item);
    else if (target - now <= sevenDays) allDueSoon.push(item);
  }
  allOverdue.sort((a, b) => a.daysDelta - b.daysDelta);
  allDueSoon.sort((a, b) => a.daysDelta - b.daysDelta);

  const { subject, html } = buildBriefing({ overdue: allOverdue, dueSoon: allDueSoon }, period);

  if (dryRun) {
    results.briefingSent = true;
    results.briefingPeriod = period;
    results.briefingPreview = { subject, recipients, overdueCount: allOverdue.length, dueSoonCount: allDueSoon.length };
    return results;
  }

  // ── 4. Invio reale ──
  try {
    await resend.emails.send({
      from,
      to: recipients,
      subject,
      html,
    });
    await db.collection('onboarding_meta').replaceOne(
      { _id: metaId },
      { _id: metaId, last_date: todayKey, last_run_at: new Date(), overdue: allOverdue.length, due_soon: allDueSoon.length },
      { upsert: true }
    );
    results.briefingSent = true;
    results.briefingPeriod = period;
    results.briefingStats = { overdue: allOverdue.length, dueSoon: allDueSoon.length };
  } catch (e) {
    results.errors.push({ type: 'briefing', period, message: e.message });
  }

  return results;
}

module.exports = { runNotificationsTick, buildBriefing };
