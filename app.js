(function () {
  "use strict";

  const APP_CONFIG = window.APP_CONFIG || {};
  const API_BASE = String(APP_CONFIG.apiBaseUrl || "").replace(/\/$/, "");

  const MEMBERS = [
    { id: "phuc", name: "Phúc", aliases: ["phúc", "phuc"], role: "Lead / Presales", color: "#22d3ee", zone: "presales" },
    { id: "thanh", name: "Thanh", aliases: ["thanh"], role: "Architecture", color: "#a78bfa", zone: "delivery" },
    { id: "tuan", name: "Tuấn", aliases: ["tuấn", "tuan"], role: "Delivery", color: "#60a5fa", zone: "delivery" },
    { id: "phu", name: "Phú", aliases: ["phú", "phu"], role: "Security Review", color: "#f59e0b", zone: "review" },
    { id: "an", name: "An", aliases: ["an"], role: "Support / Coordination", color: "#34d399", zone: "support" }
  ];

  const ZONES = {
    presales: { label: "Presales", x: 160, y: 150 },
    delivery: { label: "Delivery", x: 430, y: 310 },
    review: { label: "Review", x: 650, y: 170 },
    meeting: { label: "Meeting", x: 460, y: 120 },
    support: { label: "Support", x: 760, y: 330 },
    unknown: { label: "Other", x: 120, y: 360 }
  };

  const STATUS_LABELS = {
    on_track: "On track",
    at_risk: "At risk",
    delayed: "Delayed",
    blocked: "Blocked",
    done: "Done"
  };

  const els = {
    summaryCards: document.getElementById("summaryCards"),
    memberBoard: document.getElementById("memberBoard"),
    projectList: document.getElementById("projectList"),
    projectCount: document.getElementById("projectCount"),
    activeFilterText: document.getElementById("activeFilterText"),
    pixelLegend: document.getElementById("pixelLegend"),
    pixelCanvas: document.getElementById("pixelCanvas"),
    refreshBtn: document.getElementById("refreshBtn"),
    apiBadge: document.getElementById("apiBadge"),
    apiStatusText: document.getElementById("apiStatusText")
  };

  const ctx = els.pixelCanvas.getContext("2d");
  const state = {
    projects: [],
    activeMemberId: null,
    connectionOk: false,
    connectionMessage: "",
    tick: 0
  };

  init();

  function init() {
    bindEvents();
    refreshData();
  }

  function bindEvents() {
    els.refreshBtn.addEventListener("click", refreshData);
  }

  async function refreshData() {
    setConnectionState("checking", "Đang kiểm tra backend và tải dữ liệu…");
    try {
      await checkHealth();
      const projects = await fetchJson("/api/projects");
      state.projects = Array.isArray(projects) ? projects.map(normalizeProject) : [];
      setConnectionState("good", `Kết nối backend thành công • ${state.projects.length} dự án đã tải.`);
      render();
    } catch (error) {
      state.projects = [];
      setConnectionState("bad", `Không thể tải dữ liệu từ backend. ${error.message || error}`);
      render();
    }
  }

  async function checkHealth() {
    const health = await fetchJson("/health");
    if (!health || health.ok !== true) {
      throw new Error("Backend health check failed");
    }
    return health;
  }

  async function fetchJson(path) {
    if (!API_BASE) throw new Error("Thiếu apiBaseUrl trong config.js");
    const response = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`${response.status} ${response.statusText}${text ? ` • ${text.slice(0, 160)}` : ""}`);
    }
    return await response.json();
  }

  function setConnectionState(type, message) {
    state.connectionOk = type === "good";
    state.connectionMessage = message;
    els.apiBadge.textContent = type === "good" ? "Connected" : type === "bad" ? "Offline" : "Checking…";
    els.apiBadge.className = `chip ${type === "good" ? "good" : type === "bad" ? "bad" : "neutral"}`;
    els.apiStatusText.textContent = message;
  }

  function normalizeProject(raw) {
    const ownerId = matchMemberId(raw.owner);
    const status = normalizeStatus(raw.health_status || raw.status);
    const zone = mapZone(raw.stage, ownerId);
    return {
      id: raw.id ?? raw.project_code ?? cryptoRandom(),
      name: raw.project_name || raw.name || raw.project_code || "Untitled Project",
      code: raw.project_code || null,
      ownerId,
      ownerName: findMember(ownerId)?.name || raw.owner || "Unassigned",
      projectType: raw.project_type || "GENERAL",
      stage: raw.stage || "intake",
      status,
      score: safeNumber(raw.health_score, 0),
      reason: raw.health_reason || "",
      dueDate: raw.due_date || null,
      createdAt: raw.created_at || null,
      zone
    };
  }

  function render() {
    renderSummary();
    renderMembers();
    renderProjects();
    renderLegend();
    drawPixelMap();
  }

  function renderSummary() {
    const total = state.projects.length;
    const active = state.projects.filter((p) => p.status !== "done").length;
    const risk = state.projects.filter((p) => ["at_risk", "delayed", "blocked"].includes(p.status)).length;
    const done = state.projects.filter((p) => p.status === "done").length;
    const busyMembers = new Set(state.projects.filter((p) => p.status !== "done").map((p) => p.ownerId)).size;
    const avgScore = total ? Math.round(state.projects.reduce((sum, p) => sum + safeNumber(p.score, 0), 0) / total) : 0;

    const cards = [
      ["Tổng dự án", total],
      ["Đang active", active],
      ["Cần chú ý", risk],
      ["Đã xong", done],
      ["Người đang bận", busyMembers],
      ["Avg health", `${avgScore}%`]
    ];

    els.summaryCards.innerHTML = cards.map(([label, value]) => `
      <article class="summary-card">
        <div class="summary-label">${label}</div>
        <div class="summary-value">${value}</div>
      </article>
    `).join("");
  }

  function renderMembers() {
    els.activeFilterText.textContent = state.activeMemberId
      ? `Đang lọc: ${findMember(state.activeMemberId)?.name || state.activeMemberId}`
      : "Tất cả thành viên";

    els.memberBoard.innerHTML = MEMBERS.map((member) => {
      const items = state.projects.filter((p) => p.ownerId === member.id);
      const active = items.filter((p) => p.status !== "done").length;
      const risky = items.filter((p) => ["at_risk", "delayed", "blocked"].includes(p.status)).length;
      const done = items.filter((p) => p.status === "done").length;
      return `
        <article class="member-card ${state.activeMemberId === member.id ? "active" : ""}" data-member-id="${member.id}">
          <div class="member-top">
            <div>
              <div class="member-name">${member.name}</div>
              <div class="member-role">${member.role}</div>
            </div>
            <div class="chip">${items.length} dự án</div>
          </div>
          <div class="member-stats">
            <div class="stat-pill"><strong>${active}</strong><span class="mini-text">Active</span></div>
            <div class="stat-pill"><strong>${risky}</strong><span class="mini-text">Risk</span></div>
            <div class="stat-pill"><strong>${done}</strong><span class="mini-text">Done</span></div>
          </div>
        </article>
      `;
    }).join("");

    els.memberBoard.querySelectorAll(".member-card").forEach((card) => {
      card.addEventListener("click", () => {
        const id = card.dataset.memberId;
        state.activeMemberId = state.activeMemberId === id ? null : id;
        render();
      });
    });
  }

  function renderProjects() {
    const visibleProjects = state.activeMemberId
      ? state.projects.filter((p) => p.ownerId === state.activeMemberId)
      : state.projects;

    els.projectCount.textContent = `${visibleProjects.length} dự án`;

    if (!visibleProjects.length) {
      els.projectList.innerHTML = `<div class="empty">Chưa có dữ liệu dự án phù hợp hoặc backend chưa trả về dữ liệu.</div>`;
      return;
    }

    els.projectList.innerHTML = visibleProjects.map((project) => `
      <article class="project-card">
        <div class="project-top">
          <div>
            <div class="project-name">${escapeHtml(project.name)}</div>
            <div class="mini-text">${escapeHtml(project.ownerName)} • ${escapeHtml(getZoneLabel(project.zone))} • ${escapeHtml(project.projectType)}</div>
          </div>
          <div class="chip status-${project.status}">${STATUS_LABELS[project.status] || project.status}</div>
        </div>
        <div class="project-meta">
          ${project.code ? `<div class="chip">Code: ${escapeHtml(project.code)}</div>` : ""}
          <div class="chip">Stage: ${escapeHtml(project.stage)}</div>
          <div class="chip">Health: ${safeNumber(project.score, 0)}%</div>
          ${project.dueDate ? `<div class="chip">Due: ${escapeHtml(project.dueDate)}</div>` : ""}
        </div>
        <div class="project-note">${escapeHtml(project.reason || "Chưa có ghi chú health_reason từ backend.")}</div>
      </article>
    `).join("");
  }

  function renderLegend() {
    els.pixelLegend.innerHTML = MEMBERS.map((member) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${member.color}"></span>
        <span>${member.name}</span>
      </div>
    `).join("");
  }

  function drawPixelMap() {
    const canvas = els.pixelCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    state.tick += 1;

    drawBackground(canvas.width, canvas.height);
    drawZones();
    drawRoads();
    drawPeopleAndProjects();
  }

  function drawBackground(width, height) {
    fillRect(0, 0, width, height, "#091423");
    fillRect(0, 380, width, 140, "#0c1b2c");
    for (let i = 0; i < 80; i += 1) {
      fillRect((i * 47) % width, (i * 31) % 180, 2, 2, i % 5 === 0 ? "#203854" : "#15263e");
    }
  }

  function drawZones() {
    Object.entries(ZONES).forEach(([key, zone]) => {
      drawPanel(zone.x - 78, zone.y - 42, 156, 84, key === "meeting" ? "#18304a" : "#11253b");
      pixelText(zone.label.toUpperCase(), zone.x - 54, zone.y - 8, "#b9d5ff");
    });
  }

  function drawRoads() {
    const lines = [
      [160, 150, 430, 310],
      [430, 310, 650, 170],
      [430, 310, 760, 330],
      [430, 310, 460, 120]
    ];
    lines.forEach(([x1, y1, x2, y2]) => drawLine(x1, y1, x2, y2, "#1f3858"));
  }

  function drawPeopleAndProjects() {
    const visibleProjects = state.activeMemberId
      ? state.projects.filter((p) => p.ownerId === state.activeMemberId)
      : state.projects;

    MEMBERS.forEach((member, index) => {
      const own = visibleProjects.filter((p) => p.ownerId === member.id);
      const baseZone = ZONES[member.zone] || ZONES.unknown;
      const wobble = Math.sin((state.tick + index * 8) / 12) * 3;
      drawSprite(baseZone.x - 12 + wobble, baseZone.y + 26, member.color);

      own.forEach((project, itemIndex) => {
        const zone = ZONES[project.zone] || ZONES.unknown;
        const px = zone.x - 36 + (itemIndex % 4) * 24;
        const py = zone.y - 24 + Math.floor(itemIndex / 4) * 18;
        fillRect(px, py, 12, 12, member.color);
        strokeRect(px, py, 12, 12, project.status === "blocked" ? "#fecdd3" : "#07111f");
      });
    });
  }

  function drawSprite(x, y, color) {
    fillRect(x + 4, y, 8, 8, "#f8d7b5");
    fillRect(x + 2, y + 8, 12, 10, color);
    fillRect(x, y + 18, 6, 8, color);
    fillRect(x + 10, y + 18, 6, 8, color);
  }

  function drawPanel(x, y, w, h, color) {
    fillRect(x, y, w, h, color);
    strokeRect(x, y, w, h, "#2a466a");
  }

  function fillRect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }

  function strokeRect(x, y, w, h, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
  }

  function drawLine(x1, y1, x2, y2, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  function pixelText(text, x, y, color) {
    ctx.fillStyle = color;
    ctx.font = "24px VT323";
    ctx.fillText(text, x, y);
  }

  function matchMemberId(owner) {
    const normalized = normalizeText(owner || "");
    const found = MEMBERS.find((member) => member.aliases.some((alias) => normalized.includes(normalizeText(alias))));
    return found ? found.id : "unknown";
  }

  function mapZone(stage, ownerId) {
    const normalized = normalizeText(stage || "");
    if (normalized.includes("presale") || normalized.includes("proposal") || normalized.includes("intake")) return "presales";
    if (normalized.includes("review") || normalized.includes("assessment") || normalized.includes("design")) return "review";
    if (normalized.includes("meeting") || normalized.includes("sync")) return "meeting";
    if (normalized.includes("support") || normalized.includes("handover")) return "support";
    if (normalized.includes("delivery") || normalized.includes("implement") || normalized.includes("deploy") || normalized.includes("rollout")) return "delivery";
    return findMember(ownerId)?.zone || "unknown";
  }

  function normalizeStatus(value) {
    const normalized = normalizeText(value || "");
    if (["done", "completed", "closed", "resolved"].some((x) => normalized.includes(x))) return "done";
    if (normalized.includes("block")) return "blocked";
    if (normalized.includes("delay")) return "delayed";
    if (normalized.includes("risk")) return "at_risk";
    return "on_track";
  }

  function getZoneLabel(zone) {
    return ZONES[zone]?.label || "Other";
  }

  function findMember(id) {
    return MEMBERS.find((member) => member.id === id) || null;
  }

  function normalizeText(input) {
    return String(input || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .trim();
  }

  function safeNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function cryptoRandom() {
    return (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
})();
