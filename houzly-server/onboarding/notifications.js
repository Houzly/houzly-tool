// onboarding/notifications.js
// Modulo notifiche email per l'Onboarding.
// Invia: (1) briefing giornaliero alle 8:00 italiane, (2) alert immediati per overdue.

// La funzione runNotificationsTick è chiamata dall'endpoint /api/onboarding/cron-tick
// con un trigger esterno (cron-job.org ogni 15-30 minuti).

const ITALIAN_TZ_OFFSET_HOURS = 2; // CEST. Per CET (inverno) sarebbe 1.
// Nota: in produzione, meglio usare luxon o moment-timezone per gestire il DST.
// Per ora questo offset è una semplificazione accettabile (max 1h di delta, briefing ancora "in mattina").

/**
 * Ritorna l'ora italiana attuale come Date.
 */
function nowItalian() {
  const now = new Date();
  // Calcolo offset locale (Render UTC) e aggiungo CEST
  return new Date(now.getTime() + (ITALIAN_TZ_OFFSET_HOURS * 3600 * 1000));
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
 * Costruisce l'oggetto e il body HTML per il briefing giornaliero.
 */
function buildDailyBriefing(criticals, db_meta) {
  const overdue = criticals.overdue || [];
  const dueSoon = criticals.dueSoon || [];

  const subject = `☀ Briefing Houzly Onboarding · ${overdue.length} ritardi · ${dueSoon.length} in scadenza`;

  let html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1535;background:#f0f4ff;margin:0;padding:20px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:14px;padding:30px;box-shadow:0 2px 16px rgba(67,97,238,0.08)">

  <h1 style="font-size:20px;color:#4361ee;margin:0 0 4px;font-weight:700">☀ Briefing Onboarding</h1>
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
  <p style="font-size:11px;color:#8892b0;text-align:center;margin:20px 0 0">Houzly Tool · Onboarding alerts</p>
</div>
</body></html>`;

  return { subject, html };
}

/**
 * Costruisce email per alert immediato di un singolo task overdue.
 */
function buildOverdueAlert(item) {
  const subject = `🔴 Houzly · "${item.taskName}" in ritardo · ${item.propertyName}`;

  const days = Math.abs(item.daysDelta);
  const dayLabel = days === 0 ? 'oggi' : (days === 1 ? '1 giorno fa' : `${days} giorni fa`);

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0f1535;background:#f0f4ff;margin:0;padding:20px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:14px;padding:30px;box-shadow:0 2px 16px rgba(67,97,238,0.08)">

  <div style="background:#fcebeb;border-left:4px solid #f04060;padding:16px 20px;border-radius:8px;margin-bottom:24px">
    <div style="font-size:11px;color:#a52647;text-transform:uppercase;letter-spacing:0.08em;font-weight:700;margin-bottom:4px">⚠ Task in ritardo</div>
    <div style="font-size:18px;color:#0f1535;font-weight:700;margin-bottom:6px">${escapeHtml(item.taskName)}</div>
    <div style="font-size:13px;color:#3d4b7c">${escapeHtml(item.propertyName)}</div>
  </div>

  <table style="width:100%;font-size:13px;border-collapse:collapse">
    <tr><td style="color:#8892b0;padding:6px 0;width:40%">Data target</td><td style="color:#0f1535;font-weight:600;padding:6px 0">${fmtDateIt(item.targetDate)} (${dayLabel})</td></tr>
    ${item.assignee ? `<tr><td style="color:#8892b0;padding:6px 0">Assegnato a</td><td style="color:#0f1535;font-weight:600;padding:6px 0">${escapeHtml(item.assignee)}</td></tr>` : ''}
  </table>

  <div style="margin-top:24px;text-align:center">
    <a href="https://houzly-tool.onrender.com" style="display:inline-block;background:linear-gradient(135deg,#3d5af1 0%,#0fbcd4 100%);color:#fff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">Apri il cockpit →</a>
  </div>

  <p style="font-size:11px;color:#8892b0;text-align:center;margin:24px 0 0">Riceverai questa notifica una sola volta per questo task.</p>
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
 * Logic principale: legge stato DB e decide cosa notificare.
 *
 * @param {Object} db - MongoDB Db instance
 * @param {Object} resend - Resend client
 * @param {Object} opts
 * @param {string[]} opts.recipients - email destinatarie (es. ['info@houzly.it'])
 * @param {string} opts.from - email mittente
 * @param {boolean} opts.dryRun - se true, ritorna cosa farebbe senza mandare
 * @param {boolean} opts.forceBriefing - se true, manda briefing anche se gi inviato oggi
 * @returns {Object} riepilogo operazioni
 */
async function runNotificationsTick(db, resend, opts) {
  const recipients = opts.recipients || ['info@houzly.it'];
  const from = opts.from || 'Houzly Onboarding <onboarding@houzly.it>';
  const dryRun = !!opts.dryRun;
  const forceBriefing = !!opts.forceBriefing;

  const results = {
    briefingSent: false,
    overdueAlertsSent: 0,
    skipped: { briefing: false, overdue: 0 },
    errors: [],
  };

  // ── 1. Carico tutto lo stato necessario in una volta ──
  const [instances, catalog, briefingState] = await Promise.all([
    db.collection('onboarding_instances').find({
      status: { $in: ['pending', 'in_progress'] },
    }).toArray(),
    db.collection('onboarding_catalog').find({}).toArray(),
    db.collection('onboarding_meta').findOne({ _id: 'last_briefing' }),
  ]);

  const catalogById = new Map(catalog.map(t => [t._id, t]));
  const now = Date.now();
  const sevenDays = 7 * 86400000;

  // ── 2. Trova OVERDUE non ancora notificati ──
  const overdueNew = [];
  for (const inst of instances) {
    if (inst.reminded_overdue) continue;
    const target = new Date(inst.target_date).getTime();
    if (target >= now) continue;
    overdueNew.push({
      instanceId: inst._id,
      taskName: getTaskName(inst, catalogById),
      propertyName: inst.property_name,
      targetDate: inst.target_date,
      daysDelta: daysDelta(inst.target_date),
      assignee: inst.override_assignee || (catalogById.get(inst.task_id)?.default_assignee || ''),
    });
  }

  // ── 3. Decidi se mandare briefing (1 volta al giorno tra le 8:00 e 9:00 italiane) ──
  const italian = nowItalian();
  const italianHour = italian.getUTCHours(); // dato che ho gi shiftato di +2
  const todayKey = italian.toISOString().slice(0, 10); // "2026-04-29"
  const lastBriefingDate = briefingState?.last_date || '';

  const briefingWindow = (italianHour >= 8 && italianHour < 10);
  const shouldSendBriefing = forceBriefing || (briefingWindow && lastBriefingDate !== todayKey);

  if (shouldSendBriefing) {
    // Calcolo briefing: tutti gli overdue + tutti i due_soon (incluso quelli gi notificati per overdue)
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
    // Sort: pi urgente in cima
    allOverdue.sort((a, b) => a.daysDelta - b.daysDelta); // pi negativo = pi vecchio = prima
    allDueSoon.sort((a, b) => a.daysDelta - b.daysDelta); // pi piccolo = pi vicino = prima

    const { subject, html } = buildDailyBriefing({ overdue: allOverdue, dueSoon: allDueSoon });

    if (dryRun) {
      results.briefingSent = true;
      results.briefingPreview = { subject, recipients, overdueCount: allOverdue.length, dueSoonCount: allDueSoon.length };
    } else {
      try {
        await resend.emails.send({
          from,
          to: recipients,
          subject,
          html,
        });
        await db.collection('onboarding_meta').replaceOne(
          { _id: 'last_briefing' },
          { _id: 'last_briefing', last_date: todayKey, last_run_at: new Date(), overdue: allOverdue.length, due_soon: allDueSoon.length },
          { upsert: true }
        );
        results.briefingSent = true;
        results.briefingStats = { overdue: allOverdue.length, dueSoon: allDueSoon.length };
      } catch (e) {
        results.errors.push({ type: 'briefing', message: e.message });
      }
    }
  } else {
    if (lastBriefingDate === todayKey) results.skipped.briefing = 'already_sent_today';
    else results.skipped.briefing = `outside_window_hour=${italianHour}`;
  }

  // ── 4. Manda alert immediati per ogni overdue nuovo ──
  for (const item of overdueNew) {
    const { subject, html } = buildOverdueAlert(item);
    if (dryRun) {
      results.overdueAlertsSent++;
      continue;
    }
    try {
      await resend.emails.send({
        from,
        to: recipients,
        subject,
        html,
      });
      // Marca come notificato per non rimandare
      await db.collection('onboarding_instances').updateOne(
        { _id: item.instanceId },
        { $set: { reminded_overdue: true, updated_at: new Date() } }
      );
      results.overdueAlertsSent++;
    } catch (e) {
      results.errors.push({ type: 'overdue', task: item.taskName, message: e.message });
    }
  }

  return results;
}

module.exports = { runNotificationsTick, buildDailyBriefing, buildOverdueAlert };
