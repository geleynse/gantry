import { getDb, queryOne, queryAll } from './database.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('recipe-registry');

export interface RecipeInput {
  item_id: string;
  quantity: number;
}

export interface RecipeSkill {
  skill_id: string;
  level: number;
}

export interface Recipe {
  id: string;
  output_item_id: string;
  output_quantity: number;
  inputs: RecipeInput[];
  skills?: RecipeSkill[];
  time_seconds?: number;
  updated_at?: string;
}

/**
 * RecipeRegistry — Manages persistent knowledge of crafting recipes.
 */
export function registerRecipe(recipe: Recipe): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO game_recipes (
        id, output_item_id, output_quantity, inputs_json, skills_json, time_seconds, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        output_item_id = excluded.output_item_id,
        output_quantity = excluded.output_quantity,
        inputs_json = excluded.inputs_json,
        skills_json = excluded.skills_json,
        time_seconds = excluded.time_seconds,
        updated_at = datetime('now')
    `).run(
      recipe.id,
      recipe.output_item_id,
      recipe.output_quantity,
      JSON.stringify(recipe.inputs),
      recipe.skills ? JSON.stringify(recipe.skills) : null,
      recipe.time_seconds ?? null
    );
    
    log.info(`Registered recipe: ${recipe.id} (produces ${recipe.output_item_id})`);
  } catch (e) {
    log.error(`Failed to register recipe ${recipe.id}`, { error: e });
  }
}

interface RecipeRow {
  id: string;
  output_item_id: string;
  output_quantity: number;
  inputs_json: string;
  skills_json: string | null;
  time_seconds: number | null;
  updated_at: string;
}

function rowToRecipe(row: RecipeRow): Recipe {
  return {
    id: row.id,
    output_item_id: row.output_item_id,
    output_quantity: row.output_quantity,
    inputs: JSON.parse(row.inputs_json),
    skills: row.skills_json ? JSON.parse(row.skills_json) : undefined,
    time_seconds: row.time_seconds ?? undefined,
    updated_at: row.updated_at,
  };
}

export function getRecipe(id: string): Recipe | null {
  try {
    const row = queryOne<RecipeRow>('SELECT * FROM game_recipes WHERE id = ?', id);
    return row ? rowToRecipe(row) : null;
  } catch (e) {
    log.error(`Failed to get recipe ${id}`, { error: e });
    return null;
  }
}

export function getRecipesByOutput(item_id: string): Recipe[] {
  try {
    return queryAll<RecipeRow>('SELECT * FROM game_recipes WHERE output_item_id = ?', item_id)
      .map(rowToRecipe);
  } catch (e) {
    log.error(`Failed to get recipes for output ${item_id}`, { error: e });
    return [];
  }
}

export function getAllRecipes(): Recipe[] {
  try {
    return queryAll<RecipeRow>('SELECT * FROM game_recipes').map(rowToRecipe);
  } catch (e) {
    log.error('Failed to get all recipes', { error: e });
    return [];
  }
}
