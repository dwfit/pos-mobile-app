// src/database/menu.ts
import { queryAll, execSql } from './db';

// ---- READ CATEGORIES ----
export async function getLocalCategories() {
  const rows = await queryAll<any>(
    'SELECT * FROM categories ORDER BY name ASC;',
  );
  return rows || [];
}

// ---- SAVE CATEGORIES SNAPSHOT ----
export async function saveCategories(list: any[]) {
  // Clear existing categories
  await execSql('DELETE FROM categories;');

  // Insert new ones in a single transaction
  const valuesSql = `
    INSERT INTO categories (id, name, imageUrl, isActive)
    VALUES (?, ?, ?, ?);
  `;

  for (const c of list) {
    await execSql(valuesSql, [
      c.id,
      c.name,
      c.imageUrl || null,
      c.isActive ? 1 : 0,
    ]);
  }
}
