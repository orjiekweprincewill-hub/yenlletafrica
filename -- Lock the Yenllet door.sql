-- Lock the Yenllet door
REVOKE CONNECT ON DATABASE "setupDB" FROM PUBLIC;

-- Give your Yenllet user the keys
GRANT CONNECT ON DATABASE "setupDB" TO yenllet_admin;

-- Make sure the user can create tables (Run this while connected to setupDB)
GRANT ALL ON SCHEMA public TO yenllet_admin;
