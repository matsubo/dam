import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set');
}

export const sql = postgres(url, {
  max: 10,
  prepare: false,
  types: {
    bigint: postgres.BigInt,
  },
});

export type Sql = typeof sql;
