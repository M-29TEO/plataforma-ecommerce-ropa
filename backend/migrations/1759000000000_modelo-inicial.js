/**
 * Migración inicial: aplica el modelo de datos completo (Entregable 3).
 *
 * migrations/sql/0001_modelo_inicial.sql es una copia literal de docs/03-modelo-datos.sql
 * (el contexto de build de Docker solo ve ./backend). Si cambia el documento, los cambios
 * se agregan como migraciones NUEVAS; esta no se edita una vez aplicada.
 */
const fs = require('node:fs');
const path = require('node:path');

exports.up = (pgm) => {
  pgm.sql(fs.readFileSync(path.join(__dirname, 'sql', '0001_modelo_inicial.sql'), 'utf8'));
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP SCHEMA IF EXISTS platform, support, crm, logistics, billing, payments,
                          sales, inventory, catalog, iam CASCADE;
  `);
};
