import readline from 'node:readline';
import '../src/env.js';
import { query } from '../src/lib/db.js';
import { hashPassword, normalizePassword } from '../src/lib/password.js';

function askHidden(label) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    const originalWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (text) => {
      if (text.includes('\n') || text.includes('\r')) originalWrite(text);
      else originalWrite('*');
    };
    rl.question(label, (answer) => {
      rl.close();
      originalWrite('\n');
      resolve(answer);
    });
  });
}

async function main() {
  console.log('Definicao da senha de acesso ao painel MeLi Max Shop');
  console.log('A senha sera gravada com hash scrypt no banco Neon.');
  console.log('');

  const first = normalizePassword(await askHidden('Nova senha: '));
  if (first.length < 6) {
    console.error('A senha precisa ter pelo menos 6 caracteres.');
    process.exitCode = 1;
    return;
  }
  if (first.length > 128) {
    console.error('A senha pode ter no maximo 128 caracteres.');
    process.exitCode = 1;
    return;
  }

  const second = normalizePassword(await askHidden('Confirme a senha: '));
  if (first !== second) {
    console.error('As senhas nao conferem.');
    process.exitCode = 1;
    return;
  }

  const username = 'admin';
  const existing = await query('SELECT id FROM dashboard_users WHERE username = $1 LIMIT 1', [
    username,
  ]);

  if (existing.rowCount) {
    await query(
      `UPDATE dashboard_users
       SET password_hash = $2, active = TRUE, token_version = token_version + 1, updated_at = NOW()
       WHERE id = $1`,
      [existing.rows[0].id, hashPassword(first)]
    );
    console.log('Senha do usuario admin atualizada com sucesso.');
  } else {
    await query(
      `INSERT INTO dashboard_users (username, name, password_hash, role, active)
       VALUES ($1, 'Administrador', $2, 'admin', TRUE)`,
      [username, hashPassword(first)]
    );
    console.log('Usuario admin criado com sucesso.');
  }

  console.log('Acesse o painel e entre com a senha definida.');
}

main()
  .catch((err) => {
    console.error('Erro ao definir a senha:', err.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
