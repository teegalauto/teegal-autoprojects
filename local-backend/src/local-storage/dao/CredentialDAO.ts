/**
 * Credential DAO - 凭据数据访问层
 * 🔥 encrypted_value 由 Electron 主进程用 safeStorage 加密/解密
 * DAO 只负责存储和读取，不做加密/解密
 */

import { localDatabase } from '../database';
import { Credential } from '../types';

export class CredentialDAO {
  /**
   * 创建凭据
   */
  create(credential: Omit<Credential, 'created_at' | 'updated_at'>): Credential {
    const db = localDatabase.getDb();
    const now = Date.now();

    const stmt = db.prepare(`
      INSERT INTO credentials (
        id, user_id, name, type, description,
        env_var, encrypted_value, source, provider, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      credential.id,
      credential.user_id,
      credential.name,
      credential.type,
      credential.description,
      credential.env_var,
      credential.encrypted_value,
      credential.source || 'user',
      credential.provider || null,
      now,
      now
    );

    return {
      ...credential,
      created_at: now,
      updated_at: now
    };
  }

  /**
   * 根据 ID 获取凭据（包含 encrypted_value）
   */
  getById(id: string): Credential | null {
    const db = localDatabase.getDb();
    const stmt = db.prepare('SELECT * FROM credentials WHERE id = ?');
    const row = stmt.get(id) as any;
    return row ? this.parseRow(row) : null;
  }

  /**
   * 根据名称获取凭据（包含 encrypted_value）
   */
  getByName(name: string, userId: string): Credential | null {
    const db = localDatabase.getDb();
    const stmt = db.prepare('SELECT * FROM credentials WHERE name = ? AND user_id = ?');
    const row = stmt.get(name, userId) as any;
    return row ? this.parseRow(row) : null;
  }

  /**
   * 获取用户的所有凭据（包含 encrypted_value）
   */
  getByUserId(userId: string): Credential[] {
    const db = localDatabase.getDb();
    const stmt = db.prepare('SELECT * FROM credentials WHERE user_id = ? ORDER BY updated_at DESC');
    const rows = stmt.all(userId) as any[];
    return rows.map(row => this.parseRow(row));
  }

  /**
   * 更新凭据
   */
  update(id: string, updates: Partial<Pick<Credential, 'name' | 'type' | 'description' | 'env_var' | 'encrypted_value'>>): boolean {
    const db = localDatabase.getDb();
    const now = Date.now();

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name); }
    if (updates.type !== undefined) { fields.push('type = ?'); values.push(updates.type); }
    if (updates.description !== undefined) { fields.push('description = ?'); values.push(updates.description); }
    if (updates.env_var !== undefined) { fields.push('env_var = ?'); values.push(updates.env_var); }
    if (updates.encrypted_value !== undefined) { fields.push('encrypted_value = ?'); values.push(updates.encrypted_value); }

    if (fields.length === 0) return false;

    fields.push('updated_at = ?');
    values.push(now);
    values.push(id);

    const stmt = db.prepare(`UPDATE credentials SET ${fields.join(', ')} WHERE id = ?`);
    const result = stmt.run(...values);
    return result.changes > 0;
  }

  /**
   * 删除凭据
   */
  delete(id: string): boolean {
    const db = localDatabase.getDb();
    const stmt = db.prepare('DELETE FROM credentials WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  private parseRow(row: any): Credential {
    return {
      id: row.id,
      user_id: row.user_id,
      name: row.name,
      type: row.type,
      description: row.description,
      env_var: row.env_var,
      encrypted_value: row.encrypted_value,
      source: row.source || 'user',
      provider: row.provider || undefined,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}

export const credentialDAO = new CredentialDAO();
