function getAllowedOrigins(env) {
  const fromEnv = (env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return fromEnv.length
    ? fromEnv
    : [
        "https://gitprovpn.github.io",
        "http://127.0.0.1:8080",
        "http://localhost:8080",
        "http://127.0.0.1:5500",
        "http://localhost:5500",
      ];
}

function buildCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = getAllowedOrigins(env);

  const allowOrigin =
    origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...buildCorsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function text(body, request, env, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...buildCorsHeaders(request, env),
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function notFound(request, env) {
  return json(
    {
      ok: false,
      error: "Not found",
    },
    request,
    env,
    404
  );
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row || {}).map(([k, v]) => [k, v === null ? null : v])
  );
}

async function tableExists(env, tableName) {
  const sql = `
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `;
  const row = await env.DB.prepare(sql).bind(tableName).first();
  return !!row;
}

async function getTableColumns(env, tableName) {
  try {
    const { results } = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
    return (results || []).map((r) => r.name);
  } catch {
    return [];
  }
}

function pickFirstColumn(columns, candidates, fallback = null) {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  return fallback;
}

async function safeAll(env, sql, binds = []) {
  const stmt = env.DB.prepare(sql).bind(...binds);
  const result = await stmt.all();
  return result.results || [];
}

async function safeFirst(env, sql, binds = []) {
  const stmt = env.DB.prepare(sql).bind(...binds);
  const result = await stmt.first();
  return result || null;
}

function computeHealthFromProject(project = {}) {
  let score =
    typeof project.health_score === "number"
      ? project.health_score
      : Number(project.health_score || 100);

  if (!Number.isFinite(score)) score = 100;

  let reasons = [];

  const overdueTasks = Number(project.overdue_tasks || 0);
  const blockers = Number(project.blocker_count || 0);
  const risks = Number(project.risk_count || 0);
  const pendingApprovals = Number(project.pending_approvals || 0);

  score -= overdueTasks * 10;
  score -= blockers * 25;
  score -= Math.min(risks, 5) * 5;
  score -= pendingApprovals * 8;

  if (overdueTasks > 0) reasons.push(`Overdue tasks: ${overdueTasks}`);
  if (blockers > 0) reasons.push(`Blockers: ${blockers}`);
  if (risks > 0) reasons.push(`Open risks: ${risks}`);
  if (pendingApprovals > 0) reasons.push(`Pending approvals: ${pendingApprovals}`);

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let status = "on_track";
  if (score < 50) status = "blocked";
  else if (score < 70) status = "delayed";
  else if (score < 85) status = "at_risk";

  return {
    health_score: score,
    health_status: status,
    health_reason: reasons.join("; ") || "Healthy baseline",
  };
}

async function readProjects(env) {
  if (!(await tableExists(env, "projects"))) return [];

  const columns = await getTableColumns(env, "projects");

  const idCol = pickFirstColumn(columns, ["id"]);
  const codeCol = pickFirstColumn(columns, ["project_code", "code"]);
  const nameCol = pickFirstColumn(columns, ["project_name", "name", "title"]);
  const typeCol = pickFirstColumn(columns, ["project_type", "type"]);
  const stageCol = pickFirstColumn(columns, ["stage", "current_stage"]);
  const ownerCol = pickFirstColumn(columns, ["owner", "owner_name", "assigned_to"]);
  const healthStatusCol = pickFirstColumn(columns, ["health_status", "status"]);
  const healthScoreCol = pickFirstColumn(columns, ["health_score"]);
  const createdAtCol = pickFirstColumn(columns, ["created_at"]);
  const dueDateCol = pickFirstColumn(columns, ["due_date", "target_date"]);

  const selectParts = [
    idCol ? `${idCol} AS id` : `NULL AS id`,
    codeCol ? `${codeCol} AS project_code` : `NULL AS project_code`,
    nameCol ? `${nameCol} AS project_name` : `NULL AS project_name`,
    typeCol ? `${typeCol} AS project_type` : `'GENERAL' AS project_type`,
    stageCol ? `${stageCol} AS stage` : `'intake' AS stage`,
    ownerCol ? `${ownerCol} AS owner` : `NULL AS owner`,
    healthStatusCol ? `${healthStatusCol} AS health_status` : `'on_track' AS health_status`,
    healthScoreCol ? `${healthScoreCol} AS health_score` : `100 AS health_score`,
    createdAtCol ? `${createdAtCol} AS created_at` : `NULL AS created_at`,
    dueDateCol ? `${dueDateCol} AS due_date` : `NULL AS due_date`,
  ];

  const orderBy = createdAtCol || idCol || "rowid";

  const rows = await safeAll(
    env,
    `SELECT ${selectParts.join(", ")} FROM projects ORDER BY ${orderBy} DESC`
  );

  return rows.map(normalizeRow);
}

