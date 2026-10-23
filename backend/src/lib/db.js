import { Pool } from 'pg';

let pool;
let useMemory = false;
const memory = { accounts: [], listings: [], labels: [] };

try {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', () => { useMemory = true; });
} catch (e) {
  useMemory = true;
}

export async function query(text, params) {
  if (useMemory || !pool) return { rows: [] };
  try {
    return await pool.query(text, params);
  } catch (e) {
    useMemory = true;
    return { rows: [] };
  }
}

export function mem(table) { return memory[table] || []; }
export function memPush(table, row) { (memory[table] ||= []).push(row); return row; }
export function memFind(table, fn) { return (memory[table] || []).find(fn); }
