-- Default schedule: Mon-Fri, 10:00-19:00, 60-minute slots, Europe/Lisbon
INSERT INTO schedules (day_of_week, start_time, end_time, slot_duration, timezone, is_active)
VALUES
  (1, '10:00', '19:00', 60, 'Europe/Lisbon', true),
  (2, '10:00', '19:00', 60, 'Europe/Lisbon', true),
  (3, '10:00', '19:00', 60, 'Europe/Lisbon', true),
  (4, '10:00', '19:00', 60, 'Europe/Lisbon', true),
  (5, '10:00', '19:00', 60, 'Europe/Lisbon', true)
ON CONFLICT DO NOTHING;

-- Default admin user (password: admin123 — change in production!)
-- bcrypt hash of 'admin123'
INSERT INTO admin_users (email, password_hash, name, role)
VALUES ('admin@umai.io', '$2a$10$95CmZBGWV6Z8SYY57oK6YOR43gFyT97pchfDJuE4SCqEdehjXzsNi', 'UMAI Admin', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Vasco (restricted, set password on first login)
INSERT INTO admin_users (email, name, must_set_password, role)
VALUES ('vasco.n@letsumai.com', 'Vasco Neves', true, 'restricted')
ON CONFLICT (email) DO NOTHING;

-- Margarida (admin, set password on first login)
INSERT INTO admin_users (email, name, must_set_password, role)
VALUES ('margarida.c@letsumai.com', 'Margarida', true, 'admin')
ON CONFLICT (email) DO NOTHING;
