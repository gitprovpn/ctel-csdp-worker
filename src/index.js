import { Router } from 'itty-router';

const router = Router();
const PROJECT_PREFIX = 'CTEL-SA';

router.options('*', () => corsResponse());
router.get('/health', () => json({ ok: true, service: 'csdp-worker-v2', version: '2.0.0' }));

router.get('/api/dashboard/summary', async (_, env) => {
  const activeProjects = await scalar(env.DB, `SELECT COUNT(*) FROM projects WHERE status IN ('draft','active','at_risk','blocked')`);
  const overdueTasks = await scalar(env.DB, `SELECT COUNT(*) FROM tasks WHERE status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND date(due_date) < date('now')`);
  const pendingApprovals = await scalar(env.DB, `SELECT COUNT(*) FROM approvals WHERE status = 'pending'`);
  const openRisks = await scalar(env.DB, `SELECT COUNT(*) FROM risks WHERE status = 'open'`);
  const openBlockers = await scalar(env.DB, `SELECT COUNT(*) FROM blockers WHERE status = 'open'`);
  const redProjects = await scalar(env.DB, `SELECT COUNT(*) FROM projects WHERE health_status = 'red'`);
  return json({ ok: true, data: { activeProjects, overdueTasks, pendingApprovals, openRisks, openBlockers, redProjects } });
});

router.get('/api/dashboard/workload', async (_, env) => {
  const rows = await all(env.DB, `
    SELECT u.id, u.display_name,
           SUM(CASE WHEN t.status NOT IN ('done','cancelled') THEN 1 ELSE 0 END) AS open_tasks,
           SUM(CASE WHEN t.status NOT IN ('done','cancelled') AND t.due_date IS NOT NULL AND date(t.due_date) < date('now') THEN 1 ELSE 0 END) AS overdue_tasks,
           SUM(CASE WHEN a.status = 'pending' THEN 1 ELSE 0 END) AS pending_approvals
    FROM users u
    LEFT JOIN tasks t ON t.assignee_user_id = u.id
    LEFT JOIN approvals a ON a.approver_user_id = u.id AND a.status = 'pending'
    WHERE u.is_active = 1
    GROUP BY u.id, u.display_name
    ORDER BY overdue_tasks DESC, open_tasks DESC, u.display_name ASC
  `);
  return json({ ok: true, data: rows });
});

router.get('/api/dashboard/heatmap', async (_, env) => {
  const rows = await all(env.DB, `
    SELECT p.id, p.code, p.name, p.stage, p.health_status, p.health_score,
           COALESCE(r.open_risks, 0) AS open_risks,
           COALESCE(b.open_blockers, 0) AS open_blockers
    FROM projects p
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS open_risks FROM risks WHERE status = 'open' GROUP BY project_id
    ) r ON r.project_id = p.id
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS open_blockers FROM blockers WHERE status = 'open' GROUP BY project_id
    ) b ON b.project_id = p.id
    ORDER BY p.health_score ASC, open_blockers DESC, open_risks DESC
    LIMIT 50
  `);
  return json({ ok: true, data: rows });
});

router.get('/api/projects', async (request, env) => {
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const stage = url.searchParams.get('stage');
  let sql = `
    SELECT p.id, p.code, p.name, p.customer_name, p.type, p.status, p.priority, p.stage,
           p.health_score, p.health_status, p.health_reason, p.due_date,
           u.display_name AS owner_name
    FROM projects p
    LEFT JOIN users u ON u.id = p.owner_user_id
    WHERE 1 = 1`;
  const binds = [];
  if (status) { sql += ' AND p.status = ?'; binds.push(status); }
  if (stage) { sql += ' AND p.stage = ?'; binds.push(stage); }
  sql += ' ORDER BY p.health_score ASC, p.updated_at DESC LIMIT 100';
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return json({ ok: true, data: results || [] });
});

router.get('/api/projects/:id', async ({ params }, env) => {
  const project = await first(env.DB, `SELECT * FROM projects WHERE id = ?`, [params.id]);
  if (!project) return json({ ok: false, error: 'Project not found' }, 404);
  const tasks = await all(env.DB, `SELECT t.*, u.display_name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_user_id WHERE project_id = ? ORDER BY sequence_no ASC`, [params.id]);
  const risks = await all(env.DB, `SELECT * FROM risks WHERE project_id = ? ORDER BY risk_score DESC, created_at DESC`, [params.id]);
  const blockers = await all(env.DB, `SELECT * FROM blockers WHERE project_id = ? ORDER BY created_at DESC`, [params.id]);
  const approvals = await all(env.DB, `SELECT a.*, u.display_name AS approver_name FROM approvals a LEFT JOIN users u ON u.id = a.approver_user_id WHERE project_id = ? ORDER BY a.created_at DESC`, [params.id]);
  const health = await first(env.DB, `SELECT * FROM health_snapshots WHERE project_id = ? ORDER BY id DESC LIMIT 1`, [params.id]);
  return json({ ok: true, data: { project, tasks, risks, blockers, approvals, health } });
});