async function enrichProjectsWithMetrics(env, projects) {
  const hasTasks = await tableExists(env, "tasks");
  const hasRisks = await tableExists(env, "risks");
  const hasBlockers = await tableExists(env, "blockers");
  const hasApprovals = await tableExists(env, "approvals");

  let taskColumns = hasTasks ? await getTableColumns(env, "tasks") : [];
  let riskColumns = hasRisks ? await getTableColumns(env, "risks") : [];
  let blockerColumns = hasBlockers ? await getTableColumns(env, "blockers") : [];
  let approvalColumns = hasApprovals ? await getTableColumns(env, "approvals") : [];

  const taskProjectCol = pickFirstColumn(taskColumns, ["project_id"]);
  const taskStatusCol = pickFirstColumn(taskColumns, ["status"]);
  const taskDueCol = pickFirstColumn(taskColumns, ["due_date"]);

  const riskProjectCol = pickFirstColumn(riskColumns, ["project_id"]);
  const riskStatusCol = pickFirstColumn(riskColumns, ["status"]);

  const blockerProjectCol = pickFirstColumn(blockerColumns, ["project_id"]);
  const blockerStatusCol = pickFirstColumn(blockerColumns, ["status"]);

  const approvalProjectCol = pickFirstColumn(approvalColumns, ["project_id"]);
  const approvalStatusCol = pickFirstColumn(approvalColumns, ["status"]);

  for (const p of projects) {
    const projectId = p.id;

    p.overdue_tasks = 0;
    p.task_count = 0;
    p.risk_count = 0;
    p.blocker_count = 0;
    p.pending_approvals = 0;

    if (projectId == null) {
      Object.assign(p, computeHealthFromProject(p));
      continue;
    }

    if (hasTasks && taskProjectCol) {
      const taskCountSql = `SELECT COUNT(*) AS c FROM tasks WHERE ${taskProjectCol} = ?`;
      const taskCountRow = await safeFirst(env, taskCountSql, [projectId]);
      p.task_count = Number(taskCountRow?.c || 0);

      if (taskDueCol) {
        const overdueSql = `
          SELECT COUNT(*) AS c
          FROM tasks
          WHERE ${taskProjectCol} = ?
            AND ${taskDueCol} IS NOT NULL
            AND date(${taskDueCol}) < date('now')
            ${taskStatusCol ? `AND LOWER(COALESCE(${taskStatusCol}, '')) NOT IN ('done','closed','completed','resolved')` : ""}
        `;
        const overdueRow = await safeFirst(env, overdueSql, [projectId]);
        p.overdue_tasks = Number(overdueRow?.c || 0);
      }
    }

    if (hasRisks && riskProjectCol) {
      const riskSql = `
        SELECT COUNT(*) AS c
        FROM risks
        WHERE ${riskProjectCol} = ?
        ${riskStatusCol ? `AND LOWER(COALESCE(${riskStatusCol}, 'open')) NOT IN ('closed','done','resolved')` : ""}
      `;
      const riskRow = await safeFirst(env, riskSql, [projectId]);
      p.risk_count = Number(riskRow?.c || 0);
    }

    if (hasBlockers && blockerProjectCol) {
      const blockerSql = `
        SELECT COUNT(*) AS c
        FROM blockers
        WHERE ${blockerProjectCol} = ?
        ${blockerStatusCol ? `AND LOWER(COALESCE(${blockerStatusCol}, 'open')) NOT IN ('closed','done','resolved')` : ""}
      `;
      const blockerRow = await safeFirst(env, blockerSql, [projectId]);
      p.blocker_count = Number(blockerRow?.c || 0);
    }

    if (hasApprovals && approvalProjectCol) {
      const approvalSql = `
        SELECT COUNT(*) AS c
        FROM approvals
        WHERE ${approvalProjectCol} = ?
        ${approvalStatusCol ? `AND LOWER(COALESCE(${approvalStatusCol}, 'pending')) IN ('pending','waiting')` : ""}
      `;
      const approvalRow = await safeFirst(env, approvalSql, [projectId]);
      p.pending_approvals = Number(approvalRow?.c || 0);
    }

    Object.assign(p, computeHealthFromProject(p));
  }

  return projects;
}

