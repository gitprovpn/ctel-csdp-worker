INSERT INTO users (email, display_name, telegram_user_id, telegram_username, role, department) VALUES
('anh.nguyen@ctel.vn', 'Anh Nguyen', '10001', 'anh_nguyen', 'admin', 'Cyber Solution Architect'),
('thu.tran@ctel.vn', 'Thu Tran', '10002', 'thu_tran', 'approver', 'Cyber Solution Architect'),
('minh.le@ctel.vn', 'Minh Le', '10003', 'minh_le', 'sa', 'Cyber Solution Architect'),
('linh.pham@ctel.vn', 'Linh Pham', '10004', 'linh_pham', 'observer', 'PMO');

INSERT INTO telegram_chats (telegram_chat_id, title, type, purpose) VALUES
('-100111', 'CTEL SA Cyber Ops', 'group', 'ops'),
('-100112', 'CTEL SA Cyber Approvals', 'group', 'approvals'),
('-100113', 'CTEL SA Cyber Management', 'group', 'management');

INSERT INTO projects (code, name, customer_name, service_line, type, status, priority, stage, owner_user_id, requester_user_id, sponsor_user_id, health_score, health_status, health_reason, intake_sla_due_at, design_review_due_at, quotation_due_at, handover_due_at, start_date, due_date, description)
VALUES
('CTEL-SA-2026-001', 'SOC Modernization & Design Review', 'ABC Manufacturing', 'security_solution', 'presales', 'active', 'high', 'design_review', 1, 3, 2, 72, 'amber', 'Pending design review and one overdue task.', '2026-03-20', '2026-03-27', '2026-03-31', '2026-04-15', '2026-03-18', '2026-04-15', 'Zero Trust + SOC modernization package'),
('CTEL-SA-2026-002', 'Secure SD-WAN Delivery', 'Finbank VN', 'security_solution', 'delivery', 'at_risk', 'critical', 'implementation', 3, 1, 2, 48, 'red', 'Critical blocker open and approval expired.', '2026-03-12', '2026-03-19', '2026-03-25', '2026-04-12', '2026-03-10', '2026-04-12', 'Delivery coordination for secure SD-WAN rollout');

INSERT INTO tasks (project_id, title, description, bucket, status, priority, category, assignee_user_id, reporter_user_id, due_date, estimate_hours, sequence_no)
VALUES
(1, 'Draft HLD', 'Prepare HLD pack for design review', 'in_progress', 'in_progress', 'high', 'design', 3, 1, '2026-03-26', 6, 1),
(1, 'Vendor clarification', 'Collect final BOM constraints', 'review', 'blocked', 'medium', 'vendor', 1, 3, '2026-03-24', 3, 2),
(2, 'Firewall rule matrix', 'Finalize for change window', 'in_progress', 'review', 'critical', 'delivery', 3, 1, '2026-03-23', 5, 1),
(2, 'Customer handover deck', 'Prepare handover package', 'backlog', 'todo', 'high', 'handover', 1, 3, '2026-04-10', 4, 2);

INSERT INTO risks (project_id, title, description, severity, likelihood, risk_score, mitigation_plan, owner_user_id, status, due_date)
VALUES
(1, 'Vendor BOM delay', 'Awaiting vendor sizing confirmation', 'medium', 3, 9, 'Escalate with vendor TAM and prepare fallback BOM', 1, 'open', '2026-03-27'),
(2, 'Change window approval risk', 'Customer CAB may slip', 'high', 4, 16, 'Get pre-approval from customer CAB coordinator', 3, 'open', '2026-03-26');

INSERT INTO blockers (project_id, task_id, title, description, owner_user_id, severity, status, due_date, escalation_chat_id)
VALUES
(2, 3, 'Customer dependency unresolved', 'Pending customer IP plan sign-off', 1, 'critical', 'open', '2026-03-25', 1);

INSERT INTO approvals (project_id, deliverable_id, title, requestor_user_id, approver_user_id, status, expires_at)
VALUES
(1, NULL, 'Approve HLD for customer submission', 1, 2, 'pending', '2026-03-27 10:00:00'),
(2, NULL, 'Approve change freeze exception', 3, 2, 'pending', '2026-03-24 16:00:00');