router.post('/api/projects', async (request, env) => {
  const body = await request.json();
  validateRequired(body, ['name']);
  const code = await nextProjectCode(env);
  const result = await env.DB.prepare(`
    INSERT INTO projects (
      code, name, customer_name, service_line, type, status, priority, stage,
      owner_user_id, requester_user_id, sponsor_user_id, intake_sla_due_at,
      design_review_due_at, quotation_due_at, handover_due_at, start_date, due_date,
      description, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    code,
    body.name,
    body.customer_name || null,
    body.service_line || 'security_solution',
    body.type || 'delivery',
    body.status || 'draft',
    body.priority || 'medium',
    body.stage || 'intake',
    body.owner_user_id || null,
    body.requester_user_id || null,
    body.sponsor_user_id || null,
    body.intake_sla_due_at || null,
    body.design_review_due_at || null,
    body.quotation_due_at || null,
    body.handover_due_at || null,
    body.start_date || null,
    body.due_date || null,
    body.description || null,
    body.tags_json || null
  ).run();
  const projectId = result.meta.last_row_id;
  await recomputeProjectHealth(env, projectId, body.actor_user_id || null, body.actor_source || 'web');
  const created = await first(env.DB, `SELECT * FROM projects WHERE id = ?`, [projectId]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'project', projectId, 'create', null, created);
  return json({ ok: true, data: created }, 201);
});

router.post('/api/tasks', async (request, env) => {
  const body = await request.json();
  validateRequired(body, ['project_id', 'title']);
  const seq = await scalar(env.DB, `SELECT COALESCE(MAX(sequence_no),0) + 1 FROM tasks WHERE project_id = ?`, [body.project_id]);
  const result = await env.DB.prepare(`
    INSERT INTO tasks (project_id, title, description, bucket, status, priority, category, assignee_user_id, reporter_user_id, due_date, estimate_hours, sequence_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    body.project_id,
    body.title,
    body.description || null,
    body.bucket || 'backlog',
    body.status || 'todo',
    body.priority || 'medium',
    body.category || 'general',
    body.assignee_user_id || null,
    body.reporter_user_id || null,
    body.due_date || null,
    body.estimate_hours || null,
    seq
  ).run();
  const taskId = result.meta.last_row_id;
  const task = await first(env.DB, `SELECT * FROM tasks WHERE id = ?`, [taskId]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'task', taskId, 'create', null, task);
  await recomputeProjectHealth(env, body.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: task }, 201);
});

router.patch('/api/tasks/:id/status', async ({ params, ...request }, env) => {
  const body = await request.json();
  validateRequired(body, ['status']);
  const prev = await first(env.DB, `SELECT * FROM tasks WHERE id = ?`, [params.id]);
  if (!prev) return json({ ok: false, error: 'Task not found' }, 404);
  const completedAt = ['done', 'cancelled'].includes(body.status) ? nowIso() : null;
  await env.DB.prepare(`
    UPDATE tasks SET status = ?, bucket = ?, updated_at = CURRENT_TIMESTAMP,
      started_at = COALESCE(started_at, CASE WHEN ? = 'in_progress' THEN CURRENT_TIMESTAMP ELSE NULL END),
      completed_at = CASE WHEN ? IN ('done','cancelled') THEN CURRENT_TIMESTAMP ELSE completed_at END
    WHERE id = ?
  `).bind(body.status, body.bucket || bucketFromStatus(body.status), body.status, body.status, params.id).run();
  const next = await first(env.DB, `SELECT * FROM tasks WHERE id = ?`, [params.id]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'task', Number(params.id), 'status_update', prev, next);
  await recomputeProjectHealth(env, prev.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: next });
});

