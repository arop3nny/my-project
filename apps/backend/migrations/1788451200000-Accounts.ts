import type { MigrationInterface, QueryRunner } from 'typeorm';
export class Accounts1788451200000 implements MigrationInterface {
  name = 'Accounts1788451200000';
  async up(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
CREATE SCHEMA accounts;

CREATE TABLE accounts.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  issuer text NOT NULL,
  subject text NOT NULL,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issuer, subject)
);
`); }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`
-- Removes all account profiles.
DROP TABLE accounts.profiles;
DROP SCHEMA accounts;
`); }
}
