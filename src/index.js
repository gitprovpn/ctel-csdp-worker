function getAllowedOrigins(env) {
  const fromEnv = (env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return fromEnv.length
    ? fromEnv
    : ["https://gitprovpn.github.io","https://pjsa.pages.dev"];
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowedOrigins = getAllowedOrigins(env);

  let allowOrigin = "*";
  if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  } else if (allowedOrigins.length === 1) {
    allowOrigin = allowedOrigins[0];
  }

  const reqHeaders =
    request.headers.get("Access-Control-Request-Headers") ||
    "Content-Type, Authorization";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

function json(data, request, env, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function text(body, request, env, status = 200) {
  return new Response(body, {
    status,
    headers: {
      ...getCorsHeaders(request, env),
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function safeFirst(env, sql, binds = []) {
  return await env.DB.prepare(sql).bind(...binds).first();
}

async function safeAll(env, sql, binds = []) {
  const result = await env.DB.prepare(sql).bind(...binds).all();
  return result.results || [];
}

async function tableExists(env, tableName) {
  const row = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1`
  )
    .bind(tableName)
    .first();
  return !!row;
}

async function getColumns(env, tableName) {
  try {
    const result = await env.DB.prepare(`PRAGMA table_info(${tableName})`).all();
    return (result.results || []).map((r) => r.name);
  } catch {
    return [];
  }
}

function pick(columns, candidates, fallback = null) {
  for (const c of candidates) {
    if (columns.includes(c)) return c;
  }
  return fallback;
}

function computeHealth(project = {}) {
  let score = Number(project.health_score ?? 100);
  if (!Number.isFinite(score)) score = 100;

  const overdue = Number(project.overdue_tasks || 0);
  const blockers = Number(project.blocker_count || 0);
  const risks = Number(project.risk_count || 0);
  const approvals = Number(project.pending_approvals || 0);

  score -= overdue * 10;
  score -= blockers * 25;
  score -= Math.min(risks, 5) * 5;
  score -= approvals * 8;

  if (score < 0) score = 0;
  if (score > 100) score = 100;

  let health_status = "on_track";
  if (score < 50) health_status = "blocked";
  else if (score < 70) health_status = "delayed";
  else if (score < 85) health_status = "at_risk";

  const reasons = [];
  if (overdue) reasons.push(`Overdue tasks: ${overdue}`);
  if (blockers) reasons.push(`Blockers: ${blockers}`);
  if (risks) reasons.push(`Risks: ${risks}`);
  if (approvals) reasons.push(`Pending approvals: ${approvals}`);

  return {
    health_score: score,
    health_status,
    health_reason: reasons.join("; ") || "Healthy baseline",
  };
}

async function readProjects(env) {
  if (!(await tableExists(env, "projects"))) return [];
  const cols = await getColumns(env, "projects");
  const idCol = pick(cols, ["id"]); const codeCol = pick(cols, ["project_code", "code"]); const nameCol = pick(cols, ["project_name", "name", "title"]); const typeCol = pick(cols, ["project_type", "type"]); const stageCol = pick(cols, ["stage", "current_stage"]); const ownerCol = pick(cols, ["owner", "owner_name", "assigned_to"]); const ownerUserIdCol = pick(cols, ["owner_user_id"]); const statusCol = pick(cols, ["health_status", "status"]); const scoreCol = pick(cols, ["health_score"]); const reasonCol = pick(cols, ["health_reason"]); const createdAtCol = pick(cols, ["created_at"]); const updatedAtCol = pick(cols, ["updated_at"]); const dueDateCol = pick(cols, ["due_date", "target_date"]);
  const ownerNameExpr = ownerUserIdCol ? `(SELECT display_name FROM users u WHERE u.id = projects.${ownerUserIdCol} LIMIT 1)` : (ownerCol ? ownerCol : "NULL");
  const rows = await safeAll(env, `SELECT ${idCol ? `${idCol}` : "NULL"} AS id, ${codeCol ? `${codeCol}` : "NULL"} AS project_code, ${nameCol ? `${nameCol}` : "NULL"} AS project_name, ${typeCol ? `${typeCol}` : "'GENERAL'"} AS project_type, ${stageCol ? `${stageCol}` : "'intake'"} AS stage, ${ownerCol ? `${ownerCol}` : "NULL"} AS owner, ${ownerUserIdCol ? `${ownerUserIdCol}` : "NULL"} AS owner_user_id, ${ownerNameExpr} AS owner_name, ${statusCol ? `${statusCol}` : "'on_track'"} AS health_status, ${scoreCol ? `${scoreCol}` : "100"} AS health_score, ${reasonCol ? `${reasonCol}` : "'Healthy baseline'"} AS health_reason, ${createdAtCol ? `${createdAtCol}` : "NULL"} AS created_at, ${updatedAtCol ? `${updatedAtCol}` : "NULL"} AS updated_at, ${dueDateCol ? `${dueDateCol}` : "NULL"} AS due_date FROM projects ORDER BY ${updatedAtCol || createdAtCol || idCol || "rowid"} DESC`);
  return rows;
}

async function enrichProjects(env, projects) {
  const hasTasks = await tableExists(env, "tasks");
  const hasRisks = await tableExists(env, "risks");
  const hasBlockers = await tableExists(env, "blockers");
  const hasApprovals = await tableExists(env, "approvals");

  const taskCols = hasTasks ? await getColumns(env, "tasks") : [];
  const riskCols = hasRisks ? await getColumns(env, "risks") : [];
  const blockerCols = hasBlockers ? await getColumns(env, "blockers") : [];
  const approvalCols = hasApprovals ? await getColumns(env, "approvals") : [];

  const taskProjectCol = pick(taskCols, ["project_id"]);
  const taskStatusCol = pick(taskCols, ["status"]);
  const taskDueCol = pick(taskCols, ["due_date"]);
  const riskProjectCol = pick(riskCols, ["project_id"]);
  const riskStatusCol = pick(riskCols, ["status"]);
  const blockerProjectCol = pick(blockerCols, ["project_id"]);
  const blockerStatusCol = pick(blockerCols, ["status"]);
  const approvalProjectCol = pick(approvalCols, ["project_id"]);
  const approvalStatusCol = pick(approvalCols, ["status"]);

  for (const p of projects) {
    p.task_count = 0;
    p.overdue_tasks = 0;
    p.risk_count = 0;
    p.blocker_count = 0;
    p.pending_approvals = 0;

    if (p.id == null) {
      Object.assign(p, computeHealth(p));
      continue;
    }

    if (hasTasks && taskProjectCol) {
      const t = await safeFirst(
        env,
        `SELECT COUNT(*) AS c FROM tasks WHERE ${taskProjectCol} = ?`,
        [p.id]
      );
      p.task_count = Number(t?.c || 0);

      if (taskDueCol) {
        const o = await safeFirst(
          env,
          `SELECT COUNT(*) AS c
           FROM tasks
           WHERE ${taskProjectCol} = ?
             AND ${taskDueCol} IS NOT NULL
             AND date(${taskDueCol}) < date('now')
             ${taskStatusCol ? `AND LOWER(COALESCE(${taskStatusCol}, '')) NOT IN ('done','closed','completed','resolved')` : ""}`,
          [p.id]
        );
        p.overdue_tasks = Number(o?.c || 0);
      }
    }

    if (hasRisks && riskProjectCol) {
      const r = await safeFirst(
        env,
        `SELECT COUNT(*) AS c
         FROM risks
         WHERE ${riskProjectCol} = ?
         ${riskStatusCol ? `AND LOWER(COALESCE(${riskStatusCol}, 'open')) NOT IN ('done','closed','resolved')` : ""}`,
        [p.id]
      );
      p.risk_count = Number(r?.c || 0);
    }

    if (hasBlockers && blockerProjectCol) {
      const b = await safeFirst(
        env,
        `SELECT COUNT(*) AS c
         FROM blockers
         WHERE ${blockerProjectCol} = ?
         ${blockerStatusCol ? `AND LOWER(COALESCE(${blockerStatusCol}, 'open')) NOT IN ('done','closed','resolved')` : ""}`,
        [p.id]
      );
      p.blocker_count = Number(b?.c || 0);
    }

    if (hasApprovals && approvalProjectCol) {
      const a = await safeFirst(
        env,
        `SELECT COUNT(*) AS c
         FROM approvals
         WHERE ${approvalProjectCol} = ?
         ${approvalStatusCol ? `AND LOWER(COALESCE(${approvalStatusCol}, 'pending')) IN ('pending','waiting')` : ""}`,
        [p.id]
      );
      p.pending_approvals = Number(a?.c || 0);
    }

    Object.assign(p, computeHealth(p));
  }

  return projects;
}

async function getSummary(env) {
  const projects = await enrichProjects(env, await readProjects(env));
  const out = {
    total_projects: projects.length,
    on_track: 0,
    at_risk: 0,
    delayed: 0,
    blocked: 0,
    avg_health_score: 0,
  };

  let total = 0;
  for (const p of projects) {
    out[p.health_status] = (out[p.health_status] || 0) + 1;
    total += Number(p.health_score || 0);
  }
  out.avg_health_score = projects.length ? Math.round(total / projects.length) : 0;
  return out;
}

async function getWorkload(env) {
  if (!(await tableExists(env, "tasks"))) return [];

  const cols = await getColumns(env, "tasks");
  const ownerCol = pick(cols, ["owner", "assignee", "assigned_to"]);
  const statusCol = pick(cols, ["status"]);
  if (!ownerCol) return [];

  return await safeAll(
    env,
    `SELECT
       COALESCE(${ownerCol}, 'Unassigned') AS owner,
       COUNT(*) AS active_tasks
     FROM tasks
     ${statusCol ? `WHERE LOWER(COALESCE(${statusCol}, 'open')) NOT IN ('done','closed','completed','resolved')` : ""}
     GROUP BY COALESCE(${ownerCol}, 'Unassigned')
     ORDER BY active_tasks DESC, owner ASC`
  );
}

async function getHeatmap(env) {
  const out = [];

  if (await tableExists(env, "risks")) {
    const cols = await getColumns(env, "risks");
    const severityCol = pick(cols, ["severity", "level", "risk_level"]);
    const statusCol = pick(cols, ["status"]);

    if (severityCol) {
      const rows = await safeAll(
        env,
        `SELECT
           COALESCE(${severityCol}, 'unknown') AS category,
           COUNT(*) AS count
         FROM risks
         ${statusCol ? `WHERE LOWER(COALESCE(${statusCol}, 'open')) NOT IN ('done','closed','resolved')` : ""}
         GROUP BY COALESCE(${severityCol}, 'unknown')
         ORDER BY count DESC, category ASC`
      );
      for (const row of rows) {
        out.push({ type: "risk", category: row.category, count: Number(row.count || 0) });
      }
    } else {
      const r = await safeFirst(env, `SELECT COUNT(*) AS c FROM risks`);
      out.push({ type: "risk", category: "all", count: Number(r?.c || 0) });
    }
  }

  if (await tableExists(env, "blockers")) {
    const b = await safeFirst(env, `SELECT COUNT(*) AS c FROM blockers`);
    out.push({ type: "blocker", category: "all", count: Number(b?.c || 0) });
  }

  return out;
}

async function getPendingApprovals(env) {
  if (!(await tableExists(env, "approvals"))) return [];

  const cols = await getColumns(env, "approvals");
  const idCol = pick(cols, ["id"]);
  const projectIdCol = pick(cols, ["project_id"]);
  const approverCol = pick(cols, ["approver", "owner", "reviewer"]);
  const statusCol = pick(cols, ["status"]);
  const createdAtCol = pick(cols, ["created_at"]);
  const commentCol = pick(cols, ["comment", "notes", "reason"]);

  return await safeAll(
    env,
    `SELECT
       ${idCol ? idCol : "NULL"} AS id,
       ${projectIdCol ? projectIdCol : "NULL"} AS project_id,
       ${approverCol ? approverCol : "NULL"} AS approver,
       ${statusCol ? statusCol : "'pending'"} AS status,
       ${createdAtCol ? createdAtCol : "NULL"} AS created_at,
       ${commentCol ? commentCol : "NULL"} AS comment
     FROM approvals
     ${statusCol ? `WHERE LOWER(COALESCE(${statusCol}, 'pending')) IN ('pending','waiting')` : ""}
     ORDER BY ${createdAtCol || idCol || "rowid"} DESC`
  );
}


async function getUsers(env) {
  if (!(await tableExists(env, "users"))) return [];
  const cols = await getColumns(env, "users");
  const idCol = pick(cols, ["id"]); const nameCol = pick(cols, ["display_name", "name"]); const roleCol = pick(cols, ["role"]); const deptCol = pick(cols, ["department"]); const activeCol = pick(cols, ["is_active"]);
  return await safeAll(env, `SELECT ${idCol || "NULL"} AS id, ${nameCol || "NULL"} AS display_name, ${roleCol || "NULL"} AS role, ${deptCol || "NULL"} AS department FROM users ${activeCol ? `WHERE COALESCE(${activeCol},1)=1` : ""} ORDER BY ${nameCol || idCol || "rowid"} ASC`);
}

async function getProjectOptions(env) {
  const projects = await readProjects(env);
  return projects.map((p) => ({ id: p.id, name: p.project_name, project_code: p.project_code, owner_user_id: p.owner_user_id, owner_name: p.owner_name || p.owner, stage: p.stage, health_status: p.health_status, health_reason: p.health_reason }));
}

async function updateProjectAssignment(request, env, projectId) {
  const body = await request.json().catch(() => ({}));
  const id = Number(projectId); if (!Number.isFinite(id)) throw new Error("Invalid project id");
  const cols = await getColumns(env, "projects");
  const idCol = pick(cols, ["id"]); const ownerUserIdCol = pick(cols, ["owner_user_id"]); const ownerCol = pick(cols, ["owner", "owner_name", "assigned_to"]); const stageCol = pick(cols, ["stage", "current_stage"]); const statusCol = pick(cols, ["health_status", "status"]); const reasonCol = pick(cols, ["health_reason"]); const updatedAtCol = pick(cols, ["updated_at"]);
  const previous = await safeFirst(env, `SELECT * FROM projects WHERE ${idCol} = ? LIMIT 1`, [id]);
  if (!previous) return { ok: false, error: "Project not found" };
  const sets = []; const binds = []; const set = (col, value) => { if (!col || value === undefined) return; sets.push(`${col} = ?`); binds.push(value); };
  if (ownerUserIdCol && body.owner_user_id !== undefined) set(ownerUserIdCol, body.owner_user_id);
  if (ownerCol && body.owner_name !== undefined) set(ownerCol, body.owner_name);
  if (stageCol && body.stage !== undefined) set(stageCol, body.stage);
  if (statusCol && body.health_status !== undefined) set(statusCol, body.health_status);
  if (reasonCol && body.health_reason !== undefined) set(reasonCol, body.health_reason);
  if (updatedAtCol) set(updatedAtCol, new Date().toISOString());
  if (!sets.length) return { ok: false, error: "No supported fields to update" };
  binds.push(id);
  await env.DB.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE ${idCol} = ?`).bind(...binds).run();
  if (await tableExists(env, "audit_events")) {
    const auditCols = await getColumns(env, "audit_events");
    const fields = []; const placeholders = []; const values = []; const push = (col, val) => { if (!col) return; fields.push(col); placeholders.push("?"); values.push(val); };
    push(pick(auditCols, ["actor_user_id"]), body.owner_user_id ?? null); push(pick(auditCols, ["actor_source"]), "web"); push(pick(auditCols, ["entity_type"]), "project"); push(pick(auditCols, ["entity_id"]), id); push(pick(auditCols, ["action"]), "update_assignment"); push(pick(auditCols, ["previous_json"]), JSON.stringify(previous)); push(pick(auditCols, ["next_json"]), JSON.stringify(body)); push(pick(auditCols, ["metadata_json"]), JSON.stringify({ source: "sa-team-map-v6" }));
    if (fields.length) await env.DB.prepare(`INSERT INTO audit_events (${fields.join(", ")}) VALUES (${placeholders.join(", ")})`).bind(...values).run();
  }
  const updated = (await enrichProjects(env, await readProjects(env))).find((p) => Number(p.id) === id);
  return { ok: true, project: updated || null };
}

async function createProject(request, env) {
  const body = await request.json().catch(() => ({}));

  const code =
    body.project_code ||
    `CTEL-SA-${new Date().getUTCFullYear()}-${String(Date.now()).slice(-6)}`;

  const name = body.project_name || body.name || "Untitled Project";
  const type = body.project_type || "GENERAL";
  const stage = body.stage || "intake";
  const owner = body.owner || body.owner_name || "Unassigned";
  const ownerUserId = body.owner_user_id ?? null;
  const dueDate = body.due_date || null;
  const createdAt = new Date().toISOString();

  const cols = await getColumns(env, "projects");
  const codeCol = pick(cols, ["project_code", "code"]);
  const nameCol = pick(cols, ["project_name", "name", "title"]);
  const typeCol = pick(cols, ["project_type", "type"]);
  const stageCol = pick(cols, ["stage", "current_stage"]);
  const ownerCol = pick(cols, ["owner", "owner_name", "assigned_to"]);
  const ownerUserIdCol = pick(cols, ["owner_user_id"]);
  const dueDateCol = pick(cols, ["due_date", "target_date"]);
  const statusCol = pick(cols, ["health_status", "status"]);
  const scoreCol = pick(cols, ["health_score"]);
  const reasonCol = pick(cols, ["health_reason"]);
  const createdAtCol = pick(cols, ["created_at"]);

  const fields = [];
  const placeholders = [];
  const values = [];

  const push = (col, val) => {
    if (!col) return;
    fields.push(col);
    placeholders.push("?");
    values.push(val);
  };

  push(codeCol, code);
  push(nameCol, name);
  push(typeCol, type);
  push(stageCol, stage);
  push(ownerCol, owner);
  push(ownerUserIdCol, ownerUserId);
  push(dueDateCol, dueDate);
  push(statusCol, "on_track");
  push(scoreCol, 100);
  push(reasonCol, "Healthy baseline");
  push(createdAtCol, createdAt);

  if (!fields.length) {
    throw new Error("Projects table schema is incompatible");
  }

  await env.DB.prepare(
    `INSERT INTO projects (${fields.join(", ")}) VALUES (${placeholders.join(", ")})`
  )
    .bind(...values)
    .run();

  return {
    ok: true,
    project_code: code,
    project_name: name,
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request, env),
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/health") {
        let db = "unknown";
        try {
          const probe = await safeFirst(env, "SELECT 1 AS ok");
          db = probe?.ok === 1 ? "ok" : "unknown";
        } catch (e) {
          db = `error: ${String(e.message || e)}`;
        }

        return json(
          {
            ok: true,
            service: env.APP_NAME || "Cyber Solution Delivery Platform",
            time: new Date().toISOString(),
            db,
          },
          request,
          env
        );
      }

      if (path === "/api/projects" && request.method === "GET") {
        const projects = await enrichProjects(env, await readProjects(env));
        return json(projects, request, env);
      }

      if (path === "/api/projects" && request.method === "POST") {
        const result = await createProject(request, env);
        return json(result, request, env, 201);
      }

      if (path === "/api/users" && request.method === "GET") {
        return json(await getUsers(env), request, env);
      }

      if (path === "/api/projects/options" && request.method === "GET") {
        return json(await getProjectOptions(env), request, env);
      }

      const projectPatchMatch = path.match(/^\/api\/projects\/(\d+)$/);
      if (projectPatchMatch && request.method === "PATCH") {
        const result = await updateProjectAssignment(request, env, projectPatchMatch[1]);
        return json(result, request, env, result.ok === false ? 404 : 200);
      }

      if (path === "/api/dashboard/summary" && request.method === "GET") {
        return json(await getSummary(env), request, env);
      }

      if (path === "/api/dashboard/workload" && request.method === "GET") {
        return json(await getWorkload(env), request, env);
      }

      if (path === "/api/dashboard/heatmap" && request.method === "GET") {
        return json(await getHeatmap(env), request, env);
      }

      if (path === "/api/approvals/pending" && request.method === "GET") {
        return json(await getPendingApprovals(env), request, env);
      }

      return json(
        { ok: false, error: "Not found", path, method: request.method },
        request,
        env,
        404
      );
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