router.post('/api/risks', async (request, env) => {
  const body = await request.json();
  validateRequired(body, ['project_id', 'title']);
  const severity = body.severity || 'medium';
  const likelihood = Number(body.likelihood || 3);
  const score = body.risk_score || riskSeverityWeight(severity) * likelihood;
  const result = await env.DB.prepare(`
    INSERT INTO risks (project_id, title, description, severity, likelihood, risk_score, mitigation_plan, owner_user_id, status, due_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(body.project_id, body.title, body.description || null, severity, likelihood, score, body.mitigation_plan || null, body.owner_user_id || null, body.status || 'open', body.due_date || null).run();
  const row = await first(env.DB, `SELECT * FROM risks WHERE id = ?`, [result.meta.last_row_id]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'risk', row.id, 'create', null, row);
  await recomputeProjectHealth(env, body.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: row }, 201);
});

router.post('/api/blockers', async (request, env) => {
  const body = await request.json();
  validateRequired(body, ['project_id', 'title']);
  const result = await env.DB.prepare(`
    INSERT INTO blockers (project_id, task_id, title, description, owner_user_id, severity, status, due_date, escalation_chat_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(body.project_id, body.task_id || null, body.title, body.description || null, body.owner_user_id || null, body.severity || 'medium', body.status || 'open', body.due_date || null, body.escalation_chat_id || null).run();
  const row = await first(env.DB, `SELECT * FROM blockers WHERE id = ?`, [result.meta.last_row_id]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'blocker', row.id, 'create', null, row);
  await recomputeProjectHealth(env, body.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: row }, 201);
});

router.post('/api/approvals', async (request, env) => {
  const body = await request.json();
  validateRequired(body, ['project_id', 'title', 'approver_user_id']);
  const result = await env.DB.prepare(`
    INSERT INTO approvals (project_id, task_id, deliverable_id, title, requestor_user_id, approver_user_id, status, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `).bind(body.project_id, body.task_id || null, body.deliverable_id || null, body.title, body.requestor_user_id || null, body.approver_user_id, body.expires_at || null).run();
  const row = await first(env.DB, `SELECT * FROM approvals WHERE id = ?`, [result.meta.last_row_id]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'approval', row.id, 'create', null, row);
  await queueApprovalNotification(env, row.id);
  await recomputeProjectHealth(env, body.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: row }, 201);
});

