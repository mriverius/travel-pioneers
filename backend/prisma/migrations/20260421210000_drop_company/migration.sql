-- Drop the company column from users — it's no longer part of the profile.
ALTER TABLE "users" DROP COLUMN IF EXISTS "company";