async function getSummary(env) {
  const projects = await enrichProjectsWithMetrics(env, await readProjects(env));

  const summary = {
    total_projects: projects.length,
    on_track: 0,
    at_risk: 0,
    delayed: 0,
    blocked: 0,
    avg_health_score: 0,
  };

  let totalScore = 0;

  for (const p of projects) {
    const status = p.health_status || "on_track";
    if (summary[status] !== undefined) summary[status] += 1;
    totalScore += Number(p.health_score || 0);
  }

  summary.avg_health_score =
    projects.length > 0 ? Math.round(totalScore / projects.length) : 0;

  return summary;
}

async function getWorkload(env) {
  const hasTasks = await tableExists(env, "tasks");
  if (!hasTasks) return [];

  const columns = await getTableColumns(env, "tasks");
  const ownerCol = pickFirstColumn(columns, ["owner", "assignee", "assigned_to"]);
  const statusCol = pickFirstColumn(columns, ["status"]);

  if (!ownerCol) return [];

  const sql = `
    SELECT
      COALESCE(${ownerCol}, 'Unassigned') AS owner,
      COUNT(*) AS active_tasks
    FROM tasks
    ${
      statusCol
        ? `WHERE LOWER(COALESCE(${statusCol}, 'open')) NOT IN ('done','closed','completed','resolved')`
        : ""
    }
    GROUP BY COALESCE(${ownerCol}, 'Unassigned')
    ORDER BY active_tasks DESC, owner ASC
  `;

  const rows = await safeAll(env, sql);
  return rows.map(normalizeRow);
}

async function getHeatmap(env) {
  const output = [];

  if (await tableExists(env, "risks")) {
    const cols = await getTableColumns(env, "risks");
    const severityCol = pickFirstColumn(cols, ["severity", "level", "risk_level"]);
    const statusCol = pickFirstColumn(cols, ["status"]);

    if (severityCol) {
      const sql = `
        SELECT
          COALESCE(${severityCol}, 'unknown') AS category,
          COUNT(*) AS count
        FROM risks
        ${
          statusCol
            ? `WHERE LOWER(COALESCE(${statusCol}, 'open')) NOT IN ('closed','done','resolved')`
            : ""
        }
        GROUP BY COALESCE(${severityCol}, 'unknown')
        ORDER BY count DESC, category ASC
      `;
      const rows = await safeAll(env, sql);
      for (const row of rows) {
        output.push({
          type: "risk",
          category: row.category,
          count: Number(row.count || 0),
        });
      }
    } else {
      const row = await safeFirst(env, `SELECT COUNT(*) AS c FROM risks`);
      output.push({
        type: "risk",
        category: "all",
        count: Number(row?.c || 0),
      });
    }
  }

  if (await tableExists(env, "blockers")) {
    const row = await safeFirst(env, `SELECT COUNT(*) AS c FROM blockers`);
    output.push({
      type: "blocker",
      category: "all",
      count: Number(row?.c || 0),
    });
  }

  return output;
}

async function getPendingApprovals(env) {
  if (!(await tableExists(env, "approvals"))) return [];

  const columns = await getTableColumns(env, "approvals");

  const idCol = pickFirstColumn(columns, ["id"]);
  const projectIdCol = pickFirstColumn(columns, ["project_id"]);
  const approverCol = pickFirstColumn(columns, ["approver", "owner", "reviewer"]);
  const statusCol = pickFirstColumn(columns, ["status"]);
  const createdAtCol = pickFirstColumn(columns, ["created_at"]);
  const commentCol = pickFirstColumn(columns, ["comment", "notes", "reason"]);

  const selectParts = [
    idCol ? `${idCol} AS id` : `NULL AS id`,
    projectIdCol ? `${projectIdCol} AS project_id` : `NULL AS project_id`,
    approverCol ? `${approverCol} AS approver` : `NULL AS approver`,
    statusCol ? `${statusCol} AS status` : `'pending' AS status`,
    createdAtCol ? `${createdAtCol} AS created_at` : `NULL AS created_at`,
    commentCol ? `${commentCol} AS comment` : `NULL AS comment`,
  ];

  const whereClause = statusCol
    ? `WHERE LOWER(COALESCE(${statusCol}, 'pending')) IN ('pending','waiting')`
    : "";

  const orderBy = createdAtCol || idCol || "rowid";

  const rows = await safeAll(
    env,
    `SELECT ${selectParts.join(", ")} FROM approvals ${whereClause} ORDER BY ${orderBy} DESC`
  );

  return rows.map(normalizeRow);
}

