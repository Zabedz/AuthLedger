-- Role-based access control. Roles and the permissions they grant are reference
-- data seeded here (the role x action matrix lives in the schema, versioned with
-- the code that enforces it); which user holds which role is runtime data in
-- user_roles. Permission checks resolve per request, so a role change takes
-- effect on the next request without re-issuing the session.

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  name text NOT NULL UNIQUE,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A permission is a single action string, namespaced by domain (users.read,
-- roles.assign). Routes require one of these; the set of legal actions is fixed
-- here and mirrored by the PermissionAction type in code.
CREATE TABLE permissions (
  action text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE role_permissions (
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  action text NOT NULL REFERENCES permissions (action) ON DELETE CASCADE,
  PRIMARY KEY (role_id, action)
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id uuid NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users (id) ON DELETE SET NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

INSERT INTO permissions (action, description) VALUES
  ('users.read', 'List and view any user account'),
  ('roles.assign', 'Grant and revoke roles on any user'),
  ('audit.read', 'Read the audit event log'),
  ('sessions.revoke_any', 'Revoke sessions belonging to another user');

INSERT INTO roles (name, description) VALUES
  ('admin', 'Full administrative access to identity management'),
  ('auditor', 'Read-only access to accounts and the audit log');

-- admin holds every permission; auditor is read-only.
INSERT INTO role_permissions (role_id, action)
SELECT r.id, p.action
FROM roles r
CROSS JOIN permissions p
WHERE r.name = 'admin';

INSERT INTO role_permissions (role_id, action)
SELECT r.id, p.action
FROM roles r
JOIN permissions p ON p.action IN ('users.read', 'audit.read')
WHERE r.name = 'auditor';