router.post('/api/approvals/:id/decision', async ({ params, ...request }, env) => {
  const body = await request.json();
  validateRequired(body, ['status']);
  if (!['approved', 'rejected'].includes(body.status)) return json({ ok: false, error: 'Invalid approval status' }, 400);
  const prev = await first(env.DB, `SELECT * FROM approvals WHERE id = ?`, [params.id]);
  if (!prev) return json({ ok: false, error: 'Approval not found' }, 404);
  await env.DB.prepare(`
    UPDATE approvals SET status = ?, decision_note = ?, responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(body.status, body.decision_note || null, params.id).run();
  const next = await first(env.DB, `SELECT * FROM approvals WHERE id = ?`, [params.id]);
  await logAudit(env, body.actor_user_id || null, body.actor_source || 'web', 'approval', Number(params.id), 'decision', prev, next);
  await recomputeProjectHealth(env, prev.project_id, body.actor_user_id || null, body.actor_source || 'web');
  return json({ ok: true, data: next });
});

router.post('/api/projects/:id/recompute-health', async ({ params, ...request }, env) => {
  const body = await safeJson(request);
  const data = await recomputeProjectHealth(env, Number(params.id), body?.actor_user_id || null, body?.actor_source || 'web');
  return json({ ok: true, data });
});

router.get('/api/approvals/pending', async (request, env) => {
  const url = new URL(request.url);
  const approverUserId = url.searchParams.get('approver_user_id');
  let sql = `SELECT a.*, p.code, p.name AS project_name FROM approvals a JOIN projects p ON p.id = a.project_id WHERE a.status = 'pending'`;
  const binds = [];
  if (approverUserId) { sql += ' AND a.approver_user_id = ?'; binds.push(approverUserId); }
  sql += ' ORDER BY COALESCE(a.expires_at, "9999-12-31") ASC LIMIT 50';
  const rows = await all(env.DB, sql, binds);
  return json({ ok: true, data: rows });
});

router.post('/telegram/webhook', async (request, env) => {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');
  if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) return json({ ok: false, error: 'Unauthorized' }, 401);
  const update = await request.json();
  if (update.callback_query) await handleTelegramCallback(update.callback_query, env);
  else if (update.message?.text) await handleTelegramMessage(update.message, env);
  return json({ ok: true });
});

export default {
  fetch: (request, env, ctx) => router.handle(request, env, ctx).catch(err => {
    console.error(err);
    return json({ ok: false, error: err.message || 'Unhandled error' }, 500);
  }),
  scheduled: async (controller, env, ctx) => {
    const cron = controller.cron;
    if (cron === '0 1 * * *') await sendDailyOpsDigest(env);
    else if (cron === '30 1 * * 1') await sendWeeklyExecutiveDigest(env);
    else await refreshAllProjectHealth(env);
  },
  queue: async (batch, env, ctx) => {
    for (const msg of batch.messages) {
      try {
        const payload = msg.body;
        if (payload?.type === 'telegram_message') {
          await sendTelegramMessage(env, payload.chatId, payload.text, payload.replyMarkup || null);
        } else if (payload?.type === 'approval_request') {
          await sendApprovalTelegram(env, payload.approvalId);
        }
        msg.ack();
      } catch (error) {
        console.error('Queue processing failed', error);
        msg.retry();
      }
    }
  }
};

async function handleTelegramMessage(message, env) {
  const chatId = String(message.chat.id);
  const telegramUserId = String(message.from.id);
  const text = (message.text || '').trim();
  const user = await first(env.DB, `SELECT * FROM users WHERE telegram_user_id = ? AND is_active = 1`, [telegramUserId]);

  if (!user && !text.startsWith('/start')) {
    await sendTelegramMessage(env, chatId, '❌ User is not registered. Ask admin to map your Telegram ID.');
    return;
  }

  if (text.startsWith('/start')) {
    await sendTelegramMessage(env, chatId, `✅ Bot online. Your Telegram ID: ${telegramUserId}`);
    return;
  }
  if (text.startsWith('/help')) {
    await sendTelegramMessage(env, chatId, helpText());
    return;
  }
  if (text.startsWith('/mytasks')) {
    const tasks = await all(env.DB, `
      SELECT t.id, t.title, t.status, t.priority, t.due_date, p.code
      FROM tasks t
      JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_user_id = ? AND t.status NOT IN ('done','cancelled')
      ORDER BY COALESCE(t.due_date, '9999-12-31') ASC
      LIMIT 10
    `, [user.id]);
    const textOut = tasks.length ? '📋 My open tasks\n' + tasks.map(t => `- ${t.code} | ${t.title} | ${t.status} | due ${t.due_date || 'n/a'}`).join('\n') : '✅ No open tasks.';
    await sendTelegramMessage(env, chatId, textOut);
    return;
  }
  if (text.startsWith('/workload')) {
    const rows = await all(env.DB, `
      SELECT u.display_name, COUNT(t.id) AS open_tasks
      FROM users u LEFT JOIN tasks t ON t.assignee_user_id = u.id AND t.status NOT IN ('done','cancelled')
      WHERE u.is_active = 1 GROUP BY u.id ORDER BY open_tasks DESC, u.display_name ASC LIMIT 10
    `);
    await sendTelegramMessage(env, chatId, '👥 Workload\n' + rows.map(r => `- ${r.display_name}: ${r.open_tasks}`).join('\n'));
    return;
  }
  if (text.startsWith('/project ')) {
    const code = text.replace('/project ', '').trim();
    const project = await first(env.DB, `SELECT * FROM projects WHERE code = ?`, [code]);
    if (!project) return sendTelegramMessage(env, chatId, '❌ Project not found.');
    const openTasks = await scalar(env.DB, `SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status NOT IN ('done','cancelled')`, [project.id]);
    const openRisks = await scalar(env.DB, `SELECT COUNT(*) FROM risks WHERE project_id = ? AND status = 'open'`, [project.id]);
    const openBlockers = await scalar(env.DB, `SELECT COUNT(*) FROM blockers WHERE project_id = ? AND status = 'open'`, [project.id]);
    const pendingApprovals = await scalar(env.DB, `SELECT COUNT(*) FROM approvals WHERE project_id = ? AND status = 'pending'`, [project.id]);
    await sendTelegramMessage(env, chatId,
      `📌 ${project.code} | ${project.name}
Customer: ${project.customer_name || 'n/a'}
Stage: ${project.stage}
Status: ${project.status}
Health: ${project.health_status.toUpperCase()} (${project.health_score})
Reason: ${project.health_reason || 'n/a'}
Open tasks: ${openTasks} | Risks: ${openRisks} | Blockers: ${openBlockers} | Approvals: ${pendingApprovals}`
    );
    return;
  }
  if (text.startsWith('/newproject ')) {
    const fields = parseKeyValueCommand(text.replace('/newproject ', ''));
    const code = await nextProjectCode(env);
    const owner = fields.owner ? await findUserByTelegramUsername(env, fields.owner.replace('@', '')) : user;
    const result = await env.DB.prepare(`
      INSERT INTO projects (code, name, customer_name, type, status, priority, stage, owner_user_id, requester_user_id, due_date, description)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `).bind(code, fields.title || fields.name || 'Untitled Project', fields.customer || null, fields.type || 'delivery', fields.priority || 'medium', fields.stage || 'intake', owner?.id || user.id, user.id, fields.due || null, fields.desc || null).run();
    await recomputeProjectHealth(env, result.meta.last_row_id, user.id, 'telegram');
    await sendTelegramMessage(env, chatId, `✅ Project created: ${code}`);
    return;
  }
  if (text.startsWith('/newtask ')) {
    const fields = parseKeyValueCommand(text.replace('/newtask ', ''));
    const project = await first(env.DB, `SELECT * FROM projects WHERE code = ?`, [fields.project]);
    if (!project) return sendTelegramMessage(env, chatId, '❌ Project code not found.');
    const assignee = fields.assignee ? await findUserByTelegramUsername(env, fields.assignee.replace('@', '')) : user;
    const seq = await scalar(env.DB, `SELECT COALESCE(MAX(sequence_no),0) + 1 FROM tasks WHERE project_id = ?`, [project.id]);
    await env.DB.prepare(`
      INSERT INTO tasks (project_id, title, description, bucket, status, priority, category, assignee_user_id, reporter_user_id, due_date, sequence_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(project.id, fields.title || 'Untitled Task', fields.desc || null, fields.bucket || 'backlog', fields.status || 'todo', fields.priority || 'medium', fields.category || 'general', assignee?.id || user.id, user.id, fields.due || null, seq).run();
    await recomputeProjectHealth(env, project.id, user.id, 'telegram');
    await sendTelegramMessage(env, chatId, `✅ Task added to ${project.code}`);
    return;
  }
  if (text.startsWith('/newrisk ')) {
    const fields = parseKeyValueCommand(text.replace('/newrisk ', ''));
    const project = await first(env.DB, `SELECT * FROM projects WHERE code = ?`, [fields.project]);
    if (!project) return sendTelegramMessage(env, chatId, '❌ Project code not found.');
    const severity = fields.severity || 'medium';
    const likelihood = Number(fields.likelihood || 3);
    await env.DB.prepare(`
      INSERT INTO risks (project_id, title, severity, likelihood, risk_score, mitigation_plan, owner_user_id, status, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
    `).bind(project.id, fields.title || 'Untitled Risk', severity, likelihood, riskSeverityWeight(severity) * likelihood, fields.mitigation || null, user.id, fields.due || null).run();
    await recomputeProjectHealth(env, project.id, user.id, 'telegram');
    await sendTelegramMessage(env, chatId, `⚠️ Risk added to ${project.code}`);
    return;
  }
  if (text.startsWith('/pendingapprovals')) {
    const rows = await all(env.DB, `
      SELECT a.id, a.title, a.expires_at, p.code FROM approvals a JOIN projects p ON p.id = a.project_id
      WHERE a.approver_user_id = ? AND a.status = 'pending' ORDER BY COALESCE(a.expires_at, '9999-12-31') ASC LIMIT 10
    `, [user.id]);
    if (!rows.length) return sendTelegramMessage(env, chatId, '✅ No pending approvals.');
    await sendTelegramMessage(env, chatId, '🧾 Pending approvals\n' + rows.map(r => `- #${r.id} ${r.code} | ${r.title} | exp ${r.expires_at || 'n/a'}`).join('\n'));
    return;
  }
  await sendTelegramMessage(env, chatId, 'Unknown command. Send /help');
}

async function handleTelegramCallback(callbackQuery, env) {
  const chatId = String(callbackQuery.message.chat.id);
  const telegramUserId = String(callbackQuery.from.id);
  const user = await first(env.DB, `SELECT * FROM users WHERE telegram_user_id = ? AND is_active = 1`, [telegramUserId]);
  if (!user) {
    await answerTelegramCallback(env, callbackQuery.id, 'User not registered');
    return;
  }
  const data = callbackQuery.data || '';
  if (!data.startsWith('approval:')) {
    await answerTelegramCallback(env, callbackQuery.id, 'Unsupported action');
    return;
  }
  const [, approvalId, action] = data.split(':');
  const approval = await first(env.DB, `SELECT * FROM approvals WHERE id = ?`, [approvalId]);
  if (!approval) {
    await answerTelegramCallback(env, callbackQuery.id, 'Approval not found');
    return;
  }
  if (String(approval.approver_user_id) !== String(user.id) && !['admin', 'approver'].includes(user.role)) {
    await answerTelegramCallback(env, callbackQuery.id, 'Not your approval');
    return;
  }
  if (approval.status !== 'pending') {
    await answerTelegramCallback(env, callbackQuery.id, `Already ${approval.status}`);
    return;
  }
  const decision = action === 'approve' ? 'approved' : 'rejected';
  await env.DB.prepare(`UPDATE approvals SET status = ?, decision_note = ?, responded_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(decision, `Decision from Telegram by ${user.display_name}`, approval.id).run();
  await recomputeProjectHealth(env, approval.project_id, user.id, 'telegram');
  await answerTelegramCallback(env, callbackQuery.id, `Approval ${decision}`);
  await sendTelegramMessage(env, chatId, `✅ Approval #${approval.id} ${decision.toUpperCase()}`);
}

async function queueApprovalNotification(env, approvalId) {
  if (!env.NOTIFY_QUEUE) return;
  await env.NOTIFY_QUEUE.send({ type: 'approval_request', approvalId });
}

async function sendApprovalTelegram(env, approvalId) {
  const approval = await first(env.DB, `
    SELECT a.*, p.code, p.name AS project_name, u.telegram_user_id
    FROM approvals a
    JOIN projects p ON p.id = a.project_id
    LEFT JOIN users u ON u.id = a.approver_user_id
    WHERE a.id = ?
  `, [approvalId]);
  if (!approval?.telegram_user_id) return;
  const text = `🧾 Approval Required
#${approval.id} ${approval.title}
Project: ${approval.code} | ${approval.project_name}
Expires: ${approval.expires_at || 'n/a'}`;
  const replyMarkup = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approval:${approval.id}:approve` },
      { text: '❌ Reject', callback_data: `approval:${approval.id}:reject` }
    ]]
  };
  await sendTelegramMessage(env, approval.telegram_user_id, text, replyMarkup);
}

async function sendDailyOpsDigest(env) {
  const rows = await all(env.DB, `
    SELECT code, name, health_status, health_score, due_date, health_reason
    FROM projects
    WHERE status IN ('active','at_risk','blocked','draft')
    ORDER BY health_score ASC, due_date ASC
    LIMIT 10
  `);
  const chatId = await findChatIdByPurpose(env, env.OPS_CHAT_PURPOSE || 'ops');
  if (!chatId) return;
  const text = rows.length
    ? '📣 Daily ops digest\n' + rows.map(r => `- ${r.code} | ${r.health_status.toUpperCase()} ${r.health_score} | due ${r.due_date || 'n/a'} | ${r.health_reason || 'n/a'}`).join('\n')
    : '📣 Daily ops digest\nNo active projects.';
  await sendTelegramMessage(env, chatId, text);
}

async function sendWeeklyExecutiveDigest(env) {
  const rows = await all(env.DB, `
    SELECT code, name, customer_name, stage, health_status, health_score, due_date, health_reason
    FROM projects
    WHERE status IN ('active','at_risk','blocked')
    ORDER BY CASE health_status WHEN 'red' THEN 1 WHEN 'amber' THEN 2 ELSE 3 END, health_score ASC, due_date ASC
    LIMIT 20
  `);
  const chatId = await findChatIdByPurpose(env, env.MANAGEMENT_CHAT_PURPOSE || 'management');
  if (!chatId) return;
  const summary = rows.length
    ? '📊 Weekly executive digest\n' + rows.map(r => `- ${r.code} | ${r.customer_name || 'n/a'} | ${r.stage} | ${r.health_status.toUpperCase()} ${r.health_score} | ${r.health_reason || 'n/a'}`).join('\n')
    : '📊 Weekly executive digest\nNo active projects.';
  await sendTelegramMessage(env, chatId, summary);
}

async function refreshAllProjectHealth(env) {
  const ids = await all(env.DB, `SELECT id FROM projects WHERE status IN ('draft','active','at_risk','blocked') LIMIT 200`);
  for (const row of ids) await recomputeProjectHealth(env, row.id, null, 'system');
}

async function recomputeProjectHealth(env, projectId, actorUserId = null, actorSource = 'system') {
  const project = await first(env.DB, `SELECT * FROM projects WHERE id = ?`, [projectId]);
  if (!project) throw new Error('Project not found for health recomputation');

  const metrics = {
    overdueTasks: await scalar(env.DB, `SELECT COUNT(*) FROM tasks WHERE project_id = ? AND status NOT IN ('done','cancelled') AND due_date IS NOT NULL AND date(due_date) < date('now')`, [projectId]),
    pendingApprovals: await scalar(env.DB, `SELECT COUNT(*) FROM approvals WHERE project_id = ? AND status = 'pending'`, [projectId]),
    expiredApprovals: await scalar(env.DB, `SELECT COUNT(*) FROM approvals WHERE project_id = ? AND status = 'pending' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')`, [projectId]),
    openRisksHigh: await scalar(env.DB, `SELECT COUNT(*) FROM risks WHERE project_id = ? AND status = 'open' AND risk_score >= 12`, [projectId]),
    openBlockers: await scalar(env.DB, `SELECT COUNT(*) FROM blockers WHERE project_id = ? AND status = 'open'`, [projectId]),
    criticalBlockers: await scalar(env.DB, `SELECT COUNT(*) FROM blockers WHERE project_id = ? AND status = 'open' AND severity = 'critical'`, [projectId]),
    deliverablesLate: await scalar(env.DB, `SELECT COUNT(*) FROM deliverables WHERE project_id = ? AND status NOT IN ('approved','completed') AND due_date IS NOT NULL AND date(due_date) < date('now')`, [projectId]),
    ownerMissing: !project.owner_user_id ? 1 : 0,
    designReviewMiss: ['design_review','quotation','implementation','handover'].includes(project.stage) && project.design_review_due_at ? await compareDueMiss(env.DB, project.design_review_due_at) : 0,
    intakeMiss: project.stage !== 'intake' && project.intake_sla_due_at ? await compareDueMiss(env.DB, project.intake_sla_due_at) : 0,
    quotationMiss: ['quotation','implementation','handover'].includes(project.stage) && project.quotation_due_at ? await compareDueMiss(env.DB, project.quotation_due_at) : 0,
    handoverMiss: project.stage === 'handover' && project.handover_due_at ? await compareDueMiss(env.DB, project.handover_due_at) : 0
  };

  let score = 100;
  score -= metrics.overdueTasks * 8;
  score -= metrics.pendingApprovals * 4;
  score -= metrics.expiredApprovals * 15;
  score -= metrics.openRisksHigh * 10;
  score -= metrics.openBlockers * 10;
  score -= metrics.criticalBlockers * 15;
  score -= metrics.deliverablesLate * 7;
  score -= metrics.ownerMissing * 12;
  score -= metrics.designReviewMiss * 10;
  score -= metrics.intakeMiss * 6;
  score -= metrics.quotationMiss * 10;
  score -= metrics.handoverMiss * 10;
  if (['critical'].includes(project.priority)) score -= 5;
  if (['blocked'].includes(project.status)) score -= 10;
  score = Math.max(0, Math.min(100, score));

  const reasons = [];
  if (metrics.criticalBlockers) reasons.push('Critical blocker open');
  if (metrics.expiredApprovals) reasons.push('Approval overdue/expired');
  if (metrics.overdueTasks) reasons.push(`${metrics.overdueTasks} overdue task(s)`);
  if (metrics.openRisksHigh) reasons.push('High risks remain open');
  if (metrics.designReviewMiss) reasons.push('Design review SLA missed');
  if (metrics.quotationMiss) reasons.push('Quotation SLA missed');
  if (metrics.ownerMissing) reasons.push('Owner not assigned');

  let status = 'green';
  if (score < 60) status = 'red';
  else if (score < 85) status = 'amber';

  const reason = reasons.length ? reasons.join('; ') : 'On track';
  const previous = { health_score: project.health_score, health_status: project.health_status, health_reason: project.health_reason };

  await env.DB.prepare(`UPDATE projects SET health_score = ?, health_status = ?, health_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(score, status, reason, projectId).run();
  await env.DB.prepare(`INSERT INTO health_snapshots (project_id, score, status, reason, metrics_json) VALUES (?, ?, ?, ?, ?)`)
    .bind(projectId, score, status, reason, JSON.stringify(metrics)).run();
  await logAudit(env, actorUserId, actorSource, 'project', projectId, 'health_recompute', previous, { health_score: score, health_status: status, health_reason: reason, metrics });
  return { project_id: projectId, score, status, reason, metrics };
}

async function compareDueMiss(db, due) {
  const row = await db.prepare(`SELECT CASE WHEN datetime(?) < datetime('now') THEN 1 ELSE 0 END AS missed`).bind(due).first();
  return Number(row?.missed || 0);
}

function bucketFromStatus(status) {
  switch (status) {
    case 'todo': return 'backlog';
    case 'in_progress': return 'in_progress';
    case 'review': return 'review';
    case 'blocked': return 'blocked';
    default: return 'done';
  }
}

function riskSeverityWeight(severity) {
  return ({ low: 1, medium: 2, high: 3, critical: 4 }[severity] || 2);
}

function helpText() {
  return [
    'Cyber Solution Delivery Bot',
    '/help',
    '/mytasks',
    '/workload',
    '/pendingapprovals',
    '/project <CODE>',
    '/newproject customer=ABC type=presales stage=intake owner=@anh_nguyen due=2026-04-15 title="Zero Trust Review"',
    '/newtask project=CTEL-SA-2026-001 assignee=@minh_le priority=high due=2026-03-30 title="Draft HLD"',
    '/newrisk project=CTEL-SA-2026-001 severity=high likelihood=4 due=2026-03-29 title="Vendor sizing delay" mitigation="Escalate TAM"'
  ].join('\n');
}

function parseKeyValueCommand(input) {
  const re = /(\w+)=(("[^"]+")|([^\s]+))/g;
  const out = {};
  let match;
  while ((match = re.exec(input)) !== null) out[match[1]] = (match[2] || '').replace(/^"|"$/g, '');
  return out;
}

async function nextProjectCode(env) {
  const year = new Date().getUTCFullYear();
  const row = await env.DB.prepare(`SELECT COUNT(*) AS total FROM projects WHERE code LIKE ?`).bind(`${PROJECT_PREFIX}-${year}-%`).first();
  const seq = Number(row?.total || 0) + 1;
  return `${PROJECT_PREFIX}-${year}-${String(seq).padStart(3, '0')}`;
}

async function findChatIdByPurpose(env, purpose) {
  const kvValue = await env.CONFIG_KV?.get(`config:telegram:${purpose}:chat_id`);
  if (kvValue) return kvValue;
  const row = await first(env.DB, `SELECT telegram_chat_id FROM telegram_chats WHERE purpose = ? AND is_active = 1 ORDER BY id ASC LIMIT 1`, [purpose]);
  return row?.telegram_chat_id || null;
}

async function findUserByTelegramUsername(env, username) {
  return first(env.DB, `SELECT * FROM users WHERE telegram_username = ? AND is_active = 1`, [username]);
}

async function logAudit(env, actorUserId, actorSource, entityType, entityId, action, previousValue, nextValue) {
  await env.DB.prepare(`
    INSERT INTO audit_events (actor_user_id, actor_source, entity_type, entity_id, action, previous_json, next_json, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(actorUserId || null, actorSource || 'system', entityType, Number(entityId), action, stringifyOrNull(previousValue), stringifyOrNull(previousValue && nextValue ? diffSummary(previousValue, nextValue) : nextValue), null).run();
}

function diffSummary(previousValue, nextValue) {
  const out = {};
  for (const key of Object.keys(nextValue || {})) {
    if (JSON.stringify(previousValue?.[key]) !== JSON.stringify(nextValue?.[key])) out[key] = nextValue?.[key];
  }
  return out;
}

async function sendTelegramMessage(env, chatId, text, replyMarkup = null) {
  if (!env.TELEGRAM_BOT_TOKEN || !chatId) return;
  const body = { chat_id: chatId, text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function answerTelegramCallback(env, callbackQueryId, text) {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text })
  });
}

function validateRequired(body, fields) {
  for (const field of fields) if (body[field] === undefined || body[field] === null || body[field] === '') throw new Error(`Missing required field: ${field}`);
}

async function scalar(db, sql, params = []) {
  const row = await db.prepare(sql).bind(...params).first();
  if (!row) return 0;
  return Number(Object.values(row)[0] || 0);
}

async function first(db, sql, params = []) {
  return db.prepare(sql).bind(...params).first();
}

async function all(db, sql, params = []) {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results || [];
}

async function safeJson(request) {
  try { return await request.json(); } catch { return null; }
}

function stringifyOrNull(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function nowIso() {
  return new Date().toISOString();
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
      'access-control-allow-headers': 'content-type'
    }
  });
}