async function getProjectById(env, id) {
  const projects = await enrichProjectsWithMetrics(env, await readProjects(env));
  return projects.find((p) => String(p.id) === String(id)) || null;
}

async function recomputeProjectHealth(env, id) {
  const project = await getProjectById(env, id);
  if (!project) return null;

  const updateData = computeHealthFromProject(project);

  if (await tableExists(env, "projects")) {
    const columns = await getTableColumns(env, "projects");
    const idCol = pickFirstColumn(columns, ["id"]);
    const healthScoreCol = pickFirstColumn(columns, ["health_score"]);
    const healthStatusCol = pickFirstColumn(columns, ["health_status", "status"]);
    const healthReasonCol = pickFirstColumn(columns, ["health_reason"]);

    if (idCol && (healthScoreCol || healthStatusCol || healthReasonCol)) {
      const sets = [];
      const binds = [];

      if (healthScoreCol) {
        sets.push(`${healthScoreCol} = ?`);
        binds.push(updateData.health_score);
      }
      if (healthStatusCol) {
        sets.push(`${healthStatusCol} = ?`);
        binds.push(updateData.health_status);
      }
      if (healthReasonCol) {
        sets.push(`${healthReasonCol} = ?`);
        binds.push(updateData.health_reason);
      }

      if (sets.length > 0) {
        binds.push(id);
        await env.DB.prepare(
          `UPDATE projects SET ${sets.join(", ")} WHERE ${idCol} = ?`
        )
          .bind(...binds)
          .run();
      }
    }
  }

  return {
    ...project,
    ...updateData,
  };
}

function parsePath(pathname) {
  const projectDetail = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (projectDetail) return { route: "project_detail", id: projectDetail[1] };

  const recompute = pathname.match(/^\/api\/projects\/(\d+)\/recompute-health$/);
  if (recompute) return { route: "project_recompute", id: recompute[1] };

  return { route: pathname };
}

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    try {
      const url = new URL(request.url);
      const parsed = parsePath(url.pathname);

      if (url.pathname === "/health") {
        const health = {
          ok: true,
          service: env.APP_NAME || "Cyber Solution Delivery Platform",
          time: new Date().toISOString(),
        };

        try {
          if (env.DB) {
            const probe = await safeFirst(env, "SELECT 1 AS ok");
            health.db = probe?.ok === 1 ? "ok" : "unknown";
          } else {
            health.db = "missing_binding";
          }
        } catch (e) {
          health.db = "error";
          health.db_error = String(e.message || e);
        }

        return json(health, request, env);
      }

      if (url.pathname === "/api/projects") {
        const projects = await enrichProjectsWithMetrics(env, await readProjects(env));
        return json(projects, request, env);
      }

      if (parsed.route === "project_detail") {
        const project = await getProjectById(env, parsed.id);
        if (!project) return notFound(request, env);
        return json(project, request, env);
      }

      if (parsed.route === "project_recompute") {
        if (request.method !== "POST") {
          return json(
            { ok: false, error: "Method not allowed" },
            request,
            env,
            405
          );
        }

        const project = await recomputeProjectHealth(env, parsed.id);
        if (!project) return notFound(request, env);

        return json(
          {
            ok: true,
            project,
          },
          request,
          env
        );
      }

      if (url.pathname === "/api/dashboard/summary") {
        const summary = await getSummary(env);
        return json(summary, request, env);
      }

      if (url.pathname === "/api/dashboard/workload") {
        const workload = await getWorkload(env);
        return json(workload, request, env);
      }

      if (url.pathname === "/api/dashboard/heatmap") {
        const heatmap = await getHeatmap(env);
        return json(heatmap, request, env);
      }

      if (url.pathname === "/api/approvals/pending") {
        const approvals = await getPendingApprovals(env);
        return json(approvals, request, env);
      }

      if (url.pathname === "/telegram/webhook") {
        return json(
          {
            ok: true,
            message: "Webhook endpoint is alive",
          },
          request,
          env
        );
      }

      return notFound(request, env);
    } catch (err) {
      return json(
        {
          ok: false,
          error: String(err?.message || err),
          stack: err?.stack || null,
        },
        request,
        env,
        500
      );
    }
  },
};
