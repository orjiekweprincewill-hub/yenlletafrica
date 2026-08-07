-- 1. Lock the Yenllet database door from the general public
REVOKE CONNECT ON DATABASE "setupDB" FROM PUBLIC;

-- 2. Lock the VTU database door from the general public
REVOKE CONNECT ON DATABASE "paygoment" FROM PUBLIC;

-- 3. Give the Yenllet user the private key to Yenllet only
GRANT CONNECT ON DATABASE "setupDB" TO yenllet_admin;

-- 4. Give the Yenllet user permission to actually use the tables inside
-- (Run this while your query window is pointing to setupDB)
GRANT ALL ON SCHEMA public TO yenllet_admin;
