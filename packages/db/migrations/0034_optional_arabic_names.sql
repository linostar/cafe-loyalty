-- migration: expand
-- Arabic names are optional: a café may leave the reward's, an order type's or a campaign's Arabic name out (NULL), and
-- every page, pass and counter shows the English one instead. The length CHECKs stay (NULL passes them). An older
-- release reads these as never null, so a rollback past this one first fills the blanks (UPDATE ... SET x_ar = x_en).
-- Runs as cl_owner with search_path = app.

ALTER TABLE loyalty_programs ALTER COLUMN reward_name_ar DROP NOT NULL;
ALTER TABLE order_types ALTER COLUMN name_ar DROP NOT NULL;
ALTER TABLE campaigns ALTER COLUMN name_ar DROP NOT NULL;
