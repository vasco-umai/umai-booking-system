-- Default meeting types
INSERT INTO meeting_types (name, label, duration_minutes, is_active)
VALUES
  ('online', 'Online', 120, true),
  ('in_person', 'In-Person', 120, true)
ON CONFLICT (name) DO NOTHING;

-- Plan-meeting type mappings: Mini gets online only, others get both
INSERT INTO plan_meeting_types (plan_name, meeting_type_id)
SELECT plan_name, mt.id
FROM (VALUES ('mini'), ('essencial'), ('pro'), ('proplus')) AS plans(plan_name)
CROSS JOIN meeting_types mt
WHERE NOT (plans.plan_name = 'mini' AND mt.name = 'in_person')
ON CONFLICT (plan_name, meeting_type_id) DO NOTHING;

-- All days available for both meeting types by default (0=Sun through 6=Sat)
INSERT INTO meeting_type_schedules (meeting_type_id, day_of_week, is_available)
SELECT mt.id, d.day, true
FROM meeting_types mt
CROSS JOIN (VALUES (0),(1),(2),(3),(4),(5),(6)) AS d(day)
ON CONFLICT (meeting_type_id, day_of_week) DO NOTHING;
