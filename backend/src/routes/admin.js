import express from 'express';
import { query } from '../lib/db.js';
import { hashPassword, normalizePassword, verifyPassword } from '../lib/password.js';
import { signSession } from '../lib/session.js';

const router = express.Router();

const ROLES = new Set(['admin', 'operator']);

function normalizeUsername(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase();
}

function validUsername(value) {
  return /^[a-z0-9._-]{3,32}$/.test(value);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name || user.username,
    role: user.role,
    active: user.active !== false,
    last_login_at: user.last_login_at || null,
    created_at: user.created_at || null,
    legacy: false,
  };
}

function validateNewPassword(value) {
  const password = normalizePassword(value);
  if (password.length < 6) return { error: 'A senha precisa ter pelo menos 6 caracteres.' };
  if (password.length > 128) return { error: 'A senha pode ter no máximo 128 caracteres.' };
  return { password };
}

async function activeAdmins() {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS count FROM dashboard_users WHERE role = 'admin' AND active = TRUE"
  );
  return Number(rows[0]?.count) || 0;
}

router.use((req, res, next) => {
  if (req.dashboardUser?.role !== 'admin') {
    return res.status(403).json({
      error: 'Acesso restrito a administradores.',
      code: 'ADMIN_REQUIRED',
    });
  }
  return next();
});

router.get('/usuarios', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, username, name, role, active, last_login_at, created_at
       FROM dashboard_users
       ORDER BY id ASC`
    );
    res.json(rows.map(publicUser));
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios', async (req, res, next) => {
  try {
    const username = normalizeUsername(req.body?.username);
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const role = ROLES.has(req.body?.role) ? req.body.role : 'operator';
    const { password, error } = validateNewPassword(req.body?.password);

    if (!validUsername(username)) {
      return res.status(400).json({
        error: 'Usuário inválido. Use 3 a 32 caracteres: letras, números, ponto, hífen ou sublinhado.',
      });
    }
    if (error) return res.status(400).json({ error });

    const existing = await query('SELECT 1 FROM dashboard_users WHERE username = $1', [
      username,
    ]);
    if (existing.rowCount) {
      return res.status(409).json({ error: 'Este usuário já existe.' });
    }

    const { rows } = await query(
      `INSERT INTO dashboard_users (username, name, password_hash, role, active)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING id, username, name, role, active, last_login_at, created_at`,
      [username, name || username, hashPassword(password), role]
    );
    res.status(201).json(publicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.patch('/usuarios/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Usuário inválido.' });
    }

    const targetResult = await query('SELECT * FROM dashboard_users WHERE id = $1', [id]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

    const name =
      req.body?.name === undefined
        ? target.name
        : String(req.body.name || '').trim().slice(0, 80) || target.username;
    const role =
      req.body?.role === undefined
        ? target.role
        : ROLES.has(req.body.role)
          ? req.body.role
          : null;
    const active =
      req.body?.active === undefined ? target.active : Boolean(req.body.active);

    if (!role) return res.status(400).json({ error: 'Perfil inválido.' });
    if (id === req.dashboardUser.id && (!active || role !== 'admin')) {
      return res.status(400).json({
        error: 'Você não pode desativar nem remover o seu próprio acesso de administrador.',
      });
    }

    if (target.role === 'admin' && target.active && (role !== 'admin' || !active)) {
      if ((await activeAdmins()) <= 1) {
        return res.status(400).json({
          error: 'Mantenha pelo menos um administrador ativo.',
        });
      }
    }

    const { rows } = await query(
      `UPDATE dashboard_users
       SET name = $2, role = $3, active = $4, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, name, role, active, last_login_at, created_at`,
      [id, name, role, active]
    );
    res.json(publicUser(rows[0]));
  } catch (err) {
    next(err);
  }
});

router.post('/usuarios/:id/senha', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Usuário inválido.' });
    }

    const { password, error } = validateNewPassword(
      req.body?.new_password || req.body?.password
    );
    if (error) return res.status(400).json({ error });

    const targetResult = await query('SELECT * FROM dashboard_users WHERE id = $1', [id]);
    if (!targetResult.rowCount) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const { rows } = await query(
      `UPDATE dashboard_users
       SET password_hash = $2, token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, name, role, active, token_version, last_login_at, created_at`,
      [id, hashPassword(password)]
    );

    const user = rows[0];
    res.json({
      ok: true,
      user: publicUser(user),
      token: id === req.dashboardUser.id ? signSession(user) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/senha', async (req, res, next) => {
  try {
    const currentPassword = normalizePassword(req.body?.current_password);
    const { password, error } = validateNewPassword(req.body?.new_password);
    if (error) return res.status(400).json({ error });

    if (req.dashboardUser.legacy || !req.dashboardUser.id) {
      const username = req.dashboardUser.username || 'admin';
      const { rows } = await query(
        `INSERT INTO dashboard_users (username, name, password_hash, role, active)
         VALUES ($1, 'Administrador', $2, 'admin', TRUE)
         ON CONFLICT (username) DO UPDATE SET
           password_hash = EXCLUDED.password_hash,
           token_version = dashboard_users.token_version + 1,
           updated_at = NOW()
         RETURNING id, username, name, role, active, token_version, last_login_at, created_at`,
        [username, hashPassword(password)]
      );
      const user = rows[0];
      return res.json({
        ok: true,
        user: publicUser(user),
        token: signSession(user),
      });
    }

    const { rows } = await query('SELECT * FROM dashboard_users WHERE id = $1', [
      req.dashboardUser.id,
    ]);
    const user = rows[0];
    if (!user || !user.active) {
      return res.status(401).json({ error: 'Sessão inválida. Entre novamente.' });
    }
    if (!verifyPassword(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: 'Senha atual incorreta.' });
    }

    const updated = await query(
      `UPDATE dashboard_users
       SET password_hash = $2, token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, name, role, active, token_version, last_login_at, created_at`,
      [user.id, hashPassword(password)]
    );
    const nextUser = updated.rows[0];
    res.json({
      ok: true,
      user: publicUser(nextUser),
      token: signSession(nextUser),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/usuarios/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Usuário inválido.' });
    }
    if (id === req.dashboardUser.id) {
      return res.status(400).json({ error: 'Você não pode excluir o seu próprio usuário.' });
    }

    const targetResult = await query('SELECT * FROM dashboard_users WHERE id = $1', [id]);
    const target = targetResult.rows[0];
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado.' });

    if (target.role === 'admin' && target.active && (await activeAdmins()) <= 1) {
      return res.status(400).json({ error: 'Mantenha pelo menos um administrador ativo.' });
    }

    await query('DELETE FROM dashboard_users WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
