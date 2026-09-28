import { openDatabase, resolveDataPaths } from "./db.js";

const { dbPath } = resolveDataPaths();
const db = openDatabase(dbPath);
db.close();
console.log(`SQLite migrations are up to date: ${dbPath}`);
